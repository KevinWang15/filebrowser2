import type { FileEntry } from '@/shared/types'

export { formatBytes } from '../api'

const pad = (value: number) => String(value).padStart(2, '0')

/** Compact, fixed-width timestamp used in dense tables: 2026-10-06 14:13 */
export function formatDateTime(value: string | number) {
  const date = new Date(value)
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
export function formatDate(value: string | number) {
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
export function formatFull(value: string | number) {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}
export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(Math.ceil(seconds % 60) % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
}
export const formatCount = (value: number) => value.toLocaleString()
export const plural = (count: number, word: string, many = word + 's') => `${formatCount(count)} ${count === 1 ? word : many}`
export const initials = (name: string) => name.slice(0, 2).toUpperCase()

export type FileCategory = 'folder' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'data' | 'text' | 'font' | 'other'

const TYPES: Record<string, [string, FileCategory]> = {}
const register = (category: FileCategory, label: string, extensions: string) => {
  for (const extension of extensions.split(' ')) TYPES[extension] = [label.replace('%', extension.toUpperCase()), category]
}
register('image', '% image', 'png jpg jpeg gif webp avif bmp ico heic tif tiff')
register('image', 'SVG vector', 'svg')
register('video', '% video', 'mp4 mov mkv webm avi m4v')
register('audio', '% audio', 'mp3 wav flac ogg m4a aac opus')
register('archive', '% archive', 'zip gz tgz tar 7z rar bz2 xz zst')
register('pdf', 'PDF document', 'pdf')
register('document', 'Word document', 'doc docx odt rtf')
register('spreadsheet', 'Spreadsheet', 'xls xlsx ods numbers')
register('spreadsheet', 'CSV table', 'csv tsv')
register('presentation', 'Presentation', 'ppt pptx odp key')
register('text', 'Markdown', 'md markdown mdx')
register('text', 'Plain text', 'txt')
register('text', 'Log file', 'log')
register('data', '% data', 'json yaml yml toml ini xml sql db sqlite parquet')
register('code', 'TypeScript', 'ts tsx mts cts')
register('code', 'JavaScript', 'js jsx mjs cjs')
register('code', '% source', 'py rs go java kt swift c h cpp hpp cs rb php lua sh bash zsh ps1 vue svelte')
register('code', '% stylesheet', 'css scss sass less')
register('code', 'HTML document', 'html htm')
register('font', '% font', 'ttf otf woff woff2')

/** Lowercase extension of a name, ignoring the pending-upload suffix. */
export function extension(name: string) {
  const base = name.endsWith('.uploading') ? name.slice(0, -'.uploading'.length) : name
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}
export function fileType(entry: Pick<FileEntry, 'name' | 'kind'>): { label: string; category: FileCategory } {
  if (entry.kind === 'directory') return { label: 'Folder', category: 'folder' }
  const ext = extension(entry.name)
  const known = TYPES[ext]
  if (known) return { label: known[0], category: known[1] }
  return { label: ext ? `${ext.toUpperCase()} file` : 'File', category: 'other' }
}

// Mirrors the server's preview allowlist so the UI only offers previews that can succeed.
const TEXT_PREVIEW = /\.(txt|md|json|csv|log|yaml|yml|toml|ini|ts|js|css|scss|xml)$/i
const IMAGE_PREVIEW = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
export const MAX_TEXT_PREVIEW = 1024 * 1024
export const MAX_IMAGE_PREVIEW = 25 * 1024 * 1024
export const previewKind = (entry: FileEntry): 'text' | 'image' | null =>
  entry.kind !== 'file' || entry.uploading ? null
    : TEXT_PREVIEW.test(entry.name) && entry.size <= MAX_TEXT_PREVIEW ? 'text'
      : IMAGE_PREVIEW.test(entry.name) && entry.size <= MAX_IMAGE_PREVIEW ? 'image' : null

export const contentUrl = (path: string, preview = false) => `/api/files/content?${preview ? 'preview=1&' : ''}path=${encodeURIComponent(path)}`
export const parentPath = (path: string) => path === '/' ? '/' : '/' + path.split('/').filter(Boolean).slice(0, -1).join('/')
export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? ''
