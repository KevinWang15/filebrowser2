import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { IconCopy, IconNetwork, IconRefresh, IconTrash } from '@tabler/icons-react'
import type { NetworkShare, NetworkShares as SharesData, ShareCredentials, User, Target } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Modal } from '../components/Modal'
import { Spinner } from '../components/ui'
import { copyText } from '../lib/files'
import { useNotify } from '../lib/notify'

function connection(name: string, host?: string | null) {
  const hostname = host || window.location.hostname
  return `smb://${hostname.includes(':') && !hostname.startsWith('[') ? '[' + hostname + ']' : hostname}/${encodeURIComponent(name)}`
}

export function NetworkShares({ user }: { user: User }) {
  const notify = useNotify()
  const [data, setData] = useState<SharesData | null>(null)
  const [error, setError] = useState('')
  const [users, setUsers] = useState<User[]>([user])
  const [name, setName] = useState('')
  const [path, setPath] = useState('/')
  const [targets, setTargets] = useState<Target[]>([])
  const [targetId, setTargetId] = useState('')
  const [ownerId, setOwnerId] = useState(user.id)
  const [busy, setBusy] = useState('')
  const [credentials, setCredentials] = useState<ShareCredentials | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [removing, setRemoving] = useState<NetworkShare | null>(null)
  const request = useRef(0)
  const abortSignal = useRef<AbortSignal | undefined>(undefined)
  const admin = user.role === 'admin'
  const load = useCallback((signal = abortSignal.current) => {
    const id = ++request.current
    return api<SharesData>('/shares', { signal })
      .then(result => { if (!signal?.aborted && id === request.current) { setData(result); setError('') } })
      .catch(error => { if (!signal?.aborted && id === request.current) setError(errorMessage(error)) })
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    abortSignal.current = controller.signal
    void load(controller.signal)
    const timer = setInterval(() => { void load(controller.signal) }, 2_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [load])
  useEffect(() => {
    if (!admin) return
    const controller = new AbortController()
    void api<Target[]>('/targets', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { const eligible = result.filter(target => target.capabilities.directoryExport); setTargets(eligible); setTargetId(previous => previous || eligible[0]?.id || '') } }).catch(() => {})
    void api<User[]>('/admin/users', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setUsers(result) }).catch(() => {})
    return () => controller.abort()
  }, [admin])
  const copy = (text: string) => { void copyText(text).then(() => notify('Copied to clipboard.')).catch(error => notify(errorMessage(error), true)) }
  const update = async (key: string, operation: () => Promise<void>) => {
    setBusy(key)
    try { await operation(); await load() }
    catch (error) { notify(errorMessage(error), true); await load() }
    finally { setBusy('') }
  }
  const create = (event: FormEvent) => {
    event.preventDefault()
    void update('create', async () => {
      const result = await api<ShareCredentials>('/admin/shares', { method: 'POST', body: { targetId, protocol: 'smb', name, path, ownerId } })
      setCredentials(result); setShowPassword(false); setName('')
    })
  }
  if (!admin && !data?.configured && !data?.shares.length) return null
  return <section className="settings-section" aria-label="Network shares">
    <div className="settings-aside"><h2><IconNetwork size={15} />Network shares</h2><p>Open shared folders directly in Finder, Explorer or an SMB client.</p></div>
    <div className="settings-card network-shares">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data ? <div className="network-share-note"><Spinner />Loading network shares…</div> : <>
        {!data.configured ? <p className="network-share-note">SMB sharing is optional. <a href="https://github.com/KevinWang15/filebrowser2/blob/main/docs/network-shares.md" target="_blank" rel="noreferrer">Set up the SMB service</a> to enable it.</p>
          : <p className="network-share-note">{data.available ? 'SMB service connected. Shares are read-only.' : 'Waiting for the SMB service.'} Share and credential changes reconnect desktop clients.</p>}
        {data.shares.length === 0 && data.configured && <p className="network-share-note">No network shares yet.</p>}
        {data.shares.map(share => <article className="network-share" key={share.id} aria-label={'Share ' + share.name}>
          <div className="network-share-heading"><strong>{share.name}</strong><span className={'network-share-status is-' + share.status}>{share.status}</span></div>
          <div className="network-share-path mono">{share.path || 'Directory unavailable'}</div>
          <div className="network-share-meta">Read-only · {share.ownerName} · <span className="mono">{share.username}</span></div>
          {share.message && <p className="network-share-message">{share.message}</p>}
          <div className="network-share-actions">
            <button type="button" className="btn btn-sm" onClick={() => copy(connection(share.name, data.host))}><IconCopy size={13} />Copy address</button>
            {admin && <>
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void update(share.id, async () => { await api('/admin/shares/' + share.id, { method: 'PATCH', body: { enabled: !share.enabled } }) })}>{share.enabled ? 'Disable' : 'Enable'}</button>
              <button type="button" className="btn btn-sm" disabled={!!busy || !data.configured} onClick={() => void update(share.id, async () => { setCredentials(await api<ShareCredentials>('/admin/shares/' + share.id + '/credentials', { method: 'POST' })); setShowPassword(false) })}><IconRefresh size={13} />Reset password</button>
              <button type="button" className="btn btn-sm btn-danger-ghost" disabled={!!busy} onClick={() => setRemoving(share)}><IconTrash size={13} />Remove</button>
            </>}
          </div>
        </article>)}
        {admin && data.configured && <form className="network-share-form" onSubmit={create}>
          <div className="field"><label htmlFor="share-target">Storage target</label><select id="share-target" className="select" value={targetId} required onChange={event => setTargetId(event.target.value)}><option value="" disabled>Select a target</option>{targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}</select></div>
          <div className="field"><label htmlFor="share-name">Share name</label><input id="share-name" className="input" placeholder="Documents" value={name} onChange={event => setName(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" maxLength={48} required disabled={!!busy} /></div>
          <div className="field"><label htmlFor="share-path">Directory</label><input id="share-path" className="input" value={path} onChange={event => setPath(event.target.value)} maxLength={4096} required disabled={!!busy} /><small className="field-hint">A folder path in this workspace.</small></div>
          <div className="field"><label htmlFor="share-owner">Access as</label><select id="share-owner" className="select" value={ownerId} onChange={event => setOwnerId(event.target.value)} disabled={!!busy}>
            {users.filter(owner => !owner.disabled && (owner.role === 'admin' || owner.grants.some(grant => grant.targetId === targetId && grant.permissions.read && grant.permissions.download))).map(owner => <option key={owner.id} value={owner.id}>{owner.username} ({owner.role === 'admin' ? '/' : owner.grants.find(grant => grant.targetId === targetId)?.scope})</option>)}
          </select></div>
          <button className="btn btn-primary" disabled={!!busy || !data.available || !targetId}>{busy === 'create' ? <Spinner /> : <IconNetwork size={14} />}Create share</button>
        </form>}
      </>}
    </div>
    {credentials && <Modal title="SMB connection" description={credentials.password ? 'Save this password now. It applies to all this user’s SMB shares.' : 'Use this user’s existing SMB password for this additional share.'} icon={<IconNetwork size={18} />} onClose={() => setCredentials(null)} footer={<button type="button" className="btn btn-primary" onClick={() => setCredentials(null)}>Done</button>}>
      <div className="modal-body network-share-credentials">
        {([['Server address', connection(credentials.share.name, data?.host)], ['SMB username', credentials.username]] as const).map(([label, value]) => <div className="field" key={label}><label>{label}</label><div className="inline-form"><input className="input mono" aria-label={label} value={value} readOnly /><button type="button" className="icon-btn" aria-label={'Copy ' + label.toLowerCase()} onClick={() => copy(value)}><IconCopy size={15} /></button></div></div>)}
        {credentials.password && <div className="field"><label htmlFor="share-password">SMB password</label><div className="inline-form"><input id="share-password" className="input mono" type={showPassword ? 'text' : 'password'} value={credentials.password} readOnly /><button type="button" className="icon-btn" aria-label="Copy SMB password" onClick={() => copy(credentials.password!)}><IconCopy size={15} /></button></div><button type="button" className="btn btn-sm" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide password' : 'Show password'}</button></div>}
        <p className="field-hint">Use these credentials in your desktop client. They are separate from your browser sign-in password.</p>
      </div>
    </Modal>}
    {removing && <Modal title={'Remove “' + removing.name + '”?'} description="This stops desktop access through this share." onClose={() => setRemoving(null)} footer={<><button type="button" className="btn" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void update(removing.id, async () => { await api('/admin/shares/' + removing.id, { method: 'DELETE' }); setRemoving(null) })}>Remove share</button></>}><div className="modal-body"><p>Remove the connection to <strong>{removing.path}</strong>?</p></div></Modal>}
  </section>
}
