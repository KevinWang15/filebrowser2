import { randomUUID, createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import { type ChunkAttempt, type UploadManifest, type UploadSession, type User } from '@/shared/types'
import { Store, publicUpload, type UploadRow } from './store'
import type { SequentialUploadBackend, StorageBackend } from './storage/interface'
import { canAccessStoredPath, requirePermission, scopedPath, validName, uploadingPath } from './storage/paths'
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
  constructor(private store: Store, private storage: StorageBackend & SequentialUploadBackend, private faults: UploadFaults = {}) {
    this.timer = setInterval(() => {
      for (const [id, attempt] of this.attempts) {
        if (!this.locks.has(id) && attempt.expiresAt < Date.now() && attempt.active.size === 0) {
          void this.locked(id, async () => {
            if (attempt.active.size || this.attempts.get(id) !== attempt) return
            attempt.failed = true
            await this.storage.discardChunk(id)
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
      requirePermission(user, 'upload')
      if (!canAccessStoredPath(user, row.path)) throw new HttpError(403, 'This transfer is outside your current scope', 'FORBIDDEN')
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
  async recover() {
    for (const row of this.store.retainedUploads().filter(row => row.status === 'canceling')) {
      try {
        await this.storage.removeStage(row.id, row.path, row.inode)
        this.store.db.prepare("UPDATE uploads SET status='canceled',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id)
      } catch (error) {
        this.store.db.prepare('UPDATE uploads SET error=? WHERE id=?').run(error instanceof Error ? error.message : 'Cancellation cleanup failed', row.id)
      }
    }
    const active = this.store.activeUploads()
    for (const row of active) {
      try {
        const manifest = this.manifest(row)
        if (row.status === 'publishing' && await this.storage.isPublished(row.path, row.inode, manifest.size)) {
          // Re-sync the directory before recording completion after an interrupted publish.
          await this.storage.publish(row.id, row.path, row.inode, manifest.size)
          this.store.db.prepare("UPDATE uploads SET status='completed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id)
          await this.storage.removeStage(row.id, undefined, undefined, false)
        } else {
          await this.storage.restoreStage(row.id, row.path, row.inode)
          await this.storage.resetTo(row.id, row.committed_bytes)
          await this.storage.discardChunk(row.id)
          if (row.status === 'publishing') this.store.db.prepare("UPDATE uploads SET status='uploading' WHERE id=?").run(row.id)
        }
      } catch (error) {
        this.store.db.prepare("UPDATE uploads SET status='failed',error=?,updated_at=? WHERE id=?").run(error instanceof Error ? error.message : 'Recovery failed', new Date().toISOString(), row.id)
      }
    }
    await this.storage.orphanStages(new Set(this.store.retainedUploads().map(r => r.id)), this.store.uploadIds())
  }
  async initialize(user: User, manifest: UploadManifest): Promise<UploadSession> {
    requirePermission(user, 'upload')
    const path = posix.join(scopedPath(user, manifest.directory), validName(manifest.name))
    const manifestHash = createHash('sha256').update(JSON.stringify({ version: 1, size: manifest.size, chunkSize: manifest.chunkSize, hashes: manifest.hashes })).digest('hex')
    return this.locked(`target:${path}`, async () => {
      const existing = this.store.db.prepare("SELECT * FROM uploads WHERE path=? AND status IN ('uploading','publishing')").get(path) as unknown as UploadRow | undefined
      if (existing) {
        if (existing.user_id === user.id && existing.manifest_hash === manifestHash) return this.view(existing)
        throw new HttpError(409, 'Another transfer already owns this destination', 'DESTINATION_BUSY')
      }
      const names = [path, uploadingPath(path)]
      if (this.store.retainedUploads().some(row => [row.path, uploadingPath(row.path)].some(name => names.includes(name)))) {
        throw new HttpError(409, 'This filename is reserved by an unfinished transfer. Finish or cancel it first.', 'DESTINATION_BUSY')
      }
      const parent = await this.storage.stat(posix.dirname(path))
      if (parent.kind !== 'directory') throw new HttpError(400, 'Upload destination must be a directory')
      for (const name of names) {
        try { await this.storage.stat(name); throw new HttpError(409, 'A file with this name already exists', 'DESTINATION_EXISTS') }
        catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
      }
      if (this.store.retainedUploads().length >= 64) throw new HttpError(429, 'Too many unfinished transfers. Cancel unused transfers first.')
      const space = await this.storage.space()
      if (space.available < Math.min(manifest.size, manifest.chunkSize) * 2 + 16 * 1024 * 1024) throw new HttpError(507, 'Not enough disk space to start this transfer', 'DISK_FULL')
      const id = randomUUID()
      const inode = await this.storage.createStage(id, path)
      const now = new Date().toISOString()
      let persisted = false
      try {
        this.store.db.prepare(`INSERT INTO uploads(id,user_id,path,manifest,manifest_hash,status,inode,created_at,updated_at)
          VALUES(?,?,?,?,?,'uploading',?,?,?)`).run(id, user.id, path, JSON.stringify(manifest), manifestHash, inode, now, now)
        persisted = true
        await this.storage.restoreStage(id, path, inode)
        this.store.audit(user.username, 'upload.started', path)
      } catch (error) {
        if (!persisted) await this.storage.removeStage(id, path, inode)
        else this.store.db.prepare("UPDATE uploads SET status='failed',error=? WHERE id=?").run(error instanceof Error ? error.message : 'Initialization failed', id)
        throw error
      }
      return this.view(this.owned(id, user, false))
    })
  }
  list(user: User) { return this.store.userUploads(user.id).map(row => this.view(row)) }
  get(user: User, id: string) { return this.view(this.owned(id, user, false)) }
  async begin(user: User, id: string, index: number, connections: number): Promise<ChunkAttempt | { committed: true; session: UploadSession }> {
    return this.locked(id, async () => {
      const row = this.owned(id, user)
      if (index < row.next_chunk) return { committed: true, session: this.view(row) }
      this.editable(row)
      const manifest = this.manifest(row)
      if (index !== row.next_chunk || index >= manifest.hashes.length) throw new HttpError(409, 'Chunks must be uploaded in order', 'OUT_OF_ORDER')
      const previous = this.attempts.get(id)
      if (previous?.active.size) { this.failAttempt(previous); throw new HttpError(409, 'Waiting for previous chunk connections to close', 'UPLOAD_BUSY') }
      if (previous) previous.failed = true
      await this.storage.resetTo(id, row.committed_bytes)
      const size = Math.min(manifest.chunkSize, manifest.size - row.committed_bytes)
      if ((await this.storage.space()).available < size * 2 + 8 * 1024 * 1024) throw new HttpError(507, 'Disk is full. Free space and resume.', 'DISK_FULL')
      await this.storage.prepareChunk(id, size)
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
  async receive(user: User, id: string, attemptId: string, partIndex: number, stream: Readable, length?: number) {
    const row = this.owned(id, user)
    this.editable(row)
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.id !== attemptId || attempt.failed || this.locks.has(id) || attempt.index !== row.next_chunk) throw new HttpError(409, 'This chunk attempt expired. Retry the whole chunk.', 'ATTEMPT_EXPIRED')
    const part = attempt.parts.find(p => p.index === partIndex)
    if (!part) throw new HttpError(400, 'Invalid part number')
    if (attempt.active.has(partIndex) || attempt.completed.has(partIndex)) throw new HttpError(409, 'This part was already submitted', 'PART_BUSY')
    if (length !== undefined && length !== part.size) {
      this.failAttempt(attempt)
      if (attempt.active.size === 0) await this.storage.discardChunk(id)
      throw new HttpError(400, 'Part length does not match', 'LENGTH_MISMATCH')
    }
    attempt.active.add(partIndex)
    attempt.streams.set(partIndex, stream)
    attempt.expiresAt = Date.now() + 60 * 60 * 1000
    try {
      await this.storage.writePart(id, part.offset, part.size, stream, () => !attempt.failed && this.attempts.get(id) === attempt)
      if (attempt.failed) throw new HttpError(409, 'This chunk attempt was discarded', 'ATTEMPT_EXPIRED')
      attempt.completed.add(partIndex)
    } catch (error) { this.failAttempt(attempt); throw error }
    finally {
      try {
        if (attempt.failed && attempt.active.size === 1) await this.storage.discardChunk(id)
      } finally { attempt.streams.delete(partIndex); attempt.active.delete(partIndex) }
    }
  }
  async commit(user: User, id: string, index: number, attemptId: string): Promise<UploadSession> {
    return this.locked(id, async () => {
      const row = this.owned(id, user)
      if (index < row.next_chunk) return this.view(row)
      this.editable(row)
      const attempt = this.attempts.get(id)
      if (!attempt || attempt.id !== attemptId || attempt.index !== index || attempt.failed) throw new HttpError(409, 'This chunk attempt was discarded', 'ATTEMPT_EXPIRED')
      if (attempt.active.size || attempt.completed.size !== attempt.parts.length) throw new HttpError(409, 'All parts must complete before this chunk can be committed', 'INCOMPLETE_CHUNK')
      const manifest = this.manifest(row)
      const size = Math.min(manifest.chunkSize, manifest.size - row.committed_bytes)
      try {
        await this.storage.verifyChunk(id, manifest.hashes[index], size)
        await this.storage.appendChunk(id, row.committed_bytes, size)
        this.faults.afterAppend?.()
        this.store.db.prepare('UPDATE uploads SET next_chunk=?,committed_bytes=?,error=NULL,updated_at=? WHERE id=?')
          .run(index + 1, row.committed_bytes + size, new Date().toISOString(), id)
      } catch (error) {
        this.failAttempt(attempt)
        await this.storage.resetTo(id, row.committed_bytes)
        throw error
      } finally {
        this.attempts.delete(id)
        await this.storage.discardChunk(id)
      }
      return this.view(this.owned(id, user, false))
    })
  }
  async finalize(user: User, id: string) {
    return this.locked(id, async () => {
      const row = this.owned(id, user)
      if (row.status === 'completed') return this.view(row)
      if (row.status !== 'publishing') this.editable(row)
      const manifest = this.manifest(row)
      if (row.next_chunk !== manifest.hashes.length || row.committed_bytes !== manifest.size) throw new HttpError(409, 'The file is not fully uploaded', 'INCOMPLETE_UPLOAD')
      await this.storage.resetTo(id, row.committed_bytes)
      this.store.db.prepare("UPDATE uploads SET status='publishing',updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      await this.storage.publish(id, row.path, row.inode, manifest.size)
      this.faults.afterPublish?.()
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE uploads SET status='completed',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id)
        this.store.audit(user.username, 'upload.completed', row.path)
      })
      await this.storage.removeStage(id, undefined, undefined, false)
      return this.view(this.owned(id, user, false))
    })
  }
  async cancel(user: User, id: string) {
    return this.locked(id, async () => {
      const row = this.owned(id, user, false)
      if (row.status === 'completed') throw new HttpError(409, 'A completed transfer cannot be canceled')
      if (row.status === 'canceled') return this.view(row)
      const attempt = this.attempts.get(id)
      if (attempt) {
        this.failAttempt(attempt)
        if (attempt.active.size) throw new HttpError(409, 'Waiting for active connections to close. Retry shortly.', 'UPLOAD_BUSY')
        this.attempts.delete(id)
      }
      if (row.status === 'publishing' && await this.storage.isPublished(row.path, row.inode, this.manifest(row).size)) {
        throw new HttpError(409, 'The file has already been published; finish the transfer first')
      }
      this.store.db.prepare("UPDATE uploads SET status='canceling',updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      await this.storage.removeStage(id, row.path, row.inode)
      this.faults.afterCancelCleanup?.()
      this.store.db.prepare("UPDATE uploads SET status='canceled',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id)
      this.store.audit(user.username, 'upload.canceled', row.path)
      return this.view(this.owned(id, user, false))
    })
  }
}
