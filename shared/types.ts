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
  scope: string
  permissions: Permissions
  disabled: boolean
  createdAt: string
}

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
  upload: { chunkSize: number; maxFileSize: number; maxConnections: number }
}

export interface UploadManifest {
  name: string
  directory: string
  size: number
  lastModified: number
  chunkSize: number
  hashes: string[]
}

export interface UploadSession {
  id: string
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
}

export interface SystemInfo {
  storage: { name: string; type: string; total: number; available: number; capabilities: string[] }
  users: number
  activeUploads: number
  version: string
}
