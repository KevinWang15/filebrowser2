import { useRef, useState } from 'react'
import {
  IconAlertTriangle, IconArrowsTransferUp, IconCircleCheckFilled, IconClock, IconFileSearch, IconFolder, IconLoader2, IconPlayerPause,
  IconPlayerPauseFilled, IconPlayerPlay, IconPlus, IconRefreshAlert, IconTrash, IconX,
} from '@tabler/icons-react'
import type { User, Target, TargetAccess } from '@/shared/types'
import { errorMessage } from '../api'
import { FileIcon } from '../components/FileIcon'
import { Modal } from '../components/Modal'
import { EmptyState, Progress, Segmented, Spinner } from '../components/ui'
import { formatBytes, formatDuration, plural } from '../lib/format'
import { useNotify } from '../lib/notify'
import { can } from '../lib/permissions'
import { isRunning, STATE_LABELS, transferProgress } from '../lib/transfers'
import type { Transfer, TransferState, UploadEngine } from '../upload-engine'

function StateIcon({ state }: { state: TransferState }) {
  if (state === 'completed') return <IconCircleCheckFilled size={14} />
  if (state === 'failed') return <IconAlertTriangle size={14} />
  if (state === 'retrying') return <IconRefreshAlert size={14} />
  if (state === 'paused') return <IconPlayerPauseFilled size={13} />
  if (state === 'needs-file') return <IconFileSearch size={14} />
  if (state === 'queued') return <IconClock size={14} />
  return <IconLoader2 size={14} className="spin" />
}
const tone = (state: TransferState) => state === 'completed' ? 'success' : state === 'failed' ? 'danger' : state === 'retrying' ? 'warning' : ['paused', 'needs-file', 'queued'].includes(state) ? 'muted' : 'accent'

function TransferRow({ task, targetName, readOnly, onPause, onResume, onCancel }: { task: Transfer; targetName: string; readOnly?: boolean; onPause: () => void; onResume: () => void; onCancel: () => void }) {
  const progress = transferProgress(task)
  const running = isRunning(task)
  const remaining = task.speed > 0 ? (task.size - task.committedBytes - task.sentBytes) / task.speed : NaN
  const chunk = task.session ? `${Math.min(task.session.nextChunk + (task.state === 'completed' ? 0 : 1), task.session.totalChunks)}/${task.session.totalChunks}` : '—'
  return <tr className={`transfer-row is-${task.state}`}>
    <td className="col-name">
      <div className="name-cell">
        <FileIcon entry={{ name: task.name, kind: 'file' }} size={17} />
        <div className="transfer-name">
          <strong title={task.name}>{task.name}</strong>
          <span className="dim inline-icon"><IconFolder size={12} /><span className="mono">{targetName} · {task.directory}</span></span>
          {task.error && <p className="transfer-error">{task.error}</p>}
        </div>
      </div>
    </td>
    <td className="col-status">
      <span className={`status state-${task.state} tone-${tone(task.state)}`}><StateIcon state={task.state} /><span>{STATE_LABELS[task.state]}</span></span>
      {!!task.retry && task.state === 'retrying' && <span className="dim mono retry">attempt {task.retry} of 8</span>}
    </td>
    <td className="col-progress">
      <div className="progress-cell">
        <Progress value={progress} tone={tone(task.state)} indeterminate={task.state === 'queued' || (task.state === 'verifying' && progress >= 1)} />
        <span className="mono pct">{Math.floor(progress * 100)}%</span>
      </div>
      <span className="dim mono progress-detail">{task.state === 'hashing' ? `${formatBytes(task.hashedBytes)} checked` : `${formatBytes(task.state === 'completed' ? task.size : task.committedBytes)} verified`}</span>
    </td>
    <td className="col-size mono">{formatBytes(task.size)}</td>
    <td className="col-chunk mono">{chunk}</td>
    <td className="col-speed mono">{task.speed > 0 && running ? `${formatBytes(task.speed)}/s` : <span className="dim">—</span>}</td>
    <td className="col-eta mono">{running && task.state === 'uploading' ? formatDuration(remaining) : <span className="dim">—</span>}</td>
    <td className="col-actions">
      <div className="row-actions is-visible">
        {task.state === 'completed' ? <span className="done-check" aria-hidden="true"><IconCircleCheckFilled size={16} /></span> : readOnly ? <span className="dim">Read-only</span> : <>
          {running ? <button type="button" className="icon-btn icon-btn-sm" aria-label={'Pause ' + task.name} data-tip="Pause" onClick={onPause}><IconPlayerPause size={15} /></button>
            : <button type="button" className="btn btn-sm" onClick={onResume}><IconPlayerPlay size={13} />{task.file ? 'Resume' : 'Select file'}</button>}
          <button type="button" className="icon-btn icon-btn-sm" aria-label={'Cancel ' + task.name} data-tip="Cancel" onClick={onCancel}><IconX size={15} /></button>
        </>}
      </div>
    </td>
  </tr>
}

export function TransfersView({ targets, access, transfers, engine, user, connections, onConnections, onUpload }: {
  targets: Target[]; access: TargetAccess | null; transfers: Transfer[]; engine: UploadEngine; user: User; connections: '1' | '2' | '4'; onConnections: (value: '1' | '2' | '4') => void; onUpload: () => void
}) {
  const notify = useNotify()
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all')
  const [resumeId, setResumeId] = useState<string | null>(null)
  const [cancelId, setCancelId] = useState<string | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const active = transfers.filter(task => task.state !== 'completed')
  const complete = transfers.length - active.length
  const visible = transfers.filter(task => filter === 'all' || (filter === 'completed' ? task.state === 'completed' : task.state !== 'completed'))
  const running = transfers.filter(isRunning)
  const sending = running.filter(task => task.state !== 'queued')
  const speed = running.reduce((sum, task) => sum + task.speed, 0)
  const throughput = speed ? formatBytes(speed) + '/s' : '—'
  const totalBytes = active.reduce((sum, task) => sum + task.size, 0)
  const doneBytes = active.reduce((sum, task) => sum + task.committedBytes + task.sentBytes, 0)
  const cancelTask = transfers.find(task => task.id === cancelId)
  const resume = (task: Transfer) => { if (task.file) engine.resume(task.id); else { setResumeId(task.id); input.current?.click() } }
  const cancel = async () => {
    if (!cancelId) return
    setCancelBusy(true)
    try { await engine.cancel(cancelId); setCancelId(null); notify('Transfer canceled. Temporary data removed.') }
    catch (error) { notify(errorMessage(error), true) } finally { setCancelBusy(false) }
  }
  return <div className="page">
    <header className="page-header">
      <div className="page-heading"><h1 className="page-title"><IconArrowsTransferUp size={18} className="title-icon" />Transfers</h1>
        <span className="page-sub">Resumable, chunk-verified uploads</span></div>
      <div className="page-actions">
        {(can(access, 'upload')) && <button type="button" className="btn btn-primary" onClick={onUpload}><IconPlus size={15} /><span className="btn-label">New upload</span></button>}
      </div>
    </header>
    {access?.storageReadOnly && <p className="page-foot dim">Storage is read-only. Saved uploads can resume when write access is enabled.</p>}
    <div className="stat-strip">
      <div><span>Active</span><strong className="mono">{active.length}</strong></div>
      <div><span>Running</span><strong className="mono">{sending.length}</strong></div>
      <div><span>Remaining</span><strong className="mono">{formatBytes(Math.max(0, totalBytes - doneBytes))}</strong></div>
      <div><span>Throughput</span><strong className="mono" title={throughput}>{throughput}</strong></div>
      <div className="stat-progress"><span>Overall</span><Progress value={totalBytes ? doneBytes / totalBytes : complete ? 1 : 0} /></div>
    </div>
    <div className="toolbar">
      <Segmented size="sm" label="Filter transfers" value={filter} onChange={setFilter} options={[
        { value: 'all', label: 'All', count: transfers.length }, { value: 'active', label: 'In progress', count: active.length }, { value: 'completed', label: 'Completed', count: complete },
      ]} />
      <div className="toolbar-right">
        <span className="toolbar-label hide-sm" id="parallel-label">Parallel</span>
        <Segmented size="sm" label="Parallel connections" value={connections} onChange={onConnections}
          options={(['1', '2', '4'] as const).map(value => ({ value, label: value + '×' }))} />
        {complete > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => engine.clearCompleted()}><IconTrash size={14} /><span className="btn-label">Clear completed</span></button>}
      </div>
    </div>
    <div className="table-wrap">
      {!visible.length ? <EmptyState icon={IconArrowsTransferUp} title={filter === 'completed' ? 'No completed transfers' : 'No transfers'}
        action={filter !== 'completed' && can(access, 'upload') ? <button type="button" className="btn" onClick={onUpload}><IconPlus size={15} />Choose files</button> : undefined}>
        Uploads appear here with live progress. Interrupted transfers can be resumed after a reload.
      </EmptyState> : <table className="data-table transfers-table">
        <thead><tr>
          <th className="col-name">File</th><th className="col-status">Status</th><th className="col-progress">Progress</th><th className="col-size">Size</th>
          <th className="col-chunk">Chunk</th><th className="col-speed">Speed</th><th className="col-eta">ETA</th><th className="col-actions"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>{visible.map(task => <TransferRow key={task.id} task={task} targetName={targets.find(target => target.id === task.targetId)?.name ?? 'Unavailable target'} readOnly={!targets.some(target => target.id === task.targetId && !target.readOnly && target.enabled && (user.role === 'admin' || user.grants.some(grant => grant.targetId === target.id && grant.permissions.upload)))} onPause={() => engine.pause(task.id)} onResume={() => resume(task)} onCancel={() => setCancelId(task.id)} />)}</tbody>
      </table>}
    </div>
    <p className="page-foot dim">Only verified chunks count as saved. To resume after a reload, select the original file — it is re-checked before uploading continues.</p>
    <input ref={input} className="hidden" type="file" onChange={event => { const file = event.target.files?.[0]; if (file && resumeId) engine.resume(resumeId, file); event.target.value = ''; setResumeId(null) }} />
    {cancelId && <Modal title="Cancel this transfer?" icon={<IconX size={17} />} className="is-danger" description={cancelTask ? <span className="mono">{cancelTask.name}</span> : undefined} onClose={() => !cancelBusy && setCancelId(null)}>
      <div className="modal-body"><p className="dialog-note">This discards {cancelTask?.committedBytes ? <><span className="mono">{formatBytes(cancelTask.committedBytes)}</span> of verified progress</> : 'the saved progress'} and its temporary data.</p></div>
      <footer className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={cancelBusy} onClick={() => setCancelId(null)}>Keep transfer</button>
        <button type="button" className="btn btn-danger" disabled={cancelBusy} onClick={() => void cancel()}>{cancelBusy ? <Spinner /> : 'Cancel transfer'}</button>
      </footer>
    </Modal>}
    {active.length > 0 && <span className="sr-only" aria-live="polite">{plural(running.length, 'transfer')} running</span>}
  </div>
}
