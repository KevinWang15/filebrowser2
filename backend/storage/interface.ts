import type { Readable } from 'node:stream'
import type { FileEntry, TargetCapabilities } from '@/shared/types'

// Inspired by rclone's Fs/Object/Features separation. Operations expose virtual paths,
// never backend-native paths. A remote adapter can provide multipart instead of append.
export interface StorageBackend {
  readonly capabilities: TargetCapabilities
  list(directory: string): Promise<FileEntry[]>
  walk(directory: string): AsyncIterable<FileEntry>
  stat(path: string): Promise<FileEntry>
  open(path: string, range?: { start: number; end: number }): Promise<Readable>
  mkdir(path: string, authorize?: () => void): Promise<void>
  move(source: string, destination: string, authorize?: () => void): Promise<void>
  remove(path: string, authorize?: () => void): Promise<void>
  close(): void
  space(path?: string): Promise<{ total: number | null; available: number | null }>
}

export interface SequentialUploadBackend {
  createStage(id: string, destination: string): Promise<string>
  restoreStage(id: string, destination: string, token: string): Promise<void>
  stageSize(id: string): Promise<number>
  resetTo(id: string, committedBytes: number): Promise<void>
  prepareChunk(id: string, size: number): Promise<void>
  writePart(id: string, offset: number, size: number, source: Readable, isValid: () => boolean): Promise<void>
  verifyChunk(id: string, expectedHash: string, size: number): Promise<void>
  appendChunk(id: string, committedBytes: number, size: number): Promise<void>
  discardChunk(id: string): Promise<void>
  publish(id: string, destination: string, token: string, size: number, authorize?: () => void): Promise<void>
  isPublished(destination: string, token: string, size: number): Promise<boolean>
  removeStage(id: string, destination?: string, token?: string, removePending?: boolean): Promise<void>
  orphanStages(validIds: Set<string>, knownIds: Set<string>): Promise<void>
}

// Native protocol daemons require a directory identity in addition to virtual
// file operations. Remote backends can omit this capability.
export interface DirectoryExportBackend {
  directoryIdentity(path: string): Promise<{ dev: string; ino: string }>
}
