import { useState } from 'react'
import { IconFileZip, IconX } from '@tabler/icons-react'
import type { ArchiveJob, Target } from '@/shared/types'
import { Progress } from '../components/ui'
import { archivePhase } from '../lib/archive-jobs'
import { formatBytes, plural } from '../lib/format'
import { useNotify } from '../lib/notify'
import { errorMessage } from '../api'

export function ArchiveJobsPanel({ jobs, targets, onCancel }: { jobs: ArchiveJob[]; targets: Target[]; onCancel: (id: string) => Promise<void> }) {
  const notify = useNotify(), [canceling, setCanceling] = useState<string | null>(null)
  if (!jobs.length) return null
  return <section className="archive-jobs" aria-label="Compress and Decompress operations">
    <h2><IconFileZip size={17} />Compress &amp; Decompress</h2>
    <div className="archive-job-list">{jobs.map(job => <article className="archive-job" key={job.id}>
      <div className="archive-job-heading"><strong>{job.operation === 'compress' ? 'Compress' : 'Decompress'} · <span className="mono">{job.destination}</span></strong>
        <span className={job.status === 'failed' ? 'tone-danger' : 'dim'}>{archivePhase(job)}</span>
        {job.status === 'running' && <button type="button" className="icon-btn icon-btn-sm" aria-label={'Cancel ' + job.operation + ' ' + job.destination} disabled={canceling === job.id} onClick={() => {
          setCanceling(job.id)
          void onCancel(job.id).catch(error => notify(errorMessage(error), true)).finally(() => setCanceling(null))
        }}><IconX size={14} /></button>}
      </div>
      <div className="archive-job-progress"><Progress value={job.progress ?? 0} indeterminate={job.status === 'running' && job.progress === null} tone={job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'success' : 'accent'} />
        <span className="mono">{job.progress === null ? '—' : Math.floor(job.progress * 100) + '%'}</span></div>
      <p className="dim archive-job-detail"><span>{targets.find(target => target.id === job.targetId)?.name ?? 'Unavailable target'} · {formatBytes(job.processedBytes)}{job.totalBytes === null ? '' : ' / ' + formatBytes(job.totalBytes)} · {plural(job.processedFiles, 'file')}{job.totalFiles === null ? '' : ' of ' + job.totalFiles}</span>
        {job.currentFile && <span className="mono" title={job.currentFile}>{job.currentFile}</span>}</p>
      {job.error && <p className="transfer-error" role="alert">{job.error}</p>}
    </article>)}</div>
  </section>
}
