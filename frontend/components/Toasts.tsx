import { useEffect, useEffectEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconAlertCircle, IconCircleCheckFilled, IconX } from '@tabler/icons-react'

export interface Toast { id: number; text: string; error?: boolean }

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false)
  const dismiss = useEffectEvent(() => onDismiss())
  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => dismiss(), toast.error ? 8000 : 4500)
    return () => window.clearTimeout(timer)
  }, [paused, toast.error])
  return <div className={`toast ${toast.error ? 'is-error' : ''}`} role={toast.error ? 'alert' : 'status'} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    {toast.error ? <IconAlertCircle size={16} /> : <IconCircleCheckFilled size={16} />}
    <span>{toast.text}</span>
    <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss notification" onClick={onDismiss}><IconX size={14} /></button>
  </div>
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return createPortal(<div className="toasts" data-overlay="" aria-live="polite">{toasts.map(toast => <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />)}</div>, document.body)
}
