import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { HttpError, isFsError } from '../errors'

async function durableDirectory(path: string) {
  const first = await mkdir(path, { recursive: true, mode: 0o700 })
  if (!first) return
  // Persist each new directory entry, including the parent of the first new
  // directory. Syncing only stage.json's own directory would lose its ancestry
  // after power loss even when the remote chunk had already been acknowledged.
  const parent = dirname(resolve(first))
  for (let current = resolve(path); ; current = dirname(current)) {
    const handle = await open(current, 'r')
    try { await handle.sync() } finally { await handle.close() }
    if (current === parent) break
  }
}

async function durableJson(path: string, value: unknown) {
  const temporary = path + '.tmp', handle = await open(temporary, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const parent = await open(join(path, '..'), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

/** One verified, bounded local chunk. Remote data is never assembled locally. */
export class Chunks {
  private verified = new Map<string, string>()
  constructor(readonly directory: string) {}
  path(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid stage identifier'); return join(this.directory, id) }
  chunk(id: string) { return join(this.path(id), 'chunk') }
  async create(id: string, value: unknown) { await durableDirectory(this.path(id)); await this.save(id, value) }
  async save(id: string, value: unknown) { await durableJson(join(this.path(id), 'stage.json'), value) }
  async load<T>(id: string): Promise<T> { return JSON.parse(await readFile(join(this.path(id), 'stage.json'), 'utf8')) as T }
  async prepare(id: string, size: number) {
    await this.discard(id)
    const handle = await open(this.chunk(id), 'wx', 0o600)
    try { await handle.truncate(size) } finally { await handle.close() }
  }
  async write(id: string, offset: number, size: number, source: Readable, valid: () => boolean) {
    const handle = await open(this.chunk(id), constants.O_RDWR | constants.O_NOFOLLOW)
    let received = 0
    try {
      for await (const value of source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (!valid()) throw new HttpError(409, 'Chunk attempt was discarded', 'ATTEMPT_EXPIRED')
        if (received + buffer.length > size) throw new HttpError(400, 'Part is larger than expected', 'LENGTH_MISMATCH')
        let written = 0
        while (written < buffer.length) {
          const result = await handle.write(buffer, written, buffer.length - written, offset + received + written)
          if (!result.bytesWritten) throw new Error('Disk write made no progress')
          written += result.bytesWritten
        }
        received += buffer.length
      }
      if (received !== size || !valid()) throw new HttpError(400, 'Part did not arrive completely', 'LENGTH_MISMATCH')
    } finally { await handle.close() }
  }
  async verify(id: string, expected: string, size: number) {
    const handle = await open(this.chunk(id), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await handle.stat()).size !== size) throw new HttpError(422, 'Chunk length does not match', 'CHECKSUM_MISMATCH')
      const hash = createHash('sha256')
      for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes)
      if (hash.digest('hex') !== expected) throw new HttpError(422, 'Chunk checksum did not match; retry the whole chunk', 'CHECKSUM_MISMATCH')
      this.verified.set(id, expected)
    } finally { await handle.close() }
  }
  hash(id: string) { const hash = this.verified.get(id); if (!hash) throw new Error('Chunk was not verified'); return hash }
  async discard(id: string) { this.verified.delete(id); await unlink(this.chunk(id)).catch(e => { if (!isFsError(e, 'ENOENT')) throw e }) }
  async remove(id: string) { this.verified.delete(id); await rm(this.path(id), { recursive: true, force: true }) }
  async ids() { await durableDirectory(this.directory); return (await readdir(this.directory)).filter(id => /^[a-f0-9-]{36}$/.test(id)) }
  async size(id: string) { return (await stat(this.chunk(id))).size }
}
