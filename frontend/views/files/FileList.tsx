import { memo, useState, type DragEvent, type MouseEvent, type RefObject } from 'react'
import { IconArrowDown, IconArrowUp, IconCloudUpload, IconDots, IconDownload, IconPencil } from '@tabler/icons-react'
import type { FileEntry, User } from '@/shared/types'
import { FileIcon } from '../../components/FileIcon'
import { Progress } from '../../components/ui'
import { contentUrl, extension, fileType, formatBytes, formatDateTime, formatFull } from '../../lib/format'
import { SORT_LABELS, type SortKey } from '../../lib/files'
import { can } from '../../lib/permissions'
import { useWindowing } from '../../lib/useWindowing'

export type RowHandler = (entry: FileEntry, event: MouseEvent) => void
export interface ListProps {
  entries: FileEntry[]; user: User; selected: Set<string>; cursor: string | null; pending: Map<string, number>
  sort: SortKey; ascending: boolean; onSort: (key: SortKey) => void
  onRowClick: RowHandler; onOpen: (entry: FileEntry) => void; onMenu: (entry: FileEntry | null, event: MouseEvent) => void
  onToggle: (entry: FileEntry) => void; onToggleAll: (checked: boolean) => void
  onRename: (entry: FileEntry) => void; onDownload: (entry: FileEntry) => void; onDropInto: (entry: FileEntry, files: File[]) => void
  scroller: RefObject<HTMLDivElement | null>; rowHeight: number
}

const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'])
const canThumb = (entry: FileEntry, user: User) => entry.kind === 'file' && !entry.uploading && can(user, 'download') && RASTER.has(extension(entry.name)) && entry.size <= 8 * 1024 * 1024

function useFolderDrop(entry: FileEntry, user: User, onDropInto: ListProps['onDropInto']) {
  const [over, setOver] = useState(false)
  if (entry.kind !== 'directory' || !can(user, 'upload')) return { over: false, handlers: {} }
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setOver(true) } },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); setOver(false); onDropInto(entry, Array.from(event.dataTransfer.files)) },
    },
  }
}

function SelectBox({ entry, checked, onToggle }: { entry: FileEntry; checked: boolean; onToggle: (entry: FileEntry) => void }) {
  return <input type="checkbox" className="checkbox" aria-label={'Select ' + entry.name} disabled={entry.uploading} checked={!entry.uploading && checked}
    onChange={() => onToggle(entry)} onClick={event => event.stopPropagation()} />
}

function UploadingBadge({ progress }: { progress?: number }) {
  return <span className="badge badge-accent uploading-badge"><IconCloudUpload size={12} /><span>Uploading</span>{progress !== undefined && <span className="mono">{Math.floor(progress * 100)}%</span>}</span>
}

const Row = memo(function Row({ entry, props, selected, cursor, progress }: { entry: FileEntry; props: ListProps; selected: boolean; cursor: boolean; progress?: number }) {
  const { user } = props
  const drop = useFolderDrop(entry, user, props.onDropInto)
  const type = fileType(entry)
  const actions = !entry.uploading
  return <tr className={`file-row ${selected ? 'is-selected' : ''} ${cursor ? 'is-cursor' : ''} ${entry.uploading ? 'is-uploading' : ''} ${drop.over ? 'is-drop' : ''}`}
    data-path={entry.path} onClick={event => props.onRowClick(entry, event)} onDoubleClick={() => props.onOpen(entry)}
    onContextMenu={event => props.onMenu(entry, event)} {...drop.handlers}>
    <td className="col-check"><SelectBox entry={entry} checked={selected} onToggle={props.onToggle} /></td>
    <td className="col-name">
      <div className="name-cell">
        <FileIcon entry={entry} size={17} />
        <button type="button" className="name-btn" onClick={event => { event.stopPropagation(); props.onOpen(entry) }} title={entry.name}>{entry.name}</button>
        {entry.uploading && <UploadingBadge progress={progress} />}
      </div>
    </td>
    <td className="col-size mono">{entry.kind === 'directory' ? <span className="dim">—</span> : formatBytes(entry.size)}</td>
    <td className="col-type">{type.label}</td>
    <td className="col-date mono" title={formatFull(entry.modifiedAt)}>{formatDateTime(entry.modifiedAt)}</td>
    <td className="col-actions">
      <div className="row-actions">
        {actions && entry.kind === 'file' && can(user, 'download') && <button type="button" className="icon-btn icon-btn-sm" aria-label={'Download ' + entry.name} data-tip="Download"
          onClick={event => { event.stopPropagation(); props.onDownload(entry) }}><IconDownload size={15} /></button>}
        {actions && can(user, 'rename') && <button type="button" className="icon-btn icon-btn-sm" aria-label={'Rename ' + entry.name} data-tip="Rename"
          onClick={event => { event.stopPropagation(); props.onRename(entry) }}><IconPencil size={15} /></button>}
        <button type="button" className="icon-btn icon-btn-sm" aria-label={'More actions for ' + entry.name} data-tip="More"
          onClick={event => { event.stopPropagation(); props.onMenu(entry, event) }}><IconDots size={15} /></button>
      </div>
    </td>
  </tr>
})

function SortHeader({ column, props, className }: { column: SortKey; props: ListProps; className: string }) {
  const active = props.sort === column
  return <th className={className} aria-sort={active ? props.ascending ? 'ascending' : 'descending' : 'none'}>
    <button type="button" className={`th-btn ${active ? 'is-active' : ''}`} onClick={() => props.onSort(column)}>
      {SORT_LABELS[column]}{active && (props.ascending ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />)}
    </button>
  </th>
}

export function FileTable(props: ListProps) {
  const { entries, selected, scroller, rowHeight } = props
  const selectable = entries.filter(entry => !entry.uploading)
  const all = selectable.length > 0 && selectable.every(entry => selected.has(entry.path))
  const some = !all && selectable.some(entry => selected.has(entry.path))
  const range = useWindowing(scroller, entries.length, rowHeight)
  return <table className="file-table">
    <colgroup><col className="col-check" /><col /><col className="col-size" /><col className="col-type" /><col className="col-date" /><col className="col-actions" /></colgroup>
    <thead>
      <tr>
        <th className="col-check"><input type="checkbox" className="checkbox" aria-label="Select all files" disabled={!selectable.length} checked={all}
          ref={node => { if (node) node.indeterminate = some }} onChange={event => props.onToggleAll(event.target.checked)} /></th>
        <SortHeader column="name" props={props} className="col-name" />
        <SortHeader column="size" props={props} className="col-size" />
        <SortHeader column="type" props={props} className="col-type" />
        <SortHeader column="modifiedAt" props={props} className="col-date" />
        <th className="col-actions"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      {range.before > 0 && <tr className="spacer" aria-hidden="true"><td colSpan={6} style={{ height: range.before }} /></tr>}
      {entries.slice(range.start, range.end).map(entry => <Row key={entry.path} entry={entry} props={props} selected={selected.has(entry.path)}
        cursor={props.cursor === entry.path} progress={props.pending.get(entry.path)} />)}
      {range.after > 0 && <tr className="spacer" aria-hidden="true"><td colSpan={6} style={{ height: range.after }} /></tr>}
    </tbody>
  </table>
}

function Thumbnail({ entry, user }: { entry: FileEntry; user: User }) {
  const [failed, setFailed] = useState(false)
  if (!canThumb(entry, user) || failed) return <FileIcon entry={entry} size={36} />
  return <img src={contentUrl(entry.path)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
}

const Card = memo(function Card({ entry, props, selected, cursor, progress }: { entry: FileEntry; props: ListProps; selected: boolean; cursor: boolean; progress?: number }) {
  const drop = useFolderDrop(entry, props.user, props.onDropInto)
  return <div className={`file-card ${selected ? 'is-selected' : ''} ${cursor ? 'is-cursor' : ''} ${entry.uploading ? 'is-uploading' : ''} ${drop.over ? 'is-drop' : ''}`}
    data-path={entry.path} onClick={event => props.onRowClick(entry, event)} onDoubleClick={() => props.onOpen(entry)} onContextMenu={event => props.onMenu(entry, event)} {...drop.handlers}>
    <div className="card-check"><SelectBox entry={entry} checked={selected} onToggle={props.onToggle} /></div>
    <button type="button" className="icon-btn icon-btn-sm card-more" aria-label={'More actions for ' + entry.name} onClick={event => { event.stopPropagation(); props.onMenu(entry, event) }}><IconDots size={15} /></button>
    <div className="card-thumb"><Thumbnail entry={entry} user={props.user} /></div>
    <div className="card-body">
      <button type="button" className="name-btn" title={entry.name} onClick={event => { event.stopPropagation(); props.onOpen(entry) }}>{entry.name}</button>
      {entry.uploading ? <><UploadingBadge progress={progress} />{progress !== undefined && <Progress value={progress} />}</>
        : <span className="card-meta mono">{entry.kind === 'directory' ? 'Folder' : formatBytes(entry.size)} · {formatDateTime(entry.modifiedAt).slice(0, 10)}</span>}
    </div>
  </div>
})

export function FileGrid(props: ListProps) {
  return <div className="file-grid" role="list">
    {props.entries.map(entry => <Card key={entry.path} entry={entry} props={props} selected={props.selected.has(entry.path)} cursor={props.cursor === entry.path} progress={props.pending.get(entry.path)} />)}
  </div>
}

export function SkeletonRows({ rows = 8 }: { rows?: number }) {
  const widths = Array.from({ length: rows }, (_, index) => 30 + ((index * 37) % 45))
  return <div className="skeleton-list" aria-label="Loading files" role="status">
    {widths.map((width, index) => <div className="skeleton-row" key={index}>
      <span className="skeleton skeleton-icon" /><span className="skeleton" style={{ width: width + '%' }} /><span className="skeleton skeleton-short" /><span className="skeleton skeleton-short" />
    </div>)}
  </div>
}
