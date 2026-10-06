import { useState, type FormEvent, type ReactNode } from 'react'
import { IconDeviceDesktop, IconLock, IconMoon, IconPalette, IconServer, IconSettings, IconShieldCheck, IconSun } from '@tabler/icons-react'
import type { Bootstrap, SystemInfo, User } from '@/shared/types'
import { api, errorMessage } from '../api'
import { Progress, Segmented, Spinner } from '../components/ui'
import { formatBytes } from '../lib/format'
import { useNotify } from '../lib/notify'
import { DENSITIES, THEMES, usePref, type Density, type Theme } from '../lib/prefs'

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <section className="settings-section">
    <div className="settings-aside"><h2>{icon}{title}</h2><p>{description}</p></div>
    <div className="settings-card">{children}</div>
  </section>
}
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-label">{label}{hint && <small>{hint}</small>}</div><div className="settings-value">{children}</div></div>
}

export function SettingsView({ user, bootstrap, system, onAuthChanged }: { user: User; bootstrap: Bootstrap; system: SystemInfo | null; onAuthChanged: () => Promise<void> }) {
  const notify = useNotify()
  const [siteName, setSiteName] = useState(bootstrap.siteName)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState<'site' | 'password' | null>(null)
  const [theme, setTheme] = usePref<Theme>('theme', 'system', THEMES)
  const [density, setDensity] = usePref<Density>('density', 'compact', DENSITIES)
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy('site')
    try { await api('/admin/settings', { method: 'PATCH', body: { siteName } }); notify('Workspace name saved.'); await onAuthChanged() }
    catch (error) { notify(errorMessage(error), true) } finally { setBusy(null) }
  }
  const password = async (event: FormEvent) => {
    event.preventDefault(); setBusy('password')
    try { await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }); notify('Password changed. Sign in with your new password.'); await onAuthChanged() }
    catch (error) { notify(errorMessage(error), true) } finally { setBusy(null) }
  }
  const used = system ? system.storage.total - system.storage.available : 0
  return <div className="page page-scroll">
    <header className="page-header">
      <div className="page-heading"><h1 className="page-title"><IconSettings size={18} className="title-icon" />{user.role === 'admin' ? 'Settings' : 'Account settings'}</h1>
        <span className="page-sub">Signed in as <strong>{user.username}</strong></span></div>
    </header>
    <div className="settings">
      {user.role === 'admin' && <Section icon={<IconSettings size={15} />} title="Workspace" description="Shown to everyone in the sidebar and on the sign-in page.">
        <form onSubmit={event => void save(event)}>
          <Row label={<label htmlFor="settings-site">Workspace name</label>}>
            <div className="inline-form">
              <input id="settings-site" className="input" value={siteName} onChange={event => setSiteName(event.target.value)} required maxLength={60} />
              <button className="btn btn-primary" disabled={busy !== null || siteName.trim() === bootstrap.siteName}>{busy === 'site' ? <Spinner /> : 'Save changes'}</button>
            </div>
          </Row>
        </form>
      </Section>}

      <Section icon={<IconPalette size={15} />} title="Appearance" description="Stored in this browser only.">
        <Row label="Theme"><Segmented label="Theme" value={theme} onChange={setTheme} options={[
          { value: 'system', label: 'System', icon: IconDeviceDesktop }, { value: 'light', label: 'Light', icon: IconSun }, { value: 'dark', label: 'Dark', icon: IconMoon },
        ]} /></Row>
        <Row label="Density" hint="Row height in file and data tables."><Segmented label="Density" value={density} onChange={setDensity} options={[
          { value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' },
        ]} /></Row>
      </Section>

      <Section icon={<IconServer size={15} />} title="Storage & transfers" description="Runtime configuration reported by the server.">
        <Row label="Storage backend"><span className="inline-icon">Local filesystem</span></Row>
        <Row label="Volume usage" hint={system ? `${formatBytes(system.storage.available)} available` : undefined}>
          {system ? <div className="usage"><Progress value={system.storage.total ? used / system.storage.total : 0} /><span className="mono">{formatBytes(used)} / {formatBytes(system.storage.total)}</span></div> : <Spinner />}
        </Row>
        <Row label="Maximum file size"><span className="mono">{formatBytes(bootstrap.upload.maxFileSize)}</span></Row>
        <Row label="Chunk size"><span className="mono">{formatBytes(bootstrap.upload.chunkSize)}</span></Row>
        <Row label="Max connections per chunk"><span className="mono">{bootstrap.upload.maxConnections}</span></Row>
        <Row label="Integrity checks"><span className="inline-icon text-success"><IconShieldCheck size={14} />SHA-256</span></Row>
        {system && system.storage.capabilities.length > 0 && <Row label="Capabilities"><div className="chip-list">{system.storage.capabilities.map(item => <span key={item} className="badge mono">{item}</span>)}</div></Row>}
        <Row label="Version"><span className="mono">{system?.version ?? '0.1.0'}</span></Row>
      </Section>

      <Section icon={<IconLock size={15} />} title="Your password" description="Changing your password signs you out on all devices.">
        <form onSubmit={event => void password(event)}>
          <Row label={<label htmlFor="settings-current">Current password</label>}>
            <input id="settings-current" className="input" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required maxLength={128} />
          </Row>
          <Row label={<label htmlFor="settings-new">New password</label>} hint="At least 12 characters.">
            <input id="settings-new" className="input" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" required minLength={12} maxLength={128} />
          </Row>
          <div className="settings-actions"><button className="btn" disabled={busy !== null}>{busy === 'password' ? <Spinner /> : 'Update password'}</button></div>
        </form>
      </Section>
    </div>
  </div>
}
