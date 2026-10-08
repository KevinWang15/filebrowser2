import { createReadStream } from 'node:fs'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import {
  S3Client, ListObjectsV2Command, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListPartsCommand,
} from '@aws-sdk/client-s3'
import type { FileEntry, TargetConnection } from '@/shared/types'
import { capabilities } from './capabilities'
import { HttpError, isFsError } from '../errors'
import { normalizePath, validName } from './paths'
import { Chunks } from './chunks'
import type { SequentialUploadBackend, StorageBackend } from './interface'

type Connection = Extract<TargetConnection, { type: 's3' }>
interface Part { PartNumber: number; ETag: string; ChecksumSHA256: string; end: number }
interface Stage { id: string; destination: string; uploadId: string; parts: Part[] }
export class S3Storage implements StorageBackend, SequentialUploadBackend {
  readonly type = 's3'
  readonly capabilities
  private client: S3Client
  private chunks: Chunks
  private restored = new Set<string>()
  constructor(readonly name: string, private connection: Connection, directory: string, readOnly: boolean) {
    this.capabilities = capabilities('s3', readOnly); this.chunks = new Chunks(directory)
    this.client = new S3Client({ region: connection.region, endpoint: connection.endpoint || undefined, forcePathStyle: connection.forcePathStyle,
      credentials: { accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey, sessionToken: connection.sessionToken || undefined }, maxAttempts: 2, requestHandler: { connectionTimeout: 10_000, socketTimeout: 120_000 } })
  }
  private writable() { if (this.capabilities.readOnly) throw new HttpError(403, 'Target is read-only', 'STORAGE_READ_ONLY') }
  private key(path: string) { return [this.connection.prefix, normalizePath(path).slice(1)].filter(Boolean).join('/') }
  private async send<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      const status = error && typeof error === 'object' && '$metadata' in error ? (error.$metadata as { httpStatusCode?: number }).httpStatusCode : undefined
      if (status === 404 || error instanceof Error && error.name === 'NotFound') throw Object.assign(new Error('Object not found'), { code: 'ENOENT' })
      if (status === 412 || status === 409) throw new HttpError(409, 'Destination already exists; transfer is retained', 'DESTINATION_EXISTS')
      if (status === 401 || status === 403) throw new HttpError(403, 'S3 access was denied', 'STORAGE_PERMISSION')
      throw new HttpError(503, 'S3 target is unavailable. Check the connection and retry.', 'STORAGE_UNAVAILABLE')
    }
  }
  private async objects(prefix: string, delimiter?: string) {
    const objects: { Key?: string; Size?: number; LastModified?: Date }[] = [], prefixes: string[] = []
    let token: string | undefined
    do {
      const page = await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.connection.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token })))
      objects.push(...page.Contents ?? []); prefixes.push(...(page.CommonPrefixes ?? []).map(p => p.Prefix!)); token = page.NextContinuationToken
    } while (token)
    return { objects, prefixes }
  }
  async list(directory: string) {
    if ((await this.stat(directory)).kind !== 'directory') throw new HttpError(400, 'Choose a directory')
    const prefix = this.key(directory).replace(/\/?$/, '/').replace(/^\/$/, '')
    const { objects, prefixes } = await this.objects(prefix, '/'), entries = new Map<string, FileEntry>()
    for (const key of prefixes) {
      const name = key.slice(prefix.length).replace(/\/$/, '')
      if (!name) continue
      try { validName(name) } catch { continue }
      entries.set(name, { name, path: posix.join(directory, name), kind: 'directory', size: 0, modifiedAt: new Date(0).toISOString() })
    }
    for (const object of objects) {
      const name = object.Key!.slice(prefix.length)
      if (!name || name.includes('/') || name.toLowerCase().startsWith('.filebrowser-')) continue
      try { validName(name) } catch { continue }
      entries.set(name, { name, path: posix.join(directory, name), kind: 'file', size: object.Size ?? 0, modifiedAt: (object.LastModified ?? new Date(0)).toISOString() })
    }
    return [...entries.values()]
  }
  async *walk(directory: string): AsyncIterable<FileEntry> { for (const entry of await this.list(directory)) { yield entry; if (entry.kind === 'directory') yield* this.walk(entry.path) } }
  async stat(path: string): Promise<FileEntry> {
    path = normalizePath(path)
    const directory = { name: posix.basename(path), path, kind: 'directory' as const, size: 0, modifiedAt: new Date(0).toISOString() }
    if (path === '/') { await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.connection.bucket, Prefix: this.key('/') ? this.key('/') + '/' : '', MaxKeys: 1 }))); return directory }
    try {
      const head = await this.send(() => this.client.send(new HeadObjectCommand({ Bucket: this.connection.bucket, Key: this.key(path) })))
      return { name: posix.basename(path), path, kind: 'file', size: head.ContentLength ?? 0, modifiedAt: (head.LastModified ?? new Date(0)).toISOString() }
    } catch (error) { if (!isFsError(error, 'ENOENT')) throw error }
    const result = await this.send(() => this.client.send(new ListObjectsV2Command({ Bucket: this.connection.bucket, Prefix: this.key(path) + '/', MaxKeys: 1 })))
    if (result.KeyCount) return directory
    throw Object.assign(new Error('Object not found'), { code: 'ENOENT' })
  }
  async open(path: string, range?: { start: number; end: number }) {
    const result = await this.send(() => this.client.send(new GetObjectCommand({ Bucket: this.connection.bucket, Key: this.key(path), Range: range ? `bytes=${range.start}-${range.end}` : undefined })))
    if (!(result.Body instanceof Readable)) throw new HttpError(503, 'S3 returned an invalid object stream')
    return result.Body
  }
  async mkdir(path: string, authorize: () => void = () => {}) {
    this.writable(); await this.absent(path)
    authorize()
    await this.send(() => this.client.send(new PutObjectCommand({ Bucket: this.connection.bucket, Key: this.key(path) + '/', Body: '', ContentLength: 0, IfNoneMatch: '*' })))
  }
  private async absent(path: string) { try { await this.stat(path); throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' }) } catch (e) { if (!isFsError(e, 'ENOENT')) throw e } }
  async move(source: string, destination: string, authorize: () => void = () => {}) {
    this.writable(); const info = await this.stat(source); await this.absent(destination)
    if (info.kind === 'directory') throw new HttpError(400, 'S3 directory renames are not supported; rename individual objects')
    // Use multipart streaming copy to retain checksums and conditional publication,
    // without a full local file or S3's 5 GiB single-copy limit.
    const id = crypto.randomUUID(), token = await this.createStage(id, destination)
    try {
      let offset = 0
      while (offset < info.size) {
        authorize()
        const size = Math.min(100 * 1024 * 1024, info.size - offset)
        await this.prepareChunk(id, size)
        const stream = await this.open(source, { start: offset, end: offset + size - 1 })
        await this.writePart(id, 0, size, stream, () => { try { authorize(); return true } catch { return false } })
        const { createHash } = await import('node:crypto'), hash = createHash('sha256')
        for await (const bytes of createReadStream(this.chunks.chunk(id))) hash.update(bytes)
        await this.verifyChunk(id, hash.digest('hex'), size); await this.appendChunk(id, offset, size); await this.discardChunk(id); offset += size
      }
      await this.publish(id, destination, token, info.size, authorize); authorize(); await this.removeStage(id, undefined, undefined, false); await this.remove(source, authorize)
    } catch (error) { await this.removeStage(id, destination, token); throw error }
  }
  async remove(path: string, authorize: () => void = () => {}) {
    this.writable(); const entry = await this.stat(path)
    if (entry.kind === 'directory') {
      if ((await this.list(path)).length) throw Object.assign(new Error('Directory is not empty'), { code: 'ENOTEMPTY' })
      path += '/'
    }
    authorize()
    await this.send(() => this.client.send(new DeleteObjectCommand({ Bucket: this.connection.bucket, Key: this.key(path) + (entry.kind === 'directory' ? '/' : '') })))
  }
  async space() { return { total: null, available: null } }
  async createStage(id: string, destination: string) {
    this.writable()
    const response = await this.send(() => this.client.send(new CreateMultipartUploadCommand({ Bucket: this.connection.bucket, Key: this.key(destination), ChecksumAlgorithm: 'SHA256', Metadata: { 'filebrowser-upload-id': id } })))
    const stage: Stage = { id, destination, uploadId: response.UploadId!, parts: [] }
    try { await this.chunks.create(id, stage) }
    catch (error) { await this.send(() => this.client.send(new AbortMultipartUploadCommand({ Bucket: this.connection.bucket, Key: this.key(destination), UploadId: stage.uploadId }))); throw error }
    return JSON.stringify({ id, destination, uploadId: stage.uploadId })
  }
  async restoreStage(id: string, destination: string, token: string) {
    const identity = JSON.parse(token) as Stage, stage = await this.chunks.load<Stage>(id)
    if (identity.id !== id || identity.destination !== destination || stage.uploadId !== identity.uploadId) throw new HttpError(409, 'Upload identity changed', 'DATA_LOSS')
  }
  async stageSize(id: string) { return (await this.chunks.load<Stage>(id)).parts.at(-1)?.end ?? 0 }
  async resetTo(id: string, bytes: number) {
    const stage = await this.chunks.load<Stage>(id)
    if ((stage.parts.at(-1)?.end ?? 0) < bytes) throw new HttpError(409, 'Upload receipts are missing', 'DATA_LOSS')
    stage.parts = stage.parts.filter(p => p.end <= bytes)
    if (!this.restored.has(id) && bytes) {
      let marker: string | undefined
      const remote = new Map<number, { ETag?: string; ChecksumSHA256?: string; Size?: number }>()
      try {
        do {
          const page = await this.send(() => this.client.send(new ListPartsCommand({ Bucket: this.connection.bucket, Key: this.key(stage.destination), UploadId: stage.uploadId, PartNumberMarker: marker })))
          for (const part of page.Parts ?? []) remote.set(part.PartNumber!, part)
          marker = page.IsTruncated ? page.NextPartNumberMarker : undefined
        } while (marker)
      } catch (error) { if (isFsError(error, 'ENOENT')) throw new HttpError(409, 'Saved S3 multipart upload is missing', 'DATA_LOSS'); throw error }
      let previous = 0
      for (const part of stage.parts) {
        const saved = remote.get(part.PartNumber)
        if (!saved || saved.ETag !== part.ETag || saved.ChecksumSHA256 !== part.ChecksumSHA256 || saved.Size !== part.end - previous) throw new HttpError(409, 'Saved S3 parts failed integrity verification', 'DATA_LOSS')
        previous = part.end
      }
    }
    this.restored.add(id); await this.chunks.save(id, stage)
  }
  prepareChunk(id: string, size: number) { this.writable(); return this.chunks.prepare(id, size) }
  writePart(id: string, offset: number, size: number, source: Readable, valid: () => boolean) { return this.chunks.write(id, offset, size, source, valid) }
  verifyChunk(id: string, hash: string, size: number) { return this.chunks.verify(id, hash, size) }
  async appendChunk(id: string, offset: number, size: number) {
    this.writable()
    const stage = await this.chunks.load<Stage>(id), checksum = Buffer.from(this.chunks.hash(id), 'hex').toString('base64'), number = stage.parts.length + 1
    if ((stage.parts.at(-1)?.end ?? 0) !== offset) throw new HttpError(409, 'Upload checkpoint changed')
    const source = createReadStream(this.chunks.chunk(id))
    try {
      const response = await this.send(() => this.client.send(new UploadPartCommand({ Bucket: this.connection.bucket, Key: this.key(stage.destination), UploadId: stage.uploadId,
        PartNumber: number, Body: source, ContentLength: size, ChecksumSHA256: checksum })))
      if (response.ChecksumSHA256 !== checksum || !response.ETag) throw new HttpError(422, 'S3 did not acknowledge the chunk checksum', 'CHECKSUM_MISMATCH')
      stage.parts.push({ PartNumber: number, ETag: response.ETag, ChecksumSHA256: checksum, end: offset + size }); await this.chunks.save(id, stage)
    } finally { source.destroy() }
  }
  discardChunk(id: string) { return this.chunks.discard(id) }
  async isPublished(destination: string, token: string, size: number) {
    const identity = JSON.parse(token) as Stage
    try {
      const response = await this.send(() => this.client.send(new HeadObjectCommand({ Bucket: this.connection.bucket, Key: this.key(destination) })))
      return response.ContentLength === size && response.Metadata?.['filebrowser-upload-id'] === identity.id
    } catch (e) { if (isFsError(e, 'ENOENT')) return false; throw e }
  }
  async publish(id: string, destination: string, token: string, size: number, authorize: () => void = () => {}) {
    this.writable(); if (await this.isPublished(destination, token, size)) return
    const stage = await this.chunks.load<Stage>(id)
    authorize()
    if (!size) {
      await this.send(() => this.client.send(new PutObjectCommand({ Bucket: this.connection.bucket, Key: this.key(destination), Body: '', ContentLength: 0, IfNoneMatch: '*', Metadata: { 'filebrowser-upload-id': id } })))
      await this.send(() => this.client.send(new AbortMultipartUploadCommand({ Bucket: this.connection.bucket, Key: this.key(destination), UploadId: stage.uploadId })))
      return
    }
    if (stage.parts.at(-1)?.end !== size) throw new HttpError(409, 'Upload length changed', 'DATA_LOSS')
    await this.send(() => this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.connection.bucket, Key: this.key(destination), UploadId: stage.uploadId,
      IfNoneMatch: '*', MultipartUpload: { Parts: stage.parts.map(({ PartNumber, ETag, ChecksumSHA256 }) => ({ PartNumber, ETag, ChecksumSHA256 })) } })))
  }
  async removeStage(id: string, _destination?: string, _token?: string, removePending = true) {
    if (removePending) {
      let stage: Stage
      try { stage = await this.chunks.load<Stage>(id) } catch (e) { if (isFsError(e, 'ENOENT')) { await this.chunks.remove(id); return } throw e }
      try { await this.send(() => this.client.send(new AbortMultipartUploadCommand({ Bucket: this.connection.bucket, Key: this.key(stage.destination), UploadId: stage.uploadId }))) }
      catch (e) { if (!isFsError(e, 'ENOENT')) throw e }
    }
    this.restored.delete(id); await this.chunks.remove(id)
  }
  async orphanStages(validIds: Set<string>) { for (const id of await this.chunks.ids()) if (!validIds.has(id)) await this.removeStage(id) }
  close() { this.client.destroy() }
}
