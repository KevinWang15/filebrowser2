import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'
import { modalStack as stack } from '../lib/modalStack'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

export function Modal({ title, description, icon, children, footer, onClose, size = 'sm', side = false, className = '' }: {
  title: ReactNode; description?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode
  onClose: () => void; size?: 'sm' | 'md' | 'lg' | 'xl'; side?: boolean; className?: string
}) {
  const backdrop = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const close = useEffectEvent(() => onClose())
  useEffect(() => {
    const root = backdrop.current!, node = panel.current!
    const previous = document.activeElement as HTMLElement | null
    // Hide everything else from assistive technology and pointer/keyboard input while open.
    const hidden = [...document.body.children].filter((element): element is HTMLElement => element !== root && element instanceof HTMLElement && !element.inert && !element.hasAttribute('data-overlay'))
    for (const element of hidden) { element.inert = true; element.setAttribute('aria-hidden', 'true') }
    stack.push(root)
    const initial = node.querySelector<HTMLElement>('[data-autofocus]') ?? node.querySelector<HTMLElement>('.modal-body ' + FOCUSABLE) ?? node.querySelector<HTMLElement>(FOCUSABLE)
    initial?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== root) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Tab') {
        const elements = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null)
        if (!elements.length) return
        const first = elements[0], last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      stack.splice(stack.indexOf(root), 1)
      for (const element of hidden) { element.inert = false; element.removeAttribute('aria-hidden') }
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return createPortal(<div ref={backdrop} className={`modal-backdrop ${side ? 'is-side' : ''}`} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={panel} className={`modal modal-${size} ${side ? 'modal-side' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="modal-header">
        {icon && <span className="modal-icon">{icon}</span>}
        <div className="modal-heading"><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}><IconX size={16} /></button>
      </header>
      {children}
      {footer && <footer className="modal-footer">{footer}</footer>}
    </div>
  </div>, document.body)
}
