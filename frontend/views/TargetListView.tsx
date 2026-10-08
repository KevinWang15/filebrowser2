import { useEffect, useState } from 'react'
import { IconAlertTriangle, IconChevronRight, IconHome2, IconRefresh, IconServer } from '@tabler/icons-react'
import type { Target } from '@/shared/types'
import { EmptyState, SearchField } from '../components/ui'
import { plural } from '../lib/format'

const TYPE_LABELS = { local: 'Local storage', s3: 'S3', ftp: 'FTP / FTPS', sftp: 'SFTP' }

export function TargetListView({ targets, admin, unavailable, onOpen, onManage, onRefresh }: {
  targets: Target[]; admin: boolean; unavailable: boolean
  onOpen: (id: string) => void; onManage: () => void; onRefresh: () => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  useEffect(() => { void onRefresh() }, [onRefresh])
  const visible = targets.filter(target => target.name.toLowerCase().includes(search.trim().toLowerCase()))
  const refresh = async () => { setRefreshing(true); try { await onRefresh() } finally { setRefreshing(false) } }

  return <div className="page target-list-view">
    <header className="page-header">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><ol><li aria-current="page"><h1 className="page-title"><IconHome2 size={17} className="title-icon" />My files</h1></li></ol></nav>
      <div className="page-actions"><SearchField value={search} onChange={setSearch} label="Search targets" placeholder="Filter targets" /></div>
    </header>
    <div className="toolbar">
      <span className="toolbar-info">{plural(targets.length, 'target')}</span>
      <div className="toolbar-right">
        {admin && <button type="button" className="btn btn-sm btn-ghost" onClick={onManage}>Manage targets</button>}
        <button type="button" className="icon-btn" aria-label="Refresh targets" data-tip="Refresh targets" disabled={refreshing} onClick={() => void refresh()}><IconRefresh size={15} className={refreshing ? 'spin' : ''} /></button>
      </div>
    </div>
    {unavailable && <p className="page-foot dim" role="status"><IconAlertTriangle size={15} />This target is unavailable or you no longer have access. Choose another target.</p>}
    <div className="target-list-scroll">
      {!targets.length ? <EmptyState icon={IconServer} title="No storage targets" action={admin ? <button type="button" className="btn btn-primary" onClick={onManage}>Add a target</button> : undefined}>
        {admin ? 'Add a storage target to start browsing your files.' : 'Ask an administrator to grant access to a storage target.'}
      </EmptyState> : !visible.length ? <EmptyState icon={IconServer} title="No matching targets" action={<button type="button" className="btn btn-sm" onClick={() => setSearch('')}>Clear filter</button>}>No targets match “{search}”.</EmptyState>
        : <ul className="target-list" aria-label="Storage targets">{visible.map(target => <li key={target.id}>
          <button type="button" className="target-entry" aria-label={target.name} onClick={() => onOpen(target.id)}>
            <span className="target-entry-icon"><IconServer size={21} stroke={1.5} /></span>
            <span className="target-entry-name"><strong title={target.name}>{target.name}</strong><span>{TYPE_LABELS[target.type]}{target.readOnly ? ' · Read only' : ''}</span></span>
            <IconChevronRight size={16} className="dim" />
          </button>
        </li>)}</ul>}
    </div>
  </div>
}
