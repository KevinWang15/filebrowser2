import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleHelp, CloudUpload, Database, Download, Eye, EyeOff, File, FileArchive, FileCode2, FileImage, FileText, Folder, FolderOpen, FolderPlus, HardDrive, LayoutGrid, List, Loader2, LockKeyhole, LogOut, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, Upload, Users, X, Activity, type LucideIcon } from 'lucide-react'
import { FULL_PERMISSIONS, PERMISSIONS, READ_PERMISSIONS, type AuditEntry, type Bootstrap, type FileEntry, type Permissions, type SystemInfo, type UploadSession, type User } from '@/shared/types'
import { api, errorMessage, formatBytes } from './api'
import { UploadEngine, type Transfer } from './upload-engine'

type View = 'files' | 'transfers' | 'users' | 'activity' | 'settings'
type Notice = { text: string; error?: boolean }
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function Brand({ name = 'Filebrowser', small = false }: { name?: string; small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-icon"><FolderOpen size={small ? 21 : 24} strokeWidth={1.7} /></span><span>{name}<span className="brand-dot">.</span></span></div>
}
function Spinner() { return <Loader2 className="spin" size={18} /> }
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus()
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const elements = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href]')
        if (!elements?.length) return
        const first = elements[0], last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', listener)
    return () => { document.removeEventListener('keydown', listener); previous?.focus() }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>{children}
  </div></div>
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try { setBootstrap(await api<Bootstrap>('/bootstrap')); setError('') }
    catch (error) { setError(errorMessage(error)) }
  }, [])
  useEffect(() => { void api<Bootstrap>('/bootstrap').then(setBootstrap).catch(error => setError(errorMessage(error))) }, [])
  useEffect(() => {
    const listener = () => { void refresh() }
    window.addEventListener('fb-session-expired', listener)
    return () => window.removeEventListener('fb-session-expired', listener)
  }, [refresh])
  if (!bootstrap) return <div className="loading-page"><Brand /><div className="loading-message">{error ? <><p>{error}</p><button className="button primary" onClick={() => void refresh()}>Try again <RefreshCw size={16} /></button></> : <><Spinner /><span>Opening your workspace…</span></>}</div></div>
  if (bootstrap.needsSetup || !bootstrap.user) return <AuthScreen setup={bootstrap.needsSetup} siteName={bootstrap.siteName} onDone={refresh} />
  return <Workspace key={bootstrap.user.id} bootstrap={bootstrap} user={bootstrap.user} onAuthChanged={refresh} />
}

function AuthScreen({ setup, siteName, onDone }: { setup: boolean; siteName: string; onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(siteName)
  const [username, setUsername] = useState(setup ? 'admin' : '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (setup && step === 0) { setStep(1); return }
    if (setup && step === 1) {
      if (password !== confirm) { setError('Your passwords do not match.'); return }
      setStep(2); return
    }
    setBusy(true)
    try {
      await api(setup ? '/setup' : '/auth/login', { method: 'POST', body: setup ? { username, password, siteName: name } : { username, password } })
      await onDone()
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  return <div className="auth-layout">
    <aside className="auth-story"><Brand /><div className="auth-story-content"><span className="eyebrow"><span className="live-dot" /> YOUR FILES. YOUR SPACE.</span><h1>A home for<br />your files.<br /><span>Room to grow.</span></h1><p>Keep everything close. Share access with your team. Take even your biggest files along for the ride.</p>
      <div className="auth-illustration" aria-hidden="true"><div className="illustration-card card-back"><FileImage size={26} /><span>Something worth keeping</span></div><div className="illustration-folder"><FolderOpen size={74} strokeWidth={1} /><span>A little more organized.</span><span className="illustration-check"><Check size={17} /></span></div><div className="illustration-card card-front"><CloudUpload size={24} /><div><strong>Big files, small worries.</strong><span>Pick up where you left off.</span></div><CheckCircle2 size={18} /></div></div>
    </div><div className="auth-footer"><ShieldCheck size={16} /> Private by default. In your control.</div></aside>
    <main className="auth-main"><div className="auth-top"><span>{setup ? 'A fresh start' : 'Welcome back'}</span><span className="tag"><HardDrive size={13} /> Self hosted</span></div>
      <form className="auth-form" onSubmit={event => void submit(event)}>
        {setup && <div className="setup-steps">{['Workspace','Administrator','Ready'].map((label,index) => <div className={index <= step ? 'active' : ''} key={label}><span>{index < step ? <Check size={13} /> : index + 1}</span>{label}</div>)}</div>}
        <div className="section-icon">{setup && step === 2 ? <CheckCircle2 size={25} /> : setup && step === 0 ? <FolderOpen size={25} /> : <LockKeyhole size={25} />}</div>
        <h2>{setup ? ['Make yourself at home.','You’re in control.','Everything is ready.'][step] : 'Good to see you again.'}</h2>
        <p className="muted auth-description">{setup ? ['Let’s create your workspace. It only takes a moment.','Create your administrator account to manage files, people, and permissions.','Your private workspace is one click away.'][step] : `Sign in to ${siteName} and pick up where you left off.`}</p>
        {setup && step === 0 ? <><label>Workspace name<input value={name} onChange={e => setName(e.target.value)} required maxLength={60} placeholder="My workspace" /></label><div className="info-box"><HardDrive size={22} /><div><strong>Start with local storage</strong><p>Your files stay on this server. The storage folder is configured by your server administrator.</p></div><CheckCircle2 size={17} /></div></> : setup && step === 2 ? <div className="setup-review"><div><span>Workspace</span><strong>{name}</strong></div><div><span>Administrator</span><strong>{username}</strong></div><div><span>Storage</span><strong><HardDrive size={15} /> Local filesystem</strong></div><div><span>Large uploads</span><strong className="green"><ShieldCheck size={15} /> Resumable & verified</strong></div></div> : <>
          <label>Username<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required minLength={setup ? 2 : 1} maxLength={40} pattern={setup ? '[a-zA-Z0-9_.-]+' : undefined} placeholder="Your username" /></label>
          <label>Password<div className="password-field"><input autoComplete={setup ? 'new-password' : 'current-password'} type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={setup ? 12 : 1} maxLength={128} placeholder={setup ? 'At least 12 characters' : 'Your password'} /><button type="button" className="icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
          {setup && <><div className="password-strength">{Array.from({ length: 4 },(_,i) => <span key={i} className={password.length >= [1,8,12,18][i] ? 'filled' : ''} />)}<small>{password.length >= 12 ? 'Looking good' : 'Use 12 or more characters'}</small></div><label>Confirm password<input autoComplete="new-password" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={12} maxLength={128} placeholder="One more time" /></label></>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="auth-actions">{setup && step > 0 && <button type="button" className="button" disabled={busy} onClick={() => { setStep(step - 1); setError('') }}>Back</button>}<button className="button primary" disabled={busy}>{busy ? <Spinner /> : <>{setup ? step === 2 ? 'Create workspace' : 'Continue' : 'Sign in'}<ArrowRight size={17} /></>}</button></div>
        <p className="auth-fineprint"><LockKeyhole size={13} /> {setup ? 'No default passwords. No shared accounts.' : 'A private workspace, hosted on your own server.'}</p>
      </form><div className="auth-bottom">Made for the files that matter.</div>
    </main>
  </div>
}

function Workspace({ bootstrap, user, onAuthChanged }: { bootstrap: Bootstrap; user: User; onAuthChanged: () => Promise<void> }) {
  const [view, setView] = useState<View>('files')
  const [path, setPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [fileError, setFileError] = useState('')
  const [search, setSearch] = useState('')
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [engine] = useState(() => new UploadEngine(bootstrap.upload))
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [showUpload, setShowUpload] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const refreshFiles = useCallback(async () => {
    setLoading(true)
    try { const data = await api<{ entries: FileEntry[] }>('/files?path=' + encodeURIComponent(path)); setEntries(data.entries); setFileError('') }
    catch (error) { setFileError(errorMessage(error)); setEntries([]) }
    finally { setLoading(false) }
  }, [path])
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), [])
  useEffect(() => {
    const controller = new AbortController()
    void api<{ entries: FileEntry[] }>('/files?path=' + encodeURIComponent(path), { signal: controller.signal })
      .then(data => { setEntries(data.entries); setFileError(''); setLoading(false) })
      .catch(error => { if (!controller.signal.aborted) { setFileError(errorMessage(error)); setEntries([]); setLoading(false) } })
    return () => controller.abort()
  }, [path])
  useEffect(() => {
    engine.setCompleteHandler(() => { void refreshFiles(); void api<SystemInfo>('/system').then(setSystem).catch(error => notify(errorMessage(error), true)); notify('Upload complete. Your file is ready.') })
  }, [engine, refreshFiles, notify])
  useEffect(() => {
    engine.activate()
    const unsubscribe = engine.subscribe(setTransfers)
    void api<UploadSession[]>('/uploads').then(sessions => engine.hydrate(sessions)).catch(error => notify(errorMessage(error),true))
    void api<SystemInfo>('/system').then(setSystem).catch(error => notify(errorMessage(error),true))
    return () => { unsubscribe(); engine.dispose() }
  }, [engine, notify])
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(timer) }, [notice])
  const addFiles = (files: File[]) => { if (!files.length) return; engine.add(files,path); setShowUpload(false); setView('transfers') }
  const active = transfers.filter(t => !['completed','failed'].includes(t.state)).length
  const navigate = (next: View) => { setView(next); setSearch(''); if (next === 'files') void refreshFiles() }
  const navItem = (next: View, label: string, Icon: LucideIcon, badge?: number) => <button aria-label={label} className={`nav-item ${view === next ? 'active' : ''}`} onClick={() => navigate(next)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{!!badge && <span className="nav-count">{badge}</span>}{view === next && <span className="nav-active-dot" />}</button>
  return <div className="app-shell">
    <aside className="sidebar"><Brand name={bootstrap.siteName} small /><div className="workspace-label"><span className="workspace-avatar">{bootstrap.siteName[0].toUpperCase()}</span><div><strong>{bootstrap.siteName}</strong><span>Private workspace</span></div><LockKeyhole size={13} /></div>
      <div className="nav-caption">WORKSPACE</div><nav>{navItem('files','My files',FolderOpen)}{navItem('transfers','Transfers',ArrowUpRight,active)}</nav>
      {user.role !== 'admin' && <nav>{navItem('settings','Account settings',Settings2)}</nav>}{user.role === 'admin' && <><div className="nav-caption admin-caption">ADMINISTRATION</div><nav>{navItem('users','People & access',Users)}{navItem('activity','Activity',Activity)}{navItem('settings','Settings',Settings2)}</nav></>}
      <div className="sidebar-bottom"><div className="storage-card"><div><HardDrive size={17} /><strong>Local storage</strong><span className="live-dot" /></div>{system ? <><div className="storage-meter"><span style={{ width: `${Math.min(100,(1-system.storage.available/system.storage.total)*100)}%` }} /></div><p><strong>{formatBytes(system.storage.available)}</strong> available</p><span className="storage-caption">of {formatBytes(system.storage.total)} on this volume</span></> : <p>Connecting to storage…</p>}</div><div className="sidebar-help"><ShieldCheck size={16} /><span>Your space. Your control.</span></div></div>
    </aside>
    <div className="app-main"><header className="topbar"><div className="topbar-location"><span>Workspace</span><ChevronRight size={14} /><strong>{{ files:'My files',transfers:'Transfers',users:'People & access',activity:'Activity',settings:'Settings' }[view]}</strong></div><div className="topbar-right">{view === 'files' && <div className="search-field"><Search size={16} /><input aria-label="Search files" placeholder="Search in this folder…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>⌕</kbd></div>}<div className="user-menu"><span className="user-avatar">{user.username.slice(0,2).toUpperCase()}</span><div><strong>{user.username}</strong><span>{user.role === 'admin' ? 'Administrator' : 'Member'}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void api('/auth/logout',{method:'POST'}).then(onAuthChanged).catch(error => notify(errorMessage(error),true))}><LogOut size={17} /></button></div></div></header>
      <main className="content">
        {view === 'files' && <FilesView entries={entries} loading={loading} error={fileError} path={path} search={search} user={user} onPath={next=>{if(next===path){void refreshFiles()}else{setLoading(true);setPath(next)}}} onRefresh={refreshFiles} onUpload={() => setShowUpload(true)} onDrop={addFiles} notify={notify} />}
        {view === 'transfers' && <TransfersView transfers={transfers} engine={engine} user={user} onUpload={() => setShowUpload(true)} notify={notify} />}
        {view === 'users' && <UsersView currentUser={user} notify={notify} onAuthChanged={onAuthChanged} />}
        {view === 'activity' && <ActivityView notify={notify} />}
        {view === 'settings' && <SettingsView user={user} bootstrap={bootstrap} system={system} notify={notify} onAuthChanged={onAuthChanged} />}
      </main><footer className="app-footer"><span><span className="live-dot" /> Storage connected</span><span>Filebrowser <span className="footer-divider">/</span> A place for everything.</span><span><ShieldCheck size={13} /> Private workspace</span></footer>
    </div>
    <input className="hidden" ref={inputRef} type="file" multiple onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value='' }} />
    {showUpload && <Modal title="Upload files" onClose={() => setShowUpload(false)}><div className="upload-modal-body"><div className="upload-destination"><Folder size={18} /><span>Uploading to <strong>{path === '/' ? 'My files' : path}</strong></span></div><button className="upload-dropzone" onClick={() => inputRef.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)) }}><span className="upload-cloud"><CloudUpload size={32} strokeWidth={1.4} /></span><strong>Drop your files here</strong><span>or <em>browse your computer</em></span><small>Up to {formatBytes(bootstrap.upload.maxFileSize)} per file · Resume anytime</small></button><div className="upload-assurance"><ShieldCheck size={21} /><div><strong>A safe journey, even for big files.</strong><p>We check your file before uploading and verify every chunk. If your connection drops, your progress stays safe.</p></div></div><label className="connections-select">Connections per chunk<select defaultValue={engine.connections} onChange={e => { engine.setConnections(Number(e.target.value) as 1 | 2 | 4) }}><option value="1">1 — Best for unstable connections</option><option value="2">2 — Balanced</option><option value="4">4 — Faster connections</option></select></label></div></Modal>}
    {notice && <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}<span>{notice.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>
}

function FileIcon({ entry, large = false }: { entry: Pick<FileEntry,'name'|'kind'>; large?: boolean }) {
  const extension = entry.name.split('.').pop()?.toLowerCase()
  let Icon: LucideIcon = File, color = 'gray'
  if (entry.kind === 'directory') { Icon = Folder; color = 'amber' }
  else if (['jpg','jpeg','png','gif','webp','svg','heic'].includes(extension ?? '')) { Icon = FileImage; color = 'violet' }
  else if (['zip','gz','tar','7z','rar'].includes(extension ?? '')) { Icon = FileArchive; color = 'amber' }
  else if (['ts','tsx','js','json','py','html','css','scss','yml','yaml'].includes(extension ?? '')) { Icon = FileCode2; color = 'green' }
  else if (['txt','md','pdf','doc','docx','csv'].includes(extension ?? '')) { Icon = FileText; color = 'blue' }
  return <span className={`file-icon file-icon-${color} ${large ? 'file-icon-large' : ''}`}><Icon size={large ? 31 : 21} strokeWidth={1.5} fill={entry.kind === 'directory' ? 'currentColor' : 'none'} fillOpacity={0.15} /></span>
}

function FilesView({ entries, loading, error, path, search, user, onPath, onRefresh, onUpload, onDrop, notify }: {
  entries: FileEntry[]; loading: boolean; error: string; path: string; search: string; user: User
  onPath: (path: string) => void; onRefresh: () => Promise<void>; onUpload: () => void; onDrop: (files: File[]) => void; notify: (text: string,error?: boolean) => void
}) {
  const [layout, setLayout] = useState<'list'|'grid'>(() => localStorage.getItem('fb-layout') === 'grid' ? 'grid' : 'list')
  const [sort, setSort] = useState<'name'|'size'|'modifiedAt'>('name')
  const [ascending, setAscending] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<'folder'|'rename'|'delete'|null>(null)
  const [detail, setDetail] = useState<FileEntry | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [dragging, setDragging] = useState(false)
  const can = (permission: keyof Permissions) => user.role === 'admin' || user.permissions[permission]
  const visible = entries.filter(e => e.name.toLowerCase().includes(search.toLowerCase())).sort((a,b) => {
    const directories = Number(b.kind === 'directory') - Number(a.kind === 'directory')
    const value = sort === 'size' ? a.size-b.size : a[sort].localeCompare(b[sort],undefined,{numeric:true})
    return directories || value*(ascending ? 1 : -1)
  })
  const selectable = visible.filter(e => !e.uploading)
  const picked = entries.filter(e => !e.uploading && selected.has(e.path))
  const toggle = (path: string) => setSelected(previous => { const result=new Set(previous); if(result.has(path))result.delete(path); else result.add(path); return result })
  const navigate = (path: string) => { setSelected(new Set()); setDetail(null); onPath(path) }
  const showDetail = (entry: FileEntry) => { setSelected(new Set()); setDetail(entry) }
  const open = (entry: FileEntry) => entry.kind === 'directory' ? navigate(entry.path) : showDetail(entry)
  const changeSort = (next: typeof sort) => { if(sort===next)setAscending(!ascending); else {setSort(next);setAscending(true)} }
  const openDialog = (next: typeof dialog) => { setFormError(''); setDialog(next); setName(next === 'rename' ? picked[0]?.name ?? detail?.name ?? '' : '') }
  const download = (entry: FileEntry) => { const anchor=document.createElement('a'); anchor.href='/api/files/content?path='+encodeURIComponent(entry.path); anchor.download=entry.name; anchor.click() }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFormError('')
    try {
      if (dialog === 'folder') await api('/files/directories',{method:'POST',body:{directory:path,name}})
      if (dialog === 'rename') await api('/files',{method:'PATCH',body:{path:picked[0]?.path ?? detail?.path,name}})
      if (dialog === 'delete') for (const entry of picked.length ? picked : detail ? [detail] : []) await api('/files?path='+encodeURIComponent(entry.path),{method:'DELETE'})
      setDialog(null); setDetail(null); setSelected(new Set()); await onRefresh(); notify(dialog==='folder' ? 'Folder created.' : dialog==='rename' ? 'Name updated.' : 'Selected items deleted.')
    } catch(error) { setFormError(errorMessage(error)); if(dialog==='delete')await onRefresh() }
    finally { setBusy(false) }
  }
  const pathParts = path.split('/').filter(Boolean)
  return <div className={`files-view ${dragging ? 'dragging' : ''}`} onDragOver={e => { if(can('upload') && e.dataTransfer.types.includes('Files')) {e.preventDefault();setDragging(true)} }} onDragLeave={e => { if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false) }} onDrop={e => { e.preventDefault();setDragging(false);if(can('upload'))onDrop(Array.from(e.dataTransfer.files)) }}>
    <div className="page-heading"><div><div className="eyebrow">YOUR WORKSPACE, ORGANIZED</div><h1>All files<span className="heading-dot">.</span></h1><p>Everything you need, right where you left it.</p></div><div className="heading-actions">{can('create')&&<button className="button" onClick={()=>openDialog('folder')}><FolderPlus size={17}/>New folder</button>}{can('upload')&&<button className="button primary" onClick={onUpload}><Upload size={17}/>Upload files</button>}</div></div>
    <div className="file-summary"><span><HardDrive size={15}/>Local storage</span><span className="summary-divider"/><span><ShieldCheck size={15}/>Private & secure</span><span className="summary-right">{entries.length} {entries.length===1?'item':'items'} <span className="summary-divider"/> {formatBytes(entries.filter(e=>e.kind==='file').reduce((total,e)=>total+e.size,0))} in this folder</span></div>
    <div className="files-container"><div className="files-toolbar"><div className="breadcrumbs"><button onClick={()=>navigate('/')}><FolderOpen size={17}/><span>My files</span></button>{pathParts.map((part,index)=><span key={index}><ChevronRight size={14}/><button onClick={()=>navigate('/'+pathParts.slice(0,index+1).join('/'))}>{part}</button></span>)}</div><div className="files-toolbar-actions">{picked.length>0&&<><span className="selection-count">{picked.length} selected</span>{picked.length===1&&can('rename')&&<button className="icon-button" title="Rename" aria-label="Rename selected file" onClick={()=>openDialog('rename')}><Pencil size={16}/></button>}{can('delete')&&<button className="icon-button danger-text" title="Delete" aria-label="Delete selected items" onClick={()=>openDialog('delete')}><Trash2 size={16}/></button>}<span className="toolbar-divider"/></>}<button className="icon-button" title="Refresh" aria-label="Refresh files" onClick={()=>void onRefresh()}><RefreshCw size={16} className={loading?'spin':''}/></button><div className="view-toggle"><button aria-label="List view" className={layout==='list'?'active':''} onClick={()=>{setLayout('list');localStorage.setItem('fb-layout','list')}}><List size={17}/></button><button aria-label="Grid view" className={layout==='grid'?'active':''} onClick={()=>{setLayout('grid');localStorage.setItem('fb-layout','grid')}}><LayoutGrid size={16}/></button></div></div></div>
      {error?<div className="empty-state"><CircleHelp size={32}/><h3>Couldn’t open this folder</h3><p>{error}</p><button className="button" onClick={()=>void onRefresh()}>Try again</button></div>:loading?<div className="empty-state"><Spinner/><p>Loading your files…</p></div>:!visible.length?<div className="empty-state"><span className="empty-icon"><FolderOpen size={37} strokeWidth={1.2}/><span><Plus size={13}/></span></span><h3>{search?'No files found':'A fresh folder. A fresh start.'}</h3><p>{search?'Try another name to find what you’re looking for.':'Bring your files over. We’ll keep them organized and close.'}</p>{!search&&can('upload')&&<button className="button primary" onClick={onUpload}><Upload size={16}/>Upload your first file</button>}<span className="empty-hint">{!search&&can('upload')?'You can also drag and drop files anywhere here.':''}</span></div>:layout==='list'?<div className="table-scroll"><table className="file-table"><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="Select all files" disabled={!selectable.length} checked={selectable.length>0&&selectable.every(e=>selected.has(e.path))} onChange={e=>setSelected(e.target.checked?new Set(selectable.map(e=>e.path)):new Set())}/></th><th><button onClick={()=>changeSort('name')}>Name {sort==='name'&&(ascending?<ArrowUp size={13}/>:<ArrowDown size={13}/>)}</button></th><th><button onClick={()=>changeSort('modifiedAt')}>Last modified {sort==='modifiedAt'&&(ascending?<ArrowUp size={13}/>:<ArrowDown size={13}/>)}</button></th><th><button onClick={()=>changeSort('size')}>File size {sort==='size'&&(ascending?<ArrowUp size={13}/>:<ArrowDown size={13}/>)}</button></th><th>Type</th><th/></tr></thead><tbody>{visible.map(entry=><tr key={entry.path} className={selected.has(entry.path)?'selected':''}><td className="checkbox-cell"><input type="checkbox" aria-label={'Select '+entry.name} disabled={entry.uploading} checked={!entry.uploading&&selected.has(entry.path)} onChange={()=>toggle(entry.path)}/></td><td><button className="file-name" onClick={()=>open(entry)}><FileIcon entry={entry}/><span>{entry.name}</span></button></td><td>{date(entry.modifiedAt)}</td><td>{entry.kind==='directory'?'—':formatBytes(entry.size)}</td><td>{entry.uploading?<span className="uploading-badge"><CloudUpload size={13}/>Uploading</span>:<span className="type-label">{entry.kind==='directory'?'Folder':entry.name.includes('.')?entry.name.split('.').pop()?.toUpperCase()+' file':'File'}</span>}</td><td><button className="icon-button" aria-label={'Details for '+entry.name} onClick={()=>showDetail(entry)}><MoreHorizontal size={19}/></button></td></tr>)}</tbody></table></div>:<div className="file-grid">{visible.map(entry=><div key={entry.path} className={`file-card ${selected.has(entry.path)?'selected':''}`}><div className="file-card-top"><input type="checkbox" aria-label={'Select '+entry.name} disabled={entry.uploading} checked={!entry.uploading&&selected.has(entry.path)} onChange={()=>toggle(entry.path)}/><button className="icon-button" aria-label={'Details for '+entry.name} onClick={()=>showDetail(entry)}><MoreHorizontal size={18}/></button></div><button className="file-card-main" onClick={()=>open(entry)}><FileIcon entry={entry} large/><strong>{entry.name}</strong>{entry.uploading&&<span className="uploading-badge"><CloudUpload size={13}/>Uploading</span>}<span>{entry.kind==='directory'?'Folder':formatBytes(entry.size)} <span>·</span> {date(entry.modifiedAt)}</span></button></div>)}</div>}
      <div className="table-bottom"><span>{search?`${visible.length} matching items`:`${entries.filter(e=>e.kind==='directory').length} folders, ${entries.filter(e=>e.kind==='file').length} files`}</span><span><LockKeyhole size={12}/>Only people you give access can see these files</span></div>
    </div><div className="upload-tip"><div className="tip-icon"><Sparkles size={19}/></div><div><strong>Big files? You’re in the right place.</strong><span>Resumable uploads keep your progress safe, even when your connection doesn’t.</span></div><button onClick={onUpload} disabled={!can('upload')}>Start a transfer<ArrowUpRight size={16}/></button></div>
    {dragging&&<div className="drag-overlay"><CloudUpload size={52}/><h2>Drop files to upload</h2><span>We’ll take it from here.</span></div>}
    {dialog&&<Modal title={dialog==='folder'?'Create a folder':dialog==='rename'?'Rename item':'Delete selected items'} onClose={()=>!busy&&setDialog(null)}><form onSubmit={e=>void submit(e)} className="modal-form">{dialog==='delete'?<p>Delete {picked.length||1} {picked.length===1?'item':'items'}? This removes the files from your storage. Folders must be empty.</p>:<label>{dialog==='folder'?'Folder name':'Name'}<input value={name} onChange={e=>setName(e.target.value)} required maxLength={255} placeholder={dialog==='folder'?'e.g. Project documents':''}/></label>}{formError&&<p className="form-error" role="alert">{formError}</p>}<div className="modal-actions"><button className="button" type="button" disabled={busy} onClick={()=>setDialog(null)}>Cancel</button><button className={`button ${dialog==='delete'?'danger':'primary'}`} disabled={busy}>{busy?<Spinner/>:dialog==='folder'?'Create folder':dialog==='rename'?'Save name':'Delete items'}</button></div></form></Modal>}
    {detail&&!dialog&&<FileDetails entry={detail} user={user} onClose={()=>setDetail(null)} onDownload={()=>download(detail)} onRename={()=>openDialog('rename')} onDelete={()=>openDialog('delete')}/>}
  </div>
}

function FileDetails({ entry,user,onClose,onDownload,onRename,onDelete }: { entry: FileEntry; user: User; onClose:()=>void; onDownload:()=>void; onRename:()=>void; onDelete:()=>void }) {
  const [preview,setPreview]=useState<string|null>(null)
  const [error,setError]=useState('')
  const can=(permission:keyof Permissions)=>!entry.uploading&&(user.role==='admin'||user.permissions[permission])
  const loadPreview=async()=>{try{const response=await fetch('/api/files/content?preview=1&path='+encodeURIComponent(entry.path));if(!response.ok){const data=await response.json();throw new Error(data.message)}setPreview(await response.text())}catch(error){setError(errorMessage(error))}}
  return <Modal title="File details" onClose={onClose} wide={preview!==null}><div className="file-detail"><FileIcon entry={entry} large/><h3>{entry.name}</h3>{entry.uploading&&<><span className="uploading-badge"><CloudUpload size={14}/>Uploading</span><p className="muted uploading-note">This file is still uploading. Its final name becomes available when every chunk is verified. Use Transfers to resume or cancel your upload.</p></>}<span className="muted">{entry.kind==='directory'?'Folder':formatBytes(entry.size)}</span><dl><div><dt>Location</dt><dd>{entry.path}</dd></div><div><dt>Last modified</dt><dd>{date(entry.modifiedAt)}</dd></div></dl>{error&&<p className="form-error" role="alert">{error}</p>}{preview!==null&&<pre className="text-preview">{preview}</pre>}<div className="file-detail-actions">{entry.kind==='file'&&can('download')&&<button className="button primary" onClick={onDownload}><Download size={16}/>Download</button>}{entry.kind==='file'&&can('read')&&<button className="button" onClick={()=>void loadPreview()}><Eye size={16}/>Preview</button>}{can('rename')&&<button className="button" onClick={onRename}><Pencil size={15}/>Rename</button>}{can('delete')&&<button className="icon-button danger-text" aria-label="Delete item" onClick={onDelete}><Trash2 size={18}/></button>}</div></div></Modal>
}

function TransfersView({transfers,engine,user,onUpload,notify}:{transfers:Transfer[];engine:UploadEngine;user:User;onUpload:()=>void;notify:(text:string,error?:boolean)=>void}) {
  const [filter,setFilter]=useState<'all'|'active'|'completed'>('all')
  const [resumeId,setResumeId]=useState<string|null>(null)
  const [cancelId,setCancelId]=useState<string|null>(null)
  const [cancelBusy,setCancelBusy]=useState(false)
  const input=useRef<HTMLInputElement>(null)
  const visible=transfers.filter(t=>filter==='all'||(filter==='completed'?t.state==='completed':t.state!=='completed'))
  const active=transfers.filter(t=>t.state!=='completed').length
  const complete=transfers.filter(t=>t.state==='completed').length
  const labels:Record<Transfer['state'],string>={queued:'In queue',hashing:'Checking your file',uploading:'Uploading',verifying:'Verifying & saving',retrying:'Reconnecting',paused:'Paused','needs-file':'Ready to resume',completed:'Complete',failed:'Needs attention'}
  const resume=(task:Transfer)=>{if(task.file)engine.resume(task.id);else{setResumeId(task.id);input.current?.click()}}
  const cancel=async()=>{if(!cancelId)return;setCancelBusy(true);try{await engine.cancel(cancelId);setCancelId(null);notify('Transfer canceled. Temporary data removed.')}catch(error){notify(errorMessage(error),true)}finally{setCancelBusy(false)}}
  return <div><div className="page-heading"><div><div className="eyebrow">KEEP THINGS MOVING</div><h1>Transfers<span className="heading-dot">.</span></h1><p>A safe journey for files of every size.</p></div>{(user.role==='admin'||user.permissions.upload)&&<button className="button primary" onClick={onUpload}><Plus size={17}/>New upload</button>}</div>
    <div className="transfer-feature"><span className="feature-icon"><ShieldCheck size={29} strokeWidth={1.4}/></span><div><h3>Built for the long haul.</h3><p>We check every chunk and save your progress. Close the browser or lose your connection — select the original file to pick up where you left off.</p></div><span className="tag green-tag"><Check size={13}/>Resumable uploads</span></div>
    <div className="section-tabs"><div>{[['all','All transfers',transfers.length],['active','In progress',active],['completed','Completed',complete]].map(([key,label,count])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key as typeof filter)}>{label}<span>{count}</span></button>)}</div>{complete>0&&<button className="text-button" onClick={()=>engine.clearCompleted()}>Clear completed</button>}</div>
    <div className="transfers-list">{!visible.length?<div className="empty-state"><span className="empty-icon"><ArrowUpRight size={35}/></span><h3>{filter==='completed'?'No completed transfers yet':'Nothing moving just yet.'}</h3><p>When you upload a file, you can follow its journey here.</p>{filter!=='completed'&&(user.role==='admin'||user.permissions.upload)&&<button className="button" onClick={onUpload}><Upload size={16}/>Choose files</button>}</div>:visible.map(task=>{
      const progress=task.state==='hashing'?(task.size?task.hashedBytes/task.size:1):(task.size?(task.committedBytes+task.sentBytes)/task.size:task.state==='completed'?1:0)
      const running=['queued','hashing','uploading','verifying','retrying'].includes(task.state)
      return <div className={`transfer-row ${task.state==='completed'?'transfer-completed':''}`} key={task.id}><FileIcon entry={{name:task.name,kind:'file'}}/><div className="transfer-body"><div className="transfer-title"><strong>{task.name}</strong><span>{formatBytes(task.size)}</span></div><div className="transfer-track"><span style={{width:`${Math.min(100,progress*100)}%`}}/></div><div className="transfer-meta"><span className={`transfer-state state-${task.state}`}>{task.state==='completed'?<CheckCircle2 size={13}/>:running?<Loader2 className="spin" size={12}/>:<Pause size={12}/>} {labels[task.state]}{task.retry?` · attempt ${task.retry}`:''}</span><span>{task.state==='hashing'?`${Math.round(progress*100)}% checked`:task.state==='completed'?`Saved to ${task.directory==='/'?'My files':task.directory}`:`${formatBytes(task.committedBytes)} verified${task.speed?' · '+formatBytes(task.speed)+'/s':''}`}</span><span>{Math.round(progress*100)}%</span></div>{task.error&&<p className="transfer-error">{task.error}</p>}</div><div className="transfer-actions">{task.state==='completed'?<span className="completed-check"><Check size={18}/></span>:<>{running?<button className="icon-button" aria-label={'Pause '+task.name} onClick={()=>engine.pause(task.id)}><Pause size={18}/></button>:<button className="button small" onClick={()=>resume(task)}><Play size={14}/>{task.file?'Resume':'Select file'}</button>}<button className="icon-button" aria-label={'Cancel '+task.name} onClick={()=>setCancelId(task.id)}><X size={17}/></button></>}</div></div>
    })}</div><div className="transfer-footnote"><LockKeyhole size={14}/><span>Only verified chunks count as saved. An interrupted chunk is safely retried in full.</span></div>
    <input ref={input} className="hidden" type="file" onChange={event=>{const file=event.target.files?.[0];if(file&&resumeId)engine.resume(resumeId,file);event.target.value='';setResumeId(null)}}/>
    {cancelId&&<Modal title="Cancel this transfer?" onClose={()=>!cancelBusy&&setCancelId(null)}><div className="modal-form"><p>This discards the saved progress and temporary data for this transfer.</p><div className="modal-actions"><button className="button" disabled={cancelBusy} onClick={()=>setCancelId(null)}>Keep transfer</button><button className="button danger" disabled={cancelBusy} onClick={()=>void cancel()}>{cancelBusy?<Spinner/>:'Cancel transfer'}</button></div></div></Modal>}
  </div>
}

function UsersView({currentUser,notify,onAuthChanged}:{currentUser:User;notify:(text:string,error?:boolean)=>void;onAuthChanged:()=>Promise<void>}) {
  const [users,setUsers]=useState<User[]>([])
  const [loading,setLoading]=useState(true)
  const [editing,setEditing]=useState<User|'new'|null>(null)
  const [search,setSearch]=useState('')
  const refresh=useCallback(async()=>{try{setUsers(await api<User[]>('/admin/users'))}catch(error){notify(errorMessage(error),true)}finally{setLoading(false)}},[notify])
  useEffect(()=>{void api<User[]>('/admin/users').then(setUsers).catch(error=>notify(errorMessage(error),true)).finally(()=>setLoading(false))},[notify])
  return <div><div className="page-heading"><div><div className="eyebrow">A SPACE TO WORK TOGETHER</div><h1>People & access<span className="heading-dot">.</span></h1><p>The right files, in the right hands.</p></div><button className="button primary" onClick={()=>setEditing('new')}><Plus size={17}/>Add a person</button></div><div className="stats-grid"><div className="stat-card"><span><Users size={18}/>Total people</span><strong>{users.length}</strong><small>People in your workspace</small></div><div className="stat-card"><span><ShieldCheck size={18}/>Administrators</span><strong>{users.filter(u=>u.role==='admin'&&!u.disabled).length}</strong><small>Manage people and settings</small></div><div className="stat-card"><span><LockKeyhole size={18}/>Scoped access</span><strong>{users.filter(u=>u.scope!=='/').length}</strong><small>Access to specific folders</small></div></div><div className="people-container"><div className="people-toolbar"><h3>Workspace members <span className="count-chip">{users.length}</span></h3><div className="search-field"><Search size={15}/><input aria-label="Search people" placeholder="Find a person…" value={search} onChange={e=>setSearch(e.target.value)}/></div></div>{loading?<div className="empty-state"><Spinner/></div>:<div className="table-scroll"><table className="people-table"><thead><tr><th>Person</th><th>Role</th><th>Folder access</th><th>Permissions</th><th>Status</th><th/></tr></thead><tbody>{users.filter(u=>u.username.toLowerCase().includes(search.toLowerCase())).map(u=><tr key={u.id}><td><div className="person-cell"><span className="person-avatar">{u.username.slice(0,2).toUpperCase()}</span><div><strong>{u.username}{u.id===currentUser.id&&<span className="you-label">You</span>}</strong><span>Added {date(u.createdAt)}</span></div></div></td><td><span className={`role-badge ${u.role==='admin'?'role-admin':''}`}>{u.role==='admin'?<ShieldCheck size={13}/>:<Users size={13}/>} {u.role==='admin'?'Administrator':'Member'}</span></td><td><span className="scope-label"><Folder size={14}/>{u.scope==='/'?'All files':u.scope}</span></td><td><div className="permissions-summary">{u.role==='admin'?<span>Full access</span>:PERMISSIONS.filter(p=>u.permissions[p]).map(p=><span key={p}>{p}</span>)}{u.role!=='admin'&&!PERMISSIONS.some(p=>u.permissions[p])&&<span>No access</span>}</div></td><td><span className={`status-pill ${u.disabled?'status-disabled':''}`}><span/>{u.disabled?'Disabled':'Active'}</span></td><td><button className="icon-button" aria-label={'Edit '+u.username} onClick={()=>setEditing(u)}><Pencil size={16}/></button></td></tr>)}</tbody></table></div>}</div><div className="access-note"><ShieldCheck size={20}/><div><strong>Give everyone just the access they need.</strong><p>Choose a home folder and individual permissions. Changes revoke existing sessions immediately.</p></div></div>{editing&&<UserEditor user={editing==='new'?undefined:editing} onClose={()=>setEditing(null)} onSaved={async(id)=>{setEditing(null);notify(editing==='new'?'Person added.':'Access updated.');if(id===currentUser.id)await onAuthChanged();else await refresh()}}/>}</div>
}

function UserEditor({user,onClose,onSaved}:{user?:User;onClose:()=>void;onSaved:(id:string)=>Promise<void>}) {
  const [username,setUsername]=useState(user?.username??'')
  const [password,setPassword]=useState('')
  const [role,setRole]=useState<User['role']>(user?.role??'user')
  const [scope,setScope]=useState(user?.scope??'/')
  const [permissions,setPermissions]=useState<Permissions>(user?.permissions??{...READ_PERMISSIONS,upload:true,create:true})
  const [disabled,setDisabled]=useState(user?.disabled??false)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const submit=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{const result=await api<User>(user?`/admin/users/${user.id}`:'/admin/users',{method:user?'PATCH':'POST',body:{username,role,scope:role==='admin'?'/':scope,permissions:role==='admin'?FULL_PERMISSIONS:permissions,disabled,...(password?{password}:{})}});await onSaved(result.id)}catch(error){setError(errorMessage(error))}finally{setBusy(false)}}
  return <Modal title={user?'Manage access':'Add a person'} onClose={()=>!busy&&onClose()}><form className="modal-form" onSubmit={e=>void submit(e)}><div className="form-grid"><label>Username<input value={username} onChange={e=>setUsername(e.target.value)} required minLength={2} maxLength={40} pattern="[a-zA-Z0-9_.-]+" placeholder="e.g. alex" autoComplete="off"/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value as User['role'])}><option value="user">Member</option><option value="admin">Administrator</option></select></label></div><label>{user?'New password (optional)':'Password'}<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required={!user} minLength={12} maxLength={128} placeholder={user?'Leave blank to keep current password':'At least 12 characters'}/></label>{role==='admin'?<div className="info-box"><ShieldCheck size={20}/><p>Administrators can manage all files, people, and workspace settings.</p></div>:<><label>Home folder<input value={scope} onChange={e=>setScope(e.target.value)} required placeholder="/ or /team-documents"/><small>This existing folder becomes their root. They cannot browse outside it.</small></label><div className="permissions-heading"><strong>File permissions</strong><div><button type="button" onClick={()=>setPermissions({...READ_PERMISSIONS})}>Read only</button><button type="button" onClick={()=>setPermissions({...FULL_PERMISSIONS,delete:false})}>Collaborator</button></div></div><div className="permissions-grid">{PERMISSIONS.map(p=><label className="permission-option" key={p}><input type="checkbox" checked={permissions[p]} onChange={e=>setPermissions({...permissions,[p]:e.target.checked})}/><span><strong>{p==='read'?'Browse & preview':p==='create'?'Create folders':p[0].toUpperCase()+p.slice(1)}</strong><small>{{read:'See files and text previews',download:'Save files to their device',upload:'Add files to their folder',create:'Organize with new folders',rename:'Change file and folder names',delete:'Remove files and empty folders'}[p]}</small></span></label>)}</div></>}<label className="checkbox-label"><input type="checkbox" checked={disabled} onChange={e=>setDisabled(e.target.checked)}/>Disable this account</label>{error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy?<Spinner/>:user?'Save changes':'Add person'}</button></div></form></Modal>
}

function ActivityView({notify}:{notify:(text:string,error?:boolean)=>void}) {
  const [entries,setEntries]=useState<AuditEntry[]>([])
  const [loading,setLoading]=useState(true)
  const refresh=useCallback(async()=>{setLoading(true);try{setEntries(await api<AuditEntry[]>('/admin/audit'))}catch(error){notify(errorMessage(error),true)}finally{setLoading(false)}},[notify])
  useEffect(()=>{void api<AuditEntry[]>('/admin/audit').then(setEntries).catch(error=>notify(errorMessage(error),true)).finally(()=>setLoading(false))},[notify])
  const labels:Record<string,string>={'setup.completed':'created the workspace','auth.login':'signed in','auth.password_changed':'changed their password','upload.started':'started an upload','upload.completed':'finished an upload','upload.canceled':'canceled an upload','file.mkdir':'created a folder','file.rename':'renamed an item','file.delete':'deleted an item','user.created':'added a person','user.updated':'updated access','settings.updated':'updated workspace settings'}
  return <div><div className="page-heading"><div><div className="eyebrow">A CLEAR PICTURE</div><h1>Activity<span className="heading-dot">.</span></h1><p>Follow what’s happening in your workspace.</p></div><button className="button" onClick={()=>void refresh()}><RefreshCw size={16}/>Refresh</button></div><div className="activity-list">{loading?<div className="empty-state"><Spinner/></div>:entries.map(entry=><div className="activity-row" key={entry.id}><span className="activity-icon">{entry.action.startsWith('user')?<Users size={18}/>:entry.action.startsWith('upload')?<Upload size={18}/>:entry.action.startsWith('auth')?<LockKeyhole size={18}/>:<FolderOpen size={18}/>}</span><div><p><strong>{entry.actor}</strong> {labels[entry.action]??entry.action}</p><span>{entry.detail}</span></div><time title={new Date(entry.createdAt).toLocaleString()}>{date(entry.createdAt)} <span>{new Date(entry.createdAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span></time></div>)}</div><p className="muted activity-caption">Showing the 100 most recent workspace events.</p></div>
}

function SettingsView({user,bootstrap,system,notify,onAuthChanged}:{user:User;bootstrap:Bootstrap;system:SystemInfo|null;notify:(text:string,error?:boolean)=>void;onAuthChanged:()=>Promise<void>}) {
  const [siteName,setSiteName]=useState(bootstrap.siteName)
  const [currentPassword,setCurrentPassword]=useState('')
  const [newPassword,setNewPassword]=useState('')
  const [busy,setBusy]=useState(false)
  const save=async(event:FormEvent)=>{event.preventDefault();setBusy(true);try{await api('/admin/settings',{method:'PATCH',body:{siteName}});notify('Workspace name saved.');await onAuthChanged()}catch(error){notify(errorMessage(error),true)}finally{setBusy(false)}}
  const password=async(event:FormEvent)=>{event.preventDefault();setBusy(true);try{await api('/auth/password',{method:'POST',body:{currentPassword,newPassword}});notify('Password changed. Sign in with your new password.');await onAuthChanged()}catch(error){notify(errorMessage(error),true)}finally{setBusy(false)}}
  return <div><div className="page-heading"><div><div className="eyebrow">MAKE IT YOURS</div><h1>Settings<span className="heading-dot">.</span></h1><p>A few details that make this space your own.</p></div></div><div className="settings-grid">{user.role==='admin'&&<section className="settings-card"><div className="settings-card-title"><Settings2 size={19}/><h3>Workspace</h3></div><form onSubmit={e=>void save(e)}><label>Workspace name<input value={siteName} onChange={e=>setSiteName(e.target.value)} required maxLength={60}/></label><p className="muted">Displayed throughout the app for everyone in your workspace.</p><button className="button primary" disabled={busy}>Save changes</button></form></section>}<section className="settings-card"><div className="settings-card-title"><Database size={19}/><h3>Storage & transfers</h3></div><div className="settings-values"><div><span>Storage backend</span><strong>Local filesystem</strong></div><div><span>Available space</span><strong>{system?formatBytes(system.storage.available):'…'}</strong></div><div><span>Maximum file size</span><strong>{formatBytes(bootstrap.upload.maxFileSize)}</strong></div><div><span>Chunk size</span><strong>{formatBytes(bootstrap.upload.chunkSize)}</strong></div><div><span>Integrity checks</span><strong className="green"><ShieldCheck size={15}/> SHA-256</strong></div><div><span>Version</span><strong>{system?.version??'0.1.0'}</strong></div></div></section><section className="settings-card"><div className="settings-card-title"><LockKeyhole size={19}/><h3>Your password</h3></div><form onSubmit={e=>void password(e)}><label>Current password<input type="password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} autoComplete="current-password" required maxLength={128}/></label><label>New password<input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} autoComplete="new-password" required minLength={12} maxLength={128}/></label><p className="muted">Changing your password signs you out on all devices.</p><button className="button" disabled={busy}>Update password</button></form></section><section className="settings-card settings-note"><ShieldCheck size={31} strokeWidth={1.3}/><h3>Your files stay yours.</h3><p>This workspace runs on your server. Accounts use revocable sessions, and every file operation respects each person’s folder and permissions.</p><span className="tag"><LockKeyhole size={13}/>Signed in as {user.username}</span></section></div></div>
}
