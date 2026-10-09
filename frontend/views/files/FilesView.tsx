import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  IconAlertTriangle, IconArrowUp, IconCheck, IconCloudUpload, IconCopy, IconDownload, IconExternalLink, IconFolderOpen, IconFolderPlus, IconHome2,
  IconInfoCircle, IconLayoutGrid, IconLayoutList, IconLayoutSidebarRight, IconLayoutSidebarRightFilled, IconPencil, IconRefresh, IconSearch,
  IconSelectAll, IconSortAscending, IconTrash, IconUpload, IconX, IconChevronRight,
} from '@tabler/icons-react'
import type { FileEntry, TargetAccess } from '@/shared/types'
import { targetFiles } from '../../lib/targets'
import { api, errorMessage } from '../../api'
import { Menu, type MenuAnchor, type MenuItem } from '../../components/Menu'
import { EmptyState, Kbd, SearchField, Segmented } from '../../components/ui'
import { copyText, download, downloadFolder, SORT_KEYS, SORT_LABELS, sortEntries, summarize, type SortKey } from '../../lib/files'
import { formatBytes, parentPath, plural } from '../../lib/format'
import { shortcutBlocked } from '../../lib/modalStack'
import { useNotify } from '../../lib/notify'
import { can } from '../../lib/permissions'
import { droppedFiles, type UploadSource } from '../../lib/upload-files'
import { usePref } from '../../lib/prefs'
import { scrollRowIntoView } from '../../lib/useWindowing'
import type { Transfer } from '../../upload-engine'
import { DeleteDialog, NameDialog } from './Dialogs'
import { FileGrid, FileTable, SkeletonRows } from './FileList'
import { FileViewer } from './FileViewer'
import { Inspector } from './Inspector'

type Listing = { path: string; entries: FileEntry[]; error: string }
type Dialog = { kind: 'folder' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entries: FileEntry[] }
const ROW_HEIGHT = { compact: 32, comfortable: 40 } as const
const HEADER_HEIGHT = 30

const join = (directory: string, name: string) => (directory === '/' ? '' : directory) + '/' + name

export function FilesView({ targetName, path, user, transfers, density, folderRequest, onNavigate, onTargets, onUpload, onAddFiles, onTransfers }: {
  targetName: string; path: string; user: TargetAccess; transfers: Transfer[]; density: 'compact' | 'comfortable'; folderRequest: number
  onNavigate: (path: string) => void; onTargets: () => void; onUpload: () => void; onAddFiles: (files: UploadSource[], directory: string) => void; onTransfers: () => void
}) {
  const notify = useNotify()
  const [listing, setListing] = useState<Listing>({ path: '', entries: [], error: '' })
  const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'success'>('idle')
  const refreshController = useRef<AbortController | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [search, setSearch] = useState('')
  const [layout, setLayout] = usePref('layout', 'list', ['list', 'grid'] as const)
  const [sort, setSort] = usePref<SortKey>('sort', 'name', SORT_KEYS)
  const [order, setOrder] = usePref('order', 'asc', ['asc', 'desc'] as const)
  const [details, setDetails] = usePref('details', 'open', ['open', 'closed'] as const)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[]; label: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const dropScan = useRef<AbortController | null>(null)
  useEffect(() => () => { dropScan.current?.abort() }, [path, user.targetId])
  const currentPath = useRef<string | null>(null)
  const listingRequest = useRef(0)
  const rowHeight = ROW_HEIGHT[density]

  // The command palette asks for a new folder by bumping this counter.
  const [seenRequest, setSeenRequest] = useState(folderRequest)
  if (seenRequest !== folderRequest) { setSeenRequest(folderRequest); if (can(user, 'create')) setDialog({ kind: 'folder' }) }

  // Path changes reset view state during render rather than in an effect, so the old folder never flashes.
  const [shownPath, setShownPath] = useState(path)
  if (shownPath !== path) {
    setShownPath(path); setSelected(new Set()); setCursor(null); setAnchor(null); setSearch(''); setViewing(null); setRefreshState('idle')
  }

  const load = useCallback((target: string, signal?: AbortSignal) => {
    if (currentPath.current !== target) return Promise.resolve(false)
    const request = ++listingRequest.current
    // Manual and upload-triggered refreshes can finish after navigation or a newer refresh.
    const current = () => !signal?.aborted && currentPath.current === target && listingRequest.current === request
    return api<{ entries: FileEntry[] }>(targetFiles(user.targetId) + '?path=' + encodeURIComponent(target), { signal })
      .then(data => { if (!current()) return false; setListing({ path: target, entries: data.entries, error: '' }); return true })
      .catch(error => { if (current()) setListing({ path: target, entries: [], error: errorMessage(error) }); return false })
  }, [user.targetId])
  useEffect(() => {
    currentPath.current = path
    const controller = new AbortController()
    void load(path, controller.signal)
    return () => {
      currentPath.current = null; controller.abort()
      refreshController.current?.abort(); refreshController.current = null
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [path, load])
  const refresh = useCallback(async () => {
    if (refreshController.current || currentPath.current !== path) return
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current)
    refreshTimer.current = null
    const controller = new AbortController(); refreshController.current = controller
    setRefreshState('loading')
    const refreshed = await load(path, controller.signal)
    if (refreshController.current !== controller) return
    refreshController.current = null
    setRefreshState(refreshed ? 'success' : 'idle')
    if (refreshed) refreshTimer.current = setTimeout(() => { refreshTimer.current = null; setRefreshState('idle') }, 600)
  }, [load, path])

  // Nested uploads can create new child folders, so ancestors also refresh on session changes.
  const transferKey = transfers.filter(t => t.targetId === user.targetId && (t.directory === path || t.directory.startsWith(path === '/' ? '/' : path + '/'))).map(t => `${t.session?.id ?? t.id}:${t.state === 'completed' ? 1 : 0}`).sort().join()
  const lastKey = useRef(transferKey)
  useEffect(() => {
    if (lastKey.current === transferKey) return
    lastKey.current = transferKey
    void load(path)
  }, [transferKey, path, load])

  const pending = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of transfers) if (t.targetId === user.targetId && t.session && t.state !== 'completed' && t.size) map.set(t.session.id, Math.min(1, (t.committedBytes + t.sentBytes) / t.size))
    return map
  }, [transfers, user.targetId])

  const loading = listing.path !== path
  const entries = useMemo(() => loading ? [] : listing.entries, [loading, listing.entries])
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    return sortEntries(query ? entries.filter(entry => entry.name.toLowerCase().includes(query)) : entries, sort, order === 'asc')
  }, [entries, search, sort, order])
  const picked = useMemo(() => visible.filter(entry => selected.has(entry.path) && !entry.uploading), [visible, selected])
  const cursorEntry = visible.find(entry => entry.path === cursor) ?? null
  const viewEntry = viewing ? entries.find(entry => entry.path === viewing) ?? null : null
  const files = useMemo(() => visible.filter(entry => entry.kind === 'file'), [visible])
  const summary = useMemo(() => summarize(entries), [entries])

  const open = useCallback((entry: FileEntry) => { if (entry.kind === 'directory') onNavigate(entry.path); else setViewing(entry.path) }, [onNavigate])
  const select = (paths: string[], focus: string | null) => { setSelected(new Set(paths)); setCursor(focus); setAnchor(focus) }
  const rename = useCallback((entry: FileEntry) => setDialog({ kind: 'rename', entry }), [])
  const remove = (items: FileEntry[]) => { if (items.length) setDialog({ kind: 'delete', entries: items }) }
  const copyPath = (value: string) => { void copyText(value).then(() => notify('Path copied to clipboard.')) }
  const downloadItems = useCallback((items: FileEntry[]) => { void download(user.targetId, items).catch(error => notify(errorMessage(error), true)) }, [notify, user.targetId])
  const downloadCurrent = () => { void downloadFolder(user.targetId, path).catch(error => notify(errorMessage(error), true)) }
  const downloadOne = useCallback((entry: FileEntry) => downloadItems([entry]), [downloadItems])

  const onRowClick = useCallback((entry: FileEntry, event: MouseEvent) => {
    if (entry.uploading) { setCursor(entry.path); setSelected(new Set()); return }
    if (event.shiftKey && anchor) {
      const from = visible.findIndex(item => item.path === anchor), to = visible.findIndex(item => item.path === entry.path)
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1).filter(item => !item.uploading).map(item => item.path)
      setSelected(previous => new Set(event.metaKey || event.ctrlKey ? [...previous, ...range] : range)); setCursor(entry.path)
    } else if (event.metaKey || event.ctrlKey) {
      setSelected(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
      setCursor(entry.path); setAnchor(entry.path)
    } else { setSelected(new Set([entry.path])); setCursor(entry.path); setAnchor(entry.path) }
  }, [anchor, visible])
  const onToggle = useCallback((entry: FileEntry) => {
    setSelected(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
    setCursor(entry.path); setAnchor(entry.path)
  }, [])
  const onToggleAll = useCallback((checked: boolean) => setSelected(checked ? new Set(visible.filter(entry => !entry.uploading).map(entry => entry.path)) : new Set()), [visible])
  const onSort = useCallback((key: SortKey) => { if (key === sort) setOrder(order === 'asc' ? 'desc' : 'asc'); else { setSort(key); setOrder('asc') } }, [sort, order, setSort, setOrder])
  const dropFiles = useCallback((data: DataTransfer, directory: string) => {
    dragDepth.current = 0; setDragging(false)
    dropScan.current?.abort()
    const controller = new AbortController(); dropScan.current = controller
    void droppedFiles(data, controller.signal).then(files => {
      if (controller.signal.aborted) return
      if (files.length) onAddFiles(files, directory)
      else notify('This selection contains no files to upload.', true)
    }).catch(error => { if (!controller.signal.aborted) notify(errorMessage(error), true) })
  }, [notify, onAddFiles])
  const onDropInto = useCallback((entry: FileEntry, data: DataTransfer) => dropFiles(data, entry.path), [dropFiles])

  const entryMenu = (entry: FileEntry): MenuItem[] => {
    const many = selected.has(entry.path) && picked.length > 1
    const targets = many ? picked : [entry]
    const ready = !entry.uploading
    const downloadable = targets.filter(item => !item.uploading)
    if (many) return [
      ...(can(user, 'download') && downloadable.length ? [{ label: `Download ${downloadable.length} items`, icon: IconDownload, onSelect: () => downloadItems(downloadable) }] : []),
      ...(can(user, 'delete') ? ['separator' as const, { label: `Delete ${targets.length} items`, icon: IconTrash, danger: true, shortcut: 'Del', onSelect: () => remove(targets) }] : []),
    ]
    return [
      { label: entry.kind === 'directory' ? 'Open folder' : 'Open', icon: entry.kind === 'directory' ? IconFolderOpen : IconExternalLink, shortcut: '↵', onSelect: () => open(entry) },
      ...(ready && can(user, 'download') ? [{ label: entry.kind === 'directory' ? 'Download folder' : 'Download', icon: IconDownload, onSelect: () => downloadItems([entry]) }] : []),
      ...(entry.uploading ? [{ label: 'View in Transfers', icon: IconCloudUpload, onSelect: onTransfers }] : []),
      'separator',
      ...(ready && can(user, 'rename') ? [{ label: 'Rename', icon: IconPencil, shortcut: 'F2', onSelect: () => rename(entry) }] : []),
      { label: 'Copy path', icon: IconCopy, onSelect: () => copyPath(entry.path) },
      ...(ready && details === 'closed' ? [{ label: 'Show details', icon: IconInfoCircle, onSelect: () => { select([entry.path], entry.path); setDetails('open') } }] : []),
      ...(ready && can(user, 'delete') ? ['separator' as const, { label: 'Delete', icon: IconTrash, danger: true, shortcut: 'Del', onSelect: () => remove([entry]) }] : []),
    ]
  }
  const folderMenu = (): MenuItem[] => [
    ...(can(user, 'download') ? [{ label: 'Download folder', icon: IconDownload, onSelect: downloadCurrent }] : []),
    ...(can(user, 'create') ? [{ label: 'New folder', icon: IconFolderPlus, shortcut: 'N', onSelect: () => setDialog({ kind: 'folder' }) }] : []),
    ...(can(user, 'upload') ? [{ label: 'Upload files', icon: IconUpload, shortcut: 'U', onSelect: onUpload }] : []),
    ...(can(user, 'create') || can(user, 'upload') ? ['separator' as const] : []),
    { label: 'Select all', icon: IconSelectAll, shortcut: 'Ctrl A', onSelect: () => onToggleAll(true) },
    { label: 'Refresh', icon: IconRefresh, onSelect: () => void refresh() },
    { label: 'Copy folder path', icon: IconCopy, onSelect: () => copyPath(path) },
  ]
  const showMenu = (entry: FileEntry | null, event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation()
    const button = event.type === 'click' ? (event.currentTarget as HTMLElement).getBoundingClientRect() : null
    const at: MenuAnchor = button ? { x: button.right, y: button.bottom + 4, align: 'end' } : { x: event.clientX, y: event.clientY }
    if (entry && !selected.has(entry.path) && !entry.uploading) select([entry.path], entry.path)
    setMenu({ anchor: at, items: entry ? entryMenu(entry) : folderMenu(), label: entry ? `Actions for ${entry.name}` : 'Folder actions' })
  }
  // Rows are memoized, so they receive a stable handler that always calls the latest showMenu.
  const latestMenu = useRef(showMenu)
  useEffect(() => { latestMenu.current = showMenu })
  const menuHandler = useCallback((entry: FileEntry | null, event: MouseEvent) => latestMenu.current(entry, event), [])

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === '/' && !shortcutBlocked(event)) { event.preventDefault(); searchRef.current?.focus(); return }
    if (shortcutBlocked(event) || viewing) return
    const onControl = !!(event.target as HTMLElement).closest('button, a[href], summary')
    if (onControl && (event.key === 'Enter' || event.key === ' ')) return
    const index = visible.findIndex(entry => entry.path === cursor)
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key === 'ArrowUp') { event.preventDefault(); if (path === '/') onTargets(); else onNavigate(parentPath(path)); return }
    const columns = layout === 'grid' && scroller.current ? Math.max(1, Math.floor(scroller.current.clientWidth / 156)) : 1
    const move = (delta: number) => {
      event.preventDefault()
      if (!visible.length) return
      const next = visible[Math.max(0, Math.min(visible.length - 1, index < 0 ? 0 : index + delta))]
      setCursor(next.path)
      if (event.shiftKey && anchor) {
        const from = visible.findIndex(item => item.path === anchor), to = visible.indexOf(next)
        setSelected(new Set(visible.slice(Math.min(from, to), Math.max(from, to) + 1).filter(item => !item.uploading).map(item => item.path)))
      } else if (!mod) { setSelected(next.uploading ? new Set() : new Set([next.path])); setAnchor(next.path) }
      if (layout === 'list') scrollRowIntoView(scroller.current, visible.indexOf(next), rowHeight, HEADER_HEIGHT)
      else scroller.current?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    switch (event.key) {
      case 'ArrowDown': return move(columns)
      case 'ArrowUp': return move(-columns)
      case 'ArrowRight': if (layout === 'grid') move(1); return
      case 'ArrowLeft': if (layout === 'grid') move(-1); return
      case 'Home': return move(-visible.length)
      case 'End': return move(visible.length)
      case 'PageDown': return move(10)
      case 'PageUp': return move(-10)
      case 'Enter': if (cursorEntry) { event.preventDefault(); open(cursorEntry) } return
      case ' ': if (cursorEntry && !cursorEntry.uploading) { event.preventDefault(); onToggle(cursorEntry) } return
      case 'Backspace': event.preventDefault(); if (path === '/') onTargets(); else onNavigate(parentPath(path)); return
      case 'F2': if (picked.length === 1 && can(user, 'rename')) { event.preventDefault(); rename(picked[0]) } return
      case 'Delete': if (picked.length && can(user, 'delete')) { event.preventDefault(); remove(picked) } return
      case 'Escape': if (selected.size) { event.preventDefault(); setSelected(new Set()) } return
    }
    if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); onToggleAll(true); return }
    if (mod || event.altKey) return
    if (event.key.toLowerCase() === 'n' && can(user, 'create')) { event.preventDefault(); setDialog({ kind: 'folder' }) }
    if (event.key.toLowerCase() === 'u' && can(user, 'upload')) { event.preventDefault(); onUpload() }
    if (event.key.toLowerCase() === 'i') { event.preventDefault(); setDetails(details === 'open' ? 'closed' : 'open') }
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); if (!event.repeat) void refresh() }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  const dropHandlers = can(user, 'upload') ? {
    onDragEnter: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true) } },
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) },
    onDrop: (event: DragEvent) => { event.preventDefault(); dropFiles(event.dataTransfer, path) },
  } : {}

  const parts = path.split('/').filter(Boolean)
  const title = parts.length ? parts[parts.length - 1] : targetName
  const showDetails = details === 'open'
  const listProps = {
    entries: visible, user, selected, cursor, pending, sort, ascending: order === 'asc', onSort, onRowClick, onOpen: open, onMenu: menuHandler,
    onToggle, onToggleAll, onRename: rename, onDownload: downloadOne, onDropInto, scroller, rowHeight,
  }

  return <div className={`files-view ${dragging ? 'is-dragging' : ''}`} {...dropHandlers}>
    <header className="page-header">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <button type="button" className="icon-btn" aria-label="Parent folder" data-tip="Parent folder (Ctrl/⌘ ↑ or Backspace)" onClick={() => path === '/' ? onTargets() : onNavigate(parentPath(path))}><IconArrowUp size={16} /></button>
        <ol>
          <li><button type="button" className="crumb" onClick={onTargets}><IconHome2 size={15} /><span>My files</span></button></li>
          {parts.length > 0 && <li><IconChevronRight size={13} className="crumb-sep" /><button type="button" className="crumb" onClick={() => onNavigate('/')}><span>{targetName}</span></button></li>}
          {parts.slice(0, -1).map((part, index) => <li key={index}><IconChevronRight size={13} className="crumb-sep" /><button type="button" className="crumb" onClick={() => onNavigate('/' + parts.slice(0, index + 1).join('/'))}>{part}</button></li>)}
          <li aria-current="page"><IconChevronRight size={13} className="crumb-sep" /><h1 className="page-title" title={title}>{title}</h1></li>
        </ol>
      </nav>
      <div className="page-actions">
        <SearchField value={search} onChange={setSearch} label="Search files" placeholder="Filter this folder" inputRef={searchRef} shortcut="/" />
        {can(user, 'create') && <button type="button" className="btn" onClick={() => setDialog({ kind: 'folder' })}><IconFolderPlus size={15} /><span className="btn-label">New folder</span></button>}
        {can(user, 'upload') && <button type="button" className="btn btn-primary" onClick={onUpload}><IconUpload size={15} /><span className="btn-label">Upload files</span></button>}
      </div>
    </header>

    <div className="toolbar">
      {picked.length > 0 ? <div className="selection-bar">
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Clear selection" data-tip="Clear selection (Esc)" onClick={() => setSelected(new Set())}><IconX size={14} /></button>
        <strong>{plural(picked.length, 'item')} selected</strong>
        <span className="dim mono">{formatBytes(picked.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0))}</span>
        <span className="toolbar-sep" />
        {can(user, 'download') && <button type="button" className="btn btn-sm btn-ghost" onClick={() => downloadItems(picked)}><IconDownload size={14} />Download</button>}
        {picked.length === 1 && can(user, 'rename') && <button type="button" className="btn btn-sm btn-ghost" aria-label="Rename selected file" onClick={() => rename(picked[0])}><IconPencil size={14} />Rename</button>}
        {picked.length === 1 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => copyPath(picked[0].path)}><IconCopy size={14} />Copy path</button>}
        {can(user, 'delete') && <button type="button" className="btn btn-sm btn-ghost is-danger" aria-label="Delete selected items" onClick={() => remove(picked)}><IconTrash size={14} />Delete</button>}
      </div> : <div className="toolbar-info">
        {loading ? <span className="dim">Loading…</span> : <>
          <span>{plural(summary.folders, 'folder')}</span><span className="dot-sep" /><span>{plural(summary.files, 'file')}</span><span className="dot-sep" /><span className="mono">{formatBytes(summary.bytes)}</span>
          {search && <><span className="toolbar-sep" /><span className="badge"><IconSearch size={11} />{plural(visible.length, 'match', 'matches')}</span></>}
          {summary.uploading > 0 && <><span className="toolbar-sep" /><button type="button" className="badge badge-accent badge-btn" onClick={onTransfers}><IconCloudUpload size={11} />{summary.uploading} uploading</button></>}
        </>}
      </div>}
      <div className="toolbar-right">
        {can(user, 'download') && <button type="button" className="btn btn-sm btn-ghost" onClick={downloadCurrent}><IconDownload size={14} /><span className="btn-label">Download folder</span></button>}
        {layout === 'grid' && <button type="button" className="btn btn-sm btn-ghost" onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({ label: 'Sort by', anchor: { x: rect.right, y: rect.bottom + 4, align: 'end' }, items: SORT_KEYS.map(key => ({ label: SORT_LABELS[key] + (key === sort ? order === 'asc' ? ' ↑' : ' ↓' : ''), onSelect: () => onSort(key) })) })
        }}><IconSortAscending size={14} />{SORT_LABELS[sort]}</button>}
        <button type="button" className="icon-btn refresh-button" aria-label="Refresh files" aria-busy={refreshState === 'loading'} data-tip="Refresh (R)"
          data-state={refreshState} disabled={refreshState === 'loading'} onClick={() => void refresh()}>
          <IconRefresh size={15} aria-hidden="true" className={refreshState === 'loading' ? 'spin' : ''} />
          <span className="refresh-result" aria-hidden="true"><IconCheck size={15} /></span>
        </button>
        <Segmented size="sm" label="Layout" value={layout} onChange={setLayout} options={[
          { value: 'list', label: 'List view', icon: IconLayoutList, iconOnly: true }, { value: 'grid', label: 'Grid view', icon: IconLayoutGrid, iconOnly: true },
        ]} />
        <button type="button" className={`icon-btn hide-sm ${showDetails ? 'is-active' : ''}`} aria-pressed={showDetails} aria-label="Toggle details" data-tip="Details (I)"
          onClick={() => setDetails(showDetails ? 'closed' : 'open')}>{showDetails ? <IconLayoutSidebarRightFilled size={16} /> : <IconLayoutSidebarRight size={16} />}</button>
      </div>
    </div>

    <div className={`files-body ${showDetails ? 'has-inspector' : ''}`}>
      <div className={`files-scroll layout-${layout}`} ref={scroller} onContextMenu={event => menuHandler(null, event)}
        onClick={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('file-grid')) setSelected(new Set()) }}>
        {listing.error && !loading ? <EmptyState icon={IconAlertTriangle} title="Couldn’t open this folder" action={<div className="empty-actions">
          <button type="button" className="btn" onClick={() => void refresh()}><IconRefresh size={15} />Try again</button>
          {path !== '/' && <button type="button" className="btn btn-ghost" onClick={() => onNavigate('/')}>Go to {targetName}</button>}
          <button type="button" className="btn btn-ghost" onClick={onTargets}>Go to My files</button></div>}>{listing.error}</EmptyState>
          : loading ? <SkeletonRows />
            : !visible.length ? search
              ? <EmptyState icon={IconSearch} title="No matches" action={<button type="button" className="btn btn-sm" onClick={() => setSearch('')}>Clear filter</button>}>Nothing in this folder matches “{search}”.</EmptyState>
              : <EmptyState icon={IconFolderOpen} title="This folder is empty" action={<div className="empty-actions">
                {can(user, 'upload') && <button type="button" className="btn btn-primary" onClick={onUpload}><IconUpload size={15} />Choose files</button>}
                {can(user, 'create') && <button type="button" className="btn" onClick={() => setDialog({ kind: 'folder' })}><IconFolderPlus size={15} />Create a folder</button>}
              </div>}>{can(user, 'upload') ? <>Drop files here, or press <Kbd>U</Kbd> to upload.</> : 'There is nothing here yet.'}</EmptyState>
              : layout === 'list' ? <FileTable {...listProps} /> : <FileGrid {...listProps} />}
      </div>
      {showDetails && <Inspector entry={picked.length <= 1 ? (picked[0] ?? cursorEntry) : null} selection={picked} folder={path} folderName={title} folderEntries={entries} user={user}
        onClose={() => setDetails('closed')} onOpen={open} onDownload={downloadItems} onRename={rename} onDelete={remove} onCopyPath={copyPath} onTransfers={onTransfers} />}
      {dragging && <div className="drop-overlay"><div><IconCloudUpload size={30} stroke={1.5} /><strong>Drop to upload</strong><span>into <span className="mono">{title}</span></span></div></div>}
    </div>

    {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    {viewEntry && !dialog && <FileViewer entry={viewEntry} siblings={files} user={user} onClose={() => setViewing(null)} onStep={entry => { setViewing(entry.path); select(entry.uploading ? [] : [entry.path], entry.path) }}
      onDownload={() => downloadItems([viewEntry])} onRename={() => rename(viewEntry)} onDelete={() => remove([viewEntry])} onCopyPath={() => copyPath(viewEntry.path)} onTransfers={onTransfers} />}
    {dialog?.kind === 'folder' && <NameDialog targetId={user.targetId} mode="folder" directory={path} onClose={() => setDialog(null)} onDone={async name => {
      setDialog(null); await load(path); const created = join(path, name); select([created], created); notify(`Folder “${name}” created.`)
    }} />}
    {dialog?.kind === 'rename' && <NameDialog targetId={user.targetId} mode="rename" entry={dialog.entry} directory={path} onClose={() => setDialog(null)} onDone={async name => {
      const renamed = join(path, name); setDialog(null); if (viewing === dialog.entry.path) setViewing(renamed)
      await load(path); select([renamed], renamed); notify('Name updated.')
    }} />}
    {dialog?.kind === 'delete' && <DeleteDialog targetId={user.targetId} entries={dialog.entries} onClose={() => { setDialog(null); void load(path) }} onDone={async (deleted, failed) => {
      if (!failed) setDialog(null)
      if (dialog.entries.some(entry => entry.path === viewing)) setViewing(null)
      setSelected(new Set()); await load(path)
      if (deleted) notify(deleted === 1 ? 'Item deleted.' : `${deleted} items deleted.`)
    }} />}
  </div>
}
