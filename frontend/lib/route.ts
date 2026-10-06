import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type View = 'files' | 'transfers' | 'people' | 'activity' | 'settings'
export interface Route { view: View; path: string }

const VIEWS: readonly View[] = ['files', 'transfers', 'people', 'activity', 'settings']

/** Hash routes keep folder paths with dots or extensions out of the server's static-file fallback. */
export function parseHash(hash: string): Route {
  const [head = '', ...rest] = hash.replace(/^#\/?/, '').split('/')
  if (head === 'files' || head === '') {
    const segments = rest.filter(Boolean).map(segment => { try { return decodeURIComponent(segment) } catch { return segment } })
    return { view: 'files', path: '/' + segments.join('/') }
  }
  return { view: (VIEWS as readonly string[]).includes(head) ? head as View : 'files', path: '/' }
}

export function routeHash(route: Route) {
  if (route.view !== 'files') return '#/' + route.view
  return '#/files' + (route.path === '/' ? '' : route.path.split('/').map(encodeURIComponent).join('/'))
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
