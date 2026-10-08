import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type View = 'files' | 'transfers' | 'people' | 'activity' | 'settings' | 'targets'
interface Route { view: View; targetId: string | null; path: string }

const VIEWS: readonly View[] = ['files', 'transfers', 'people', 'activity', 'settings', 'targets']

/** Hash routes keep folder paths with dots or extensions out of the server's static-file fallback. */
function parseHash(hash: string): Route {
  const [head = '', ...rest] = hash.replace(/^#\/?/, '').split('/')
  if (head === 'files' || head === '') {
    const segments = rest.filter(Boolean).map(segment => { try { return decodeURIComponent(segment) } catch { return segment } })
    return { view: 'files', targetId: segments.shift() ?? null, path: '/' + segments.join('/') }
  }
  return { view: (VIEWS as readonly string[]).includes(head) ? head as View : 'files', targetId: rest[0] || null, path: '/' }
}

function routeHash(route: Route) {
  if (route.view !== 'files') return '#/' + route.view + (route.targetId ? '/' + encodeURIComponent(route.targetId) : '')
  return '#/files' + (route.targetId ? '/' + encodeURIComponent(route.targetId) : '') + (route.path === '/' ? '' : route.path.split('/').map(encodeURIComponent).join('/'))
}

const subscribe = (listener: () => void) => {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const route = useMemo(() => parseHash(hash), [hash])
  const navigate = useCallback((next: Route) => { window.location.hash = routeHash(next) }, [])
  return [route, navigate]
}
