import { constants } from 'node:fs'
import { lstat, mkdir, readdir, open, unlink, rmdir, link, rename, statfs, rm, readFile, readlink, symlink, opendir } from 'node:fs/promises'
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import type { FileEntry } from '@/shared/types'
import type { DirectoryExportBackend, SequentialUploadBackend, StorageBackend } from './interface'
import { capabilities } from './capabilities'
import { normalizePath, uploadingPath } from './paths'
import { HttpError, isFsError } from '../errors'

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}

async function directoryFilesystem(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    const device = (await handle.stat({ bigint: true })).dev
    let mount: string | null = null
    try { mount = (await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8')).match(/^mnt_id:\s*(\d+)$/m)?.[1] ?? null }
    catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'EACCES')) throw error }
    return { device, mount }
  } finally { await handle.close() }
}

function sameFilesystem(a: Awaited<ReturnType<typeof directoryFilesystem>>, b: Awaited<ReturnType<typeof directoryFilesystem>>) {
  return a.device === b.device && (a.mount === null || b.mount === null || a.mount === b.mount)
}

export class LocalStorage implements StorageBackend, SequentialUploadBackend, DirectoryExportBackend {
  readonly name = 'Local storage'
  readonly type = 'local'
  readonly capabilities: StorageBackend['capabilities']
  readonly root: string
  readonly staging: string
  private rootLock?: DatabaseSync
  constructor(root: string, private afterMoveLink?: () => void, private readOnly = false) {
    this.capabilities = capabilities('local', readOnly)
    this.root = resolve(root)
    this.staging = join(this.root, '.filebrowser-uploads')
  }
  private writable() {
    if (this.readOnly) throw new HttpError(403, 'Storage is read-only', 'STORAGE_READ_ONLY')
  }
  async init() {
    let ancestor = '/'
    for (const component of this.root.split('/').filter(Boolean)) {
      ancestor = join(ancestor, component)
      try { if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Storage root must not contain symlinks') }
      catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
    }
    if (this.readOnly) {
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Read-only storage root must be an existing directory without symlinks')
      return
    }
    await mkdir(this.root, { recursive: true, mode: 0o750 })
    await mkdir(this.staging, { mode: 0o700 }).catch(error => { if (!isFsError(error, 'EEXIST')) throw error })
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(this.staging)).isSymbolicLink()) throw new Error('Storage root and staging must not be symlinks')
    await syncDirectory(this.root)
  }
  async lock() {
    if (this.readOnly) return
    const path = join(this.root, '.filebrowser-lock')
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Storage lock must not be a symlink') }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
    const lock = new DatabaseSync(path)
    try { lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;') }
    catch { lock.close(); throw new HttpError(409, 'Another Filebrowser process owns this storage root', 'STORAGE_BUSY') }
    this.rootLock = lock
  }
  close() { this.rootLock?.close(); this.rootLock = undefined }
  private stage(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid upload ID')
    return join(this.staging, id)
  }
  // The central registry can point to a stage on another mounted filesystem.
  // These private, app-created symlinks are never accessible through file APIs.
  private async linkedStage(id: string) {
    const registry = this.stage(id)
    let info
    try { info = await lstat(registry) }
    catch (error) { if (isFsError(error, 'ENOENT')) return null; throw error }
    if (!info.isSymbolicLink()) return null
    const target = await readlink(registry)
    const relativeTarget = relative(this.root, target)
    const device = /^\.filebrowser-uploads-([0-9]+)$/.exec(basename(dirname(target)))?.[1]
    if (!isAbsolute(target) || isAbsolute(relativeTarget) || relativeTarget === '..' || relativeTarget.startsWith('../') || basename(target) !== id || !device) {
      throw new HttpError(409, 'Invalid upload staging registry', 'DATA_LOSS')
    }
    let available = false
    try {
      const volume = await this.safePath(this.virtualPath(dirname(dirname(target))))
      available = (await lstat(volume, { bigint: true })).dev === BigInt(device)
    } catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error }
    if (!available) {
      throw new HttpError(409, 'The upload filesystem is unavailable. Mount it before retrying.', 'STORAGE_UNAVAILABLE')
    }
    return target
  }
  private async safePath(path: string, allowMissing = false): Promise<string> {
    const virtual = normalizePath(path)
    let current = this.root
    const parts = virtual.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i])
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new HttpError(403, 'Symbolic links cannot be accessed')
        if (i < parts.length - 1 && !info.isDirectory()) throw new HttpError(400, 'A parent path is not a directory')
      } catch (error) {
        if (allowMissing && i === parts.length - 1 && isFsError(error, 'ENOENT')) return current
        throw error
      }
    }
    return current
  }
  private entry(path: string, info: { isDirectory(): boolean; size: number; mtime: Date }): FileEntry {
    return { name: basename(path), path, kind: info.isDirectory() ? 'directory' : 'file', size: info.size, modifiedAt: info.mtime.toISOString() }
  }
  async list(directory: string) {
    const native = await this.safePath(directory)
    if (!(await lstat(native)).isDirectory()) throw new HttpError(400, 'This is not a directory')
    const entries = await readdir(native, { withFileTypes: true })
    const result: FileEntry[] = []
    // Bound stat concurrency: large directories must not exhaust file descriptors.
    for (let start = 0; start < entries.length; start += 64) {
      const batch = await Promise.all(entries.slice(start, start + 64).filter(e => !e.name.toLowerCase().startsWith('.filebrowser-') && !e.isSymbolicLink() && (e.isDirectory() || e.isFile())).map(async e => {
        let path: string
        try { path = normalizePath(directory + '/' + e.name) }
        catch (error) { if (error instanceof HttpError && error.statusCode === 400) return null; throw error }
        try {
          const info = await lstat(join(native, e.name))
          return info.isFile() || info.isDirectory() ? this.entry(path, info) : null
        } catch (error) { if (isFsError(error, 'ENOENT')) return null; throw error }
      }))
      result.push(...batch.filter((e): e is FileEntry => e !== null))
    }
    return result.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  async *walk(directory: string): AsyncIterable<FileEntry> {
    const handle = await opendir(await this.safePath(directory))
    // opendir's async iterator closes every directory on completion or abort.
    for await (const child of handle) {
      if (child.name.toLowerCase().startsWith('.filebrowser-') || child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) continue
      let path: string
      try { path = normalizePath(directory + '/' + child.name) }
      catch (error) { if (error instanceof HttpError && error.statusCode === 400) continue; throw error }
      const native = await this.safePath(path)
      const info = await lstat(native)
      if (!info.isDirectory() && !info.isFile()) continue
      yield this.entry(path, info)
      if (info.isDirectory()) yield* this.walk(path)
    }
  }
  async stat(path: string) {
    const info = await lstat(await this.safePath(path))
    if (!info.isFile() && !info.isDirectory()) throw new HttpError(400, 'Only regular files and directories can be accessed')
    return this.entry(normalizePath(path), info)
  }
  async directoryIdentity(path: string) {
    const info = await lstat(await this.safePath(path), { bigint: true })
    if (!info.isDirectory()) throw new HttpError(400, 'Only directories can be shared')
    return { dev: info.dev.toString(), ino: info.ino.toString() }
  }
  async open(path: string, range?: { start: number; end: number }) {
    const handle = await open(await this.safePath(path), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile()) { await handle.close(); throw new HttpError(400, 'Only regular files can be opened') }
    return handle.createReadStream({ ...(range ?? {}), autoClose: true })
  }
  async mkdir(path: string, authorize: () => void = () => {}) {
    this.writable()
    const native = await this.safePath(path, true)
    authorize()
    await mkdir(native, { mode: 0o750 })
    await syncDirectory(dirname(native))
  }
  async move(source: string, destination: string, authorize: () => void = () => {}) {
    this.writable()
    if (normalizePath(source) === '/') throw new HttpError(400, 'Cannot move the storage root')
    const from = await this.safePath(source)
    const to = await this.safePath(destination, true)
    try { await lstat(to); throw new HttpError(409, 'The destination already exists') } catch (e) { if (!isFsError(e, 'ENOENT')) throw e }
    const info = await lstat(from)
    authorize()
    if (info.isFile()) {
      // POSIX rename replaces an existing file. Exclusive link + unlink moves the
      // same inode without that race, and remains recoverable between both names.
      await link(from, to)
      await syncDirectory(dirname(to))
      this.afterMoveLink?.()
      authorize()
      await unlink(from)
      await syncDirectory(dirname(from))
    } else {
      await rename(from, to)
      await syncDirectory(dirname(from))
      if (dirname(from) !== dirname(to)) await syncDirectory(dirname(to))
    }
  }
  async remove(path: string, authorize: () => void = () => {}) {
    this.writable()
    if (normalizePath(path) === '/') throw new HttpError(400, 'Cannot remove the storage root')
    const native = await this.safePath(path)
    const info = await lstat(native)
    authorize()
    // Empty directories only: do not recursively delete a user's tree by accident.
    if (info.isDirectory()) await rmdir(native)
    else await unlink(native)
    await syncDirectory(dirname(native))
  }
  async space(path = '/') {
    const info = await statfs(await this.safePath(path))
    return { total: info.blocks * info.bsize, available: info.bavail * info.bsize }
  }
  private target(id: string) { return join(this.stage(id), 'target.uploading') }
  private async writeDestination(id: string, destination: string) {
    const marker = await open(join(this.stage(id), 'destination.json'), 'wx', 0o600)
    try { await marker.writeFile(JSON.stringify({ destination })); await marker.sync() } finally { await marker.close() }
  }
  async createStage(id: string, destination: string) {
    this.writable()
    const registry = this.stage(id)
    const parent = await this.safePath(dirname(destination))
    const filesystem = await directoryFilesystem(parent), device = filesystem.device
    let stage = registry
    // Separate bind mounts can share st_dev while still rejecting hard links.
    if (!sameFilesystem(filesystem, await directoryFilesystem(this.staging))) {
      let volume = parent
      while (volume !== this.root) {
        const above = dirname(volume)
        if (!sameFilesystem(filesystem, await directoryFilesystem(above))) break
        volume = above
      }
      const staging = join(volume, '.filebrowser-uploads-' + device)
      await mkdir(staging, { mode: 0o700 }).catch(error => { if (!isFsError(error, 'EEXIST')) throw error })
      const info = await lstat(staging)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(409, 'Invalid upload staging directory', 'DATA_LOSS')
      await syncDirectory(volume)
      stage = join(staging, id)
      // Persist the locator before creating any payload on the other disk.
      // A crash at any following step leaves an identifiable orphan to clean up.
      await symlink(stage, registry)
      await syncDirectory(this.staging)
    }
    await mkdir(stage, { mode: 0o700 })
    const file = await open(this.target(id), 'wx', 0o600)
    try { await file.sync() } finally { await file.close() }
    await this.writeDestination(id, destination)
    await syncDirectory(stage)
    await syncDirectory(dirname(stage))
    await syncDirectory(this.staging)
    const info = await lstat(this.target(id), { bigint: true })
    return `${info.dev}:${info.ino}`
  }
  async restoreStage(id: string, destination: string, inode: string) {
    this.writable()
    await this.linkedStage(id)
    const info = await lstat(this.target(id), { bigint: true })
    if (!info.isFile() || `${info.dev}:${info.ino}` !== inode) throw new HttpError(409, 'Upload staging identity changed', 'DATA_LOSS')
    try { await this.writeDestination(id, destination) }
    catch (error) { if (!isFsError(error, 'EEXIST')) throw error }
    await syncDirectory(this.stage(id))
    const pending = await this.safePath(uploadingPath(destination), true)
    try { await link(this.target(id), pending) }
    catch (error) {
      if (!isFsError(error, 'EEXIST') || !await this.isPublished(uploadingPath(destination), inode, Number(info.size))) {
        if (isFsError(error, 'EEXIST')) throw new HttpError(409, 'The .uploading name already exists; your transfer is retained', 'DESTINATION_EXISTS')
        throw error
      }
    }
    await syncDirectory(dirname(pending))
  }
  async stageSize(id: string) { return (await lstat(this.target(id))).size }
  async resetTo(id: string, committedBytes: number) {
    this.writable()
    const file = await open(this.target(id), constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const size = (await file.stat()).size
      if (size < committedBytes) throw new HttpError(409, 'Committed data is missing from disk; start a new transfer', 'DATA_LOSS')
      if (size === committedBytes) return
      await file.truncate(committedBytes)
      await file.sync()
    } finally { await file.close() }
  }
  async prepareChunk(id: string, size: number) {
    this.writable()
    await this.discardChunk(id)
    const handle = await open(join(this.stage(id), 'chunk'), 'wx', 0o600)
    try { await handle.truncate(size) } finally { await handle.close() }
  }
  async writePart(id: string, offset: number, size: number, source: Readable, isValid: () => boolean) {
    this.writable()
    const handle = await open(join(this.stage(id), 'chunk'), constants.O_RDWR | constants.O_NOFOLLOW)
    let received = 0
    try {
      for await (const value of source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!isValid()) throw new HttpError(409, 'This chunk attempt was discarded', 'ATTEMPT_EXPIRED')
        if (received + buffer.length > size) throw new HttpError(400, 'Part is larger than expected', 'LENGTH_MISMATCH')
        let written = 0
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, offset + received + written)
          if (result.bytesWritten === 0) throw new Error('Disk write made no progress')
          written += result.bytesWritten
        }
        received += buffer.length
      }
      if (received !== size || !isValid()) throw new HttpError(400, 'Part did not arrive completely', 'LENGTH_MISMATCH')
    } finally { await handle.close() }
  }
  async verifyChunk(id: string, expectedHash: string, size: number) {
    const file = await open(join(this.stage(id), 'chunk'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await file.stat()).size !== size) throw new HttpError(422, 'Chunk length does not match', 'CHECKSUM_MISMATCH')
      const hash = createHash('sha256')
      for await (const buffer of file.createReadStream({ autoClose: false })) hash.update(buffer)
      if (hash.digest('hex') !== expectedHash) throw new HttpError(422, 'Chunk checksum did not match; the entire chunk was discarded', 'CHECKSUM_MISMATCH')
    } finally { await file.close() }
  }
  async appendChunk(id: string, committedBytes: number, size: number) {
    this.writable()
    const target = await open(this.target(id), constants.O_RDWR | constants.O_NOFOLLOW)
    const chunk = await open(join(this.stage(id), 'chunk'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await target.truncate(committedBytes)
      let position = committedBytes
      for await (const value of chunk.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
        const buffer = value as Buffer
        let written = 0
        while (written < buffer.length) {
          const result = await target.write(buffer, written, buffer.length - written, position + written)
          if (!result.bytesWritten) throw new Error('Disk write made no progress')
          written += result.bytesWritten
        }
        position += buffer.length
      }
      if (position !== committedBytes + size) throw new Error('Chunk changed during append')
      await target.sync()
    } catch (error) {
      await target.truncate(committedBytes)
      await target.sync()
      throw error
    } finally { await target.close(); await chunk.close() }
  }
  async publish(id: string, destination: string, inode: string, size: number, authorize: () => void = () => {}) {
    this.writable()
    if (await this.isPublished(destination, inode, size)) {
      await syncDirectory(dirname(await this.safePath(destination)))
      await this.removePending(destination, inode)
      return
    }
    await this.restoreStage(id, destination, inode)
    if (await this.stageSize(id) !== size) throw new HttpError(409, 'Upload length changed before publication', 'DATA_LOSS')
    try { await this.move(uploadingPath(destination), destination, authorize) }
    catch (error) {
      if (isFsError(error, 'EEXIST')) throw new HttpError(409, 'The destination already exists; your transfer is retained', 'DESTINATION_EXISTS')
      throw error
    }
  }
  async isPublished(destination: string, inode: string, size: number) {
    try {
      const info = await lstat(await this.safePath(destination), { bigint: true })
      return info.isFile() && `${info.dev}:${info.ino}` === inode && info.size === BigInt(size)
    } catch (e) { if (isFsError(e, 'ENOENT')) return false; throw e }
  }
  async discardChunk(id: string) { this.writable(); await unlink(join(this.stage(id), 'chunk')).catch(e => { if (!isFsError(e, 'ENOENT')) throw e }) }
  private async removePending(destination: string, inode: string) {
    const pending = uploadingPath(normalizePath(destination))
    try {
      const parent = await this.safePath(dirname(pending))
      const native = join(parent, basename(pending))
      const info = await lstat(native, { bigint: true })
      // A host-side replacement or ordinary suffix-named file is never removed.
      if (!info.isFile() || `${info.dev}:${info.ino}` !== inode) return
      await unlink(native)
      await syncDirectory(parent)
    } catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
  }
  async removeStage(id: string, destination?: string, inode?: string, removePending = true) {
    this.writable()
    const linked = await this.linkedStage(id)
    if (removePending) {
      if (destination && inode) await this.removePending(destination, inode)
      else {
        try {
          const marker = JSON.parse(await readFile(join(this.stage(id), 'destination.json'), 'utf8')) as { destination: string }
          const info = await lstat(this.target(id), { bigint: true })
          await this.removePending(marker.destination, `${info.dev}:${info.ino}`)
        } catch (error) {
          // An initialization killed before its marker fsync can leave invalid
          // JSON. No public alias is exposed before the database session exists.
          if (!isFsError(error, 'ENOENT') && !(error instanceof SyntaxError) && !(error instanceof HttpError && error.statusCode === 400)) throw error
        }
      }
    }
    if (linked) {
      await rm(linked, { recursive: true, force: true })
      await syncDirectory(dirname(linked))
      // The durable registry is removed last so cancellation can be retried.
      await unlink(this.stage(id))
    } else await rm(this.stage(id), { recursive: true, force: true })
    await syncDirectory(this.staging)
  }
  async orphanStages(validIds: Set<string>, knownIds: Set<string>) {
    this.writable()
    for (const e of await readdir(this.staging, { withFileTypes: true })) {
      if ((e.isDirectory() || e.isSymbolicLink()) && /^[a-f0-9-]{36}$/.test(e.name) && !validIds.has(e.name)) {
        try { await this.removeStage(e.name, undefined, undefined, !knownIds.has(e.name)) }
        catch (error) { if (!(error instanceof HttpError && error.code === 'STORAGE_UNAVAILABLE')) throw error }
      }
    }
  }
  virtualPath(native: string) { return '/' + relative(this.root, native).split('\\').join('/') }
}
