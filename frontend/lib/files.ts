import { useEffect, useState } from 'react'
import type { FileEntry } from '@/shared/types'
import { api, errorMessage } from '../api'
import { targetFiles } from './targets'
import { contentUrl, fileType } from './format'

export type SortKey = 'name' | 'size' | 'modifiedAt' | 'type'
export const SORT_KEYS: readonly SortKey[] = ['name', 'size', 'modifiedAt', 'type']
export const SORT_LABELS: Record<SortKey, string> = { name: 'Name', size: 'Size', modifiedAt: 'Modified', type: 'Type' }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export function sortEntries(entries: FileEntry[], key: SortKey, ascending: boolean) {
  const direction = ascending ? 1 : -1
  return [...entries].sort((a, b) => {
    const folders = Number(b.kind === 'directory') - Number(a.kind === 'directory')
    if (folders) return folders
    const value = key === 'size' ? a.size - b.size
      : key === 'modifiedAt' ? Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)
        : key === 'type' ? collator.compare(fileType(a).label, fileType(b).label) : 0
    return (value || collator.compare(a.name, b.name)) * direction
  })
}

function nativeDownload(url: string, name?: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name ?? ''
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

export async function downloadFolder(targetId: string, path: string) {
  const ticket = await api<{ url: string }>(targetFiles(targetId) + '/archive-tickets', { method: 'POST', body: { paths: [path] } })
  nativeDownload(ticket.url)
}

export async function download(targetId: string, entries: FileEntry[]) {
  const ready = entries.filter(entry => !entry.uploading)
  if (!ready.length) return
  if (ready.length === 1 && ready[0].kind === 'file') {
    nativeDownload(contentUrl(targetId, ready[0].path), ready[0].name)
    return
  }
  const ticket = await api<{ url: string }>(targetFiles(targetId) + '/archive-tickets', { method: 'POST', body: { paths: ready.map(entry => entry.path) } })
  nativeDownload(ticket.url)
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return }
  catch { /* Clipboard API needs a secure context; fall back below. */ }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

interface Summary { folders: number; files: number; bytes: number; uploading: number }
export function summarize(entries: FileEntry[]): Summary {
  const summary = { folders: 0, files: 0, bytes: 0, uploading: 0 }
  for (const entry of entries) {
    if (entry.kind === 'directory') summary.folders++
    else { summary.files++; summary.bytes += entry.size }
    if (entry.uploading) summary.uploading++
  }
  return summary
}

type Loaded<T> = { key: string; value?: T; error?: string }

/** Fetches a directory listing for side panels. Pass null to skip. */
export function useListing(targetId: string, path: string | null, delay = 0) {
  const [state, setState] = useState<Loaded<FileEntry[]>>({ key: '' })
  useEffect(() => {
    if (path === null) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      api<{ entries: FileEntry[] }>(targetFiles(targetId) + '?path=' + encodeURIComponent(path), { signal: controller.signal })
        .then(data => setState({ key: targetId + path, value: data.entries }))
        .catch(error => { if (!controller.signal.aborted) setState({ key: targetId + path, error: errorMessage(error) }) })
    }, delay)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [targetId, path, delay])
  return path !== null && state.key === targetId + path ? state : { key: path ?? '', value: undefined, error: undefined, loading: path !== null }
}

/** Fetches a plain-text preview through the sandboxed preview endpoint. Pass null to skip. */
export function useTextPreview(targetId: string, path: string | null, delay = 0) {
  const [state, setState] = useState<Loaded<string>>({ key: '' })
  useEffect(() => {
    if (path === null) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(contentUrl(targetId, path, true), { signal: controller.signal, credentials: 'same-origin' })
        if (!response.ok) {
          const data = await response.json().catch(() => ({ message: 'Preview is unavailable' }))
          throw new Error(data.message)
        }
        const text = await response.text()
        setState({ key: targetId + path, value: text })
      } catch (error) {
        if (!controller.signal.aborted) setState({ key: targetId + path, error: errorMessage(error) })
      }
    }, delay)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [targetId, path, delay])
  return path !== null && state.key === targetId + path ? state : { key: path ?? '', value: undefined, error: undefined }
}
