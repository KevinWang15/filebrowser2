import { useCallback, useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
const storageKey = (key: string) => 'fb-' + key

function read(key: string) {
  try { return localStorage.getItem(storageKey(key)) } catch { return null }
}
function setPref(key: string, value: string) {
  try { localStorage.setItem(storageKey(key), value) } catch { /* Browser policy may disable preference storage. */ }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener) }
}

/** A string preference persisted in localStorage and shared live between components. */
export function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const raw = useSyncExternalStore(subscribe, () => read(key))
  const value = allowed.includes(raw as T) ? raw as T : fallback
  const set = useCallback((next: T) => setPref(key, next), [key])
  return [value, set]
}

export const THEMES = ['system', 'light', 'dark'] as const
export const DENSITIES = ['compact', 'comfortable'] as const
export type Theme = typeof THEMES[number]
export type Density = typeof DENSITIES[number]

/** Applies appearance preferences to the document root. index.html applies them before first paint. */
export function applyAppearance(theme: Theme, density: Density) {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  root.dataset.density = density
}
