import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { HttpError } from '../errors'
import type { Permission, TargetAccess } from '@/shared/types'

export function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\\') || [...input].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new HttpError(400, 'Invalid path')
  const components = input.split('/').filter(Boolean)
  if (components.some(p => p === '..' || p === '.' || p.toLowerCase().startsWith('.filebrowser-'))) throw new HttpError(400, 'This path is not allowed')
  return '/' + components.join('/')
}

export function validName(name: string): string {
  if (!name.trim() || name === '.' || name === '..' || /[/\\]/.test(name) || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || name.toLowerCase().startsWith('.filebrowser-') || Buffer.byteLength(name) > 255) {
    throw new HttpError(400, 'Use a valid file name without slashes (up to 255 bytes)')
  }
  return name
}

export function uploadingPath(destination: string): string {
  const name = posix.basename(destination)
  if (Buffer.byteLength(name + '.uploading') <= 255) return destination + '.uploading'
  // Preserve support for 255-byte names without splitting a UTF-8 character.
  const suffix = `.${createHash('sha256').update(destination).digest('hex').slice(0, 16)}.uploading`
  let prefix = ''
  for (const character of name) {
    if (Buffer.byteLength(prefix + character + suffix) > 255) break
    prefix += character
  }
  return posix.join(posix.dirname(destination), prefix + suffix)
}

export function scopedPath(user: TargetAccess, input: string): string {
  return normalizePath(posix.join(user.scope, normalizePath(input)))
}

export function requirePermission(user: TargetAccess, permission: Permission) {
  if (user.storageReadOnly && permission !== 'read' && permission !== 'download') throw new HttpError(403, 'Storage is read-only', 'STORAGE_READ_ONLY')
  if (user.disabled || (user.role !== 'admin' && !user.permissions[permission])) throw new HttpError(403, `You do not have ${permission} permission`, 'FORBIDDEN')
}

export function canAccessStoredPath(user: TargetAccess, path: string): boolean {
  return user.scope === '/' || path === user.scope || path.startsWith(user.scope + '/')
}
