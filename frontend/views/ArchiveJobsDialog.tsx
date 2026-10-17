import { useState } from 'react'
import { IconAlertTriangle, IconCircleCheckFilled, IconCircleX, IconFileZip, IconLoader2, IconX } from '@tabler/icons-react'
import type { ArchiveJob, Target } from '@/shared/types'
import { Modal } from '../components/Modal'
import { Progress } from '../components/ui'
import { archivePhase } from '../lib/archive-jobs'
import { formatBytes, plural } from '../lib/format'
import { useNotify } from '../lib/notify'
import { errorMessage } from '../api'

export function ArchiveJobsDialog({ jobs, targets, onCancel, onClose }: {
  jobs: ArchiveJob[]; targets: Target[]; onCancel: (id: string) => Promise<void>; onClose: () => void
}) {
  const notify = useNotify(), [canceling, setCanceling] = useState<string | null>(null)
  const job = jobs[0]
  const running = job.status === 'running'
  const tone = job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'success' : job.status === 'canceled' ? 'muted' : 'accent'
  const StatusIcon = job.status === 'completed' ? IconCircleCheckFilled : job.status === 'failed' ? IconAlertTriangle : job.status === 'canceled' ? IconCircleX : IconLoader2
  return <Modal title="Compress & Decompress" icon={<IconFileZip size={17} />} size="md" onClose={onClose}>
    <div className="modal-body archive-progress-body">
      {running && <p className="dialog-note">You can close this window and keep browsing. Reopen it from Archive operations in My files.</p>}
      <article className="archive-job" aria-label={`${job.operation === 'compress' ? 'Compress' : 'Decompress'} ${job.destination}`}>
          <div className="archive-job-heading"><strong>{job.operation === 'compress' ? 'Compress' : 'Decompress'}</strong>
            <span className={`status tone-${tone}`}><StatusIcon size={14} className={job.status === 'running' ? 'spin' : undefined} aria-hidden="true" />{archivePhase(job)}</span>
            {job.status === 'running' && <button type="button" className="icon-btn icon-btn-sm" aria-label={'Cancel ' + job.operation + ' ' + job.destination} disabled={canceling === job.id} onClick={() => {
              setCanceling(job.id)
              void onCancel(job.id).catch(error => notify(errorMessage(error), true)).finally(() => setCanceling(null))
            }}><IconX size={14} /></button>}
          </div>
          <p className="archive-job-destination mono">{job.destination}</p>
          <div className="archive-job-progress"><Progress value={job.progress ?? 0} indeterminate={job.status === 'running' && job.progress === null} tone={tone} />
            <span className="mono">{job.progress === null ? '—' : Math.floor(job.progress * 100) + '%'}</span></div>
          <p className="dim archive-job-detail"><span>{targets.find(target => target.id === job.targetId)?.name ?? 'Unavailable target'}</span>
            <span>{formatBytes(job.processedBytes)}{job.totalBytes === null ? '' : ' / ' + formatBytes(job.totalBytes)}</span>
            <span>{job.totalFiles === null ? plural(job.processedFiles, 'file') : `${job.processedFiles} / ${plural(job.totalFiles, 'file')}`}</span></p>
          {job.currentFile && <p className="dim mono archive-job-file" title={job.currentFile}>{job.currentFile}</p>}
          {job.error && <p className="archive-job-error" role="alert">{job.error}</p>}
      </article>
    </div>
    <footer className="modal-footer"><button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>Close</button></footer>
  </Modal>
}
