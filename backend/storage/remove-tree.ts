import { HttpError, isFsError } from '../errors'
import type { StorageBackend } from './interface'
import { normalizePath } from './paths'

/** Delete addressable children first, retaining adapter path checks for every mutation. */
export async function removeTree(storage: StorageBackend, path: string, authorize: () => void): Promise<void> {
  path = normalizePath(path)
  if (path === '/') throw new HttpError(400, 'Cannot remove the storage root')
  authorize()
  const entry = await storage.stat(path)
  authorize()
  if (entry.kind === 'directory') {
    const children = await storage.list(path)
    authorize()
    for (const child of children) {
      try { await removeTree(storage, child.path, authorize) }
      catch (error) { if (!isFsError(error, 'ENOENT')) throw error; authorize() }
    }
  }
  authorize()
  try { await storage.remove(path, authorize) }
  catch (error) {
    // S3 prefixes without markers disappear as their last child is removed.
    if (entry.kind !== 'directory' || !isFsError(error, 'ENOENT')) throw error
    authorize()
  }
  authorize()
}
