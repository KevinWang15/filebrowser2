import { MAX_CHUNKS, type TargetCapabilities, type TargetType } from '@/shared/types'

export function capabilities(type: TargetType, readOnly: boolean): TargetCapabilities {
  return { rangeRead: true, atomicMove: type === 'sftp', sequentialUpload: !readOnly, readOnly,
    directoryExport: type === 'local', durableUpload: type !== 'ftp', exclusivePublish: type !== 'ftp', minChunkSize: type === 's3' ? 5 * 1024 * 1024 : 0,
    maxChunks: type === 's3' ? 10000 : MAX_CHUNKS }
}
