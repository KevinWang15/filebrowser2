import { randomUUID, createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import { type ChunkAttempt, type UploadManifest, type UploadSession, type User } from '@/shared/types'
import { Store, publicUpload, type UploadRow } from './store'
import { Targets } from './targets'
import { canAccessStoredPath, scopedPath, validName, uploadingPath } from './storage/paths'
import { HttpError, isFsError } from './errors'

interface Attempt extends ChunkAttempt {
  completed: Set<number>
  active: Set<number>
  streams: Map<number, Readable>
  failed: boolean
  expiresAt: number
}
export interface UploadFaults {
  afterAppend?: () => void
  afterPublish?: () => void
  afterPublishLink?: () => void
  afterCancelCleanup?: () => void
}

export class Uploads {
  private attempts = new Map<string, Attempt>()
  private locks = new Set<string>()
  private manifests = new Map<string, { raw: string; parsed: UploadManifest }>()
  private timer: ReturnType<typeof setInterval>
  constructor(private store: Store, private targets: Targets, private faults: UploadFaults = {}) {
    this.timer = setInterval(() => {
      for (const [id, attempt] of this.attempts) {
        if (!this.locks.has(id) && attempt.expiresAt < Date.now() && attempt.active.size === 0) {
          void this.locked(id, async () => {
            if (attempt.active.size || this.attempts.get(id) !== attempt) return
            attempt.failed = true
            await (await this.targets.backend(this.store.uploadMetadata(id)!.target_id)).discardChunk(id)
            this.attempts.delete(id)
          }).catch(() => {})
        }
      }
    }, 60_000).unref()
  }
  close() { clearInterval(this.timer); for (const attempt of this.attempts.values()) this.failAttempt(attempt) }
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(id)) throw new HttpError(409, 'Transfer is busy. Retry shortly.', 'UPLOAD_BUSY')
    this.locks.add(id)
    try { return await fn() } finally { this.locks.delete(id) }
  }
  private owned(id: string, user: User, write = true): UploadRow {
    const row = this.store.uploadMetadata(id)
    if (!row || row.user_id !== user.id) throw new HttpError(404, 'Transfer not found')
    if (write) {
      const access = this.targets.access(user, row.target_id, 'upload')
      if (!canAccessStoredPath(access, row.path)) throw new HttpError(403, 'This transfer is outside your current scope', 'FORBIDDEN')
    }
    this.manifest(row)
    return row
  }
  private manifest(row: UploadRow): UploadManifest {
    let entry = this.manifests.get(row.id)
    if (!entry) {
      const raw = row.manifest || this.store.upload(row.id)!.manifest
      entry = { raw, parsed: JSON.parse(raw) as UploadManifest }
      if (this.manifests.size >= 8) this.manifests.delete(this.manifests.keys().next().value!)
    }
    // Manifests are immutable. Keep a bounded LRU while status always comes from SQLite.
    this.manifests.delete(row.id); this.manifests.set(row.id, entry)
    row.manifest = entry.raw
    return entry.parsed
  }
  private view(row: UploadRow) { return publicUpload(row, this.manifest(row)) }
  private failAttempt(attempt: Attempt) {
    attempt.failed = true
    // Do not wait an hour for a stalled sibling connection before a whole-chunk retry.
    for (const stream of attempt.streams.values()) stream.destroy()
  }
  private editable(row: UploadRow) {
    if (row.status !== 'uploading') throw new HttpError(409, row.error ?? `Transfer is ${row.status}`, 'UPLOAD_STATE')
  }
  revoke(userId: string) { for (const [id, attempt] of this.attempts) if (this.store.uploadMetadata(id)?.user_id === userId) this.failAttempt(attempt) }
  async recover() {
    for (const row of this.store.retainedUploads().filter(row => row.status === 'canceling' && this.targets.row(row.target_id).type === 'local' && this.targets.row(row.target_id).enabled && !this.targets.row(row.target_id).read_only)) {
      try {
        const storage = await this.targets.backend(row.target_id)
        await storage.removeStage(row.id, row.path, row.storage_token)
        this.store.db.prepare("UPDATE uploads SET status='canceled',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id)
      } catch (error) {
        this.store.db.prepare('UPDATE uploads SET error=? WHERE id=?').run(error instanceof Error ? error.message : 'Cancellation cleanup failed', row.id)
      }
    }
    const active = this.store.activeUploads().filter(row => this.targets.row(row.target_id).type === 'local' && this.targets.row(row.target_id).enabled && !this.targets.row(row.target_id).read_only)
    for (const row of active) {
      try {
        const storage = await this.targets.backend(row.target_id)
        const manifest = this.manifest(row)
        if (row.status === 'publishing' && await storage.isPublished(row.path, row.storage_token, manifest.size)) {
          // Re-sync the directory before recording completion after an interrupted publish.
          await storage.publish(row.id, row.path, row.storage_token, manifest.size)
          this.store.db.prepare("UPDATE uploads SET status='completed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id)
          await storage.removeStage(row.id, undefined, undefined, false)
        } else {
          await storage.restoreStage(row.id, row.path, row.storage_token)
          await storage.resetTo(row.id, row.committed_bytes)
          await storage.discardChunk(row.id)
          if (row.status === 'publishing') this.store.db.prepare("UPDATE uploads SET status='uploading' WHERE id=?").run(row.id)
        }
      } catch (error) {
        this.store.db.prepare("UPDATE uploads SET status='failed',error=?,updated_at=? WHERE id=?").run(error instanceof Error ? error.message : 'Recovery failed', new Date().toISOString(), row.id)
      }
    }
    for (const target of this.store.targets().filter(t => t.type === 'local' && t.enabled && !t.read_only)) {
      await (await this.targets.backend(target.id)).orphanStages(new Set(this.store.retainedUploads().filter(row => row.target_id === target.id).map(r => r.id)), this.store.uploadIds())
    }
  }
  async initialize(user: User, manifest: UploadManifest, session: () => void = () => {}): Promise<UploadSession> {
    const access = this.targets.access(user, manifest.targetId, 'upload'), storage = await this.targets.backend(manifest.targetId)
    const authorize = () => {
      session()
      if (this.targets.access(user, manifest.targetId, 'upload').scope !== access.scope) throw new HttpError(403, 'Your target scope changed', 'FORBIDDEN')
    }
    authorize()
    if (manifest.chunkSize < storage.capabilities.minChunkSize && manifest.hashes.length > 1 || manifest.hashes.length > storage.capabilities.maxChunks) throw new HttpError(400, 'The manifest exceeds this target’s multipart limits')
    const path = posix.join(scopedPath(access, manifest.directory), validName(manifest.name))
    const manifestHash = createHash('sha256').update(JSON.stringify({ version: 1, size: manifest.size, chunkSize: manifest.chunkSize, hashes: manifest.hashes })).digest('hex')
    return this.locked(`target:${manifest.targetId}:${path}`, async () => {
      const existing = this.store.db.prepare("SELECT * FROM uploads WHERE target_id=? AND path=? AND status IN ('uploading','publishing')").get(manifest.targetId, path) as unknown as UploadRow | undefined
      if (existing) {
        if (existing.user_id === user.id && existing.manifest_hash === manifestHash) return this.view(existing)
        throw new HttpError(409, 'Another transfer already owns this destination', 'DESTINATION_BUSY')
      }
      const names = [path, uploadingPath(path)]
      if (this.store.retainedUploads().some(row => row.target_id === manifest.targetId && [row.path, uploadingPath(row.path)].some(name => names.includes(name)))) {
        throw new HttpError(409, 'This filename is reserved by an unfinished transfer. Finish or cancel it first.', 'DESTINATION_BUSY')
      }
      const parent = await storage.stat(posix.dirname(path))
      if (parent.kind !== 'directory') throw new HttpError(400, 'Upload destination must be a directory')
      for (const name of names) {
        try { await storage.stat(name); throw new HttpError(409, 'A file with this name already exists', 'DESTINATION_EXISTS') }
        catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
      }
      if (this.store.retainedUploads().length >= 64) throw new HttpError(429, 'Too many unfinished transfers. Cancel unused transfers first.')
      const space = await storage.space(posix.dirname(path))
      authorize()
      if (space.available !== null && space.available < Math.min(manifest.size, manifest.chunkSize) * 2 + 16 * 1024 * 1024) throw new HttpError(507, 'Not enough disk space to start this transfer', 'DISK_FULL')
      const id = randomUUID()
      const token = await storage.createStage(id, path)
      const now = new Date().toISOString()
      let persisted = false
      try {
        authorize()
        this.store.db.prepare(`INSERT INTO uploads(id,user_id,target_id,path,manifest,manifest_hash,status,storage_token,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'uploading',?,?,?)`).run(id, user.id, manifest.targetId, path, JSON.stringify(manifest), manifestHash, token, now, now)
        persisted = true
        await storage.restoreStage(id, path, token)
        authorize()
        this.store.audit(user.username, 'upload.started', path, manifest.targetId)
      } catch (error) {
        if (!persisted) await storage.removeStage(id, path, token)
        else this.store.db.prepare("UPDATE uploads SET status='failed',error=? WHERE id=?").run(error instanceof Error ? error.message : 'Initialization failed', id)
        throw error
      }
      return this.view(this.owned(id, user, false))
    })
  }
  list(user: User) { return this.store.userUploads(user.id).map(row => this.view(row)) }
  get(user: User, id: string) { return this.view(this.owned(id, user, false)) }
  async begin(user: User, id: string, index: number, connections: number, authorize: () => void = () => {}): Promise<ChunkAttempt | { committed: true; session: UploadSession }> {
    return this.locked(id, async () => {
      const row = this.owned(id, user), storage = await this.targets.backend(row.target_id)
      authorize(); this.owned(id, user)
      if (index < row.next_chunk) return { committed: true, session: this.view(row) }
      this.editable(row)
      const manifest = this.manifest(row)
      if (index !== row.next_chunk || index >= manifest.hashes.length) throw new HttpError(409, 'Chunks must be uploaded in order', 'OUT_OF_ORDER')
      const previous = this.attempts.get(id)
      if (previous?.active.size) { this.failAttempt(previous); throw new HttpError(409, 'Waiting for previous chunk connections to close', 'UPLOAD_BUSY') }
      if (previous) previous.failed = true
      await storage.restoreStage(id, row.path, row.storage_token)
      await storage.resetTo(id, row.committed_bytes)
      const size = Math.min(manifest.chunkSize, manifest.size - row.committed_bytes)
      const space = await storage.space(posix.dirname(row.path))
      if (space.available !== null && space.available < size * 2 + 8 * 1024 * 1024) throw new HttpError(507, 'Disk is full. Free space and resume.', 'DISK_FULL')
      await storage.prepareChunk(id, size)
      authorize(); this.owned(id, user)
      const parts = Array.from({ length: Math.min(connections, size) }, (_, part) => {
        const count = Math.min(connections, size)
        const offset = Math.floor(size * part / count)
        return { index: part, offset, size: Math.floor(size * (part + 1) / count) - offset }
      })
      const attempt: Attempt = { id: randomUUID(), index, parts, completed: new Set(), active: new Set(), streams: new Map(), failed: false, expiresAt: Date.now() + 60 * 60 * 1000 }
      this.attempts.set(id, attempt)
      return { id: attempt.id, index, parts }
    })
  }
  async receive(user: User, id: string, attemptId: string, partIndex: number, stream: Readable, length?: number, authorize: () => void = () => {}) {
    const row = this.owned(id, user), storage = await this.targets.backend(row.target_id)
    this.editable(row)
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.id !== attemptId || attempt.failed || this.locks.has(id) || attempt.index !== row.next_chunk) throw new HttpError(409, 'This chunk attempt expired. Retry the whole chunk.', 'ATTEMPT_EXPIRED')
    const part = attempt.parts.find(p => p.index === partIndex)
    if (!part) throw new HttpError(400, 'Invalid part number')
    if (attempt.active.has(partIndex) || attempt.completed.has(partIndex)) throw new HttpError(409, 'This part was already submitted', 'PART_BUSY')
    if (length !== undefined && length !== part.size) {
      this.failAttempt(attempt)
      if (attempt.active.size === 0) await storage.discardChunk(id)
      throw new HttpError(400, 'Part length does not match', 'LENGTH_MISMATCH')
    }
    attempt.active.add(partIndex)
    attempt.streams.set(partIndex, stream)
    attempt.expiresAt = Date.now() + 60 * 60 * 1000
    try {
      await storage.writePart(id, part.offset, part.size, stream, () => { try { authorize(); this.owned(id, user); return !attempt.failed && this.attempts.get(id) === attempt } catch { return false } })
      if (attempt.failed) throw new HttpError(409, 'This chunk attempt was discarded', 'ATTEMPT_EXPIRED')
      attempt.completed.add(partIndex)
    } catch (error) { this.failAttempt(attempt); throw error }
    finally {
      try {
        if (attempt.failed && attempt.active.size === 1) await storage.discardChunk(id)
      } finally { attempt.streams.delete(partIndex); attempt.active.delete(partIndex) }
    }
  }
  async commit(user: User, id: string, index: number, attemptId: string, authorize: () => void = () => {}): Promise<UploadSession> {
    return this.locked(id, async () => {
      const row = this.owned(id, user), storage = await this.targets.backend(row.target_id)
      if (index < row.next_chunk) return this.view(row)
      this.editable(row)
      const attempt = this.attempts.get(id)
      if (!attempt || attempt.id !== attemptId || attempt.index !== index || attempt.failed) throw new HttpError(409, 'This chunk attempt was discarded', 'ATTEMPT_EXPIRED')
      if (attempt.active.size || attempt.completed.size !== attempt.parts.length) throw new HttpError(409, 'All parts must complete before this chunk can be committed', 'INCOMPLETE_CHUNK')
      const manifest = this.manifest(row)
      const size = Math.min(manifest.chunkSize, manifest.size - row.committed_bytes)
      try {
        await storage.verifyChunk(id, manifest.hashes[index], size)
        authorize(); this.owned(id, user)
        await storage.appendChunk(id, row.committed_bytes, size)
        authorize(); this.owned(id, user)
        this.faults.afterAppend?.()
        this.store.db.prepare('UPDATE uploads SET next_chunk=?,committed_bytes=?,error=NULL,updated_at=? WHERE id=?')
          .run(index + 1, row.committed_bytes + size, new Date().toISOString(), id)
      } catch (error) {
        this.failAttempt(attempt)
        await storage.resetTo(id, row.committed_bytes)
        throw error
      } finally {
        this.attempts.delete(id)
        await storage.discardChunk(id)
      }
      return this.view(this.owned(id, user, false))
    })
  }
  async finalize(user: User, id: string, authorize: () => void = () => {}) {
    return this.locked(id, async () => {
      const row = this.owned(id, user), storage = await this.targets.backend(row.target_id)
      if (row.status === 'completed') return this.view(row)
      if (row.status !== 'publishing') this.editable(row)
      const manifest = this.manifest(row)
      if (row.next_chunk !== manifest.hashes.length || row.committed_bytes !== manifest.size) throw new HttpError(409, 'The file is not fully uploaded', 'INCOMPLETE_UPLOAD')
      if (row.status !== 'publishing') {
        await storage.restoreStage(id, row.path, row.storage_token)
        await storage.resetTo(id, row.committed_bytes)
      }
      this.store.db.prepare("UPDATE uploads SET status='publishing',updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      await storage.publish(id, row.path, row.storage_token, manifest.size, () => { authorize(); this.owned(id, user) })
      authorize(); this.owned(id, user)
      this.faults.afterPublish?.()
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE uploads SET status='completed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id)
        this.store.audit(user.username, 'upload.completed', row.path, row.target_id)
      })
      await storage.removeStage(id, undefined, undefined, false)
      return this.view(this.owned(id, user, false))
    })
  }
  async cancel(user: User, id: string) {
    return this.locked(id, async () => {
      const row = this.owned(id, user, false), storage = await this.targets.backend(row.target_id)
      if (row.status === 'completed') throw new HttpError(409, 'A completed transfer cannot be canceled')
      if (row.status === 'canceled') return this.view(row)
      const attempt = this.attempts.get(id)
      if (attempt) {
        this.failAttempt(attempt)
        if (attempt.active.size) throw new HttpError(409, 'Waiting for active connections to close. Retry shortly.', 'UPLOAD_BUSY')
        this.attempts.delete(id)
      }
      if (row.status === 'publishing' && await storage.isPublished(row.path, row.storage_token, this.manifest(row).size)) {
        throw new HttpError(409, 'The file has already been published; finish the transfer first')
      }
      this.store.db.prepare("UPDATE uploads SET status='canceling',updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      await storage.removeStage(id, row.path, row.storage_token)
      this.faults.afterCancelCleanup?.()
      this.store.db.prepare("UPDATE uploads SET status='canceled',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      this.store.audit(user.username, 'upload.canceled', row.path, row.target_id)
      return this.view(this.owned(id, user, false))
    })
  }
}
