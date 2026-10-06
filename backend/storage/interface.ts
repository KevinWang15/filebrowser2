import type { Readable } from 'node:stream'
import type { FileEntry } from '@/shared/types'

// Inspired by rclone's Fs/Object/Features separation. Operations expose virtual paths,
// never backend-native paths. A remote adapter can provide multipart instead of append.
export interface StorageBackend {
  readonly name: string
  readonly type: string
  readonly capabilities: { rangeRead: boolean; atomicMove: boolean; sequentialUpload: boolean }
  list(directory: string): Promise<FileEntry[]>
  stat(path: string): Promise<FileEntry>
  open(path: string, range?: { start: number; end: number }): Promise<Readable>
  mkdir(path: string): Promise<void>
  move(source: string, destination: string): Promise<void>
  remove(path: string): Promise<void>
  space(): Promise<{ total: number; available: number }>
}

export interface SequentialUploadBackend {
  createStage(id: string, destination: string): Promise<string>
  restoreStage(id: string, destination: string, inode: string): Promise<void>
  stageSize(id: string): Promise<number>
  resetTo(id: string, committedBytes: number): Promise<void>
  prepareChunk(id: string, size: number): Promise<void>
  writePart(id: string, offset: number, size: number, source: Readable, isValid: () => boolean): Promise<void>
  verifyChunk(id: string, expectedHash: string, size: number): Promise<void>
  appendChunk(id: string, committedBytes: number, size: number): Promise<void>
  discardChunk(id: string): Promise<void>
  publish(id: string, destination: string, inode: string, size: number): Promise<void>
  isPublished(destination: string, inode: string, size: number): Promise<boolean>
  removeStage(id: string, destination?: string, inode?: string, removePending?: boolean): Promise<void>
  orphanStages(validIds: Set<string>, knownIds: Set<string>): Promise<void>
}
