import { IconListCheck } from '@tabler/icons-react'
import { useOperations } from './context'
export function OperationsButton() {
  const { operations, open } = useOperations()
  if (!operations.length) return null
  return <button type="button" className="btn operations-button" aria-label={`Operations (${operations.length})`} onClick={open}>
    <IconListCheck size={15} /><span className="btn-label">Operations</span><span className="operations-count">{operations.length}</span>
  </button>
}
