import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ARCHIVE_FORMATS, type ArchiveFormat, type ArchiveJob, type FileEntry, type TargetAccess, type User } from '@/shared/types'
import { archiveFormat } from '@/shared/archive-rules'
import { packArchive, unpackArchive, meter, type ArchiveMember, type ArchiveWork, type PackMember } from './archive-codecs'
import { HttpError, isFsError } from './errors'
import { Store } from './store'
import { Targets } from './targets'
import { normalizePath, requirePermission, scopedPath, uploadingPath, validName } from './storage/paths'

interface JobRow { id: string; user_id: string; target_id: string; scope: string; data: string }
interface Running { job: ArchiveJob; access: TargetAccess; abort: AbortController; done: Promise<void>; paths: string[] }
const overlaps = (a: string, b: string) => a === b || a === '/' || b === '/' || a.startsWith(b + '/') || b.startsWith(a + '/')
const positive = (value: string | undefined, fallback: number) => {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Archive limits must be positive integer values')
  return result
}

/** Dedicated stored archives. The streamed download service is independent. */
export class ArchiveJobs {
  private running = new Map<string, Running>()
  private directory: string
  private closed = false
  readonly maxBytes: number
  readonly maxEntries: number
  constructor(private store: Store, private targets: Targets, private protectDestination: (target: string, path: string) => void,
    limits: { maxBytes?: number; maxEntries?: number } = {}) {
    this.directory = join(targets.stateDirectory, 'archive-work')
    this.maxBytes = limits.maxBytes ?? positive(process.env.FB_ARCHIVE_MAX_BYTES, 10 * 1024 ** 3)
    this.maxEntries = limits.maxEntries ?? positive(process.env.FB_ARCHIVE_MAX_ENTRIES, 100_000)
  }
  async init() {
    for (const row of this.store.db.prepare('SELECT * FROM archive_jobs').all() as unknown as JobRow[]) {
      const job = JSON.parse(row.data) as ArchiveJob
      if (job.status === 'running') {
        job.status = 'failed'; job.error = 'Server restarted. Start this operation again. If saving had started, the destination may contain completed files.'
        job.updatedAt = new Date().toISOString(); this.save(job)
      }
    }
    await rm(this.directory, { recursive: true, force: true })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }
  list(user: User): ArchiveJob[] {
    const rows = this.store.db.prepare('SELECT * FROM archive_jobs WHERE user_id=? ORDER BY rowid DESC LIMIT 200').all(user.id) as unknown as JobRow[]
    return rows.filter(row => { try { return this.targets.access(user, row.target_id).scope === row.scope } catch { return false } })
      .map(row => this.running.get(row.id)?.job ?? JSON.parse(row.data) as ArchiveJob)
  }
  blockMutation(targetId: string, path: string) {
    for (const active of this.running.values()) if (active.job.targetId === targetId && active.paths.some(reserved => overlaps(reserved, path))) {
      throw new HttpError(409, 'This path is in use by a Compress or Decompress operation. Wait or cancel it first.', 'ARCHIVE_BUSY')
    }
  }
  private save(job: ArchiveJob) { this.store.db.prepare('UPDATE archive_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id) }
  async start(user: User, targetId: string, input: { operation: 'compress' | 'decompress'; paths: string[]; directory: string; name: string; format?: ArchiveFormat }): Promise<ArchiveJob> {
    if (this.closed) throw new HttpError(503, 'Server is stopping')
    const access = this.targets.access(user, targetId, 'download'); requirePermission(access, 'upload')
    if (input.operation === 'decompress') requirePermission(access, 'create')
    if (!input.paths.length || input.paths.length > 1000 || Buffer.byteLength(JSON.stringify(input.paths)) > 64 * 1024) throw new HttpError(400, 'Select between 1 and 1000 items (up to 64 KiB of paths)')
    if (input.operation === 'decompress' && input.paths.length !== 1) throw new HttpError(400, 'Choose one archive to decompress')
    const paths = [...new Set(input.paths.map(normalizePath))]
    const format = input.operation === 'compress' ? input.format : archiveFormat(paths[0])
    if (!format || !ARCHIVE_FORMATS.includes(format)) throw new HttpError(400, 'Choose a TAR, TAR.GZ, ZIP or 7z archive format')
    const name = validName(input.name)
    if (input.operation === 'compress' && !name.toLowerCase().endsWith('.' + format)) throw new HttpError(400, 'Archive name must end with .' + format)
    const destination = normalizePath(posix.join(normalizePath(input.directory), name)), storedDestination = scopedPath(access, destination)
    if (destination.length + access.scope.length > 4096) throw new HttpError(400, 'Destination path is too long')
    const storedPaths = paths.map(path => scopedPath(access, path))
    const reservedPaths = [...storedPaths, storedDestination, ...(input.operation === 'compress' ? [uploadingPath(storedDestination)] : [])]
    // Reserve synchronously, before any adapter awaits, so competing POSTs cannot
    // race each other or a rename/delete/upload of their sources or destination.
    if (this.running.size >= 2 || [...this.running.values()].some(active => active.access.id === user.id)) throw new HttpError(429, 'Another archive operation is running. Wait or cancel it first.')
    for (const path of reservedPaths) {
      this.blockMutation(targetId, path)
      if (this.store.retainedUploads().some(upload => upload.target_id === targetId && [upload.path, uploadingPath(upload.path)].some(pending => overlaps(path, pending)))) {
        throw new HttpError(409, 'Selected paths contain an unfinished upload. Finish or cancel it first.', 'DESTINATION_BUSY')
      }
    }
    this.protectDestination(targetId, storedDestination)
    const now = new Date().toISOString()
    const job: ArchiveJob = { id: randomUUID(), targetId, operation: input.operation, format, paths, destination, status: 'running', phase: 'scanning',
      processedBytes: 0, totalBytes: null, processedFiles: 0, totalFiles: null, currentFile: '', progress: null, error: null, createdAt: now, updatedAt: now }
    const active: Running = { job, access, abort: new AbortController(), paths: reservedPaths, done: Promise.resolve() }
    this.running.set(job.id, active)
    try {
      const storage = await this.targets.backend(targetId)
      this.authorize(active)
      if ((await storage.stat(scopedPath(access, input.directory))).kind !== 'directory') throw new HttpError(400, 'Choose a destination directory')
      try { await storage.stat(storedDestination); throw new HttpError(409, 'The destination already exists. Choose a new name.', 'DESTINATION_EXISTS') }
      catch (error) { if (!isFsError(error, 'ENOENT') && !(error instanceof HttpError && error.statusCode === 404)) throw error }
      if (input.operation === 'compress') {
        const pending = uploadingPath(storedDestination)
        this.protectDestination(targetId, pending)
        try { await storage.stat(pending); throw new HttpError(409, 'The staging name already exists. Choose a new archive name.', 'DESTINATION_EXISTS') }
        catch (error) { if (!isFsError(error, 'ENOENT') && !(error instanceof HttpError && error.statusCode === 404)) throw error }
      }
      for (const path of storedPaths) {
        const entry = await storage.stat(path)
        if (input.operation === 'decompress' && entry.kind !== 'file') throw new HttpError(400, 'Choose an archive file')
      }
      this.authorize(active)
      this.store.db.prepare('INSERT INTO archive_jobs(id,user_id,target_id,scope,data) VALUES(?,?,?,?,?)').run(job.id, user.id, targetId, access.scope, JSON.stringify(job))
      active.done = this.run(active)
      return { ...job }
    } catch (error) { this.running.delete(job.id); throw error }
  }
  private authorize(active: Running) {
    active.abort.signal.throwIfAborted()
    const current = this.targets.access(active.access, active.job.targetId, 'download'); requirePermission(current, 'upload')
    if (active.job.operation === 'decompress') requirePermission(current, 'create')
    if (current.scope !== active.access.scope) throw new HttpError(403, 'Your target scope changed')
  }
  private async run(active: Running) {
    const { job, access, abort } = active, directory = join(this.directory, job.id)
    let lastSaved = 0, bytesRead = 0, status: ArchiveJob['status'] = 'completed'
    const update = (force = false) => {
      job.updatedAt = new Date().toISOString()
      if (force || Date.now() - lastSaved > 500) { this.save(job); lastSaved = Date.now() }
    }
    const work: ArchiveWork = {
      signal: abort.signal, maxBytes: this.maxBytes, maxEntries: this.maxEntries, check: () => this.authorize(active),
      tick: (file, bytes, files = 0) => {
        this.authorize(active); bytesRead += bytes
        if (bytesRead > this.maxBytes) throw new HttpError(413, 'Archive exceeds the size limit')
        job.currentFile = file; job.processedBytes += bytes; job.processedFiles += files
        if (job.totalBytes !== null) {
          const fraction = job.totalBytes ? job.processedBytes / job.totalBytes : 0
          const start = job.phase === 'saving' ? 0.8 : job.phase === 'scanning' ? 0 : 0.1
          const length = job.phase === 'saving' ? 0.199 : job.phase === 'scanning' ? 0.1 : job.format === '7z' && job.operation === 'compress' ? 0.35 : 0.7
          job.progress = Math.max(job.progress ?? 0, Math.min(0.999, start + fraction * length))
        }
        update()
      },
      total: (bytes, files) => { job.totalBytes = bytes; job.totalFiles = files; update(true) },
      nativeProgress: percent => { if (job.operation === 'compress') { job.progress = Math.max(job.progress ?? 0, 0.45 + percent / 100 * 0.35); update() } },
    }
    const phase = (value: ArchiveJob['phase'], bytes: number | null, files: number | null) => {
      work.check(); job.phase = value; job.processedBytes = 0; job.totalBytes = bytes; job.processedFiles = 0; job.totalFiles = files
      job.progress = bytes === null ? null : value === 'saving' ? 0.8 : value === 'scanning' ? 0 : 0.1
      bytesRead = 0; update(true)
    }
    const guard = setInterval(() => { try { work.check() } catch (error) { abort.abort(error) } }, 500).unref()
    const timeout = setTimeout(() => abort.abort(new Error('Archive operation exceeded the one-hour time limit')), 60 * 60 * 1000).unref()
    try {
      await mkdir(directory, { mode: 0o700 })
      const storage = await this.targets.backend(job.targetId), destination = scopedPath(access, job.destination)
      if (job.operation === 'compress') {
        const entries = await this.scan(active)
        phase('compressing', entries.reduce((total, entry) => total + entry.size, 0), entries.filter(entry => entry.kind === 'file').length)
        const archive = join(directory, 'archive.' + job.format)
        await packArchive(job.format, entries, archive, directory, work)
        const size = (await stat(archive)).size
        phase('saving', size, 1)
        await this.publish(active, archive, destination, size, work)
      } else {
        const source = scopedPath(access, job.paths[0]), entry = await storage.stat(source)
        if (entry.size > this.maxBytes) throw new HttpError(413, 'Archive exceeds the size limit')
        phase('scanning', entry.size, 1)
        const archive = join(directory, 'source.' + job.format)
        await pipeline(await storage.open(source), meter(work, entry.name, entry.size), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: abort.signal })
        phase('decompressing', null, null)
        const output = join(directory, 'output'), members = await unpackArchive(job.format, archive, output, work)
        for (const member of members) {
          if (normalizePath(posix.join(destination, member.name)).length > 4096) throw new HttpError(400, 'Extracted destination path is too long')
        }
        phase('saving', members.reduce((bytes, member) => bytes + member.size, 0), members.filter(member => member.kind === 'file').length)
        // A fresh directory prevents archives from overwriting existing contents.
        await storage.mkdir(destination, work.check)
        await this.publishMembers(active, output, destination, members, work)
      }
      this.store.audit(access.username, 'archive.' + job.operation, job.destination, job.targetId)
    } catch (error) {
      status = abort.signal.aborted && abort.signal.reason === 'canceled' ? 'canceled' : 'failed'
      const reason = abort.signal.aborted ? abort.signal.reason : error
      job.error = status === 'canceled' ? null : this.errorMessage(reason)
      if (job.phase === 'saving') job.error = (job.error ? job.error + ' ' : '') + 'The destination may contain completed files; partial staging data was removed.'
    } finally {
      clearInterval(guard); clearTimeout(timeout)
      await rm(directory, { recursive: true, force: true }).catch(error => {
        status = 'failed'; job.error = this.errorMessage(error) + ' Temporary archive data could not be removed.'
      })
      job.status = status
      if (status === 'completed') { job.phase = 'finished'; job.progress = 1; job.currentFile = '' }
      update(true); this.running.delete(job.id)
    }
  }
  private errorMessage(error: unknown) {
    if (isFsError(error, 'ENOSPC') || isFsError(error, 'EDQUOT')) return 'Storage is full. Free space on the state or target volume and start again.'
    if (isFsError(error, 'ENOENT')) return 'A source file or destination directory is no longer available.'
    if (isFsError(error, 'EEXIST')) return 'A destination name already exists. Choose a new name.'
    if (isFsError(error, 'EACCES') || isFsError(error, 'EPERM') || isFsError(error, 'EROFS')) return 'Storage denied access to a source or destination.'
    if (isFsError(error, 'ENAMETOOLONG')) return 'An archive member path is too long to save.'
    return error instanceof Error ? error.message : 'Archive operation failed'
  }
  private async scan(active: Running): Promise<PackMember[]> {
    const storage = await this.targets.backend(active.job.targetId), selections: { path: string; entry: FileEntry }[] = []
    for (const path of active.job.paths) selections.push({ path, entry: await storage.stat(scopedPath(active.access, path)) })
    const roots = selections.filter(selection => !selections.some(parent => parent !== selection && parent.entry.kind === 'directory' && overlaps(parent.path, selection.path) && parent.path.length < selection.path.length))
    let base = posix.dirname(roots[0].path)
    while (roots.some(root => root.path !== base && !root.path.startsWith(base === '/' ? '/' : base + '/'))) base = posix.dirname(base)
    const storedBase = scopedPath(active.access, base), result: PackMember[] = []
    let bytes = 0
    const append = (entry: typeof selections[number]['entry']) => {
      this.authorize(active)
      const name = posix.relative(storedBase, entry.path)
      if (!name) return
      bytes += entry.kind === 'file' ? entry.size : 0
      if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes || result.length >= this.maxEntries) throw new HttpError(413, 'Selection exceeds the size or entry limit')
      active.job.currentFile = name
      result.push({ name, kind: entry.kind, size: entry.kind === 'file' ? entry.size : 0, modifiedAt: entry.modifiedAt, open: async () => { this.authorize(active); return storage.open(entry.path) } })
    }
    for (const root of roots) {
      append(root.entry)
      if (root.entry.kind === 'directory') for await (const entry of storage.walk(root.entry.path)) append(entry)
    }
    return result
  }
  private async publishMembers(active: Running, output: string, destination: string, members: ArchiveMember[], work: ArchiveWork) {
    const storage = await this.targets.backend(active.job.targetId)
    const directories = members.filter(member => member.kind === 'directory').sort((a, b) => a.name.split('/').length - b.name.split('/').length)
    for (const member of directories) { work.check(); await storage.mkdir(posix.join(destination, member.name), work.check) }
    for (const member of members.filter(member => member.kind === 'file')) await this.publish(active, join(output, member.name), posix.join(destination, member.name), member.size, work)
  }
  private async publish(active: Running, source: string, destination: string, size: number, work: ArchiveWork) {
    const storage = await this.targets.backend(active.job.targetId), id = randomUUID()
    const label = active.job.operation === 'compress' ? posix.basename(destination) : posix.relative(scopedPath(active.access, active.job.destination), destination)
    let token: string | undefined
    work.check()
    try {
      token = await storage.createStage(id, destination)
      let offset = 0
      const chunkSize = Math.max(8 * 1024 * 1024, storage.capabilities.minChunkSize, Math.ceil(size / storage.capabilities.maxChunks))
      while (offset < size) {
        work.check()
        const count = Math.min(chunkSize, size - offset), hash = createHash('sha256')
        for await (const bytes of createReadStream(source, { start: offset, end: offset + count - 1 })) { work.check(); hash.update(bytes) }
        await storage.prepareChunk(id, count)
        const stream = createReadStream(source, { start: offset, end: offset + count - 1 })
        const cancel = () => stream.destroy(new Error('Archive operation stopped'))
        work.signal.addEventListener('abort', cancel, { once: true })
        try {
          await storage.writePart(id, 0, count, stream, () => { work.check(); return true })
          work.check(); await storage.verifyChunk(id, hash.digest('hex'), count)
          work.check(); await storage.appendChunk(id, offset, count)
          await storage.discardChunk(id)
        } finally { work.signal.removeEventListener('abort', cancel); stream.destroy() }
        offset += count; work.tick(label, count)
      }
      work.check(); await storage.publish(id, destination, token, size, work.check)
      work.tick(label, 0, 1)
    } finally { await storage.removeStage(id, destination, token).catch(error => { if (!isFsError(error, 'ENOENT')) throw error }) }
  }
  async cancel(user: User, id: string) {
    const row = this.store.db.prepare('SELECT * FROM archive_jobs WHERE id=? AND user_id=?').get(id, user.id) as unknown as JobRow | undefined
    if (!row) throw new HttpError(404, 'Archive operation not found')
    const active = this.running.get(id)
    if (active) { active.abort.abort('canceled'); await active.done }
    return this.running.get(id)?.job ?? JSON.parse((this.store.db.prepare('SELECT data FROM archive_jobs WHERE id=?').get(id) as { data: string }).data) as ArchiveJob
  }
  async stopTarget(targetId: string) {
    const jobs = [...this.running.values()].filter(active => active.job.targetId === targetId)
    for (const active of jobs) active.abort.abort('canceled')
    await Promise.all(jobs.map(active => active.done))
  }
  async close() {
    this.closed = true
    for (const active of this.running.values()) active.abort.abort(new Error('Server stopped. Start this operation again.'))
    await Promise.all([...this.running.values()].map(active => active.done))
  }
}
