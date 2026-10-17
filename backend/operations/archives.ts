import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { ARCHIVE_FORMATS, type ArchiveFormat, type FileEntry, type TargetAccess, type User } from '@/shared/types'
import { archiveFormat } from '@/shared/archive-rules'
import { packArchive, unpackArchive, meter, type ArchiveMember, type ArchiveWork, type PackMember } from './archive-codecs'
import { pathsOverlap, type OperationContext, type OperationHandler, type OperationPlan } from './manager'
import { HttpError, isFsError } from '../errors'
import { Store } from '../store'
import { Targets } from '../targets'
import { normalizePath, requirePermission, scopedPath, uploadingPath, validName } from '../storage/paths'

const inputSchema = z.object({ targetId: z.string().uuid(), paths: z.array(z.string()).min(1).max(1000), directory: z.string(), name: z.string(), format: z.enum(ARCHIVE_FORMATS).optional() }).strict()
interface ArchiveTask { targetId: string; operation: 'compress' | 'decompress'; format: ArchiveFormat; paths: string[]; destination: string; access: TargetAccess }
const positive = (value: string | undefined, fallback: number) => {
  const result = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Archive limits must be positive integer values')
  return result
}

/** Archive use cases provide validation and work to the common Operations manager. */
export class ArchiveOperations {
  readonly maxBytes: number
  readonly maxEntries: number
  readonly handlers: Readonly<Record<string, OperationHandler>>
  constructor(private store: Store, private targets: Targets, private protectDestination: (target: string, path: string) => void,
    limits: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? positive(process.env.FB_ARCHIVE_MAX_BYTES, 10 * 1024 ** 3)
    this.maxEntries = limits.maxEntries ?? positive(process.env.FB_ARCHIVE_MAX_ENTRIES, 100_000)
    this.handlers = { 'archive.compress': (user, input) => this.prepare(user, 'compress', input), 'archive.decompress': (user, input) => this.prepare(user, 'decompress', input) }
  }
  private prepare(user: User, operation: ArchiveTask['operation'], raw: unknown): OperationPlan {
    const input = inputSchema.parse(raw), { targetId } = input
    const access = this.targets.access(user, targetId, 'download'); requirePermission(access, 'upload')
    if (operation === 'decompress') requirePermission(access, 'create')
    if (Buffer.byteLength(JSON.stringify(input.paths)) > 64 * 1024) throw new HttpError(400, 'Select up to 64 KiB of paths')
    if (operation === 'decompress' && input.paths.length !== 1) throw new HttpError(400, 'Choose one archive to decompress')
    const paths = [...new Set(input.paths.map(normalizePath))]
    const format = operation === 'compress' ? input.format : archiveFormat(paths[0])
    if (!format || !ARCHIVE_FORMATS.includes(format)) throw new HttpError(400, 'Choose a TAR, TAR.GZ, ZIP or 7z archive format')
    const name = validName(input.name)
    if (operation === 'compress' && !name.toLowerCase().endsWith('.' + format)) throw new HttpError(400, 'Archive name must end with .' + format)
    const destination = normalizePath(posix.join(normalizePath(input.directory), name)), storedDestination = scopedPath(access, destination)
    if (destination.length + access.scope.length > 4096) throw new HttpError(400, 'Destination path is too long')
    const storedPaths = paths.map(path => scopedPath(access, path)), reservedPaths = [...storedPaths, storedDestination, ...(operation === 'compress' ? [uploadingPath(storedDestination)] : [])]
    for (const path of reservedPaths) {
      if (this.store.retainedUploads().some(upload => upload.target_id === targetId && [upload.path, uploadingPath(upload.path)].some(pending => pathsOverlap(path, pending)))) {
        throw new HttpError(409, 'Selected paths contain an unfinished upload. Finish or cancel it first.', 'DESTINATION_BUSY')
      }
    }
    this.protectDestination(targetId, storedDestination)
    const task: ArchiveTask = { targetId, operation, format, paths, destination, access }
    return {
      title: operation === 'compress' ? 'Compress' : 'Decompress', description: destination, unit: 'file', timeoutMs: 60 * 60 * 1000,
      resource: { targetId, scope: access.scope, paths: reservedPaths }, check: () => this.authorize(task),
      validate: async context => {
        const storage = await this.targets.backend(targetId); context.check()
        if ((await storage.stat(scopedPath(access, input.directory))).kind !== 'directory') throw new HttpError(400, 'Choose a destination directory')
        context.check()
        try { await storage.stat(storedDestination); throw new HttpError(409, 'The destination already exists. Choose a new name.', 'DESTINATION_EXISTS') }
        catch (error) { if (!isFsError(error, 'ENOENT') && !(error instanceof HttpError && error.statusCode === 404)) throw error }
        if (operation === 'compress') {
          context.check()
          const pending = uploadingPath(storedDestination); this.protectDestination(targetId, pending)
          try { await storage.stat(pending); throw new HttpError(409, 'The staging name already exists. Choose a new archive name.', 'DESTINATION_EXISTS') }
          catch (error) { if (!isFsError(error, 'ENOENT') && !(error instanceof HttpError && error.statusCode === 404)) throw error }
        }
        for (const path of storedPaths) {
          context.check()
          const entry = await storage.stat(path)
          if (operation === 'decompress' && entry.kind !== 'file') throw new HttpError(400, 'Choose an archive file')
        }
        context.check()
      },
      execute: context => this.execute(task, context),
    }
  }
  private authorize(task: ArchiveTask) {
    const current = this.targets.access(task.access, task.targetId, 'download'); requirePermission(current, 'upload')
    if (task.operation === 'decompress') requirePermission(current, 'create')
    if (current.scope !== task.access.scope) throw new HttpError(403, 'Your target scope changed')
  }
  private async execute(task: ArchiveTask, context: OperationContext) {
    const { operation, format, access } = task, progress = context.operation
    let bytesRead = 0, phaseName = 'scanning'
    const work: ArchiveWork = {
      signal: context.signal, maxBytes: this.maxBytes, maxEntries: this.maxEntries, check: context.check,
      tick: (file, bytes, files = 0) => {
        context.check(); bytesRead += bytes
        if (bytesRead > this.maxBytes) throw new HttpError(413, 'Archive exceeds the size limit')
        const processedBytes = progress.processedBytes + bytes, processedItems = progress.processedItems + files
        let fraction = progress.progress
        if (progress.totalBytes !== null) {
          const done = progress.totalBytes ? processedBytes / progress.totalBytes : 0
          const start = phaseName === 'saving' ? 0.8 : phaseName === 'scanning' ? 0 : 0.1
          const length = phaseName === 'saving' ? 0.199 : phaseName === 'scanning' ? 0.1 : format === '7z' && operation === 'compress' ? 0.35 : 0.7
          fraction = Math.max(fraction ?? 0, Math.min(0.999, start + done * length))
        }
        context.report({ currentItem: file, processedBytes, processedItems, progress: fraction })
      },
      total: (bytes, files) => context.report({ totalBytes: bytes, totalItems: files }, true),
      nativeProgress: percent => { if (operation === 'compress') context.report({ progress: Math.max(progress.progress ?? 0, 0.45 + percent / 100 * 0.35) }) },
    }
    const phase = (value: 'scanning' | 'compressing' | 'decompressing' | 'saving', bytes: number | null, files: number | null) => {
      phaseName = value; bytesRead = 0
      const labels = { scanning: operation === 'compress' ? 'Scanning files' : 'Reading archive', compressing: 'Compressing', decompressing: 'Decompressing', saving: 'Saving to storage' }
      context.report({ phase: labels[value], processedBytes: 0, totalBytes: bytes, processedItems: 0, totalItems: files,
        progress: bytes === null ? null : value === 'saving' ? 0.8 : value === 'scanning' ? 0 : 0.1,
        warning: value === 'saving' ? 'If this operation stops before completion, the destination may contain completed output.' : null }, true)
    }
    try {
      const storage = await this.targets.backend(task.targetId), destination = scopedPath(access, task.destination)
      if (operation === 'compress') {
        phase('scanning', null, null)
        const entries = await this.scan(task, context)
        phase('compressing', entries.reduce((total, entry) => total + entry.size, 0), entries.filter(entry => entry.kind === 'file').length)
        const archive = join(context.directory, 'archive.' + format)
        await packArchive(format, entries, archive, context.directory, work)
        const size = (await stat(archive)).size
        phase('saving', size, 1); await this.publish(task, archive, destination, size, work)
      } else {
        const source = scopedPath(access, task.paths[0]), entry = await storage.stat(source)
        if (entry.size > this.maxBytes) throw new HttpError(413, 'Archive exceeds the size limit')
        phase('scanning', entry.size, 1)
        const archive = join(context.directory, 'source.' + format)
        await pipeline(await storage.open(source), meter(work, entry.name, entry.size), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal: context.signal })
        phase('decompressing', null, null)
        const output = join(context.directory, 'output'), members = await unpackArchive(format, archive, output, work)
        for (const member of members) if (normalizePath(posix.join(destination, member.name)).length > 4096) throw new HttpError(400, 'Extracted destination path is too long')
        phase('saving', members.reduce((bytes, member) => bytes + member.size, 0), members.filter(member => member.kind === 'file').length)
        await storage.mkdir(destination, work.check); await this.publishMembers(task, output, destination, members, work)
      }
      this.store.audit(access.username, 'archive.' + operation, task.destination, task.targetId)
    } catch (error) { throw new Error(this.errorMessage(error), { cause: error }) }
  }
  private errorMessage(error: unknown) {
    if (isFsError(error, 'ENOSPC') || isFsError(error, 'EDQUOT')) return 'Storage is full. Free space on the state or target volume and start again.'
    if (isFsError(error, 'ENOENT')) return 'A source file or destination directory is no longer available.'
    if (isFsError(error, 'EEXIST')) return 'A destination name already exists. Choose a new name.'
    if (isFsError(error, 'EACCES') || isFsError(error, 'EPERM') || isFsError(error, 'EROFS')) return 'Storage denied access to a source or destination.'
    if (isFsError(error, 'ENAMETOOLONG')) return 'An archive member path is too long to save.'
    return error instanceof Error ? error.message : 'Archive operation failed'
  }
  private async scan(task: ArchiveTask, context: OperationContext): Promise<PackMember[]> {
    const storage = await this.targets.backend(task.targetId), selections: { path: string; entry: FileEntry }[] = []
    for (const path of task.paths) { context.check(); selections.push({ path, entry: await storage.stat(scopedPath(task.access, path)) }) }
    const roots = selections.filter(selection => !selections.some(parent => parent !== selection && parent.entry.kind === 'directory' && pathsOverlap(parent.path, selection.path) && parent.path.length < selection.path.length))
    let base = posix.dirname(roots[0].path)
    while (roots.some(root => root.path !== base && !root.path.startsWith(base === '/' ? '/' : base + '/'))) base = posix.dirname(base)
    const storedBase = scopedPath(task.access, base), result: PackMember[] = []
    let bytes = 0
    const append = (entry: typeof selections[number]['entry']) => {
      context.check()
      const name = posix.relative(storedBase, entry.path)
      if (!name) return
      bytes += entry.kind === 'file' ? entry.size : 0
      if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes || result.length >= this.maxEntries) throw new HttpError(413, 'Selection exceeds the size or entry limit')
      context.report({ currentItem: name })
      result.push({ name, kind: entry.kind, size: entry.kind === 'file' ? entry.size : 0, modifiedAt: entry.modifiedAt, open: async () => { context.check(); return storage.open(entry.path) } })
    }
    for (const root of roots) {
      append(root.entry)
      if (root.entry.kind === 'directory') for await (const entry of storage.walk(root.entry.path)) append(entry)
    }
    return result
  }
  private async publishMembers(task: ArchiveTask, output: string, destination: string, members: ArchiveMember[], work: ArchiveWork) {
    const storage = await this.targets.backend(task.targetId)
    const directories = members.filter(member => member.kind === 'directory').sort((a, b) => a.name.split('/').length - b.name.split('/').length)
    for (const member of directories) { work.check(); await storage.mkdir(posix.join(destination, member.name), work.check) }
    for (const member of members.filter(member => member.kind === 'file')) await this.publish(task, join(output, member.name), posix.join(destination, member.name), member.size, work)
  }
  private async publish(task: ArchiveTask, source: string, destination: string, size: number, work: ArchiveWork) {
    const storage = await this.targets.backend(task.targetId), id = randomUUID()
    const label = task.operation === 'compress' ? posix.basename(destination) : posix.relative(scopedPath(task.access, task.destination), destination)
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
}
