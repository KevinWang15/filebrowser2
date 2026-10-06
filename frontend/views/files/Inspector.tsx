import { IconCloudUpload, IconCopy, IconDownload, IconExternalLink, IconFolderOpen, IconPencil, IconTrash, IconX } from '@tabler/icons-react'
import type { FileEntry, User } from '@/shared/types'
import { FileIcon } from '../../components/FileIcon'
import { fileType, formatBytes, formatFull, plural, previewKind } from '../../lib/format'
import { summarize, useListing } from '../../lib/files'
import { can } from '../../lib/permissions'
import { Preview } from './Preview'

function Meta({ rows }: { rows: [string, React.ReactNode, string?][] }) {
  return <dl className="meta-list">{rows.map(([label, value, title]) => <div key={label}><dt>{label}</dt><dd title={title}>{value}</dd></div>)}</dl>
}

function FolderContents({ entry }: { entry: FileEntry }) {
  const listing = useListing(entry.path, 150)
  if (listing.error) return <p className="inspector-note">{listing.error}</p>
  if (!listing.value) return <div className="inspector-contents is-loading"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
  const summary = summarize(listing.value)
  const items = listing.value.slice(0, 8)
  return <div className="inspector-section">
    <h4>Contents <span className="dim">{plural(listing.value.length, 'item')} · {formatBytes(summary.bytes)}</span></h4>
    {items.length ? <ul className="inspector-contents">
      {items.map(child => <li key={child.path}><FileIcon entry={child} size={14} /><span>{child.name}</span><span className="mono dim">{child.kind === 'file' ? formatBytes(child.size) : ''}</span></li>)}
      {listing.value.length > items.length && <li className="dim">+ {listing.value.length - items.length} more</li>}
    </ul> : <p className="inspector-note">This folder is empty.</p>}
  </div>
}

export function Inspector({ entry, selection, folder, folderEntries, user, onClose, onOpen, onDownload, onRename, onDelete, onCopyPath, onTransfers }: {
  entry: FileEntry | null; selection: FileEntry[]; folder: string; folderEntries: FileEntry[]; user: User
  onClose: () => void; onOpen: (entry: FileEntry) => void; onDownload: (entries: FileEntry[]) => void; onRename: (entry: FileEntry) => void
  onDelete: (entries: FileEntry[]) => void; onCopyPath: (path: string) => void; onTransfers: () => void
}) {
  const header = <header className="inspector-header"><h3>Details</h3><button type="button" className="icon-btn icon-btn-sm" aria-label="Close details" data-tip="Close details" onClick={onClose}><IconX size={15} /></button></header>

  if (selection.length > 1) {
    const summary = summarize(selection)
    const files = selection.filter(item => item.kind === 'file')
    return <aside className="inspector" aria-label="Details">
      {header}
      <div className="inspector-body">
        <div className="inspector-hero is-stack">
          <div className="stack-icons">{selection.slice(0, 3).map(item => <FileIcon key={item.path} entry={item} size={22} />)}</div>
          <strong>{plural(selection.length, 'item')} selected</strong>
        </div>
        <Meta rows={[['Folders', summary.folders.toLocaleString()], ['Files', summary.files.toLocaleString()], ['Total size', formatBytes(summary.bytes), `${summary.bytes.toLocaleString()} bytes`]]} />
        <div className="inspector-actions">
          {files.length > 0 && can(user, 'download') && <button type="button" className="btn btn-sm" onClick={() => onDownload(files)}><IconDownload size={14} />Download {files.length}</button>}
          {can(user, 'delete') && <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => onDelete(selection)}><IconTrash size={14} />Delete</button>}
        </div>
        <ul className="inspector-contents">{selection.slice(0, 12).map(item => <li key={item.path}><FileIcon entry={item} size={14} /><span>{item.name}</span><span className="mono dim">{item.kind === 'file' ? formatBytes(item.size) : ''}</span></li>)}</ul>
      </div>
    </aside>
  }

  if (!entry) {
    const summary = summarize(folderEntries)
    const name = folder === '/' ? 'All files' : folder.split('/').pop()!
    return <aside className="inspector" aria-label="Details">
      {header}
      <div className="inspector-body">
        <div className="inspector-hero"><FileIcon entry={{ name, kind: 'directory' }} size={34} /><strong>{name}</strong><span className="dim">Current folder</span></div>
        <Meta rows={[['Location', <span className="mono">{folder}</span>, folder], ['Folders', summary.folders.toLocaleString()], ['Files', summary.files.toLocaleString()],
          ['Size', formatBytes(summary.bytes), `${summary.bytes.toLocaleString()} bytes, excluding subfolders`], ...(summary.uploading ? [['Uploading', summary.uploading.toLocaleString()] as [string, string]] : [])]} />
        <p className="inspector-note">Select an item to see its details. Hold <kbd className="kbd">Shift</kbd> or <kbd className="kbd">Ctrl</kbd> to select several.</p>
      </div>
    </aside>
  }

  const type = fileType(entry)
  const ready = !entry.uploading
  const preview = previewKind(entry)
  return <aside className="inspector" aria-label="Details">
    {header}
    <div className="inspector-body">
      {preview && ready ? <Preview entry={entry} user={user} className="inspector-preview" delay={120} limit={60} />
        : <div className="inspector-hero"><FileIcon entry={entry} size={34} /></div>}
      <div className="inspector-title">
        <strong title={entry.name}>{entry.name}</strong>
        <span className="dim">{type.label}{entry.kind === 'file' ? ' · ' + formatBytes(entry.size) : ''}</span>
      </div>
      {entry.uploading && <div className="callout callout-accent"><IconCloudUpload size={15} /><div>Upload in progress. The final name appears once every chunk is verified. <button type="button" className="link" onClick={onTransfers}>Open Transfers</button></div></div>}
      <div className="inspector-actions">
        {entry.kind === 'directory' && <button type="button" className="btn btn-sm" onClick={() => onOpen(entry)}><IconFolderOpen size={14} />Open</button>}
        {entry.kind === 'file' && ready && can(user, 'download') && <button type="button" className="btn btn-sm" onClick={() => onDownload([entry])}><IconDownload size={14} />Download</button>}
        {entry.kind === 'file' && ready && <button type="button" className="btn btn-sm" onClick={() => onOpen(entry)}><IconExternalLink size={14} />Open</button>}
        {ready && can(user, 'rename') && <button type="button" className="icon-btn" aria-label={'Rename ' + entry.name} data-tip="Rename" onClick={() => onRename(entry)}><IconPencil size={15} /></button>}
        <button type="button" className="icon-btn" aria-label="Copy path" data-tip="Copy path" onClick={() => onCopyPath(entry.path)}><IconCopy size={15} /></button>
        {ready && can(user, 'delete') && <button type="button" className="icon-btn is-danger" aria-label={'Delete ' + entry.name} data-tip="Delete" onClick={() => onDelete([entry])}><IconTrash size={15} /></button>}
      </div>
      <Meta rows={[
        ['Type', type.label],
        ...(entry.kind === 'file' ? [['Size', <span className="mono">{formatBytes(entry.size)}</span>, `${entry.size.toLocaleString()} bytes`] as [string, React.ReactNode, string]] : []),
        ['Modified', <span className="mono">{formatFull(entry.modifiedAt)}</span>],
        ['Location', <span className="mono">{entry.path}</span>, entry.path],
      ]} />
      {entry.kind === 'directory' && <FolderContents entry={entry} />}
    </div>
  </aside>
}
