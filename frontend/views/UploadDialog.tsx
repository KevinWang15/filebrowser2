import { useRef, useState } from 'react'
import { IconCloudUpload, IconFolder, IconShieldCheck } from '@tabler/icons-react'
import type { Bootstrap } from '@/shared/types'
import { Modal } from '../components/Modal'
import { formatBytes } from '../lib/format'

const CONNECTION_OPTIONS = [
  { value: '1', label: '1 — Best for unstable connections' },
  { value: '2', label: '2 — Balanced' },
  { value: '4', label: '4 — Faster connections' },
] as const

export function UploadDialog({ targetName, directory, limits, connections, onConnections, onFiles, onClose }: {
  targetName: string; directory: string; limits: Bootstrap['upload']; connections: '1' | '2' | '4'; onConnections: (value: '1' | '2' | '4') => void
  onFiles: (files: File[]) => void; onClose: () => void
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  return <Modal title="Upload files" icon={<IconCloudUpload size={17} />} size="md"
    description={<span className="inline-icon"><IconFolder size={13} />Uploading to <span className="mono">{targetName} · {directory}</span></span>} onClose={onClose}>
    <div className="modal-body upload-body">
      <button type="button" className={`dropzone ${over ? 'is-over' : ''}`} onClick={() => input.current?.click()} data-autofocus
        onDragOver={event => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={event => { event.preventDefault(); setOver(false); onFiles(Array.from(event.dataTransfer.files)) }}>
        <span className="dropzone-icon"><IconCloudUpload size={24} stroke={1.5} /></span>
        <strong>Drop files here or <span className="link">browse</span></strong>
        <span className="dim">Up to <span className="mono">{formatBytes(limits.maxFileSize)}</span> per file · <span className="mono">{formatBytes(limits.chunkSize)}</span> verified chunks</span>
      </button>
      <div className="field field-inline">
        <div>
          <label htmlFor="upload-connections">Connections per chunk</label>
          <span className="field-hint">Parallel requests used inside each chunk.</span>
        </div>
        <select id="upload-connections" className="select" value={connections} onChange={event => onConnections(event.target.value as '1' | '2' | '4')}>
          {CONNECTION_OPTIONS.filter(option => Number(option.value) <= limits.maxConnections).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>
      <input ref={input} className="hidden" type="file" multiple tabIndex={-1} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; onFiles(files) }} />
      <p className="callout callout-muted"><IconShieldCheck size={15} /><span>Every chunk is SHA-256 verified before it is saved. If the connection drops, progress resumes from the last verified chunk — even after a reload.</span></p>
    </div>
  </Modal>
}
