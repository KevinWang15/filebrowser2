import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { IconPlus, IconServer, IconPencil, IconTrash } from '@tabler/icons-react'
import type { AdminTarget, TargetConnection, TargetType } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Modal } from '../components/Modal'
import { EmptyState, Spinner } from '../components/ui'
import { useNotify } from '../lib/notify'

import { emptyConnection, TARGET_LABELS } from '../lib/target-connections'
const LABELS: Record<string, string> = { root: 'Root directory', bucket: 'Bucket', region: 'Region', endpoint: 'S3 endpoint', prefix: 'Key prefix',
  accessKeyId: 'Access key ID', secretAccessKey: 'Secret access key', sessionToken: 'Session token', host: 'Host', port: 'Port', username: 'Remote username',
  password: 'Remote password', privateKey: 'SSH private key', passphrase: 'Key passphrase', hostKey: 'Server host key fingerprint', forcePathStyle: 'Use path-style requests', tls: 'Use TLS (FTPS)' }
const SECRETS = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'password', 'privateKey', 'passphrase']

export function ConnectionFields({ value, onChange, secrets = [], fixedLocation = false }: {
  value: TargetConnection; onChange: (value: TargetConnection) => void; secrets?: string[]; fixedLocation?: boolean
}) {
  const update = (field: string, next: string | number | boolean) => onChange({ ...value, [field]: next } as TargetConnection)
  const location = value.type === 'local' ? ['root'] : value.type === 's3' ? ['bucket', 'endpoint', 'prefix'] : ['host', 'port', 'root']
  return <div className="target-fields">{Object.entries(value).filter(([field]) => field !== 'type').map(([field, current]) => {
    const id = 'connection-' + field, secret = SECRETS.includes(field), optional = ['endpoint', 'prefix', ...SECRETS].includes(field)
    return typeof current === 'boolean' ? <label className="perm-option" key={field}><span className="perm-text"><strong>{LABELS[field]}</strong></span><input className="switch" type="checkbox" checked={current} onChange={event => update(field, event.target.checked)} /></label> :
      <div className="field" key={field}><label htmlFor={id}>{LABELS[field]}</label>
        {field === 'privateKey' ? <textarea id={id} className="input mono" rows={3} value={current} autoComplete="off" placeholder={secrets.includes(field) ? 'Leave blank to keep saved key' : 'Optional: paste an OpenSSH private key'} onChange={event => update(field, event.target.value)} /> :
          <input id={id} className="input" type={typeof current === 'number' ? 'number' : secret ? 'password' : 'text'} value={current} required={!optional} autoComplete="off" spellCheck={false}
            min={typeof current === 'number' ? 1 : undefined} max={typeof current === 'number' ? 65535 : undefined} disabled={fixedLocation && location.includes(field)}
            placeholder={secrets.includes(field) ? 'Leave blank to keep saved secret' : field === 'hostKey' ? 'SHA256:… (from the server administrator)' : field === 'endpoint' ? 'Optional: default AWS endpoint' : ''}
            onChange={event => update(field, typeof current === 'number' ? Number(event.target.value) : event.target.value)} />}
        {field === 'root' && <span className="field-hint">Paths shown in the browser are relative to this directory.</span>}
      </div>
  })}{value.type === 'ftp' && <p className="field-hint">Uploads require REST STREAM and verify saved bytes. FTP has no durable flush or exclusive rename; use SFTP or S3 for stronger crash guarantees.</p>}
  {value.type === 'sftp' && <p className="field-hint">The server must support the OpenSSH fsync extension for durable uploads. Verify the host key with your server administrator.</p>}
  </div>
}

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
