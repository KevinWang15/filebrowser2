import { isValidFileName, MAX_PATH_LENGTH } from '@/shared/file-rules'

export interface UploadSource { file: File; relativePath: string }
export interface UploadFolder { directory: string; name: string }

export function selectedFiles(files: FileList | File[]): UploadSource[] {
  return Array.from(files, file => ({ file, relativePath: file.webkitRelativePath || file.name }))
}

export function uploadDestination(source: UploadSource, directory: string) {
  const parts = source.relativePath.split('/')
  if (!parts.every(isValidFileName) || parts.at(-1) !== source.file.name) throw new Error(`Invalid upload path: ${source.relativePath}`)
  let parent = directory === '/' ? '' : directory
  const folders: UploadFolder[] = []
  for (const name of parts.slice(0, -1)) {
    folders.push({ directory: parent || '/', name })
    parent += '/' + name
  }
  if ((parent + '/' + source.file.name).length > MAX_PATH_LENGTH) throw new Error(`Upload path is too long: ${source.relativePath}`)
  return { file: source.file, directory: parent || '/', folders }
}

export async function droppedFiles(data: DataTransfer, signal?: AbortSignal): Promise<UploadSource[]> {
  // Entries and files must be captured while the drop event's data store is readable.
  const entries = Array.from(data.items).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry())
  const files = selectedFiles(Array.from(data.files))
  if (!entries.some(Boolean)) return files
  if (entries.some(entry => !entry)) throw new Error('Could not read all dropped items. Please select them with the file or folder picker.')
  const sources: UploadSource[] = []
  const check = () => signal?.throwIfAborted()
  async function walk(entry: FileSystemEntry, parent: string) {
    check()
    const relativePath = parent + entry.name
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
      check(); sources.push({ file, relativePath })
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // Chromium returns at most 100 entries per read. Keep reading until exhausted.
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
        check()
        if (!children.length) break
        for (const child of children) await walk(child, relativePath + '/')
      }
    } else throw new Error(`Cannot upload this item: ${relativePath}`)
  }
  for (const entry of entries) await walk(entry!, '')
  return sources
}
