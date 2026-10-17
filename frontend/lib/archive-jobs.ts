import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArchiveJob } from '@/shared/types'
import { api } from '../api'

export const archivePhase = (job: ArchiveJob) => job.status === 'completed' ? 'Complete' : job.status === 'failed' ? 'Failed' : job.status === 'canceled' ? 'Canceled'
  : job.phase === 'scanning' ? job.operation === 'compress' ? 'Scanning files' : 'Reading archive'
    : job.phase === 'saving' ? 'Saving to storage' : job.phase === 'compressing' ? 'Compressing' : 'Decompressing'

export function useArchiveJobs() {
  const [jobs, setJobs] = useState<ArchiveJob[]>([])
  const revision = useRef(0)
  const track = useCallback((job: ArchiveJob) => {
    revision.current++
    setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)])
  }, [])
  useEffect(() => {
    let disposed = false, pending = false, timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const refresh = () => {
      clearTimeout(timer)
      if (pending || disposed) return
      pending = true
      const startedAt = revision.current
      void api<ArchiveJob[]>('/archive-jobs', { signal: controller.signal }).then(jobs => { if (!disposed && startedAt === revision.current) setJobs(jobs) }).catch(() => {}).finally(() => {
        pending = false
        if (!disposed) timer = setTimeout(refresh, 1000)
      })
    }
    refresh()
    return () => { disposed = true; controller.abort(); clearTimeout(timer) }
  }, [])
  const cancel = useCallback(async (id: string) => {
    const job = await api<ArchiveJob>(`/archive-jobs/${id}/cancel`, { method: 'POST' })
    track(job)
  }, [track])
  return { jobs, cancel, track }
}
