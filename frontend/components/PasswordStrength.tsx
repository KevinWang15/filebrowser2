import { useEffect, useMemo, useState } from 'react'
import type { passwordStrength } from '../lib/password-strength'

type Estimate = typeof passwordStrength
const LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong']

export function PasswordStrength({ password, username, workspace }: { password: string; username: string; workspace: string }) {
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let active = true
    void import('../lib/password-strength').then(module => {
      if (active) setEstimate(() => module.passwordStrength)
    }).catch(() => { if (active) setUnavailable(true) })
    return () => { active = false }
  }, [])
  const result = useMemo(() => password && estimate ? estimate(password, username, workspace) : null, [password, username, workspace, estimate])
  const tooShort = password.length > 0 && password.length < 12
  const level = tooShort ? 1 : result ? Math.max(1, result.score) : 0
  const label = !password ? 'Use 12 or more characters' : tooShort ? 'Too short' : result ? LABELS[result.score] : unavailable ? 'Strength unavailable' : 'Checking strength…'
  const feedback = tooShort ? 'Use at least 12 characters.' : result ? [result.warning, ...result.suggestions].filter(Boolean).join(' ') : ''
  return <div id="password-strength" aria-live="polite" aria-atomic="true">
    <div className="strength" data-level={level}>
      {[0, 1, 2, 3].map(index => <span key={index} className={index < level ? 'is-on' : ''} aria-hidden="true" />)}
      <small>{label}</small>
    </div>
    {feedback && <p className="field-hint strength-feedback">{feedback}</p>}
  </div>
}
