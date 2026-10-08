import { useEffect, useEffectEvent } from 'react'
import { IconChevronLeft, IconChevronRight, IconCloudUpload, IconCopy, IconDownload, IconPencil, IconTrash } from '@tabler/icons-react'
import type { FileEntry, TargetAccess } from '@/shared/types'
import { FileIcon } from '../../components/FileIcon'
import { Modal } from '../../components/Modal'
import { fileType, formatBytes, formatFull, previewKind } from '../../lib/format'
import { can } from '../../lib/permissions'
import { Preview } from './Preview'

/** Full file view: preview on the left, metadata and actions on the right. Arrow keys step through the folder's files. */
export function FileViewer({ entry, siblings, user, onClose, onStep, onDownload, onRename, onDelete, onCopyPath, onTransfers }: {
  entry: FileEntry; siblings: FileEntry[]; user: TargetAccess; onClose: () => void; onStep: (entry: FileEntry) => void
  onDownload: () => void; onRename: () => void; onDelete: () => void; onCopyPath: () => void; onTransfers: () => void
}) {
  const index = siblings.findIndex(item => item.path === entry.path)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined
  const step = useEffectEvent((event: KeyboardEvent) => {
    if ((event.target as HTMLElement).closest('input, textarea, select')) return
    if (event.key === 'ArrowLeft' && previous) { event.preventDefault(); onStep(previous) }
    if (event.key === 'ArrowRight' && next) { event.preventDefault(); onStep(next) }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => step(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])
  const type = fileType(entry)
  const ready = !entry.uploading
  const hasPreview = ready && previewKind(entry) !== null && (previewKind(entry) === 'text' ? can(user, 'read') : can(user, 'download'))
  return <Modal size="xl" className="viewer" icon={<FileIcon entry={entry} size={18} />} title={entry.name}
    description={<>{type.label} · <span className="mono">{formatBytes(entry.size)}</span>{siblings.length > 1 && index >= 0 && <span className="dim"> · {index + 1} of {siblings.length}</span>}</>}
    onClose={onClose}>
    <div className="modal-body viewer-body">
      <div className="viewer-stage">
        {hasPreview ? <Preview key={entry.path} entry={entry} user={user} className="text-preview" />
          : <div className="viewer-placeholder"><FileIcon entry={entry} size={56} /><span>{entry.uploading ? 'Preview is available after the upload completes.' : 'No preview available for this file type.'}</span>
            {ready && can(user, 'download') && <button type="button" className="btn btn-sm" onClick={onDownload} tabIndex={-1}><IconDownload size={14} />Download to view</button>}</div>}
        {previous && <button type="button" className="viewer-nav is-prev" aria-label="Previous file" data-tip="Previous (←)" onClick={() => onStep(previous)}><IconChevronLeft size={18} /></button>}
        {next && <button type="button" className="viewer-nav is-next" aria-label="Next file" data-tip="Next (→)" onClick={() => onStep(next)}><IconChevronRight size={18} /></button>}
      </div>
      <aside className="viewer-side">
        {entry.uploading && <div className="callout callout-accent"><IconCloudUpload size={15} />
          <p>This file is still uploading. Its final name becomes available when every chunk is verified. <button type="button" className="link" onClick={onTransfers}>Use Transfers</button> to resume or cancel it.</p></div>}
        <div className="viewer-actions">
          {ready && can(user, 'download') && <button type="button" className="btn btn-primary" onClick={onDownload}><IconDownload size={15} />Download</button>}
          {ready && can(user, 'rename') && <button type="button" className="btn" onClick={onRename}><IconPencil size={15} />Rename</button>}
          {ready && can(user, 'delete') && <button type="button" className="btn btn-danger-ghost" onClick={onDelete}><IconTrash size={15} />Delete</button>}
        </div>
        <dl className="meta-list">
          <div><dt>Type</dt><dd>{type.label}</dd></div>
          <div><dt>Size</dt><dd className="mono" title={`${entry.size.toLocaleString()} bytes`}>{formatBytes(entry.size)}</dd></div>
          <div><dt>Bytes</dt><dd className="mono">{entry.size.toLocaleString()}</dd></div>
          <div><dt>Modified</dt><dd className="mono">{formatFull(entry.modifiedAt)}</dd></div>
          <div><dt>Location</dt><dd className="mono path-value">{entry.path}<button type="button" className="icon-btn icon-btn-sm" aria-label="Copy path" data-tip="Copy path" onClick={onCopyPath}><IconCopy size={13} /></button></dd></div>
        </dl>
        <p className="viewer-hint"><kbd className="kbd">←</kbd><kbd className="kbd">→</kbd> previous / next · <kbd className="kbd">Esc</kbd> close</p>
      </aside>
    </div>
  </Modal>
}
