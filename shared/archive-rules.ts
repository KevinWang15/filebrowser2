import type { ArchiveFormat } from './types'

export function archiveFormat(name: string): ArchiveFormat | null {
  if (/\.(tar\.gz|tgz)$/i.test(name)) return 'tar.gz'
  return /\.(tar|zip|7z)$/i.exec(name)?.[1].toLowerCase() as ArchiveFormat | undefined ?? null
}

export function archiveStem(name: string) {
  return name.replace(/\.(tar\.gz|tgz|tar|zip|7z)$/i, '') || 'extracted'
}
