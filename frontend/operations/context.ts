import { createContext, useContext } from 'react'
import type { Operation } from '@/shared/types'
export interface OperationActions {
  operations: Operation[]; isOpen: boolean
  open: () => void; close: () => void
  start: (type: string, input: unknown) => Promise<Operation>
  cancel: (id: string) => Promise<void>
  clear: (id?: string) => Promise<void>
}
export const OperationsContext = createContext<OperationActions | null>(null)
export function useOperations() {
  const context = useContext(OperationsContext)
  if (!context) throw new Error('OperationsProvider is required')
  return context
}
