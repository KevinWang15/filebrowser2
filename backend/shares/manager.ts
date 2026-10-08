import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { isIP } from 'node:net'
import type { NetworkShare, NetworkShares, ShareCredentials, User } from '@/shared/types'
import { storageLocations } from '../config'
import { HttpError, isFsError } from '../errors'
import type { DirectoryExportBackend } from '../storage/interface'
import { Targets } from '../targets'
import { canAccessStoredPath, normalizePath } from '../storage/paths'
import { Store } from '../store'
import { agentStatusSchema, controlSchema, controlShareSchema, SHARE_LEASE_MS, type ShareAgentStatus, type ShareControl } from './control'
import { smbProvider, type ShareProvider } from './providers'

interface ShareRow {
  sequence: number; id: string; protocol: string; name: string; user_id: string; target_id: string; path: string
  username: string; secret: string; directory_dev: string; directory_ino: string; enabled: number; created_at: string
  account_sequence: number; credentials_valid: number
}

const publicationErrors = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'ESTALE', 'EMFILE', 'ENFILE']
const isPublicationError = (error: unknown) => publicationErrors.some(code => isFsError(error, code))

export class DirectoryShares {
  readonly configured: boolean
  private providers = new Map<string, ShareProvider>([[smbProvider.id, smbProvider]])
  private timer?: ReturnType<typeof setInterval>
  private writing: Promise<string> = Promise.resolve('')
  private stopped = false
  private revision = ''
  private publicationFailed = false

  constructor(private store: Store, private targets: Targets, private directory: string, enabled: boolean, private host: string | null = null) {
    this.configured = enabled
    if (host && (host.length > 253 || !(isIP(host.replace(/^\[|\]$/g, '')) || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)))) throw new Error('FB_SMB_PUBLIC_HOST must be a hostname or IP address without a port')
  }
  async init() {
    if (!this.configured) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Protocol control directory must not be a symlink')
    await this.publish()
    this.timer = setInterval(() => { void this.publish().catch(() => { /* An unrenewed lease closes the companion service. */ }) }, 2_000)
    this.timer.unref()
  }
  private rows() { return this.store.db.prepare(`SELECT shares.*,accounts.username,accounts.secret,accounts.credentials_valid,accounts.sequence AS account_sequence
    FROM network_shares shares JOIN network_share_accounts accounts ON accounts.protocol=shares.protocol AND accounts.user_id=shares.user_id ORDER BY shares.sequence`).all() as unknown as ShareRow[] }
  private row(id: string) {
    const row = this.rows().find(row => row.id === id)
    if (!row) throw new HttpError(404, 'Share not found')
    return row
  }
  private owner(row: ShareRow) { const owner = this.store.user(row.user_id); return owner ? this.store.publicUser(owner) : null }
  private access(row: ShareRow) {
    const owner = this.owner(row)
    try { return owner ? this.targets.access(owner, row.target_id, 'download') : null } catch { return null }
  }
  private allowed(row: ShareRow) {
    const owner = this.access(row)
    return !!row.credentials_valid && !!owner && canAccessStoredPath(owner, row.path)
      && (owner.role === 'admin' || owner.permissions.read)
  }
  private async storage(targetId: string) {
    if (!this.targets.localRoot(targetId)) throw new HttpError(400, 'This target does not support native directory export')
    return await this.targets.backend(targetId) as Awaited<ReturnType<Targets['backend']>> & DirectoryExportBackend
  }
  private async status(): Promise<ShareAgentStatus | null> {
    if (!this.configured) return null
    try {
      const info = await lstat(join(this.directory, 'status.json'))
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return null
      const status = agentStatusSchema.parse(JSON.parse(await readFile(join(this.directory, 'status.json'), 'utf8')))
      return status.checkedAt <= Date.now() + 1_000 && Date.now() - status.checkedAt < 4_000 ? status : null
    } catch { return null }
  }
  private public(row: ShareRow, user: User, status: ShareAgentStatus | null): NetworkShare {
    const owner = this.owner(row)
    const blocked = !this.allowed(row) || !!status?.failed.includes(row.id)
    const current = status?.revision === this.revision && status.ready
    const state = !row.enabled ? 'disabled' : blocked ? 'blocked' : !this.configured || this.publicationFailed || !status || status.error ? 'unavailable'
      : current && status.active.includes(row.id) ? 'active' : 'pending'
    return { id: row.id, targetId: row.target_id, targetName: this.targets.row(row.target_id).name, protocol: row.protocol, name: row.name,
      path: user.role === 'admin' ? row.path : this.access(row) && canAccessStoredPath(this.access(row)!, row.path) ? '/' + posix.relative(this.access(row)!.scope, row.path) : '',
      ownerId: row.user_id, ownerName: owner?.username ?? '', username: row.username, enabled: !!row.enabled, readOnly: true,
      status: state, message: !row.credentials_valid ? 'Reset the owner’s SMB password before enabling access.'
        : status?.failed.includes(row.id) ? 'The shared directory changed or is unavailable. Recreate its share.'
        : blocked ? 'The owner must have read and download access to this directory.'
        : state === 'unavailable' ? 'The SMB service is unavailable.' : state === 'pending' ? 'Applying share configuration.' : '', createdAt: row.created_at }
  }
  async list(user: User): Promise<NetworkShares> {
    const status = await this.status()
    return { host: this.host, configured: this.configured, available: !this.publicationFailed && !!status?.ready && !status.error && status.revision === this.revision,
      protocols: [...this.providers.values()].map(({ id, name, readOnly }) => ({ id, name, readOnly })),
      shares: this.rows().filter(row => user.role === 'admin' || row.user_id === user.id).map(row => this.public(row, user, status)) }
  }
  private async writeControl(control: ShareControl, valid: () => boolean = () => true) {
    const temporary = join(this.directory, `.desired-${randomUUID()}`)
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify(control)); await handle.sync() } finally { await handle.close() }
      if (!valid()) { await unlink(temporary); return false }
      await rename(temporary, join(this.directory, 'desired.json'))
      return true
    } catch (error) { await unlink(temporary).catch(() => {}); throw error }
  }
  async publish(wait = false) {
    if (!this.configured || this.stopped) return false
    const write = async () => {
      const shares: ShareControl['shares'] = []
      for (const row of this.rows().filter(row => row.enabled && this.allowed(row))) {
        try {
          const storage = await this.storage(row.target_id)
          const root = this.targets.localRoot(row.target_id)!
          storageLocations(root, this.directory)
          shares.push({ id: row.id, name: row.name, path: row.path, username: row.username, uid: 100_000 + row.account_sequence,
            directory: { dev: row.directory_dev, ino: row.directory_ino }, storage: { path: root, ...await storage.directoryIdentity('/') }, ntHash: row.secret })
        } catch { /* An unavailable target never authorizes a native export. */ }
      }
      const access = { uid: process.geteuid?.() ?? 1000, gid: process.getegid?.() ?? 1000, groups: process.getgroups?.() ?? [] }
      const policy = { version: 2 as const, protocol: 'smb' as const, access, shares }
      const revision = createHash('sha256').update(JSON.stringify(policy)).digest('hex')
      const control: ShareControl = controlSchema.parse({ ...policy, revision, expiresAt: this.stopped ? 0 : Date.now() + SHARE_LEASE_MS })
      // Storage probes and control-file fsync can wait while an administrator
      // revokes access. Never renew a lease containing a superseded grant.
      const valid = () => {
        const current = this.rows()
        return shares.every(share => {
          const row = current.find(row => row.id === share.id)
          return row?.enabled && this.allowed(row) && row.secret === share.ntHash && row.directory_dev === share.directory.dev && row.directory_ino === share.directory.ino
        })
      }
      if (!await this.writeControl(control, valid)) { this.revision = ''; return '' }
      this.revision = revision
      this.publicationFailed = false
      return revision
    }
    const writing = this.writing.catch(() => '').then(write).catch(error => {
      if (!isPublicationError(error)) throw error
      // Database changes are already durable. Keep their successful response,
      // including newly issued credentials, while an unrenewed lease expires.
      this.publicationFailed = true
      this.revision = ''
      return ''
    })
    this.writing = writing
    const revision = await writing
    if (!revision) return false
    if (!wait) return true
    const deadline = Date.now() + 3_000
    do {
      const status = await this.status()
      if (status?.revision === revision && status.ready && !status.error) return true
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    return false
  }
  async create(actor: User, input: { targetId: string; protocol: string; name: string; path: string; ownerId: string }, authorize: () => void = () => {}): Promise<ShareCredentials> {
    if (!this.configured) throw new HttpError(409, 'Enable the optional SMB service before creating shares')
    const provider = this.providers.get(input.protocol)
    if (!provider) throw new HttpError(400, 'Unsupported sharing protocol')
    if (this.rows().length >= 200) throw new HttpError(409, 'The 200-share limit has been reached')
    const path = normalizePath(input.path)
    const owner = this.store.user(input.ownerId)
    if (!owner) throw new HttpError(404, 'Share owner not found')
    const access = this.targets.access(this.store.publicUser(owner), input.targetId, 'download')
    if (!(access.role === 'admin' || access.permissions.read) || !canAccessStoredPath(access, path)) throw new HttpError(403, 'The owner must have read and download access to this directory')
    const storage = await this.storage(input.targetId)
    const directory = await storage.directoryIdentity(path)
    const root = { path: this.targets.localRoot(input.targetId)!, ...await storage.directoryIdentity('/') }
    storageLocations(root.path, this.directory)
    const id = randomUUID(), username = 'fb_' + id.replaceAll('-', '').slice(0, 24)
    // Validate before persisting or generating credentials; Samba expands percent macros in paths.
    controlShareSchema.parse({ id, name: input.name, path, directory, storage: root, username, uid: 100_001, ntHash: '0'.repeat(32) })
    const credentials = await provider.credentials()
    let password: string | null = null
    try {
      this.store.transaction(() => {
        authorize()
        const current = this.targets.access(this.store.publicUser(this.store.user(input.ownerId)!), input.targetId, 'download')
        if (!(current.role === 'admin' || current.permissions.read) || !canAccessStoredPath(current, path)) throw new HttpError(403, 'The owner must have read and download access to this directory')
        if (this.rows().length >= 200) throw new HttpError(409, 'The 200-share limit has been reached')
        const account = this.store.db.prepare('SELECT credentials_valid FROM network_share_accounts WHERE protocol=? AND user_id=?').get(input.protocol, input.ownerId) as { credentials_valid: number } | undefined
        if (!account) {
          this.store.db.prepare('INSERT INTO network_share_accounts(protocol,user_id,username,secret) VALUES(?,?,?,?)').run(input.protocol, input.ownerId, username, credentials.secret)
          password = credentials.password
        } else if (!account.credentials_valid) {
          this.store.db.prepare('UPDATE network_share_accounts SET secret=?,credentials_valid=1 WHERE protocol=? AND user_id=?').run(credentials.secret, input.protocol, input.ownerId)
          password = credentials.password
        }
        this.store.db.prepare('INSERT INTO network_shares(id,protocol,name,user_id,target_id,path,directory_dev,directory_ino,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, input.protocol, input.name, input.ownerId, input.targetId, path, directory.dev, directory.ino, new Date().toISOString())
      })
    } catch (error) {
      if (String((error as Error).message).includes('network_shares.name')) throw new HttpError(409, 'This share name is already in use')
      throw error
    }
    this.store.audit(actor.username, 'share.created', input.name)
    await this.publish(true)
    const row = this.row(id)
    const status = await this.status(); authorize()
    return { share: this.public(row, actor, status), username: row.username, password }
  }
  async setEnabled(actor: User, id: string, enabled: boolean) {
    this.row(id)
    this.store.db.prepare('UPDATE network_shares SET enabled=? WHERE id=?').run(Number(enabled), id)
    this.store.audit(actor.username, enabled ? 'share.enabled' : 'share.disabled', this.row(id).name)
    await this.publish(true)
    return this.public(this.row(id), actor, await this.status())
  }
  async rotate(actor: User, id: string, authorize: () => void = () => {}): Promise<ShareCredentials> {
    const row = this.row(id), provider = this.providers.get(row.protocol)!
    const credentials = await provider.credentials()
    authorize()
    this.store.db.prepare('UPDATE network_share_accounts SET secret=?,credentials_valid=1 WHERE protocol=? AND user_id=?').run(credentials.secret, row.protocol, row.user_id)
    this.store.audit(actor.username, 'share.credentials_rotated', row.name)
    await this.publish(true)
    const status = await this.status(); authorize()
    return { share: this.public(this.row(id), actor, status), username: row.username, password: credentials.password }
  }
  async remove(actor: User, id: string, authorize: () => void = () => {}) {
    const row = this.row(id)
    this.store.db.prepare('UPDATE network_shares SET enabled=0 WHERE id=?').run(id)
    const applied = await this.publish(true)
    if (!applied) throw new HttpError(503, 'Share disabled; waiting for the SMB service to confirm removal. Retry when it is available.')
    authorize()
    this.store.db.prepare('DELETE FROM network_shares WHERE id=?').run(id)
    this.store.audit(actor.username, 'share.deleted', row.name)
  }
  blockMutation(targetId: string, path: string) {
    if (this.rows().some(row => row.target_id === targetId && (row.path === path || row.path.startsWith(path === '/' ? '/' : path + '/')))) {
      throw new HttpError(409, 'Remove directory shares before renaming or deleting this folder', 'DIRECTORY_SHARED')
    }
  }
  invalidateCredentials(userId: string) {
    this.store.db.prepare('UPDATE network_shares SET enabled=0 WHERE user_id=?').run(userId)
    this.store.db.prepare('UPDATE network_share_accounts SET credentials_valid=0 WHERE user_id=?').run(userId)
  }
  async close() {
    if (this.timer) clearInterval(this.timer)
    this.stopped = true
    await this.writing.catch(() => '')
    if (this.configured) {
      try {
        const parsed = controlSchema.safeParse(JSON.parse(await readFile(join(this.directory, 'desired.json'), 'utf8')))
        if (!parsed.success) return
        const control = parsed.data
        control.expiresAt = 0
        await this.writeControl(control)
      } catch (error) { if (!isPublicationError(error) && !(error instanceof SyntaxError)) throw error }
    }
  }
}
