import { CHUNK_SIZE, MAX_CHUNKS, MAX_FILE_SIZE } from '@/shared/types'

export function uploadConfig(chunkOverride?: number, fileOverride?: number) {
  const chunkSize = chunkOverride ?? Number(process.env.FB_UPLOAD_CHUNK_SIZE ?? CHUNK_SIZE)
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > CHUNK_SIZE) throw new Error('FB_UPLOAD_CHUNK_SIZE must be an integer between 65536 and 104857600 bytes')
  const maxFileSize = fileOverride ?? Number(process.env.FB_MAX_FILE_SIZE ?? Math.min(MAX_FILE_SIZE, chunkSize * MAX_CHUNKS))
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 0 || maxFileSize > MAX_FILE_SIZE || maxFileSize > chunkSize * MAX_CHUNKS) {
    throw new Error('FB_MAX_FILE_SIZE must fit the 1 TiB and 12000-chunk limits')
  }
  return { chunkSize, maxFileSize, maxConnections: 4 }
}
