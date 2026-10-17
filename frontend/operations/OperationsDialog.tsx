import { useState } from 'react'
import { IconAlertTriangle, IconCircleCheckFilled, IconCircleX, IconListCheck, IconLoader2, IconTrash, IconX } from '@tabler/icons-react'
import type { Target } from '@/shared/types'
import { Modal } from '../components/Modal'
import { Progress } from '../components/ui'
import { formatBytes, plural } from '../lib/format'
import { useNotify } from '../lib/notify'
import { errorMessage } from '../api'
import { useOperations } from './context'

export function OperationsDialog({ targets }: { targets: Target[] }) {
  const { operations, isOpen, close, cancel, clear } = useOperations()
  const notify = useNotify(), [busy, setBusy] = useState<string | null>(null)
  if (!isOpen || !operations.length) return null
  const running = operations.some(operation => operation.status === 'running'), finished = operations.some(operation => operation.status !== 'running')
  const act = (id: string, action: () => Promise<void>) => {
    setBusy(id)
    void action().catch(error => notify(errorMessage(error), true)).finally(() => setBusy(null))
  }
  return <Modal title="Operations" icon={<IconListCheck size={17} />} size="md" onClose={close}>
    <div className="modal-body operations-body">
      {running && <p className="dialog-note">Operations keep running when this window is closed.</p>}
      <div className="operations-list">{operations.map(operation => {
        const active = operation.status === 'running'
        const tone = operation.status === 'failed' ? 'danger' : operation.status === 'completed' ? 'success' : operation.status === 'canceled' ? 'muted' : 'accent'
        const StatusIcon = operation.status === 'completed' ? IconCircleCheckFilled : operation.status === 'failed' ? IconAlertTriangle : operation.status === 'canceled' ? IconCircleX : IconLoader2
        const status = active ? operation.phase : operation.status === 'completed' ? 'Complete' : operation.status === 'failed' ? 'Failed' : 'Canceled'
        return <article className="operation" key={operation.id} aria-label={`${operation.title} ${operation.description}`}>
          <div className="operation-heading"><strong>{operation.title}</strong>
            <span className={`status tone-${tone}`}><StatusIcon size={14} className={active ? 'spin' : undefined} aria-hidden="true" />{status}</span>
            <button type="button" className="icon-btn icon-btn-sm" aria-label={`${active ? 'Cancel' : 'Clear'} ${operation.title} ${operation.description}`} disabled={busy !== null} data-tip={active ? 'Cancel operation' : 'Clear task'} onClick={() => act(operation.id, () => active ? cancel(operation.id) : clear(operation.id))}>
              {active ? <IconX size={14} /> : <IconTrash size={14} />}
            </button>
          </div>
          <p className="operation-description mono">{operation.description}</p>
          <div className="operation-progress"><Progress value={operation.progress ?? 0} indeterminate={active && operation.progress === null} tone={tone} />
            <span className="mono">{operation.progress === null ? '—' : Math.floor(operation.progress * 100) + '%'}</span></div>
          <p className="dim operation-detail">
            {operation.targetId && <span>{targets.find(target => target.id === operation.targetId)?.name ?? 'Unavailable target'}</span>}
            {(operation.totalBytes !== null || operation.processedBytes > 0) && <span>{formatBytes(operation.processedBytes)}{operation.totalBytes === null ? '' : ' / ' + formatBytes(operation.totalBytes)}</span>}
            {(operation.totalItems !== null || operation.processedItems > 0) && <span>{operation.totalItems === null ? plural(operation.processedItems, operation.unit) : `${operation.processedItems} / ${plural(operation.totalItems, operation.unit)}`}</span>}
          </p>
          {operation.currentItem && <p className="dim mono operation-current" title={operation.currentItem}>{operation.currentItem}</p>}
          {operation.error && <p className="operation-error" role="alert">{operation.error}</p>}
          {!active && operation.warning && <p className="operation-warning">{operation.warning}</p>}
        </article>
      })}</div>
    </div>
    <footer className="modal-footer operations-footer">
      {finished && <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={() => act('finished', () => clear())}><IconTrash size={14} />Clear finished</button>}
      <button type="button" className="btn btn-primary" data-autofocus onClick={close}>Close</button>
    </footer>
  </Modal>
}
