import { useEffect, useRef, useState } from 'react'
import { IconCloudUpload, IconFolder, IconShieldCheck } from '@tabler/icons-react'
import type { Bootstrap } from '@/shared/types'
import { Modal } from '../components/Modal'
import { formatBytes } from '../lib/format'
import { droppedFiles, selectedFiles, type UploadSource } from '../lib/upload-files'
import { errorMessage } from '../api'

const CONNECTION_OPTIONS = [
  { value: '1', label: '1 — Best for unstable connections' },
  { value: '2', label: '2 — Balanced' },
  { value: '4', label: '4 — Faster connections' },
] as const

export function UploadDialog({ targetName, directory, allowFolders, limits, connections, onConnections, onFiles, onClose }: {
  targetName: string; directory: string; allowFolders: boolean; limits: Bootstrap['upload']; connections: '1' | '2' | '4'; onConnections: (value: '1' | '2' | '4') => void
  onFiles: (files: UploadSource[]) => void; onClose: () => void
}) {
  const [over, setOver] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [folderPicker] = useState(() => 'webkitdirectory' in document.createElement('input'))
  const input = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const scan = useRef<AbortController | null>(null)
  useEffect(() => () => { scan.current?.abort() }, [])
  const choose = (files: UploadSource[]) => {
    if (!files.length) { setError('This selection contains no files to upload.'); return }
    setError(''); onFiles(files)
  }
  const drop = (data: DataTransfer) => {
    scan.current?.abort()
    const controller = new AbortController(); scan.current = controller
    setScanning(true); setError('')
    void droppedFiles(data, controller.signal).then(files => { if (!controller.signal.aborted) choose(files) })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
      .finally(() => { if (!controller.signal.aborted) setScanning(false) })
  }
  return <Modal title="Upload files" icon={<IconCloudUpload size={17} />} size="md"
    description={<span className="inline-icon"><IconFolder size={13} /><span>Uploading to <span className="mono">{targetName} · {directory}</span></span></span>} onClose={() => { scan.current?.abort(); onClose() }}>
    <div className="modal-body upload-body">
      <button type="button" className={`dropzone ${over ? 'is-over' : ''}`} onClick={() => input.current?.click()} disabled={scanning} data-autofocus
        onDragOver={event => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={event => { event.preventDefault(); setOver(false); drop(event.dataTransfer) }}>
        <span className="dropzone-icon"><IconCloudUpload size={24} stroke={1.5} /></span>
        <strong>{scanning ? 'Reading folder contents…' : <>Drop files{allowFolders ? ' or folders' : ''} here or <span className="link">browse</span></>}</strong>
        <span className="dim">Up to <span className="mono">{formatBytes(limits.maxFileSize)}</span> per file · <span className="mono">{formatBytes(limits.chunkSize)}</span> verified chunks</span>
      </button>
      {allowFolders && folderPicker && <div className="field">
        <button type="button" className="btn" disabled={scanning} onClick={() => folderInput.current?.click()}><IconFolder size={16} />Choose folder</button>
        <span className="field-hint">Folder paths are preserved. Empty folders aren’t included.</span>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="field field-inline">
        <div>
          <label htmlFor="upload-connections">Connections per chunk</label>
          <span className="field-hint">Parallel requests used inside each chunk.</span>
        </div>
        <select id="upload-connections" className="select" value={connections} onChange={event => onConnections(event.target.value as '1' | '2' | '4')}>
          {CONNECTION_OPTIONS.filter(option => Number(option.value) <= limits.maxConnections).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <input ref={input} className="hidden" type="file" multiple tabIndex={-1} onChange={event => { const files = selectedFiles(Array.from(event.target.files ?? [])); event.target.value = ''; choose(files) }} />
      {allowFolders && folderPicker && <input ref={element => { folderInput.current = element; if (element) element.webkitdirectory = true }} className="hidden" type="file" tabIndex={-1}
        onChange={event => { const files = selectedFiles(Array.from(event.target.files ?? [])); event.target.value = ''; choose(files) }} />}
      <p className="callout callout-muted"><IconShieldCheck size={15} /><span>Every chunk is SHA-256 verified before it is saved. If the connection drops, progress resumes from the last verified chunk — even after a reload.</span></p>
    </div>
  </Modal>
}
