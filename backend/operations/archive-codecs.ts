import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip, crc32 } from 'node:zlib'
import { pack, extract } from 'tar-stream'
import { ZipFile } from 'yazl'
import * as yauzl from 'yauzl'
import type { ArchiveFormat } from '@/shared/types'
import { MAX_PATH_LENGTH } from '@/shared/file-rules'
import { normalizePath, validName } from '../storage/paths'
import { HttpError } from '../errors'

export interface ArchiveMember { name: string; kind: 'file' | 'directory'; size: number }
export interface PackMember extends ArchiveMember { modifiedAt: string; open: () => Promise<Readable> }
export interface ArchiveWork {
  signal: AbortSignal; maxBytes: number; maxEntries: number
  check: () => void
  tick: (file: string, bytes: number, files?: number) => void
  total: (bytes: number, files: number) => void
  nativeProgress: (percent: number) => void
}

export function meter(work: ArchiveWork, name: string, expected?: number, checksum?: number) {
  let bytes = 0, crc = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        work.check(); bytes += chunk.length
        if (bytes > (expected ?? work.maxBytes)) throw new HttpError(400, 'Archive entry exceeds its declared size or the archive limit')
        if (checksum !== undefined) crc = crc32(chunk, crc)
        work.tick(name, chunk.length)
        callback(null, chunk)
      } catch (error) { callback(error as Error) }
    },
    flush(callback) {
      if (expected !== undefined && bytes !== expected) return callback(new Error('Archive entry size changed or is invalid'))
      if (checksum !== undefined && crc !== checksum) return callback(new Error('Archive entry checksum did not match'))
      callback()
    },
  })
}

/** Only files and directories are ever created, with application-chosen modes. */
class Members {
  readonly entries = new Map<string, ArchiveMember>()
  private bytes = 0
  constructor(private work: ArchiveWork) {}
  add(raw: string, kind: ArchiveMember['kind'], size: number): ArchiveMember | null {
    this.work.check()
    // Common TAR writers prefix paths with ./ and include a root directory entry.
    let name = raw
    while (name.startsWith('./')) name = name.slice(2)
    if (kind === 'directory') name = name.replace(/\/+$/, '')
    if ((!name || name === '.') && kind === 'directory') return null
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.length > MAX_PATH_LENGTH) throw new HttpError(400, 'Archive contains an invalid path')
    normalizePath(name)
    for (const part of name.split('/')) validName(part)
    if (!Number.isSafeInteger(size) || size < 0 || (kind === 'directory' && size !== 0)) throw new HttpError(400, 'Archive contains an invalid entry size')
    const existing = this.entries.get(name)
    if (existing) {
      if (existing.kind === 'directory' && kind === 'directory') return existing
      throw new HttpError(400, 'Archive contains duplicate or conflicting paths')
    }
    const components = name.split('/')
    for (let index = 1; index < components.length; index++) this.add(components.slice(0, index).join('/'), 'directory', 0)
    this.bytes += size
    if (this.bytes > this.work.maxBytes || this.entries.size >= this.work.maxEntries) throw new HttpError(413, 'Archive exceeds the expanded size or entry limit')
    const entry = { name, kind, size }
    this.entries.set(name, entry)
    return entry
  }
  total() { this.work.total(this.bytes, [...this.entries.values()].filter(entry => entry.kind === 'file').length) }
}

export async function packArchive(format: ArchiveFormat, entries: PackMember[], output: string, directory: string, work: ArchiveWork) {
  if (format === '7z') {
    const input = join(directory, 'input'); await mkdir(input, { mode: 0o700 })
    for (const entry of entries) {
      const path = join(input, entry.name)
      await mkdir(entry.kind === 'directory' ? path : dirname(path), { recursive: true, mode: 0o700 })
      if (entry.kind === 'file') {
        await pipeline(await entry.open(), meter(work, entry.name, entry.size), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
        work.tick(entry.name, 0, 1)
      }
    }
    // The input tree contains only validated adapter reads; never pass target-native paths.
    await seven(['a', '-t7z', '-mx=5', '-mmt=2', '--', output, '.'], work, input)
    if ((await stat(output)).size > work.maxBytes) throw new HttpError(413, 'Compressed archive exceeds the size limit')
    return
  }
  if (format === 'zip') {
    const zip = new ZipFile()
    const zipOutput = zip.outputStream as Readable
    const writing = pipeline(zipOutput, meterOutput(work), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
    void writing.catch(() => {})
    // A producer error must also reject the consumer pipeline.
    zip.on('error', error => zipOutput.destroy(error))
    try {
      for (const entry of entries) {
        if (entry.kind === 'directory') zip.addEmptyDirectory(entry.name, { mtime: new Date(entry.modifiedAt), mode: 0o40755 })
        else zip.addReadStreamLazy(entry.name, { size: entry.size, mtime: new Date(entry.modifiedAt), mode: 0o100644 }, callback => {
          void entry.open().then(source => {
            if (zipOutput.destroyed || work.signal.aborted) { source.destroy(); return }
            const counted = meter(work, entry.name, entry.size)
            const stop = () => { source.destroy(); counted.destroy() }
            zipOutput.once('close', stop)
            source.on('error', error => counted.destroy(error))
            counted.once('close', () => { zipOutput.removeListener('close', stop); source.destroy() })
            counted.once('end', () => work.tick(entry.name, 0, 1))
            callback(null, source.pipe(counted))
          }).catch(error => zipOutput.destroy(error))
        })
      }
      zip.end()
      await writing
    } catch (error) { zipOutput.destroy(); await writing.catch(() => {}); throw error }
    return
  }
  const tar = pack()
  const writing = format === 'tar.gz'
    ? pipeline(tar, createGzip(), meterOutput(work), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
    : pipeline(tar, meterOutput(work), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
  // Attach immediately while the producer is awaiting remote reads.
  void writing.catch(() => {})
  try {
    for (const entry of entries) {
      work.check()
      const target = tar.entry({ name: entry.name + (entry.kind === 'directory' ? '/' : ''), type: entry.kind === 'directory' ? 'directory' : 'file',
        size: entry.size, mtime: new Date(entry.modifiedAt), mode: entry.kind === 'directory' ? 0o755 : 0o644 })
      await pipeline(entry.kind === 'file' ? await entry.open() : Readable.from([]), meter(work, entry.name, entry.size), target, { signal: work.signal })
      if (entry.kind === 'file') work.tick(entry.name, 0, 1)
    }
    tar.finalize(); await writing
  } catch (error) { tar.destroy(error as Error); await writing.catch(() => {}); throw error }
}

function meterOutput(work: ArchiveWork) {
  let bytes = 0
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try {
      work.check(); bytes += chunk.length
      if (bytes > work.maxBytes) throw new HttpError(413, 'Compressed archive exceeds the size limit')
      callback(null, chunk)
    } catch (error) { callback(error as Error) }
  } })
}

export async function unpackArchive(format: ArchiveFormat, source: string, output: string, work: ArchiveWork): Promise<ArchiveMember[]> {
  const members = new Members(work)
  await mkdir(output, { mode: 0o700 })
  if (format === '7z') {
    // Extract individual entries to stdout: the native decoder never creates paths
    // from untrusted archive metadata, including links or traversal names.
    const listing = await seven(['l', '-t7z', '-slt', '-ba', '--', source], work)
    const records = listing.trim() ? listing.trimEnd().split(/\r?\n\r?\n/) : []
    const files: { member: ArchiveMember; original: string }[] = []
    if (records.length > work.maxEntries) throw new HttpError(413, 'Archive exceeds the entry limit')
    for (const record of records) {
      const fields = new Map<string, string>()
      for (const line of record.split(/\r?\n/)) {
        const split = line.indexOf(' = ')
        if (split < 1 || fields.has(line.slice(0, split))) throw new HttpError(400, 'Archive contains ambiguous entry metadata')
        fields.set(line.slice(0, split), line.slice(split + 3))
      }
      const original = fields.get('Path')
      if (!original || fields.get('Encrypted') !== '-' || fields.has('Symbolic Link') || fields.has('Hard Link') || /[lbcps]/.test((fields.get('Attributes') ?? '').split(' ').at(-1)?.slice(0, 1) ?? '')) {
        throw new HttpError(400, 'Encrypted archives, links and special entries are unsupported')
      }
      const kind = fields.get('Folder') === '+' || /^D/.test(fields.get('Attributes') ?? '') ? 'directory' : 'file'
      const member = members.add(original, kind, Number(fields.get('Size')))
      if (member?.kind === 'file') files.push({ member, original })
    }
    members.total()
    for (const { member, original } of files) {
      const path = join(output, member.name); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await seven(['x', '-t7z', '-so', '-spd', '-ssc', '-r-', '-i!' + original, '--', source], work, undefined, { path, member })
      work.tick(member.name, 0, 1)
    }
  } else if (format === 'zip') {
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(source, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)))
    const files: { entry: yauzl.Entry; member: ArchiveMember }[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { zip.close(); reject(work.signal.reason) }
        work.signal.addEventListener('abort', abort, { once: true })
        const done = (error?: Error) => { work.signal.removeEventListener('abort', abort); if (error) reject(error); else resolve() }
        zip.once('error', done); zip.once('end', () => done())
        zip.on('entry', (entry: yauzl.Entry) => {
          try {
            const type = (entry.externalFileAttributes >>> 16) & 0o170000
            if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || (type !== 0 && type !== 0o100000 && type !== 0o040000)) throw new HttpError(400, 'Encrypted ZIPs, unsupported compression methods, links and special entries are unsupported')
            const kind = entry.fileName.endsWith('/') || type === 0o040000 ? 'directory' : 'file'
            const member = members.add(entry.fileName, kind, entry.uncompressedSize)
            if (member?.kind === 'file') files.push({ entry, member })
            zip.readEntry()
          } catch (error) { reject(error); zip.close() }
        })
        zip.readEntry()
      })
      members.total()
      for (const { entry, member } of files) {
        work.check()
        const path = join(output, member.name); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)))
        await pipeline(stream, meter(work, member.name, member.size, entry.crc32), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
        work.tick(member.name, 0, 1)
      }
    } finally { zip.close() }
  } else {
    const tar = extract()
    const reading = format === 'tar.gz' ? pipeline(createReadStream(source), createGunzip(), tar, { signal: work.signal }) : pipeline(createReadStream(source), tar, { signal: work.signal })
    void reading.catch(() => {})
    try {
      for await (const stream of tar) {
        const { header } = stream
        if (header.type !== 'file' && header.type !== 'directory') throw new HttpError(400, 'Archive links and special entries are unsupported')
        const member = members.add(header.name, header.type, header.size ?? 0)
        if (member?.kind === 'file') {
          const path = join(output, member.name); await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await pipeline(stream, meter(work, member.name, member.size), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: work.signal })
          work.tick(member.name, 0, 1)
        } else stream.resume()
      }
      await reading
      members.total()
    } catch (error) { tar.destroy(error as Error); await reading.catch(() => {}); throw error }
  }
  return [...members.entries.values()]
}

async function seven(args: string[], work: ArchiveWork, cwd?: string, output?: { path: string; member: ArchiveMember }): Promise<string> {
  work.check()
  const child = spawn(process.env.FB_7ZIP_PATH || '7zz', [...args.slice(0, 1), '-bsp2', '-y', ...(args[0] === 'a' ? [] : ['-p-']), ...args.slice(1)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: work.signal, killSignal: 'SIGKILL', env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  })
  let result = '', overflow = false
  child.stderr.on('data', (chunk: Buffer) => {
    for (const match of chunk.toString().matchAll(/(\d{1,3})%/g)) work.nativeProgress(Number(match[1]))
  })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', error => reject('code' in error && error.code === 'ENOENT' ? new HttpError(503, '7-Zip is unavailable. Install current 7-Zip and set FB_7ZIP_PATH.') : error))
    child.once('close', code => code === 0 && !overflow ? resolve() : reject(new Error(overflow ? 'Archive listing exceeds the metadata limit' : '7-Zip could not process this archive. It may be damaged, encrypted or unsupported.')))
  })
  void closed.catch(() => {})
  const writing = output ? pipeline(child.stdout, meter(work, output.member.name, output.member.size), createWriteStream(output.path, { flags: 'wx', mode: 0o600 }), { signal: work.signal }) : undefined
  if (!output) child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    // Bound listing metadata independently of the expanded data limit.
    if (result.length + chunk.length > 16 * 1024 * 1024) { overflow = true; child.kill('SIGKILL') }
    else result += chunk
  })
  try { await Promise.all([closed, writing]); return result }
  catch (error) { child.kill('SIGKILL'); await Promise.allSettled([closed, writing]); throw error }
}
