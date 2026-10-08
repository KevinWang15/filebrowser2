import { createReadStream } from 'node:fs'
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable, PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { TLSSocket } from 'node:tls'
import { Client as SSH, type SFTPWrapper, type Stats } from 'ssh2'
import { Client as FTP } from 'basic-ftp'
import type { FileEntry, TargetConnection } from '@/shared/types'
import { capabilities } from './capabilities'
import { HttpError, isFsError } from '../errors'
import { normalizePath, validName } from './paths'
import { Chunks } from './chunks'
import type { SequentialUploadBackend, StorageBackend } from './interface'

type Connection = Extract<TargetConnection, { type: 'ftp' | 'sftp' }>
interface Receipt { start: number; end: number; hash: string }
interface Stage { id: string; destination: string; pending: string; receipts: Receipt[] }
const missing = () => Object.assign(new Error('Remote path not found'), { code: 'ENOENT' })
const exists = () => Object.assign(new Error('Destination exists'), { code: 'EEXIST' })
function call<T>(run: (callback: (error: Error | undefined | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => run((error, result) => error ? reject(error) : resolve(result)))
}
function done(run: (callback: (error: Error | undefined | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run(error => error ? reject(error) : resolve()))
}
class RestartFTP extends FTP {
  async restartUpload(source: Readable, path: string, offset: number) {
    if (offset) await this.send(`REST ${offset}`)
    const context = this.ftp
    const guarded = Readable.from((async function* () {
      // The SDK checks getCipher(), which Node can expose before secureConnect.
      // An empty source must not end the TLS stream while it is negotiating.
      const socket = context.dataSocket
      if (socket instanceof TLSSocket && !socket.authorized) await once(socket, 'secureConnect')
      yield* source
    })())
    try { return await this._uploadFromStream(guarded, path, 'STOR') }
    finally { guarded.destroy(); source.destroy() }
  }
}

/** Offset-based uploads to a private remote stage, with read-back verification. */
export class FileRemoteStorage implements StorageBackend, SequentialUploadBackend {
  readonly type
  readonly capabilities
  private chunks: Chunks
  private closed = false
  private restored = new Set<string>()
  private idle: { client: SSH; sftp: SFTPWrapper; dead: boolean }[] = []
  private connections = new Set<SSH | FTP>()
  constructor(readonly name: string, private connection: Connection, directory: string, readOnly: boolean) {
    this.type = connection.type; this.capabilities = capabilities(connection.type, readOnly); this.chunks = new Chunks(directory)
  }
  private writable() { if (this.capabilities.readOnly) throw new HttpError(403, 'Target is read-only', 'STORAGE_READ_ONLY') }
  private native(path: string) { return posix.join(this.connection.root, normalizePath(path)) }
  private async sftp() {
    const connection = this.connection
    if (connection.type !== 'sftp') throw new Error('Wrong adapter')
    const cached = this.idle.pop()
    if (cached && !cached.dead) return this.checkout(cached)
    if (cached) { cached.client.end(); this.connections.delete(cached.client) }
    const client = new SSH(); this.connections.add(client)
    const slot = { client, sftp: null as unknown as SFTPWrapper, dead: false }
    client.once('close', () => { this.restored.clear(); slot.dead = true; this.connections.delete(client); this.idle = this.idle.filter(entry => entry !== slot) })
    client.on('error', () => { slot.dead = true; this.restored.clear() })
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => { client.setNoDelay(true); resolve() }); client.once('error', reject)
        client.connect({ host: connection.host, port: connection.port, username: connection.username, password: connection.password || undefined,
          privateKey: connection.privateKey || undefined, passphrase: connection.passphrase || undefined, readyTimeout: 20_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          hostHash: 'sha256', hostVerifier: (digest: string) => 'SHA256:' + Buffer.from(digest, 'hex').toString('base64').replace(/=+$/, '') === connection.hostKey.replace(/=+$/, '') })
      })
      const sftp = await call<SFTPWrapper>(callback => client.sftp(callback))
      slot.sftp = sftp
      return this.checkout(slot)
    } catch { client.end(); this.connections.delete(client); throw new HttpError(503, 'SFTP connection failed. Check credentials and the pinned host key.', 'STORAGE_UNAVAILABLE') }
  }
  private checkout(slot: { client: SSH; sftp: SFTPWrapper; dead: boolean }) {
    let released = false
    return { client: slot.client, sftp: slot.sftp, close: () => {
      if (released) return
      released = true
      if (!this.closed && !slot.dead && this.idle.length < 4) this.idle.push(slot)
      else { slot.client.end(); this.connections.delete(slot.client) }
    } }
  }
  private async ftp() {
    if (this.connection.type !== 'ftp') throw new Error('Wrong adapter')
    const client = new RestartFTP(20_000); this.connections.add(client)
    try { await client.access({ host: this.connection.host, port: this.connection.port, user: this.connection.username, password: this.connection.password, secure: this.connection.tls }); return client }
    catch { client.close(); this.connections.delete(client); throw new HttpError(503, 'FTP connection failed. Check credentials and TLS settings.', 'STORAGE_UNAVAILABLE') }
  }
  private closeFtp(client: FTP) { client.close(); this.connections.delete(client) }
  private async wrap<T>(run: () => Promise<T>): Promise<T> {
    try { return await run() } catch (error) {
      if (error instanceof HttpError || isFsError(error, 'ENOENT') || isFsError(error, 'EEXIST') || isFsError(error, 'ENOTEMPTY')) throw error
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 2) throw missing()
      if (code === 3 || code === 550) throw new HttpError(403, 'Remote storage access was denied', 'STORAGE_PERMISSION')
      throw new HttpError(503, 'Remote storage operation failed. Check the target and retry.', 'STORAGE_UNAVAILABLE')
    }
  }
  private async checkedSftp(sftp: SFTPWrapper, path: string, allowMissing = false) {
    let current = '/'
    const parts = path.split('/').filter(Boolean)
    for (const [index, part] of parts.entries()) {
      current = posix.join(current, part)
      let info: Stats
      try { info = await call<Stats>(cb => sftp.lstat(current, cb)) } catch (error) {
        if (allowMissing && index === parts.length - 1 && error && typeof error === 'object' && 'code' in error && error.code === 2) return
        throw error
      }
      if (info.isSymbolicLink() || !info.isDirectory() && index < parts.length - 1) throw new HttpError(403, 'Symbolic links and special paths cannot be followed')
      if (index === parts.length - 1 && !info.isDirectory() && !info.isFile()) throw new HttpError(403, 'Special files cannot be accessed')
    }
  }
  private async ftpInfo(client: FTP, path: string, allowMissing = false) {
    let current = '/'
    const parts = path.split('/').filter(Boolean)
    for (const [index, part] of parts.entries()) {
      const entries = await client.list(current), entry = entries.find(e => e.name === part)
      if (!entry) { if (allowMissing && index === parts.length - 1) return; throw missing() }
      if (entry.isSymbolicLink || !entry.isDirectory && index < parts.length - 1 || !entry.isFile && !entry.isDirectory) throw new HttpError(403, 'Symbolic links and special files cannot be accessed')
      current = posix.join(current, part)
      if (index === parts.length - 1) return entry
    }
    return undefined
  }
  async stat(path: string): Promise<FileEntry> { return this.rawStat(this.native(path), normalizePath(path)) }
  private async rawStat(native: string, virtual: string): Promise<FileEntry> {
    return this.wrap(async () => {
      if (this.type === 'sftp') {
        const { sftp, close } = await this.sftp()
        try { await this.checkedSftp(sftp, native); const info = await call<Stats>(cb => sftp.lstat(native, cb));
          return { name: posix.basename(virtual), path: virtual, kind: info.isDirectory() ? 'directory' : 'file', size: info.isDirectory() ? 0 : info.size, modifiedAt: new Date(info.mtime * 1000).toISOString() }
        } finally { close() }
      }
      const client = await this.ftp()
      try { const info = await this.ftpInfo(client, native)
        return { name: posix.basename(virtual), path: virtual, kind: !info || info.isDirectory ? 'directory' : 'file', size: info?.isFile ? info.size : 0, modifiedAt: (info?.modifiedAt ?? new Date(0)).toISOString() }
      } finally { this.closeFtp(client) }
    })
  }
  async list(path: string): Promise<FileEntry[]> {
    path = normalizePath(path); const native = this.native(path)
    return this.wrap(async () => {
      if (this.type === 'sftp') {
        const { sftp, close } = await this.sftp()
        try {
          await this.checkedSftp(sftp, native)
          const entries = await call<{ filename: string; attrs: Stats }[]>(cb => sftp.readdir(native, cb))
          return entries.filter(e => this.visible(e.filename) && (e.attrs.isDirectory() || e.attrs.isFile())).map(e => ({ name: e.filename, path: posix.join(path, e.filename),
            kind: e.attrs.isDirectory() ? 'directory' : 'file', size: e.attrs.isDirectory() ? 0 : e.attrs.size, modifiedAt: new Date(e.attrs.mtime * 1000).toISOString() }))
        } finally { close() }
      }
      const client = await this.ftp()
      try { await this.ftpInfo(client, native); return (await client.list(native)).filter(e => this.visible(e.name) && (e.isDirectory || e.isFile) && !e.isSymbolicLink)
        .map(e => ({ name: e.name, path: posix.join(path, e.name), kind: e.isDirectory ? 'directory' : 'file', size: e.isFile ? e.size : 0, modifiedAt: (e.modifiedAt ?? new Date(0)).toISOString() }))
      } finally { this.closeFtp(client) }
    })
  }
  private visible(name: string) { try { validName(name); return true } catch { return false } }
  async *walk(path: string): AsyncIterable<FileEntry> { for (const e of await this.list(path)) { yield e; if (e.kind === 'directory') yield* this.walk(e.path) } }
  async open(path: string, range?: { start: number; end: number }) { return this.rawOpen(this.native(path), range) }
  private rawOpen(path: string, range?: { start: number; end: number }): Promise<Readable> { return this.wrap(() => this.uncheckedOpen(path, range)) }
  private async uncheckedOpen(path: string, range?: { start: number; end: number }): Promise<Readable> {
    if (this.type === 'sftp') {
      const { client, sftp, close } = await this.sftp()
      try {
        await this.checkedSftp(sftp, path)
        const source = sftp.createReadStream(path, range ? { start: range.start, end: range.end } : {})
        const output = new PassThrough({ highWaterMark: 64 * 1024 })
        const disconnected = () => { source.destroy(); output.destroy(new HttpError(503, 'SFTP connection closed during read', 'STORAGE_UNAVAILABLE')) }
        client.once('close', disconnected)
        output.once('close', () => { client.removeListener('close', disconnected); source.destroy(); close() })
        output.on('error', () => {})
        void pipeline(source, output).catch(() => output.destroy(new HttpError(503, 'SFTP read failed', 'STORAGE_UNAVAILABLE')))
        return output
      } catch (error) { close(); throw error }
    }
    const client = await this.ftp(), sink = new PassThrough()
    try { await this.ftpInfo(client, path) } catch (error) { this.closeFtp(client); throw error }
    const downloading = client.downloadTo(sink, path, range?.start ?? 0)
    void downloading.then(() => sink.end(), error => sink.destroy(error instanceof Error ? error : new Error('FTP download failed')))
    const output = Readable.from((async function* () {
      let remaining = range ? range.end - range.start + 1 : Infinity
      for await (const value of sink) {
        const bytes = value as Buffer, count = Math.min(bytes.length, remaining)
        yield bytes.subarray(0, count); remaining -= count
        if (!remaining) break
      }
      if (remaining !== Infinity && remaining > 0) throw new HttpError(409, 'Remote file became shorter', 'DATA_LOSS')
    })())
    output.once('close', () => { sink.destroy(); this.closeFtp(client) }); output.on('error', () => {})
    return output
  }
  private async absent(path: string) { try { await this.rawStat(path, '/'); throw exists() } catch (e) { if (!isFsError(e, 'ENOENT')) throw e } }
  async mkdir(path: string, authorize: () => void = () => {}) { this.writable(); const native = this.native(path); await this.absent(native); await this.rawMkdir(native, authorize) }
  private async rawMkdir(path: string, authorize: () => void = () => {}) {
    return this.wrap(async () => {
      if (this.type === 'sftp') { const { sftp, close } = await this.sftp(); try { await this.checkedSftp(sftp, path, true); authorize(); await done(cb => sftp.mkdir(path, { mode: 0o700 }, cb)) } finally { close() } }
      else { const client = await this.ftp(); try { await this.ftpInfo(client, path, true); authorize(); await client.send(`MKD ${path}`) } finally { this.closeFtp(client) } }
    })
  }
  async move(source: string, destination: string, authorize: () => void = () => {}) { this.writable(); return this.rawMove(this.native(source), this.native(destination), authorize) }
  private async rawMove(source: string, destination: string, authorize: () => void = () => {}) {
    await this.absent(destination)
    return this.wrap(async () => {
      if (this.type === 'sftp') { const { sftp, close } = await this.sftp(); try { await this.checkedSftp(sftp, source); await this.checkedSftp(sftp, destination, true); authorize(); await done(cb => sftp.rename(source, destination, cb)) } finally { close() } }
      else { const client = await this.ftp(); try { await this.ftpInfo(client, source); await this.ftpInfo(client, destination, true); authorize(); await client.send(`RNFR ${source}`); authorize(); await client.send(`RNTO ${destination}`) } finally { this.closeFtp(client) } }
    })
  }
  async remove(path: string, authorize: () => void = () => {}) { this.writable(); const entry = await this.stat(path); if (entry.kind === 'directory' && (await this.list(path)).length) throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' }); await this.rawRemove(this.native(path), entry.kind === 'directory', authorize) }
  private async rawRemove(path: string, directory = false, authorize: () => void = () => {}) {
    return this.wrap(async () => {
      if (this.type === 'sftp') { const { sftp, close } = await this.sftp(); try { await this.checkedSftp(sftp, path); authorize(); await done(cb => directory ? sftp.rmdir(path, cb) : sftp.unlink(path, cb)) } finally { close() } }
      else { const client = await this.ftp(); try { await this.ftpInfo(client, path); authorize(); if (directory) await client.send(`RMD ${path}`); else await client.remove(path) } finally { this.closeFtp(client) } }
    })
  }
  async space() { return { total: null, available: null } }
  private privateDirectory(id: string, destination: string) { return posix.join(posix.dirname(this.native(destination)), '.filebrowser-upload-' + id) }
  async createStage(id: string, destination: string) {
    this.writable()
    if (this.type === 'ftp') {
      const client = await this.ftp()
      try { if (!/REST STREAM/i.test((await client.send('FEAT')).message)) throw new HttpError(400, 'This FTP server does not support restart writes; resumable upload is unavailable') }
      finally { this.closeFtp(client) }
    }
    const directory = this.privateDirectory(id, destination), stage: Stage = { id, destination, pending: posix.join(directory, 'payload.uploading'), receipts: [] }
    // Persist identity first. A crash during creation is cleaned as an orphan.
    await this.chunks.create(id, stage)
    await this.rawMkdir(directory)
    await this.rawWrite(stage.pending, Readable.from([]), 0, true)
    return JSON.stringify({ id, destination })
  }
  async restoreStage(id: string, destination: string, token: string) {
    const identity = JSON.parse(token) as Stage, stage = await this.chunks.load<Stage>(id)
    if (identity.id !== id || identity.destination !== destination || stage.destination !== destination) throw new HttpError(409, 'Upload identity changed', 'DATA_LOSS')
    try { await this.rawStat(stage.pending, '/') } catch (error) { if (isFsError(error, 'ENOENT')) throw new HttpError(409, 'Saved remote upload is missing', 'DATA_LOSS'); throw error }
  }
  private async verifyReceipts(stage: Stage, path: string) {
    if (!stage.receipts.length) return
    const stream = await this.rawOpen(path, { start: 0, end: stage.receipts.at(-1)!.end - 1 })
    let index = 0, position = 0, hash = createHash('sha256')
    try {
      for await (const value of stream) {
        const bytes = value as Buffer
        let offset = 0
        while (offset < bytes.length) {
          const receipt = stage.receipts[index]
          if (!receipt || receipt.start > position) throw new HttpError(409, 'Remote upload receipts are inconsistent', 'DATA_LOSS')
          const size = Math.min(bytes.length - offset, receipt.end - position)
          hash.update(bytes.subarray(offset, offset + size)); offset += size; position += size
          if (position === receipt.end) {
            if (hash.digest('hex') !== receipt.hash) throw new HttpError(409, 'Saved remote bytes failed checksum verification. Cancel and restart this transfer.', 'DATA_LOSS')
            index++; hash = createHash('sha256')
          }
        }
      }
      if (index !== stage.receipts.length) throw new HttpError(409, 'Saved remote bytes are missing', 'DATA_LOSS')
    } finally { stream.destroy() }
  }
  async stageSize(id: string) { return (await this.rawStat((await this.chunks.load<Stage>(id)).pending, '/')).size }
  async resetTo(id: string, bytes: number) {
    const stage = await this.chunks.load<Stage>(id), size = await this.stageSize(id)
    if (size < bytes || (stage.receipts.at(-1)?.end ?? 0) < bytes) throw new HttpError(409, 'Committed remote data or receipts are missing', 'DATA_LOSS')
    stage.receipts = stage.receipts.filter(p => p.end <= bytes)
    if (!this.restored.has(id)) { await this.verifyReceipts(stage, stage.pending); this.restored.add(id) }
    if (size > bytes && this.type === 'sftp') {
      const { sftp, close } = await this.sftp()
      try { await this.checkedSftp(sftp, stage.pending); await done(cb => sftp.setstat(stage.pending, { size: bytes }, cb)); await this.sync(sftp, stage.pending) } finally { close() }
    }
    // FTP has no portable truncate. Its unacknowledged tail is hidden and is
    // replaced with REST+STOR at the durable offset on the next attempt.
    await this.chunks.save(id, stage)
  }
  prepareChunk(id: string, size: number) { this.writable(); return this.chunks.prepare(id, size) }
  writePart(id: string, offset: number, size: number, source: Readable, valid: () => boolean) { return this.chunks.write(id, offset, size, source, valid) }
  verifyChunk(id: string, hash: string, size: number) { return this.chunks.verify(id, hash, size) }
  private async sync(sftp: SFTPWrapper, path: string) {
    const handle = await call<Buffer>(cb => sftp.open(path, 'r+', cb))
    try { await done(cb => sftp.ext_openssh_fsync(handle, cb)) } finally { await done(cb => sftp.close(handle, cb)) }
  }
  private async rawWrite(path: string, source: Readable, offset: number, create = false) {
    return this.wrap(async () => {
      if (this.type === 'sftp') {
        const { client, sftp, close } = await this.sftp()
        let destination: ReturnType<SFTPWrapper['createWriteStream']> | undefined
        let disconnected!: () => void
        const lost = new Promise<never>((_, reject) => { disconnected = () => reject(new HttpError(503, 'SFTP connection closed during write', 'STORAGE_UNAVAILABLE')) })
        client.once('close', disconnected)
        try {
          const writing = (async () => {
            await this.checkedSftp(sftp, path, create)
            destination = sftp.createWriteStream(path, { flags: create ? 'wx' : 'r+', start: offset, mode: 0o600 })
            await pipeline(source, destination)
            await this.sync(sftp, path)
          })()
          await Promise.race([writing, lost])
        } finally { client.removeListener('close', disconnected); source.destroy(); destination?.destroy(); close() }
      } else {
        const client = await this.ftp()
        try { await this.ftpInfo(client, path, create); await client.restartUpload(source, path, offset) } finally { this.closeFtp(client) }
      }
    })
  }
  async appendChunk(id: string, offset: number, size: number) {
    this.writable()
    const stage = await this.chunks.load<Stage>(id), expected = this.chunks.hash(id)
    if ((stage.receipts.at(-1)?.end ?? 0) !== offset) throw new HttpError(409, 'Remote upload checkpoint changed')
    await this.rawWrite(stage.pending, createReadStream(this.chunks.chunk(id)), offset)
    const stream = await this.rawOpen(stage.pending, { start: offset, end: offset + size - 1 }), hash = createHash('sha256')
    try { for await (const bytes of stream) hash.update(bytes) } finally { stream.destroy() }
    if (hash.digest('hex') !== expected || await this.stageSize(id) !== offset + size) throw new HttpError(422, 'Remote chunk integrity verification failed', 'CHECKSUM_MISMATCH')
    stage.receipts.push({ start: offset, end: offset + size, hash: expected }); await this.chunks.save(id, stage)
  }
  discardChunk(id: string) { return this.chunks.discard(id) }
  async isPublished(destination: string, token: string, size: number) {
    const identity = JSON.parse(token) as Stage
    let entry: FileEntry
    try { entry = await this.stat(destination) } catch (e) { if (isFsError(e, 'ENOENT')) return false; throw e }
    if (entry.kind !== 'file' || entry.size !== size) return false
    const stage = await this.chunks.load<Stage>(identity.id)
    // A lost rename acknowledgement is rare. Prove full content, never infer
    // ownership from size/mtime, and never delete a possibly unrelated final file.
    try { await this.verifyReceipts(stage, this.native(destination)) }
    catch (error) { if (error instanceof HttpError && error.code === 'DATA_LOSS') return false; throw error }
    return (stage.receipts.at(-1)?.end ?? 0) === size
  }
  async publish(id: string, destination: string, token: string, size: number, authorize: () => void = () => {}) {
    this.writable(); if (await this.isPublished(destination, token, size)) return
    if (await this.stageSize(id) !== size) throw new HttpError(409, 'Remote upload length changed', 'DATA_LOSS')
    const stage = await this.chunks.load<Stage>(id)
    if (this.type === 'ftp') await this.verifyReceipts(stage, stage.pending)
    authorize()
    await this.rawMove(stage.pending, this.native(destination), authorize)
  }
  async removeStage(id: string, _destination?: string, _token?: string, removePending = true) {
    let stage: Stage
    try { stage = await this.chunks.load<Stage>(id) } catch (error) { if (isFsError(error, 'ENOENT')) { await this.chunks.remove(id); return } throw error }
    if (removePending) { try { await this.rawRemove(stage.pending) } catch (e) { if (!isFsError(e, 'ENOENT')) throw e } }
    try { await this.rawRemove(this.privateDirectory(id, stage.destination), true) } catch (e) { if (!isFsError(e, 'ENOENT')) throw e }
    this.restored.delete(id); await this.chunks.remove(id)
  }
  async orphanStages(validIds: Set<string>) { for (const id of await this.chunks.ids()) if (!validIds.has(id)) await this.removeStage(id) }
  close() { this.closed = true; this.idle = []; this.restored.clear(); for (const client of this.connections) { if (client instanceof SSH) client.end(); else client.close() } this.connections.clear() }
}
