import { useId, type ReactNode } from 'react'
import { IconLoader2, type Icon } from '@tabler/icons-react'
import { initials } from '../lib/format'

export function Spinner({ size = 16 }: { size?: number }) { return <IconLoader2 className="spin" size={size} aria-hidden="true" /> }
export function Kbd({ children }: { children: ReactNode }) { return <kbd className="kbd">{children}</kbd> }

export function Logo({ size = 24 }: { size?: number }) {
  const id = useId()
  return <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <defs><linearGradient id={id} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop stopColor="var(--logo-a)" /><stop offset="1" stopColor="var(--logo-b)" /></linearGradient></defs>
    <rect width="24" height="24" rx="6.5" fill={`url(#${id})`} />
    <path d="M6 8.6c0-.9.7-1.6 1.6-1.6h2.6c.4 0 .8.2 1.1.5l1 1h4.1c.9 0 1.6.7 1.6 1.6v5.3c0 .9-.7 1.6-1.6 1.6H7.6c-.9 0-1.6-.7-1.6-1.6z" fill="#fff" fillOpacity=".95" />
    <path d="M6 11h12" stroke="var(--logo-b)" strokeOpacity=".35" strokeWidth="1.2" />
  </svg>
}

const AVATAR_TONES = ['teal', 'blue', 'amber', 'green', 'rose', 'orange', 'cyan', 'slate']
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const tone = AVATAR_TONES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_TONES.length]
  return <span className={`avatar avatar-${tone}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">{initials(name)}</span>
}

export function Progress({ value, tone = 'accent', indeterminate = false }: { value: number; tone?: 'accent' | 'success' | 'warning' | 'danger' | 'muted'; indeterminate?: boolean }) {
  return <span className={`progress tone-${tone} ${indeterminate ? 'is-indeterminate' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
  </span>
}

export function EmptyState({ icon: Glyph, title, children, action, compact = false }: { icon: Icon; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty ${compact ? 'is-compact' : ''}`}>
    <span className="empty-icon"><Glyph size={22} stroke={1.5} /></span>
    <h3>{title}</h3>
    {children && <p>{children}</p>}
    {action}
  </div>
}

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: {
  value: T; label: string; size?: 'sm' | 'md'
  options: { value: T; label: string; icon?: Icon; count?: number; iconOnly?: boolean }[]
  onChange: (value: T) => void
}) {
  return <div className={`segmented segmented-${size}`} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" className={value === option.value ? 'is-active' : ''} aria-pressed={value === option.value}
      aria-label={option.iconOnly ? option.label : undefined} data-tip={option.iconOnly ? option.label : undefined} onClick={() => onChange(option.value)}>
      {option.icon && <option.icon size={15} stroke={1.75} />}
      {!option.iconOnly && <span>{option.label}</span>}
      {option.count !== undefined && <span className="segmented-count">{option.count.toLocaleString()}</span>}
    </button>)}
  </div>
}

export function SearchField({ value, onChange, label, placeholder, inputRef, shortcut }: {
  value: string; onChange: (value: string) => void; label: string; placeholder: string; inputRef?: React.Ref<HTMLInputElement>; shortcut?: string
}) {
  const id = useId()
  return <div className="search-field">
    <label htmlFor={id} className="sr-only">{label}</label>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m21 21-6-6" /></svg>
    <input id={id} ref={inputRef} type="search" value={value} placeholder={placeholder} autoComplete="off" spellCheck={false}
      onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && value) { event.stopPropagation(); onChange('') } }} />
    {shortcut && !value && <kbd className="kbd">{shortcut}</kbd>}
  </div>
}
