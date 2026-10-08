import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconActivity, IconFolder, IconLock, IconRefresh, IconSettings, IconUpload, IconUsers, type Icon } from '@tabler/icons-react'
import type { AuditEntry, Target } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Avatar, EmptyState, SearchField, Segmented, Spinner } from '../components/ui'
import { formatDateTime, formatFull } from '../lib/format'
import { useNotify } from '../lib/notify'

const LABELS: Record<string, string> = {
  'setup.completed': 'created the workspace', 'auth.login': 'signed in', 'auth.password_changed': 'changed their password',
  'upload.started': 'started an upload', 'upload.completed': 'finished an upload', 'upload.canceled': 'canceled an upload',
  'file.mkdir': 'created a folder', 'file.rename': 'renamed an item', 'file.delete': 'deleted an item',
  'target.created': 'added a storage target', 'target.updated': 'updated a storage target', 'target.deleted': 'removed a storage target',
  'user.created': 'added a person', 'user.updated': 'updated access', 'settings.updated': 'updated workspace settings',
}
type Category = 'all' | 'file' | 'upload' | 'auth' | 'admin'
const category = (action: string): Exclude<Category, 'all'> =>
  action.startsWith('file') ? 'file' : action.startsWith('upload') ? 'upload' : action.startsWith('auth') ? 'auth' : 'admin'
const ICONS: Record<Exclude<Category, 'all'>, Icon> = { file: IconFolder, upload: IconUpload, auth: IconLock, admin: IconSettings }

export function ActivityView({ targets }: { targets: Target[] }) {
  const notify = useNotify()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Category>('all')
  const [search, setSearch] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true)
    try { setEntries(await api<AuditEntry[]>('/admin/audit')) } catch (error) { notify(errorMessage(error), true) } finally { setLoading(false) }
  }, [notify])
  useEffect(() => { void api<AuditEntry[]>('/admin/audit').then(setEntries).catch(error => notify(errorMessage(error), true)) }, [notify])
  const list = useMemo(() => entries ?? [], [entries])
  const counts = useMemo(() => {
    const result: Record<Category, number> = { all: list.length, file: 0, upload: 0, auth: 0, admin: 0 }
    for (const entry of list) result[category(entry.action)]++
    return result
  }, [list])
  const query = search.trim().toLowerCase()
  const visible = list.filter(entry => (filter === 'all' || category(entry.action) === filter)
    && (!query || [entry.actor, entry.detail, entry.action, LABELS[entry.action] ?? '', targets.find(target => target.id === entry.targetId)?.name ?? entry.targetId ?? ''].some(value => value.toLowerCase().includes(query))))
  return <div className="page">
    <header className="page-header">
      <div className="page-heading"><h1 className="page-title"><IconActivity size={18} className="title-icon" />Activity</h1>
        <span className="page-sub">The 100 most recent workspace events</span></div>
      <div className="page-actions">
        <SearchField value={search} onChange={setSearch} label="Search activity" placeholder="Filter events" />
        <button type="button" className="btn" onClick={() => void refresh()}><IconRefresh size={15} className={loading ? 'spin' : ''} /><span className="btn-label">Refresh</span></button>
      </div>
    </header>
    <div className="toolbar">
      <Segmented size="sm" label="Filter activity" value={filter} onChange={setFilter} options={[
        { value: 'all', label: 'All', count: counts.all }, { value: 'file', label: 'Files', icon: IconFolder, count: counts.file },
        { value: 'upload', label: 'Uploads', icon: IconUpload, count: counts.upload }, { value: 'auth', label: 'Sign-ins', icon: IconLock, count: counts.auth },
        { value: 'admin', label: 'Admin', icon: IconUsers, count: counts.admin },
      ]} />
    </div>
    <div className="table-wrap activity-list">
      {!entries ? <div className="empty"><Spinner /></div> : !visible.length ? <EmptyState icon={IconActivity} title="No matching events" /> :
        <table className="data-table activity-table">
          <thead><tr><th className="col-time">Time</th><th className="col-actor">Person</th><th>Event</th><th>Target</th><th>Detail</th></tr></thead>
          <tbody>{visible.map(entry => {
            const kind = category(entry.action), Glyph = ICONS[kind]
            return <tr key={entry.id}>
              <td className="col-time mono dim" title={formatFull(entry.createdAt)}>{formatDateTime(entry.createdAt)}</td>
              <td className="col-actor"><div className="person"><Avatar name={entry.actor} size={20} /><strong>{entry.actor}</strong></div></td>
              <td><span className={`event tone-${kind}`}><Glyph size={13} stroke={1.75} />{LABELS[entry.action] ?? entry.action}</span></td>
              <td>{entry.targetId ? targets.find(target => target.id === entry.targetId)?.name ?? 'Unavailable target' : 'Workspace'}</td>
              <td className="mono detail" title={entry.detail}>{entry.detail}</td>
            </tr>
          })}</tbody>
        </table>}
    </div>
  </div>
}
