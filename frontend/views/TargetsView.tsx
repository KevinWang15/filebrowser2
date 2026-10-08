import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlus, IconServer, IconPencil, IconTrash } from '@tabler/icons-react'
import type { AdminTarget, TargetConnection, TargetType } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Modal } from '../components/Modal'
import { ConnectionFields } from '../components/ConnectionFields'
import { EmptyState, Spinner } from '../components/ui'
import { useNotify } from '../lib/notify'
import { emptyConnection, TARGET_LABELS } from '../lib/target-connections'
export function TargetsView({ onChanged }: { onChanged: () => Promise<void> }) {
  const [targets, setTargets] = useState<AdminTarget[] | null>(null), [editing, setEditing] = useState<AdminTarget | 'new' | null>(null)
  const [removing, setRemoving] = useState<AdminTarget | null>(null), [busy, setBusy] = useState('')
  const notify = useNotify()
  const load = useCallback(async () => { try { setTargets(await api<AdminTarget[]>('/admin/targets')) } catch (error) { notify(errorMessage(error), true) } }, [notify])
  useEffect(() => { void api<AdminTarget[]>('/admin/targets').then(setTargets).catch(error => notify(errorMessage(error), true)) }, [notify])
  const test = async (target: AdminTarget) => {
    setBusy(target.id)
    try { await api(`/admin/targets/${target.id}/test`, { method: 'POST' }); notify(`Connected to “${target.name}”.`) }
    catch (error) { notify(errorMessage(error), true) } finally { setBusy('') }
  }
  const remove = async () => {
    if (!removing) return
    setBusy(removing.id)
    try { await api(`/admin/targets/${removing.id}`, { method: 'DELETE' }); setRemoving(null); await load(); await onChanged(); notify('Target removed.') }
    catch (error) { notify(errorMessage(error), true) } finally { setBusy('') }
  }
  return <div className="page page-scroll">
    <header className="page-header"><div className="page-heading"><h1 className="page-title"><IconServer size={18} />Storage targets</h1><span className="page-sub">Named storage connections with independent access grants</span></div><button className="btn btn-primary" onClick={() => setEditing('new')}><IconPlus size={15} />Add target</button></header>
    {!targets ? <div className="empty"><Spinner /></div> : !targets.length ? <EmptyState icon={IconServer} title="No storage targets">Add a local directory, S3 bucket, FTP server or SFTP server.</EmptyState> :
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Name</th><th>Storage type</th><th>Access</th><th>Status</th><th>Actions</th></tr></thead><tbody>{targets.map(target => <tr key={target.id}>
        <td><strong>{target.name}</strong></td><td>{TARGET_LABELS[target.type]}</td><td>{target.readOnly ? 'Read only' : 'Read and write'}</td><td>{target.enabled ? 'Enabled' : 'Disabled'}</td>
        <td><div className="row-actions is-visible"><button className="btn btn-sm" disabled={!!busy || !target.enabled} onClick={() => void test(target)}>{busy === target.id ? <Spinner /> : 'Test connection'}</button>
          <button className="icon-btn" aria-label={'Edit target ' + target.name} onClick={() => setEditing(target)}><IconPencil size={15} /></button><button className="icon-btn" aria-label={'Remove target ' + target.name} onClick={() => setRemoving(target)}><IconTrash size={15} /></button></div></td>
      </tr>)}</tbody></table></div>}
    <p className="page-foot">Grant members access in People & access. Administrators can access every enabled target.</p>
    {editing && <TargetEditor target={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); await onChanged() }} />}
    {removing && <Modal title={`Remove “${removing.name}”?`} description="This removes the connection and its access grants. Files stay in storage." onClose={() => !busy && setRemoving(null)} footer={<><button className="btn" onClick={() => setRemoving(null)}>Cancel</button><button className="btn btn-danger" disabled={!!busy} onClick={() => void remove()}>Remove target</button></>}><div className="modal-body"><p>Targets with transfer history or protocol shares must be disabled instead.</p></div></Modal>}
  </div>
}
function TargetEditor({ target, onClose, onSaved }: { target?: AdminTarget; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(target?.name ?? ''), [connection, setConnection] = useState<TargetConnection>(target?.connection ?? emptyConnection('local'))
  const [readOnly, setReadOnly] = useState(target?.readOnly ?? false), [enabled, setEnabled] = useState(target?.enabled ?? true)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await api(target ? '/admin/targets/' + target.id : '/admin/targets', { method: target ? 'PATCH' : 'POST', body: { name, connection, readOnly, enabled } }); await onSaved() }
    catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  return <Modal side title={target ? 'Edit storage target' : 'Add storage target'} icon={<IconServer size={18} />} onClose={() => !busy && onClose()}>
    <form className="drawer-form" onSubmit={event => void submit(event)}><div className="modal-body">
      <div className="field"><label htmlFor="target-name">Target name</label><input id="target-name" className="input" value={name} required maxLength={60} onChange={event => setName(event.target.value)} /></div>
      <div className="field"><label htmlFor="target-type">Storage type</label><select id="target-type" className="select" value={connection.type} disabled={!!target} onChange={event => setConnection(emptyConnection(event.target.value as TargetType))}>{Object.entries(TARGET_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></div>
      <ConnectionFields value={connection} onChange={setConnection} secrets={target?.secrets} fixedLocation={!!target} />
      <label className="perm-option"><span className="perm-text">Read only</span><input className="switch" type="checkbox" checked={readOnly} onChange={event => setReadOnly(event.target.checked)} /></label>
      <label className="perm-option"><span className="perm-text">Enabled</span><input className="switch" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Save target'}</button></footer></form>
  </Modal>
}
