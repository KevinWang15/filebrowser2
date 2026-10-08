import { useState, type FormEvent } from 'react'
import { IconArrowLeft, IconArrowRight, IconCheck, IconEye, IconEyeOff, IconLock, IconShieldCheck } from '@tabler/icons-react'
import type { TargetConnection, TargetType } from '@/shared/types'
import { ConnectionFields } from './TargetsView'
import { emptyConnection, TARGET_LABELS } from '../lib/target-connections'
import { api, errorMessage } from '../api'
import { Logo, Spinner } from '../components/ui'
import { PasswordStrength } from '../components/PasswordStrength'

const STEPS = ['Workspace', 'Storage', 'Administrator', 'Review'] as const

function PasswordInput({ id, value, onChange, setup, autoComplete, placeholder }: {
  id: string; value: string; onChange: (value: string) => void; setup: boolean; autoComplete: string; placeholder: string
}) {
  const [visible, setVisible] = useState(false)
  return <div className="input-group">
    <input id={id} className="input" type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} placeholder={placeholder}
      onChange={event => onChange(event.target.value)} required minLength={setup ? 12 : 1} maxLength={128} aria-describedby={setup ? 'password-strength' : undefined} />
    <button type="button" className="icon-btn" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>
      {visible ? <IconEyeOff size={15} /> : <IconEye size={15} />}
    </button>
  </div>
}

export function AuthScreen({ setup, siteName, setupLocalPath, setupLocalReadOnly, onDone }: { setup: boolean; siteName: string; setupLocalPath: string; setupLocalReadOnly: boolean; onDone: () => Promise<void> }) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(siteName)
  const [username, setUsername] = useState(setup ? 'admin' : '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [targetName, setTargetName] = useState('Local')
  const [connection, setConnection] = useState<TargetConnection>(emptyConnection('local', setupLocalPath))
  const [targetReadOnly, setTargetReadOnly] = useState(setupLocalReadOnly)
  const [addTarget, setAddTarget] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (setup && step === 0) { setStep(1); return }
    if (setup && step === 1) { setStep(2); return }
    if (setup && step === 2) {
      if (password !== confirm) { setError('Your passwords do not match.'); return }
      setStep(3); return
    }
    setBusy(true)
    try {
      await api(setup ? '/setup' : '/auth/login', { method: 'POST', body: setup ? { username, password, siteName: name, target: addTarget ? { name: targetName, connection, enabled: true, readOnly: targetReadOnly } : null } : { username, password } })
      await onDone()
    } catch (error) { setError(errorMessage(error)) } finally { setBusy(false) }
  }
  const heading = setup ? ['Make yourself at home.', 'Connect your storage.', 'Create the administrator.', 'Review and create.'][step] : 'Good to see you again.'
  const description = setup
    ? ['Name this workspace. You can change it later in Settings.', 'Choose your first named target. Add more after setup.', 'This account manages files, people, and permissions.', 'Confirm the details below to finish setup.'][step]
    : <>Sign in to <strong>{siteName}</strong></>

  return <div className="auth">
    <div className="auth-grid" aria-hidden="true" />
    <div className="auth-panel">
      <div className="auth-brand"><Logo size={28} /><span>{setup ? 'Filebrowser' : siteName}</span></div>
      <form className="auth-card" onSubmit={event => void submit(event)} noValidate={false}>
        {setup && <ol className="stepper" aria-label="Setup progress">
          {STEPS.map((label, index) => <li key={label} className={index < step ? 'is-done' : index === step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}>
            <span className="stepper-dot">{index < step ? <IconCheck size={11} stroke={3} /> : index + 1}</span><span className="stepper-label">{label}</span>
          </li>)}
        </ol>}
        <div className="auth-heading"><h1>{heading}</h1><p>{description}</p></div>

        {setup && step === 0 && <div className="field">
          <label htmlFor="auth-site">Workspace name</label>
          <input id="auth-site" className="input" value={name} onChange={event => setName(event.target.value)} required maxLength={60} placeholder="My workspace" />

        </div>}

        {setup && step === 1 && <>
          <label className="perm-option"><span className="perm-text">Configure a storage target now</span><input className="switch" type="checkbox" checked={addTarget} onChange={event => setAddTarget(event.target.checked)} /></label>
          {addTarget && <>
            <div className="field"><label htmlFor="setup-target-name">Target name</label><input id="setup-target-name" className="input" value={targetName} required maxLength={60} onChange={event => setTargetName(event.target.value)} /></div>
            <div className="field"><label htmlFor="setup-target-type">Storage type</label><select id="setup-target-type" className="select" value={connection.type} onChange={event => { const type = event.target.value as TargetType; setConnection(emptyConnection(type, setupLocalPath)); setTargetName(previous => previous === 'Local' || Object.keys(TARGET_LABELS).some(value => previous === value.toUpperCase()) ? type === 'local' ? 'Local' : type.toUpperCase() : previous) }}>{Object.entries(TARGET_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></div>
            <ConnectionFields value={connection} onChange={setConnection} />
            {connection.type === 'local' && setupLocalPath && <p className="field-hint">Suggested local directory: <code>{setupLocalPath}</code>. This directory will appear as / when browsing files.</p>}
            <label className="perm-option"><span className="perm-text">Read only</span><input type="checkbox" className="switch" checked={targetReadOnly} onChange={event => setTargetReadOnly(event.target.checked)} /></label>
          </>}
        </>}

        {setup && step === 3 && <dl className="review-list">
          <div><dt>Workspace</dt><dd>{name}</dd></div>
          <div><dt>Administrator</dt><dd>{username}</dd></div>
          <div><dt>Storage</dt><dd>{addTarget ? targetName + ' · ' + TARGET_LABELS[connection.type] : 'Configure later'}</dd></div>
          {addTarget && <div><dt>Location</dt><dd className="mono">{connection.type === 'local' ? connection.root : connection.type === 's3' ? connection.bucket + (connection.prefix ? '/' + connection.prefix : '') : connection.host + ':' + connection.port + connection.root}</dd></div>}
          <div><dt>Uploads</dt><dd className={addTarget && !targetReadOnly ? 'text-success' : undefined}>{addTarget ? targetReadOnly ? 'Disabled · read only' : <><IconShieldCheck size={14} /> Resumable, SHA-256 verified</> : 'Configure storage first'}</dd></div>
        </dl>}

        {(!setup || step === 2) && <>
          <div className="field">
            <label htmlFor="auth-username">Username</label>
            <input id="auth-username" className="input" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required
              minLength={setup ? 2 : 1} maxLength={40} pattern={setup ? '[a-zA-Z0-9_.-]+' : undefined} placeholder="username" autoFocus={!setup} spellCheck={false} autoCapitalize="none" />
          </div>
          <div className="field">
            <label htmlFor="auth-password">Password</label>
            <PasswordInput id="auth-password" value={password} onChange={setPassword} setup={setup} autoComplete={setup ? 'new-password' : 'current-password'}
              placeholder={setup ? 'At least 12 characters' : '••••••••••••'} />
            {setup && <PasswordStrength password={password} username={username} workspace={name} />}
          </div>
          {setup && <div className="field">
            <label htmlFor="auth-confirm">Confirm password</label>
            <input id="auth-confirm" className="input" autoComplete="new-password" type="password" value={confirm} onChange={event => setConfirm(event.target.value)}
              required minLength={12} maxLength={128} placeholder="Repeat password" />
          </div>}
        </>}

        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="auth-actions">
          {setup && step > 0 && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setStep(step - 1); setError('') }}><IconArrowLeft size={15} />Back</button>}
          <button className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? <Spinner /> : <>{setup ? step === 3 ? 'Create workspace' : 'Continue' : 'Sign in'}<IconArrowRight size={15} /></>}
          </button>
        </div>
      </form>
      <p className="auth-foot"><IconLock size={12} /> {setup ? 'No default passwords. Sessions are revocable.' : 'Private, self-hosted workspace'}</p>
    </div>
  </div>
}
