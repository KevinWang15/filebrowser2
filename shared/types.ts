export const CHUNK_SIZE = 100 * 1024 * 1024
export const MAX_FILE_SIZE = 1024 ** 4
export const MAX_CHUNKS = 12_000
export const PERMISSIONS = ['read', 'download', 'upload', 'create', 'rename', 'delete'] as const
export type Permission = typeof PERMISSIONS[number]
export type Permissions = Record<Permission, boolean>
export const FULL_PERMISSIONS: Permissions = { read: true, download: true, upload: true, create: true, rename: true, delete: true }
export const READ_PERMISSIONS: Permissions = { read: true, download: true, upload: false, create: false, rename: false, delete: false }

export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  grants: TargetGrant[]
  disabled: boolean
  createdAt: string
}

export type TargetType = 'local' | 's3' | 'ftp' | 'sftp'
export interface TargetGrant { targetId: string; scope: string; permissions: Permissions }
export interface TargetAccess extends User { targetId: string; scope: string; permissions: Permissions; storageReadOnly: boolean }
export interface TargetCapabilities {
  rangeRead: boolean; atomicMove: boolean; sequentialUpload: boolean; readOnly: boolean
  directoryExport: boolean; durableUpload: boolean; exclusivePublish: boolean; minChunkSize: number; maxChunks: number
}
export type TargetConnection =
  | { type: 'local'; root: string }
  | { type: 's3'; bucket: string; region: string; endpoint: string; prefix: string; accessKeyId: string; secretAccessKey: string; sessionToken: string; forcePathStyle: boolean }
  | { type: 'ftp'; host: string; port: number; username: string; password: string; root: string; tls: boolean }
  | { type: 'sftp'; host: string; port: number; username: string; password: string; privateKey: string; passphrase: string; root: string; hostKey: string }
export interface Target {
  id: string; name: string; type: TargetType; enabled: boolean; readOnly: boolean; createdAt: string
  capabilities: TargetCapabilities
}
export interface AdminTarget extends Target { connection: TargetConnection; secrets: string[] }

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: string
  uploading?: boolean
}

export interface Bootstrap {
  needsSetup: boolean
  siteName: string
  user: User | null
  targets: Target[]
  setupLocalPath: string
  setupLocalReadOnly: boolean
  upload: { chunkSize: number; maxFileSize: number; maxConnections: number }
}

export interface UploadManifest {
  targetId: string
  name: string
  directory: string
  size: number
  lastModified: number
  chunkSize: number
  hashes: string[]
}

export interface UploadSession {
  id: string
  targetId: string
  name: string
  directory: string
  size: number
  chunkSize: number
  totalChunks: number
  nextChunk: number
  committedBytes: number
  manifestHash: string
  status: 'uploading' | 'publishing' | 'canceling' | 'completed' | 'canceled' | 'failed'
  createdAt: string
  updatedAt: string
  error: string | null
}

export interface ChunkAttempt {
  id: string
  index: number
  parts: { index: number; offset: number; size: number }[]
}

export interface AuditEntry {
  id: number
  actor: string
  action: string
  detail: string
  createdAt: string
  targetId: string | null
}

export interface SystemInfo {
  targets: { id: string; name: string; type: TargetType; total: number | null; available: number | null; error: string | null }[]
  users: number
  activeUploads: number
  version: string
}

export interface NetworkShare {
  id: string
  targetId: string
  targetName: string
  protocol: string
  name: string
  path: string
  ownerId: string
  ownerName: string
  username: string
  enabled: boolean
  readOnly: boolean
  status: 'active' | 'pending' | 'disabled' | 'blocked' | 'unavailable'
  message: string
  createdAt: string
}

export interface NetworkShares {
  host: string | null
  configured: boolean
  available: boolean
  protocols: { id: string; name: string; readOnly: boolean }[]
  shares: NetworkShare[]
}

export interface ShareCredentials {
  share: NetworkShare
  username: string
  password: string | null
}
