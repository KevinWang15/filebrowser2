import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { Icon } from '@tabler/icons-react'

export type MenuItem = { label: string; icon?: Icon; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string } | 'separator'
export interface MenuAnchor { x: number; y: number; align?: 'start' | 'end' }

/** A floating menu at viewport coordinates. Used for context menus and overflow buttons. */
export function Menu({ anchor, items, label, onClose }: { anchor: MenuAnchor; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(() => onClose())
  useLayoutEffect(() => {
    const node = ref.current!
    const { width, height } = node.getBoundingClientRect()
    const left = anchor.align === 'end' ? anchor.x - width : anchor.x
    node.style.left = Math.max(6, Math.min(left, window.innerWidth - width - 6)) + 'px'
    node.style.top = (anchor.y + height > window.innerHeight - 6 ? Math.max(6, anchor.y - height) : anchor.y) + 'px'
    node.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus()
  }, [anchor])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close() }
    const onKey = (event: KeyboardEvent) => {
      const elements = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])]
      const index = elements.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); previous?.focus() }
      else if (event.key === 'ArrowDown') { event.preventDefault(); elements[(index + 1) % elements.length]?.focus() }
      else if (event.key === 'ArrowUp') { event.preventDefault(); elements[(index - 1 + elements.length) % elements.length]?.focus() }
      else if (event.key === 'Home') { event.preventDefault(); elements[0]?.focus() }
      else if (event.key === 'End') { event.preventDefault(); elements[elements.length - 1]?.focus() }
    }
    const dismiss = () => close()
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    document.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('scroll', dismiss, true)
    }
  }, [])
  return createPortal(<div ref={ref} className="menu" role="menu" aria-label={label} onContextMenu={event => event.preventDefault()}>
    {items.map((item, index) => item === 'separator' ? <div key={index} className="menu-separator" role="separator" /> :
      <button key={item.label} type="button" role="menuitem" className={`menu-item ${item.danger ? 'is-danger' : ''}`} disabled={item.disabled}
        onClick={() => { onClose(); item.onSelect() }}>
        {item.icon ? <item.icon size={15} stroke={1.75} /> : <span className="menu-icon-space" />}
        <span>{item.label}</span>
        {item.shortcut && <kbd className="kbd">{item.shortcut}</kbd>}
      </button>)}
  </div>, document.body)
}
