import type { FileEntry } from './types'

export const MAX_PATH_LENGTH = 4096
export const MAX_NAME_BYTES = 255
const utf8 = new TextEncoder()

export function isValidFileName(name: string): boolean {
  return !!name.trim() && name !== '.' && name !== '..' &&
    ![...name].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    utf8.encode(name).length <= MAX_NAME_BYTES
}

const TEXT_PREVIEW = /\.(txt|md|json|csv|log|yaml|yml|toml|ini|ts|js|css|scss|xml)$/i
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
export function supportsTextPreview(entry: Pick<FileEntry, 'name' | 'size'>): boolean {
  return TEXT_PREVIEW.test(entry.name) && entry.size <= MAX_TEXT_PREVIEW_BYTES
}
