import { useEffect, useState, type RefObject } from 'react'

/** Visible row range for a fixed-row-height scroll container. Below `threshold` rows everything renders. */
export function useWindowing(container: RefObject<HTMLElement | null>, count: number, rowHeight: number, threshold = 250, overscan = 12) {
  const [viewport, setViewport] = useState({ top: 0, height: 900 })
  const enabled = count > threshold
  useEffect(() => {
    const node = container.current
    if (!node || !enabled) return
    let frame = 0
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setViewport({ top: node.scrollTop, height: node.clientHeight })) }
    update()
    node.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => { cancelAnimationFrame(frame); node.removeEventListener('scroll', update); observer.disconnect() }
  }, [container, enabled])
  if (!enabled) return { start: 0, end: count, before: 0, after: 0 }
  const start = Math.max(0, Math.floor(viewport.top / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((viewport.top + viewport.height) / rowHeight) + overscan)
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight }
}

/** Scrolls a fixed-height row into view even if it is not rendered yet. */
export function scrollRowIntoView(node: HTMLElement | null, index: number, rowHeight: number, headerHeight: number) {
  if (!node) return
  const top = index * rowHeight, bottom = top + rowHeight
  const visibleTop = node.scrollTop, visibleBottom = node.scrollTop + node.clientHeight - headerHeight
  if (top < visibleTop) node.scrollTop = top
  else if (bottom > visibleBottom) node.scrollTop = bottom - node.clientHeight + headerHeight
}
