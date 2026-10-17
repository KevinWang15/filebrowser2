import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClearedOperations, Operation } from '@/shared/types'
import { api } from '../api'
import { usePref } from '../lib/prefs'
import { OperationsContext } from './context'

export function OperationsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [operations, setOperations] = useState<Operation[]>([])
  const [window, setWindow] = usePref('operations-window-' + userId, 'closed', ['open', 'closed'] as const)
  const revision = useRef(0)
  const track = useCallback((operation: Operation) => {
    revision.current++
    setOperations(previous => [operation, ...previous.filter(item => item.id !== operation.id)])
  }, [])
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const refresh = () => {
      const startedAt = revision.current
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      void api<Operation[]>('/operations', { signal }).then(operations => { if (!disposed && startedAt === revision.current) setOperations(operations) }).catch(() => {}).finally(() => {
        if (!disposed) timer = setTimeout(refresh, 1000)
      })
    }
    refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [])
  const start = useCallback(async (type: string, input: unknown) => {
    const operation = await api<Operation>('/operations', { method: 'POST', body: { type, input } })
    track(operation); setWindow('open')
    return operation
  }, [track, setWindow])
  const cancel = useCallback(async (id: string) => { track(await api<Operation>(`/operations/${id}/cancel`, { method: 'POST' })) }, [track])
  const clear = useCallback(async (id?: string) => {
    const { clearedIds } = await api<ClearedOperations>(id ? `/operations/${id}` : '/operations', { method: 'DELETE' })
    revision.current++
    setOperations(previous => previous.filter(operation => !clearedIds.includes(operation.id)))
  }, [])
  return <OperationsContext.Provider value={{ operations, isOpen: window === 'open', open: () => setWindow('open'), close: () => setWindow('closed'), start, cancel, clear }}>{children}</OperationsContext.Provider>
}
