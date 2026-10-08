import { CHUNK_SIZE, MAX_CHUNKS, MAX_FILE_SIZE } from '@/shared/types'
import { isAbsolute, relative, resolve } from 'node:path'

export function storageLocations(root: string, state: string) {
  const storageRoot = resolve(root)
  const stateDirectory = resolve(state)
  if (storageRoot.split('/').some(part => part.toLowerCase().startsWith('.filebrowser-'))) {
    throw new Error('A local target root cannot be inside a reserved .filebrowser-* directory')
  }
  const targetLocation = relative(stateDirectory, storageRoot)
  if (!isAbsolute(targetLocation) && targetLocation !== '..' && !targetLocation.startsWith('../')) {
    throw new Error('State directory cannot contain a local target root')
  }
  const location = relative(storageRoot, stateDirectory)
  const inside = !isAbsolute(location) && location !== '..' && !location.startsWith('../')
  // Whole-filesystem browsing has no outside directory. Use the namespace that
  // the file API rejects to keep SQLite accounts/sessions private in that case.
  if (inside && !location.split('/').some(part => part.toLowerCase().startsWith('.filebrowser-'))) {
    throw new Error('State directory must be outside a local target root or inside a reserved .filebrowser-* directory. Choose a narrower target root, or move private state to a reserved directory and set FB_STATE_DIR before restarting.')
  }
  return { storageRoot, stateDirectory }
}

export function serverStorage(argv: string[] = process.argv.slice(2), env = process.env) {
  if (argv.length) throw new Error('Storage targets are configured in setup or administration; positional storage arguments are not supported')
  if (env.FB_STORAGE_ROOT || env.SERVE_PATH || env.FB_READ_ONLY) throw new Error('Global storage configuration is not supported. Configure named targets in the application.')
  return { stateDirectory: env.FB_STATE_DIR ?? './.filebrowser-state', setupLocalPath: env.FB_SETUP_LOCAL_PATH ?? './data' }
}

export function uploadConfig(chunkOverride?: number, fileOverride?: number) {
  const chunkSize = chunkOverride ?? Number(process.env.FB_UPLOAD_CHUNK_SIZE ?? CHUNK_SIZE)
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 64 * 1024 || chunkSize > CHUNK_SIZE) throw new Error('FB_UPLOAD_CHUNK_SIZE must be an integer between 65536 and 104857600 bytes')
  const maxFileSize = fileOverride ?? Number(process.env.FB_MAX_FILE_SIZE ?? Math.min(MAX_FILE_SIZE, chunkSize * MAX_CHUNKS))
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 0 || maxFileSize > MAX_FILE_SIZE || maxFileSize > chunkSize * MAX_CHUNKS) {
    throw new Error('FB_MAX_FILE_SIZE must fit the 1 TiB and 12000-chunk limits')
  }
  return { chunkSize, maxFileSize, maxConnections: 4 }
}
