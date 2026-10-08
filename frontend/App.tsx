import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  IconActivity, IconAlertTriangle, IconArrowsTransferUp, IconCommand, IconDeviceDesktop, IconFolderPlus, IconFolders, IconKeyboard, IconLayoutRows,
  IconLogout, IconMoon, IconRefresh, IconServer, IconSettings, IconSun, IconUpload, IconUsers, type Icon,
} from '@tabler/icons-react'
import type { Bootstrap, SystemInfo, UploadSession, User } from '@/shared/types'
import { VERSION } from '@/shared/version'
import { api, errorMessage } from './api'
import { CommandPalette, type Command } from './components/CommandPalette'
import { Shortcuts } from './components/Shortcuts'
import { Toasts, type Toast } from './components/Toasts'
import { Tooltips } from './components/Tooltips'
import { Avatar, Kbd, Logo, Progress, Spinner } from './components/ui'
import { formatBytes, plural } from './lib/format'
import { shortcutBlocked } from './lib/modalStack'
import { NotifyContext } from './lib/notify'
import { isRunning, STATE_LABELS, transferProgress } from './lib/transfers'
import { targetAccess } from './lib/targets'
import { TargetsView } from './views/TargetsView'
import { can } from './lib/permissions'
import { applyAppearance, DENSITIES, THEMES, usePref, type Density, type Theme } from './lib/prefs'
import { useRoute, type View } from './lib/route'
import { UploadEngine, type Transfer } from './upload-engine'
import { ActivityView } from './views/ActivityView'
import { AuthScreen } from './views/AuthScreen'
import { FilesView } from './views/files/FilesView'
import { PeopleView } from './views/PeopleView'
import { SettingsView } from './views/SettingsView'
import { TransfersView } from './views/TransfersView'
import { UploadDialog } from './views/UploadDialog'

const CONNECTIONS = ['1', '2', '4'] as const

function useAppearance() {
  const [theme, setTheme] = usePref<Theme>('theme', 'system', THEMES)
  const [density, setDensity] = usePref<Density>('density', 'compact', DENSITIES)
  useEffect(() => { applyAppearance(theme, density) }, [theme, density])
  return { theme, setTheme, density, setDensity }
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  useAppearance()
  const refresh = useCallback(async () => {
    try { setBootstrap(await api<Bootstrap>('/bootstrap')); setError('') } catch (error) { setError(errorMessage(error)) }
  }, [])
  useEffect(() => { void api<Bootstrap>('/bootstrap').then(setBootstrap).catch(error => setError(errorMessage(error))) }, [])
  useEffect(() => {
    const listener = () => { void refresh() }
    window.addEventListener('fb-session-expired', listener)
    return () => window.removeEventListener('fb-session-expired', listener)
  }, [refresh])
  if (!bootstrap) return <div className="splash">
    <Logo size={32} />
    {error ? <div className="splash-error"><IconAlertTriangle size={16} /><span>{error}</span><button type="button" className="btn btn-sm" onClick={() => void refresh()}><IconRefresh size={14} />Try again</button></div>
      : <div className="splash-loading"><Spinner /><span>Opening workspace…</span></div>}
  </div>
  if (bootstrap.needsSetup || !bootstrap.user) return <><AuthScreen setup={bootstrap.needsSetup} siteName={bootstrap.siteName} setupLocalPath={bootstrap.setupLocalPath} onDone={refresh} /><Tooltips /></>
  return <Workspace key={bootstrap.user.id} bootstrap={bootstrap} user={bootstrap.user} onAuthChanged={refresh} />
}

function Workspace({ bootstrap, user, onAuthChanged }: { bootstrap: Bootstrap; user: User; onAuthChanged: () => Promise<void> }) {
  const [route, navigate] = useRoute()
  const { theme, setTheme, density, setDensity } = useAppearance()
  const [connections, setConnections] = usePref('connections', '1', CONNECTIONS)
  const [engine] = useState(() => new UploadEngine(bootstrap.upload))
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [overlay, setOverlay] = useState<'upload' | 'palette' | 'shortcuts' | null>(null)
  const [lastFolder, setLastFolder] = useState({ targetId: null as string | null, path: '/' })
  const [folderRequest, setFolderRequest] = useState(0)
  const chord = useRef(0)
  const admin = user.role === 'admin'
  const target = bootstrap.targets.find(target => target.id === route.targetId) ?? (!route.targetId ? bootstrap.targets[0] : null) ?? null
  useEffect(() => { if (target && !route.targetId) navigate({ ...route, targetId: target.id }) }, [target, route, navigate])
  const access = targetAccess(user, target)
  const view: View = !admin && (route.view === 'people' || route.view === 'activity' || route.view === 'targets') ? 'files' : route.view
  const folder = view === 'files' ? route.path : lastFolder.targetId === target?.id ? lastFolder.path : '/'
  if (view === 'files' && (route.path !== lastFolder.path || target?.id !== lastFolder.targetId)) setLastFolder({ targetId: target?.id ?? null, path: route.path })

  const notify = useCallback((text: string, error = false) => {
    setToasts(previous => [...previous.slice(-3), { id: Date.now() + Math.random(), text, error }])
  }, [])
  const loadSystem = useCallback(() => { void api<SystemInfo>('/system').then(setSystem).catch(() => {}) }, [])

  useEffect(() => { engine.setConnections(Number(connections) as 1 | 2 | 4) }, [engine, connections])
  useEffect(() => {
    engine.setCompleteHandler(task => { loadSystem(); notify(`Uploaded “${task.name}”.`) })
  }, [engine, loadSystem, notify])
  useEffect(() => {
    engine.activate()
    const unsubscribe = engine.subscribe(setTransfers)
    void api<UploadSession[]>('/uploads').then(sessions => engine.hydrate(sessions)).catch(error => notify(errorMessage(error), true))
    void api<SystemInfo>('/system').then(setSystem).catch(error => notify(errorMessage(error), true))
    return () => { unsubscribe(); engine.dispose() }
  }, [engine, notify])

  // Warn before closing the tab while bytes are in flight; verified progress survives, but the current chunk restarts.
  const running = transfers.filter(isRunning)
  const busy = running.length > 0
  useEffect(() => {
    if (!busy) return
    const listener = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', listener)
    return () => window.removeEventListener('beforeunload', listener)
  }, [busy])

  const go = useCallback((next: View, path?: string) => navigate({ view: next, targetId: target?.id ?? null, path: next === 'files' ? path ?? '/' : '/' }), [navigate, target?.id])
  const goFiles = () => go('files', view === 'files' ? '/' : folder)
  const addFiles = useCallback((files: File[], directory: string, fromDialog = false) => {
    if (!files.length) return
    if (!target || !can(access, 'upload')) return
    engine.add(files, target, directory)
    setOverlay(null)
    if (fromDialog) go('transfers')
    else notify(`Uploading ${plural(files.length, 'file')} to ${directory === '/' ? 'My files' : directory}.`)
  }, [engine, go, notify, target, access])
  const signOut = () => { void api('/auth/logout', { method: 'POST' }).then(onAuthChanged).catch(error => notify(errorMessage(error), true)) }
  const openUpload = useCallback(() => setOverlay('upload'), [])

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOverlay(overlay === 'palette' ? null : 'palette'); return }
    if (shortcutBlocked(event) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '?') { event.preventDefault(); setOverlay('shortcuts'); return }
    const key = event.key.toLowerCase()
    if (Date.now() - chord.current < 1000) {
      chord.current = 0
      const target = ({ f: 'files', t: 'transfers', s: 'settings', ...(admin ? { p: 'people', a: 'activity' } : {}) } as Record<string, View>)[key]
      if (target) { event.preventDefault(); go(target, folder) }
      return
    }
    if (key === 'g') chord.current = Date.now()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [])

  const active = transfers.filter(task => task.state !== 'completed')
  const attention = transfers.filter(task => task.state === 'failed' || task.state === 'needs-file').length
  const overall = useMemo(() => {
    const total = running.reduce((sum, task) => sum + task.size, 0)
    return total ? running.reduce((sum, task) => sum + transferProgress(task) * task.size, 0) / total : 0
  }, [running])
  const speed = running.reduce((sum, task) => sum + task.speed, 0)

  const commands: Command[] = [
    { id: 'files', group: 'Go to', label: 'My files', icon: IconFolders, shortcut: 'G F', run: () => go('files', '/') },
    { id: 'transfers', group: 'Go to', label: 'Transfers', icon: IconArrowsTransferUp, shortcut: 'G T', run: () => go('transfers') },
    ...(admin ? [
      { id: 'people', group: 'Go to', label: 'People & access', icon: IconUsers, shortcut: 'G P', keywords: 'users accounts', run: () => go('people') },
      { id: 'activity', group: 'Go to', label: 'Activity', icon: IconActivity, shortcut: 'G A', keywords: 'audit log', run: () => go('activity') },
    ] : []),
    { id: 'settings', group: 'Go to', label: admin ? 'Settings' : 'Account settings', icon: IconSettings, shortcut: 'G S', run: () => go('settings') },
    ...(can(access, 'upload') ? [{ id: 'upload', group: 'Actions', label: 'Upload files', icon: IconUpload, keywords: 'add', run: openUpload }] : []),
    ...(can(access, 'create') ? [{ id: 'folder', group: 'Actions', label: 'New folder…', icon: IconFolderPlus, keywords: 'create mkdir', run: () => { go('files', folder); setFolderRequest(value => value + 1) } }] : []),
    { id: 'theme-light', group: 'Preferences', label: 'Use light theme', icon: IconSun, keywords: 'appearance', run: () => setTheme('light') },
    { id: 'theme-dark', group: 'Preferences', label: 'Use dark theme', icon: IconMoon, keywords: 'appearance', run: () => setTheme('dark') },
    { id: 'theme-system', group: 'Preferences', label: 'Use system theme', icon: IconDeviceDesktop, keywords: 'appearance', run: () => setTheme('system') },
    { id: 'density', group: 'Preferences', label: density === 'compact' ? 'Comfortable density' : 'Compact density', icon: IconLayoutRows, run: () => setDensity(density === 'compact' ? 'comfortable' : 'compact') },
    { id: 'shortcuts', group: 'Help', label: 'Keyboard shortcuts', icon: IconKeyboard, shortcut: '?', run: () => setOverlay('shortcuts') },
    { id: 'signout', group: 'Account', label: 'Sign out', icon: IconLogout, run: signOut },
  ]

  const navItem = (target: View, label: string, Glyph: Icon, badge?: { count: number; tone?: string }) =>
    <button type="button" aria-label={label} aria-current={view === target ? 'page' : undefined} className={`nav-item ${view === target ? 'is-active' : ''}`}
      onClick={() => target === 'files' ? goFiles() : go(target)}>
      <Glyph size={17} stroke={1.75} /><span className="nav-label">{label}</span>
      {!!badge?.count && <span className={`nav-badge ${badge.tone ?? ''}`}>{badge.count}</span>}
    </button>
  const volume = system?.targets.find(volume => volume.id === target?.id)
  const storageUsed = volume?.total && volume.available !== null ? 1 - volume.available / volume.total : 0
  const nextTheme: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'

  return <NotifyContext.Provider value={notify}>
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><Logo size={22} /><span className="brand-name" title={bootstrap.siteName}>{bootstrap.siteName}</span></div>
        <button type="button" className="palette-trigger" onClick={() => setOverlay('palette')}><IconCommand size={14} /><span>Search commands</span><Kbd>{/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</Kbd></button>
        <nav className="nav" aria-label="Main">
          <div className="nav-caption">Workspace</div>
          {navItem('files', 'My files', IconFolders)}
          <label className="sr-only" htmlFor="target-picker">Storage target</label>
          <select id="target-picker" className="select target-picker" value={target?.id ?? ''} onChange={event => { setOverlay(null); navigate({ view: 'files', targetId: event.target.value, path: '/' }) }}>
            <option value="" disabled>Select a target</option>{bootstrap.targets.map(target => <option key={target.id} value={target.id}>{target.name} · {target.type.toUpperCase()}</option>)}
          </select>
          {navItem('transfers', 'Transfers', IconArrowsTransferUp, { count: active.length, tone: attention ? 'is-warning' : running.length ? 'is-accent' : '' })}
          {admin ? <>
            <div className="nav-caption">Administration</div>
            {navItem('targets', 'Storage targets', IconServer)}
            {navItem('people', 'People & access', IconUsers)}
            {navItem('activity', 'Activity', IconActivity)}
            {navItem('settings', 'Settings', IconSettings)}
          </> : navItem('settings', 'Account settings', IconSettings)}
        </nav>
        {running.length > 0 && <button type="button" className="sidebar-transfer" onClick={() => go('transfers')}>
          <div><span className="spin-dot" /><strong>{plural(running.length, 'upload')}</strong><span className="mono">{Math.floor(overall * 100)}%</span></div>
          <Progress value={overall} />
          <span className="dim mono">{speed ? formatBytes(speed) + '/s' : STATE_LABELS[running[0].state] + '…'}</span>
        </button>}
        <div className="sidebar-foot">
          <div className="storage">
            <div className="storage-head"><IconServer size={13} /><span>Storage</span>{volume?.total !== null && volume?.total !== undefined && <span className="mono dim">{Math.round(storageUsed * 100)}%</span>}</div>
            <Progress value={storageUsed} tone={storageUsed > 0.9 ? 'danger' : storageUsed > 0.75 ? 'warning' : 'accent'} />
            <span className="dim mono storage-caption">{volume?.total && volume.available !== null ? `${formatBytes(volume.available)} free / ${formatBytes(volume.total)}` : target ? 'Capacity not reported' : 'Select a target'}</span>
          </div>
          <div className="user-block">
            <Avatar name={user.username} size={26} />
            <div className="user-meta"><strong>{user.username}</strong><span>{admin ? 'Administrator' : 'Member'}</span></div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`Theme: ${theme}. Switch to ${nextTheme}`} data-tip={`Theme: ${theme}`} onClick={() => setTheme(nextTheme)}>
              {theme === 'dark' ? <IconMoon size={15} /> : theme === 'light' ? <IconSun size={15} /> : <IconDeviceDesktop size={15} />}
            </button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Sign out" data-tip="Sign out" onClick={signOut}><IconLogout size={15} /></button>
          </div>
        </div>
      </aside>
      <main className="main">
        {view === 'files' && (access && target ? <FilesView key={target.id} path={route.path} user={access} transfers={transfers} density={density} onNavigate={path => go('files', path)}
          onUpload={openUpload} onAddFiles={addFiles} onTransfers={() => go('transfers')} folderRequest={folderRequest} /> : <div className="page page-scroll"><header className="page-header"><h1 className="page-title">Choose a storage target</h1></header><p className="page-foot">{bootstrap.targets.length ? 'Select a target in the sidebar to browse its files.' : admin ? 'Add a target in Storage targets to start browsing.' : 'Ask an administrator to grant access to a storage target.'}</p></div>)}
        {view === 'transfers' && <TransfersView targets={bootstrap.targets} access={access} transfers={transfers} engine={engine} user={user} connections={connections} onConnections={setConnections} onUpload={openUpload} />}
        {view === 'people' && <PeopleView currentUser={user} onAuthChanged={onAuthChanged} />}
        {view === 'targets' && <TargetsView onChanged={onAuthChanged} />}
        {view === 'activity' && <ActivityView targets={bootstrap.targets} />}
        {view === 'settings' && <SettingsView user={user} bootstrap={bootstrap} system={system} onAuthChanged={onAuthChanged} />}
        <footer className="statusbar">
          <span className="status-item"><span className="live-dot" />Connected</span>
          {access?.storageReadOnly && <span className="status-item">Read-only storage</span>}
          <span className="status-item mono">{target?.name ?? 'No target'} · {folder}</span>
          <span className="status-spacer" />
          {running.length > 0 && <button type="button" className="status-item status-btn" onClick={() => go('transfers')}><IconArrowsTransferUp size={12} />{running.length} running · <span className="mono">{formatBytes(speed)}/s</span></button>}
          {attention > 0 && <button type="button" className="status-item status-btn is-warning" onClick={() => go('transfers')}><IconAlertTriangle size={12} />{attention} need attention</button>}
          <span className="status-item mono hide-sm">{formatBytes(bootstrap.upload.chunkSize)} chunks · {connections}× parallel</span>
          <button type="button" className="status-item status-btn hide-sm" onClick={() => setOverlay('shortcuts')}><IconKeyboard size={12} />Shortcuts <Kbd>?</Kbd></button>
          <span className="status-item mono dim hide-sm">v{system?.version ?? VERSION}</span>
        </footer>
      </main>
      {overlay === 'upload' && target && access && can(access, 'upload') && <UploadDialog targetName={target.name} directory={folder}
        limits={{ ...bootstrap.upload, maxFileSize: Math.min(bootstrap.upload.maxFileSize, target.capabilities.maxChunks * bootstrap.upload.chunkSize) }} connections={connections} onConnections={setConnections}
        onFiles={files => addFiles(files, folder, true)} onClose={() => setOverlay(null)} />}
      {overlay === 'palette' && <CommandPalette commands={commands} onClose={() => setOverlay(null)} onOpenPath={path => go('files', '/' + path.split('/').filter(Boolean).join('/'))} />}
      {overlay === 'shortcuts' && <Shortcuts onClose={() => setOverlay(null)} />}
      <Toasts toasts={toasts} onDismiss={id => setToasts(previous => previous.filter(toast => toast.id !== id))} />
      <Tooltips />
    </div>
  </NotifyContext.Provider>
}
