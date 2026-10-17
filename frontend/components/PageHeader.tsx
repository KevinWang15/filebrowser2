import type { ReactNode } from 'react'
import { OperationsButton } from '../operations/OperationsButton'

export function PageHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <header className="page-header">{children}<div className="page-actions">{actions}<OperationsButton /></div></header>
}
