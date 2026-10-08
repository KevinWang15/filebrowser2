import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync, openSync, fsyncSync, closeSync, lstatSync, constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { z } from 'zod'
import { FULL_PERMISSIONS, type AdminTarget, type Target, type TargetAccess, type TargetConnection, type User, type Permission } from '@/shared/types'
import { Store, type TargetRow } from './store'
import { HttpError, isFsError } from './errors'
import { LocalStorage } from './storage/local'
import { S3Storage } from './storage/s3'
import { FileRemoteStorage } from './storage/remote'
import { capabilities } from './storage/capabilities'
import type { SequentialUploadBackend, StorageBackend } from './storage/interface'
import { normalizePath, requirePermission } from './storage/paths'

const text = z.string().max(4096).refine(v => ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), 'Control characters are not allowed')
const secret = z.string().max(32768)
const host = text.min(1).refine(v => !/[\s/@\\]/.test(v), 'Use a host name or IP address')
const root = text.min(1).refine(v => v.startsWith('/') && !v.includes('\\') && !v.split('/').some(p => p === '..' || p === '.'), 'Use an absolute path without traversal')
const connectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), root: text.min(1) }).strict(),
  z.object({ type: z.literal('s3'), bucket: text.min(1).max(255).refine(v => !/[\s/\\]/.test(v), 'Invalid bucket name'), region: text.min(1), endpoint: text.default(''), prefix: text.default(''),
    accessKeyId: secret.default(''), secretAccessKey: secret.default(''), sessionToken: secret.default(''), forcePathStyle: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('ftp'), host, port: z.number().int().min(1).max(65535).default(21), username: text.min(1), password: secret.default('').refine(v => !v.includes('\r') && !v.includes('\n'), 'FTP passwords cannot contain line breaks'), root,
    tls: z.boolean().default(true) }).strict(),
  z.object({ type: z.literal('sftp'), host, port: z.number().int().min(1).max(65535).default(22), username: text.min(1), password: secret.default(''), privateKey: secret.default(''), passphrase: secret.default(''), root,
    hostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, 'Provide the server SHA256 host key fingerprint') }).strict(),
])
export const targetSchema = z.object({ name: z.string().trim().min(1).max(60), connection: connectionSchema,
  enabled: z.boolean().default(true), readOnly: z.boolean().default(false) }).strict()
const SECRET_FIELDS = new Set(['accessKeyId', 'secretAccessKey', 'sessionToken', 'password', 'privateKey', 'passphrase'])
type Backend = StorageBackend & SequentialUploadBackend
const contains = (parent: string, child: string) => parent === child || !parent || parent === '/' || child.startsWith(parent + '/')
function directoryId(path: string) {
  try { const info = lstatSync(path, { bigint: true }); return info.isDirectory() ? `${info.dev}:${info.ino}` : null }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
function containsDirectory(parent: string, child: string) {
  const id = directoryId(parent)
  if (!id) return false
  for (let path = child; ; path = dirname(path)) {
    if (directoryId(path) === id) return true
    if (path === dirname(path)) return false
  }
}

export class Targets {
  private key: Buffer
  private backends = new Map<string, Promise<Backend>>()
  constructor(readonly store: Store, readonly stateDirectory: string, private publishFault?: () => void) {
    const keyPath = join(stateDirectory, 'targets.key')
    try { this.key = readFileSync(keyPath) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      if (store.targets().length) throw new Error('Target encryption key is missing. Restore targets.key with the database.', { cause: error })
      this.key = randomBytes(32); writeFileSync(keyPath, this.key, { mode: 0o600, flag: 'wx' })
      const file = openSync(keyPath, 'r'), parent = openSync(stateDirectory, 'r')
      try { fsyncSync(file); fsyncSync(parent) } finally { closeSync(file); closeSync(parent) }
    }
    if (this.key.length !== 32) throw new Error('Invalid target encryption key')
    chmodSync(keyPath, 0o600)
  }
  private encrypt(connection: TargetConnection) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    const body = Buffer.concat([cipher.update(JSON.stringify(connection)), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64')
  }
  connection(row: TargetRow): TargetConnection {
    const data = Buffer.from(row.connection, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12))
    cipher.setAuthTag(data.subarray(12, 28))
    return connectionSchema.parse(JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString()))
  }
  row(id: string): TargetRow {
    const row = this.store.target(id)
    if (!row) throw new HttpError(404, 'Storage target not found')
    return row
  }
  view(row: TargetRow): Target {
    return { id: row.id, name: row.name, type: row.type, enabled: !!row.enabled, readOnly: !!row.read_only, createdAt: row.created_at,
      capabilities: capabilities(row.type, !!row.read_only) }
  }
  adminView(row: TargetRow): AdminTarget {
    const connection = this.connection(row), secrets: string[] = []
    for (const field of Object.keys(connection)) {
      if (!SECRET_FIELDS.has(field)) continue
      const record = connection as unknown as Record<string, unknown>
      if (record[field]) secrets.push(field)
      record[field] = ''
    }
    return { ...this.view(row), connection, secrets }
  }
  list(user: User): Target[] {
    return this.store.targets().filter(row => row.enabled && (user.role === 'admin' || user.grants.some(g => g.targetId === row.id)))
      .map(row => this.view(row))
  }
  access(user: User, targetId: string, permission?: Permission): TargetAccess {
    // Always refresh grants, including operations that outlive the HTTP authentication hook.
    const account = this.store.user(user.id)
    if (!account || account.disabled) throw new HttpError(403, 'Account access was revoked')
    const current = this.store.publicUser(account), row = this.row(targetId)
    if (!row.enabled) throw new HttpError(403, 'Storage target is disabled', 'TARGET_DISABLED')
    const grant = current.role === 'admin' ? { scope: '/', permissions: FULL_PERMISSIONS } : current.grants.find(g => g.targetId === row.id)
    if (!grant) throw new HttpError(403, 'You do not have access to this storage target', 'FORBIDDEN')
    const access = { ...current, ...grant, targetId: row.id, storageReadOnly: !!row.read_only }
    if (permission) requirePermission(access, permission)
    return access
  }
  private validate(connection: TargetConnection, currentId?: string) {
    if (connection.type === 'ftp' || connection.type === 'sftp') connection.root = normalizePath(connection.root)
    if (connection.type === 'local') {
      connection.root = resolve(connection.root)
    }
    if (connection.type === 's3') {
      if (connection.endpoint) {
        let url: URL
        try { url = new URL(connection.endpoint) } catch { throw new HttpError(400, 'Invalid S3 endpoint URL') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Use an HTTP or HTTPS S3 endpoint without credentials')
      }
      connection.prefix = connection.prefix.replace(/^\/+|\/+$/g, '')
      if (connection.prefix.includes('\\') || connection.prefix.split('/').some(p => p === '..' || p === '.')) throw new HttpError(400, 'Invalid S3 prefix')
      if (!connection.accessKeyId || !connection.secretAccessKey) throw new HttpError(400, 'S3 access key and secret are required')
    }
    if (connection.type === 'sftp' && !connection.password && !connection.privateKey) throw new HttpError(400, 'Provide an SFTP password or private key')
    for (const row of this.store.targets().filter(row => row.id !== currentId && row.type === connection.type)) {
      const other = this.connection(row)
      let overlap = false
      if (connection.type === 'local' && other.type === 'local') {
        overlap = contains(connection.root, other.root) || contains(other.root, connection.root) || containsDirectory(connection.root, other.root) || containsDirectory(other.root, connection.root)
      } else if (connection.type === 's3' && other.type === 's3') {
        const endpoint = (value: string) => value ? new URL(value).href.replace(/\/$/, '') : 'aws-s3'
        overlap = connection.bucket === other.bucket && endpoint(connection.endpoint) === endpoint(other.endpoint) && (contains(connection.prefix, other.prefix) || contains(other.prefix, connection.prefix))
      } else if ((connection.type === 'ftp' || connection.type === 'sftp') && (other.type === 'ftp' || other.type === 'sftp')) {
        // Separate remote accounts may have separate chroots. Detect overlap
        // within the same protocol endpoint and authenticated namespace.
        overlap = connection.host.toLowerCase() === other.host.toLowerCase() && connection.port === other.port && connection.username === other.username && (contains(connection.root.replace(/\/$/, '') || '/', other.root.replace(/\/$/, '') || '/') || contains(other.root.replace(/\/$/, '') || '/', connection.root.replace(/\/$/, '') || '/'))
      }
      if (overlap) throw new HttpError(409, 'Storage target namespaces must not overlap. Use folder scopes on one target to grant access.')
    }
  }
  create(input: z.infer<typeof targetSchema>) {
    const body = targetSchema.parse(input); this.validate(body.connection)
    const id = randomUUID()
    this.store.db.prepare('INSERT INTO targets(id,name,type,connection,enabled,read_only,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, body.name, body.connection.type, this.encrypt(body.connection), +body.enabled, +body.readOnly, new Date().toISOString())
    return this.adminView(this.row(id))
  }
  async update(id: string, input: z.infer<typeof targetSchema>) {
    const body = targetSchema.parse(input), row = this.row(id), previous = this.connection(row)
    if (previous.type !== body.connection.type) throw new HttpError(400, 'Create a new target to change the storage type')
    const record = body.connection as unknown as Record<string, unknown>, old = previous as unknown as Record<string, unknown>
    for (const field of SECRET_FIELDS) if (field in record && !record[field]) record[field] = old[field]
    const locationFields = previous.type === 'local' ? ['root'] : previous.type === 's3' ? ['bucket', 'prefix', 'endpoint'] : ['host', 'port', 'root']
    if (locationFields.some(field => record[field] !== old[field])) throw new HttpError(400, 'Create a new target to change its storage location')
    const connectionChanged = JSON.stringify(body.connection) !== JSON.stringify(previous)
    const settingsChanged = Object.keys(record).some(field => !SECRET_FIELDS.has(field) && record[field] !== old[field])
    if (settingsChanged && this.store.retainedUploads().some(upload => upload.target_id === id)) throw new HttpError(409, 'Finish or cancel uploads before changing connection settings. Secret credentials can be renewed independently.')
    if (connectionChanged && this.store.db.prepare('SELECT id FROM network_shares WHERE target_id=?').get(id)) throw new HttpError(409, 'Remove this target’s protocol shares before editing it')
    // Verify a local write-access transition before replacing a working configuration.
    // Retain the initialized backend and its lock so the check is not lost on save.
    const writable = body.connection.type === 'local' && body.enabled && !body.readOnly && (row.read_only || !row.enabled)
      ? new LocalStorage(body.connection.root, this.publishFault) : undefined
    try {
      if (writable) {
        this.validate(body.connection, id)
        await writable.init(); await access(writable.root, constants.W_OK); await writable.lock()
      }
      this.store.db.prepare('UPDATE targets SET name=?,connection=?,enabled=?,read_only=? WHERE id=?')
        .run(body.name, this.encrypt(body.connection), +body.enabled, +body.readOnly, id)
    } catch (error) {
      writable?.close()
      if (writable && (isFsError(error, 'EACCES') || isFsError(error, 'EPERM'))) {
        throw new HttpError(403, 'Cannot enable write access. Grant the application write permission to this directory before disabling Read only.', 'STORAGE_PERMISSION')
      }
      if (writable && isFsError(error, 'EROFS')) {
        throw new HttpError(403, 'Cannot enable write access. Make the filesystem mount writable before disabling Read only.', 'STORAGE_READ_ONLY')
      }
      throw error
    }
    await this.release(id)
    if (writable) this.backends.set(id, Promise.resolve(writable))
    return this.adminView(this.row(id))
  }
  async remove(id: string) {
    this.row(id)
    if (this.store.db.prepare('SELECT id FROM uploads WHERE target_id=? LIMIT 1').get(id) || this.store.db.prepare('SELECT id FROM network_shares WHERE target_id=? LIMIT 1').get(id)) {
      throw new HttpError(409, 'This target has transfer history or protocol shares. Disable it to retain those records.')
    }
    this.store.db.prepare('DELETE FROM targets WHERE id=?').run(id)
    await this.release(id)
  }
  async backend(id: string): Promise<Backend> {
    const row = this.row(id)
    if (!row.enabled) throw new HttpError(403, 'Storage target is disabled', 'TARGET_DISABLED')
    let pending = this.backends.get(id)
    if (!pending) {
      pending = (async () => {
        const connection = this.connection(row), directory = join(this.stateDirectory, 'targets', id)
        this.validate(connection, id)
        if (connection.type === 'local') {
          const backend = new LocalStorage(connection.root, this.publishFault, !!row.read_only)
          await backend.init(); await backend.lock(); return backend
        }
        const backend = connection.type === 's3' ? new S3Storage(connection, directory, !!row.read_only) : new FileRemoteStorage(connection, directory, !!row.read_only)
        if (!row.read_only) {
          try { await backend.orphanStages(new Set(this.store.retainedUploads().filter(upload => upload.target_id === id).map(upload => upload.id))) }
          catch (error) { backend.close(); throw error }
        }
        return backend
      })()
      this.backends.set(id, pending)
      void pending.catch(() => { if (this.backends.get(id) === pending) this.backends.delete(id) })
    }
    return pending
  }
  private async release(id: string) { const pending = this.backends.get(id); this.backends.delete(id); if (pending) { try { (await pending).close() } catch { /* Failed initialization already closed its resources. */ } } }
  async close() { for (const id of this.backends.keys()) await this.release(id); this.key.fill(0) }
  localRoot(id: string) { const connection = this.connection(this.row(id)); return connection.type === 'local' ? resolve(connection.root) : null }
}
