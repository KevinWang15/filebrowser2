import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * One shared tooltip for every element with a `data-tip` attribute.
 * The text mirrors the element's accessible label, so it is presentation only.
 */
export function Tooltips() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const tip = ref.current!
    let timer = 0, current: HTMLElement | null = null
    const hide = () => { clearTimeout(timer); current = null; tip.classList.remove('is-visible') }
    const show = (target: HTMLElement) => {
      const text = target.dataset.tip
      if (!text || !target.isConnected) return
      tip.textContent = text
      const rect = target.getBoundingClientRect(), box = tip.getBoundingClientRect()
      const below = target.dataset.tipSide !== 'top' && rect.bottom + box.height + 8 < window.innerHeight
      const side = target.dataset.tipSide === 'right'
      const left = side ? rect.right + 8 : Math.max(6, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 6))
      const top = side ? rect.top + rect.height / 2 - box.height / 2 : below ? rect.bottom + 6 : rect.top - box.height - 6
      tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
      tip.classList.add('is-visible')
    }
    const over = (event: Event) => {
      const target = (event.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null
      if (target === current) return
      hide()
      if (!target) return
      current = target
      timer = window.setTimeout(() => show(target), event.type === 'focusin' ? 0 : 450)
    }
    const focusIn = (event: FocusEvent) => { if ((event.target as HTMLElement).matches?.(':focus-visible')) over(event) }
    document.addEventListener('pointerover', over)
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    return () => {
      hide()
      document.removeEventListener('pointerover', over)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
    }
  }, [])
  return createPortal(<div ref={ref} className="tooltip" data-overlay="" aria-hidden="true" />, document.body)
}
