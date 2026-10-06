import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconFolder, IconLock, IconPencil, IconShieldCheck, IconUserCog, IconUserPlus, IconUsers } from '@tabler/icons-react'
import { FULL_PERMISSIONS, PERMISSIONS, READ_PERMISSIONS, type Permissions, type User } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Modal } from '../components/Modal'
import { Avatar, EmptyState, SearchField, Segmented, Spinner } from '../components/ui'
import { formatDate, formatFull } from '../lib/format'
import { useNotify } from '../lib/notify'
import { PERMISSION_META } from '../lib/permissions'

const PRESETS: { label: string; permissions: Permissions }[] = [
  { label: 'Read only', permissions: { ...READ_PERMISSIONS } },
  { label: 'Contributor', permissions: { ...READ_PERMISSIONS, upload: true, create: true } },
  { label: 'Collaborator', permissions: { ...FULL_PERMISSIONS, delete: false } },
  { label: 'Full access', permissions: { ...FULL_PERMISSIONS } },
]

function PermissionDots({ user }: { user: User }) {
  const allowed = PERMISSIONS.filter(permission => user.role === 'admin' || user.permissions[permission])
  return <div className="perm-dots">
    <span className="sr-only">{allowed.length ? allowed.map(permission => PERMISSION_META[permission].label).join(', ') : 'No access'}</span>
    {PERMISSIONS.map(permission => {
      const meta = PERMISSION_META[permission], on = allowed.includes(permission)
      return <span key={permission} className={`perm-dot ${on ? 'is-on' : ''}`} data-tip={`${meta.label}: ${on ? 'allowed' : 'not allowed'}`} aria-hidden="true">
        <meta.icon size={13} stroke={1.75} />
      </span>
    })}
  </div>
}

export function PeopleView({ currentUser, onAuthChanged }: { currentUser: User; onAuthChanged: () => Promise<void> }) {
  const notify = useNotify()
  const [users, setUsers] = useState<User[] | null>(null)
  const [editing, setEditing] = useState<User | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'admin' | 'user' | 'disabled'>('all')
  const refresh = useCallback(async () => {
    try { setUsers(await api<User[]>('/admin/users')) } catch (error) { notify(errorMessage(error), true) }
  }, [notify])
  useEffect(() => { void api<User[]>('/admin/users').then(setUsers).catch(error => notify(errorMessage(error), true)) }, [notify])
  const list = users ?? []
  const query = search.trim().toLowerCase()
  const visible = list.filter(user => (!query || user.username.toLowerCase().includes(query) || user.scope.toLowerCase().includes(query))
    && (filter === 'all' || (filter === 'disabled' ? user.disabled : user.role === filter && !user.disabled)))
  return <div className="page">
    <header className="page-header">
      <div className="page-heading"><h1 className="page-title"><IconUsers size={18} className="title-icon" />People & access</h1>
        <span className="page-sub">Accounts, home folders, and permissions</span></div>
      <div className="page-actions">
        <SearchField value={search} onChange={setSearch} label="Search people" placeholder="Filter by name or folder" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}><IconUserPlus size={15} /><span className="btn-label">Add a person</span></button>
      </div>
    </header>
    <div className="toolbar">
      <Segmented size="sm" label="Filter people" value={filter} onChange={setFilter} options={[
        { value: 'all', label: 'All', count: list.length },
        { value: 'admin', label: 'Admins', count: list.filter(user => user.role === 'admin' && !user.disabled).length },
        { value: 'user', label: 'Members', count: list.filter(user => user.role === 'user' && !user.disabled).length },
        { value: 'disabled', label: 'Disabled', count: list.filter(user => user.disabled).length },
      ]} />
      <div className="toolbar-right toolbar-info hide-sm"><span>{list.filter(user => user.scope !== '/').length} with scoped folders</span></div>
    </div>
    <div className="table-wrap">
      {!users ? <div className="empty"><Spinner /></div> : !visible.length ? <EmptyState icon={IconUsers} title="No people found">Try a different filter.</EmptyState> :
        <table className="data-table people-table">
          <thead><tr><th>Person</th><th>Role</th><th>Home folder</th><th>Permissions</th><th>Status</th><th>Added</th><th className="col-actions"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{visible.map(user => <tr key={user.id} className={user.disabled ? 'is-disabled' : ''} onDoubleClick={() => setEditing(user)}>
            <td><div className="person"><Avatar name={user.username} /><strong>{user.username}</strong>{user.id === currentUser.id && <span className="badge">You</span>}</div></td>
            <td>{user.role === 'admin' ? <span className="badge badge-accent"><IconShieldCheck size={12} />Administrator</span> : <span className="badge">Member</span>}</td>
            <td><span className="inline-icon mono"><IconFolder size={13} className="dim" />{user.scope === '/' ? 'All files' : user.scope}</span></td>
            <td><PermissionDots user={user} /></td>
            <td><span className={`status-dot ${user.disabled ? 'is-off' : 'is-on'}`}>{user.disabled ? 'Disabled' : 'Active'}</span></td>
            <td className="mono dim" title={formatFull(user.createdAt)}>{formatDate(user.createdAt)}</td>
            <td className="col-actions"><div className="row-actions is-visible">
              <button type="button" className="icon-btn icon-btn-sm" aria-label={'Edit ' + user.username} data-tip="Edit access" onClick={() => setEditing(user)}><IconPencil size={15} /></button>
            </div></td>
          </tr>)}</tbody>
        </table>}
    </div>
    <p className="page-foot dim"><IconLock size={12} /> Changing access, role, or password immediately revokes that person’s existing sessions.</p>
    {editing && <UserEditor user={editing === 'new' ? undefined : editing} self={editing !== 'new' && editing.id === currentUser.id} onClose={() => setEditing(null)} onSaved={async id => {
      setEditing(null); notify(editing === 'new' ? 'Person added.' : 'Access updated.')
      if (id === currentUser.id) await onAuthChanged(); else await refresh()
    }} />}
  </div>
}

function UserEditor({ user, self, onClose, onSaved }: { user?: User; self: boolean; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [username, setUsername] = useState(user?.username ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<User['role']>(user?.role ?? 'user')
  const [scope, setScope] = useState(user?.scope ?? '/')
  const [permissions, setPermissions] = useState<Permissions>(user?.permissions ?? { ...READ_PERMISSIONS, upload: true, create: true })
  const [disabled, setDisabled] = useState(user?.disabled ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await api<User>(user ? `/admin/users/${user.id}` : '/admin/users', {
        method: user ? 'PATCH' : 'POST',
        body: { username, role, scope: role === 'admin' ? '/' : scope, permissions: role === 'admin' ? FULL_PERMISSIONS : permissions, disabled, ...(password ? { password } : {}) },
      })
      await onSaved(result.id)
    } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  const preset = PRESETS.find(item => PERMISSIONS.every(permission => item.permissions[permission] === permissions[permission]))
  return <Modal side size="md" title={user ? 'Manage access' : 'Add a person'} icon={user ? <IconUserCog size={17} /> : <IconUserPlus size={17} />}
    description={user ? <>Editing <strong>{user.username}</strong>{self && ' (you)'}</> : 'Create an account with its own home folder'} onClose={() => !busy && onClose()}>
    <form className="drawer-form" onSubmit={event => void submit(event)}>
      <div className="modal-body">
        <section className="form-section">
          <h4>Account</h4>
          <div className="form-grid">
            <div className="field"><label htmlFor="user-name">Username</label>
              <input id="user-name" className="input" value={username} onChange={event => setUsername(event.target.value)} required minLength={2} maxLength={40} pattern="[a-zA-Z0-9_.-]+" placeholder="e.g. alex" autoComplete="off" spellCheck={false} /></div>
            <div className="field"><label htmlFor="user-role">Role</label>
              <select id="user-role" className="select" value={role} onChange={event => setRole(event.target.value as User['role'])}><option value="user">Member</option><option value="admin">Administrator</option></select></div>
          </div>
          <div className="field"><label htmlFor="user-password">{user ? 'New password (optional)' : 'Password'}</label>
            <input id="user-password" className="input" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required={!user} minLength={12} maxLength={128}
              placeholder={user ? 'Leave blank to keep current password' : 'At least 12 characters'} /></div>
        </section>
        {role === 'admin' ? <p className="callout callout-accent"><IconShieldCheck size={15} /><span>Administrators can manage all files, people, and workspace settings.</span></p> : <>
          <section className="form-section">
            <h4>Home folder</h4>
            <div className="field"><label htmlFor="user-scope" className="sr-only">Home folder</label>
              <div className="input-group input-prefix"><IconFolder size={14} /><input id="user-scope" className="input mono" value={scope} onChange={event => setScope(event.target.value)} required placeholder="/ or /team-documents" spellCheck={false} /></div>
              <span className="field-hint">This existing folder becomes their root. They cannot browse outside it.</span></div>
          </section>
          <section className="form-section">
            <div className="section-head"><h4>Permissions</h4>
              <div className="preset-row" role="group" aria-label="Permission presets">{PRESETS.map(item => <button key={item.label} type="button" className={`chip ${preset === item ? 'is-active' : ''}`}
                onClick={() => setPermissions({ ...item.permissions })}>{item.label}</button>)}</div></div>
            <div className="perm-list">{PERMISSIONS.map(permission => {
              const meta = PERMISSION_META[permission]
              return <label className="perm-option" key={permission}>
                <span className="perm-icon"><meta.icon size={15} stroke={1.75} /></span>
                <span className="perm-text"><strong>{meta.label}</strong><small>{meta.description}</small></span>
                <input type="checkbox" className="switch" checked={permissions[permission]} onChange={event => setPermissions({ ...permissions, [permission]: event.target.checked })} />
              </label>
            })}</div>
          </section>
        </>}
        <section className="form-section">
          <h4>Status</h4>
          <label className="perm-option">
            <span className="perm-text"><strong>Disable this account</strong><small>Blocks sign-in and ends current sessions.</small></span>
            <input type="checkbox" className="switch is-danger" checked={disabled} onChange={event => setDisabled(event.target.checked)} />
          </label>
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : user ? 'Save changes' : 'Add person'}</button>
      </footer>
    </form>
  </Modal>
}

