import { useState, type FormEvent } from 'react'
import { IconFileZip } from '@tabler/icons-react'
import { ARCHIVE_FORMATS, type ArchiveFormat, type FileEntry } from '@/shared/types'
import { archiveStem } from '@/shared/archive-rules'
import { isValidFileName, MAX_NAME_BYTES } from '@/shared/file-rules'
import { errorMessage } from '../../api'
import { Modal } from '../../components/Modal'
import { Spinner } from '../../components/ui'
import { plural } from '../../lib/format'
import { useOperations } from '../../operations/context'

export function ArchiveDialog({ targetId, operation, entries, directory, onClose, onStarted }: {
  targetId: string; operation: 'compress' | 'decompress'; entries: FileEntry[]; directory: string; onClose: () => void; onStarted: () => void
}) {
  const { start } = useOperations()
  const compress = operation === 'compress'
  const [format, setFormat] = useState<ArchiveFormat>('zip')
  const [name, setName] = useState(compress ? (entries.length === 1 ? entries[0].name : 'archive') + '.zip' : archiveStem(entries[0].name))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const trimmed = name.trim()
  const valid = isValidFileName(trimmed) && (!compress || trimmed.toLowerCase().endsWith('.' + format))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      await start('archive.' + operation, { targetId, paths: entries.map(entry => entry.path), directory, name: trimmed, ...(compress ? { format } : {}) })
      onStarted()
    } catch (error) { setError(errorMessage(error)); setBusy(false) }
  }
  return <Modal title={compress ? 'Compress' : 'Decompress'} icon={<IconFileZip size={17} />} onClose={() => !busy && onClose()}
    description={compress ? `${plural(entries.length, 'item')} selected` : entries[0].name}>
    <form onSubmit={event => void submit(event)}>
      <div className="modal-body">
        {compress && <div className="field"><label htmlFor="archive-format">Format</label>
          <select id="archive-format" className="input" value={format} onChange={event => {
            const next = event.target.value as ArchiveFormat
            setName(current => current.toLowerCase().endsWith('.' + format) ? current.slice(0, -(format.length + 1)) + '.' + next : current + '.' + next)
            setFormat(next)
          }}>{ARCHIVE_FORMATS.map(format => <option key={format} value={format}>{format === 'tar' ? 'TAR (uncompressed)' : format.toUpperCase()}</option>)}</select>
        </div>}
        <div className="field"><label htmlFor="archive-name">{compress ? 'Archive name' : 'Destination folder name'}</label>
          <input id="archive-name" className="input" data-autofocus required maxLength={MAX_NAME_BYTES} value={name} spellCheck={false} onChange={event => setName(event.target.value)} aria-invalid={!!trimmed && !valid} />
          {!!trimmed && !valid && <span className="field-error">{!isValidFileName(trimmed) ? 'Choose a valid file name without slashes.' : `Use the .${format} extension.`}</span>}
        </div>
        <p className="dialog-note">{compress ? 'The archive will be saved in' : 'A new folder will be created in'} <span className="mono">{directory}</span>. Existing names are kept. A progress window will open when the operation starts.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid || busy}>{busy ? <Spinner /> : compress ? 'Compress' : 'Decompress'}</button>
      </footer>
    </form>
  </Modal>
}
