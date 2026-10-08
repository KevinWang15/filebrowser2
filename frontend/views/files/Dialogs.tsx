import { useState, type FormEvent } from 'react'
import { IconAlertTriangle, IconFolderPlus, IconPencil, IconTrash } from '@tabler/icons-react'
import type { FileEntry } from '@/shared/types'
import { isValidFileName, MAX_NAME_BYTES } from '@/shared/file-rules'
import { targetFiles } from '../../lib/targets'
import { api, errorMessage } from '../../api'
import { FileIcon } from '../../components/FileIcon'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/ui'
import { formatBytes, plural } from '../../lib/format'

/** Create-folder and rename dialog. Rename preselects the name without its extension. */
export function NameDialog({ targetId, mode, entry, directory, onClose, onDone }: {
  targetId: string; mode: 'folder' | 'rename'; entry?: FileEntry; directory: string; onClose: () => void; onDone: (name: string) => Promise<void> | void
}) {
  const [name, setName] = useState(mode === 'rename' ? entry?.name ?? '' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const trimmed = name.trim()
  const invalid = trimmed && !isValidFileName(trimmed) ? `Use a valid name without slashes (up to ${MAX_NAME_BYTES} UTF-8 bytes).` : ''
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed || invalid) return
    setBusy(true); setError('')
    try {
      if (mode === 'folder') await api(targetFiles(targetId) + '/directories', { method: 'POST', body: { directory, name: trimmed } })
      else await api(targetFiles(targetId), { method: 'PATCH', body: { path: entry!.path, name: trimmed } })
      await onDone(trimmed)
    } catch (error) { setError(errorMessage(error)); setBusy(false) }
  }
  const label = mode === 'folder' ? 'Folder name' : 'Name'
  return <Modal title={mode === 'folder' ? 'New folder' : 'Rename'} icon={mode === 'folder' ? <IconFolderPlus size={17} /> : <IconPencil size={17} />}
    description={mode === 'folder' ? <>In <span className="mono">{directory}</span></> : <span className="mono">{entry?.path}</span>}
    onClose={() => !busy && onClose()}>
    <form onSubmit={event => void submit(event)}>
      <div className="modal-body">
        <div className="field">
          <label htmlFor="name-input">{label}</label>
          <input id="name-input" className="input" value={name} data-autofocus required maxLength={MAX_NAME_BYTES} spellCheck={false} placeholder={mode === 'folder' ? 'Untitled folder' : ''}
            aria-invalid={!!invalid || !!error}
            onChange={event => setName(event.target.value)}
            onFocus={event => {
              const dot = entry?.kind === 'file' ? name.lastIndexOf('.') : -1
              event.target.setSelectionRange(0, dot > 0 ? dot : name.length)
            }} />
          {invalid && <span className="field-error">{invalid}</span>}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !trimmed || !!invalid || (mode === 'rename' && trimmed === entry?.name)}>
          {busy ? <Spinner /> : mode === 'folder' ? 'Create folder' : 'Save name'}
        </button>
      </footer>
    </form>
  </Modal>
}

/** Deletes items one by one. Partial failures are reported and the listing is refreshed either way. */
export function DeleteDialog({ targetId, entries, onClose, onDone }: { targetId: string; entries: FileEntry[]; onClose: () => void; onDone: (deleted: number, failed: number) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [done, setDone] = useState(0)
  const folders = entries.filter(entry => entry.kind === 'directory').length
  const bytes = entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0)
  const remove = async () => {
    setBusy(true)
    const failures = new Map<string, string>()
    let deleted = 0
    for (const entry of entries) {
      try { await api(targetFiles(targetId) + '?path=' + encodeURIComponent(entry.path), { method: 'DELETE' }); deleted++; setDone(deleted) }
      catch (error) { failures.set(entry.path, errorMessage(error)) }
    }
    setErrors(failures)
    setBusy(false)
    await onDone(deleted, failures.size)
  }
  const failed = entries.filter(entry => errors.has(entry.path))
  return <Modal title={entries.length === 1 ? `Delete “${entries[0].name}”?` : `Delete ${plural(entries.length, 'item')}?`} icon={<IconTrash size={17} />}
    description="This permanently removes the items from storage." className="is-danger" onClose={() => !busy && onClose()}>
    <div className="modal-body">
      {failed.length ? <>
        <div className="callout callout-danger"><IconAlertTriangle size={15} /><p>{plural(failed.length, 'item')} could not be deleted.</p></div>
        <ul className="dialog-list">{failed.map(entry => <li key={entry.path}><FileIcon entry={entry} size={14} /><span>{entry.name}</span><span className="dialog-list-error">{errors.get(entry.path)}</span></li>)}</ul>
      </> : <>
        {entries.length > 1 && <ul className="dialog-list">{entries.slice(0, 8).map(entry => <li key={entry.path}><FileIcon entry={entry} size={14} /><span>{entry.name}</span><span className="mono dim">{entry.kind === 'file' ? formatBytes(entry.size) : ''}</span></li>)}
          {entries.length > 8 && <li className="dim">+ {entries.length - 8} more</li>}</ul>}
        <p className="dialog-note">{bytes > 0 && <><span className="mono">{formatBytes(bytes)}</span> of selected files will be freed. </>}{folders > 0 && 'Folders and all their contents will be permanently deleted.'}</p>
      </>}
    </div>
    <footer className="modal-footer">
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>{failed.length ? 'Close' : 'Cancel'}</button>
      {!failed.length && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()} data-autofocus>
        {busy ? <><Spinner />{entries.length > 1 && `${done}/${entries.length}`}</> : entries.length === 1 ? 'Delete' : 'Delete items'}
      </button>}
    </footer>
  </Modal>
}
