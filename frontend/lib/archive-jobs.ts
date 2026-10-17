import { useCallback, useEffect, useState } from 'react'
import type { ArchiveJob } from '@/shared/types'
import { api } from '../api'

export const archivePhase = (job: ArchiveJob) => job.status === 'completed' ? 'Complete' : job.status === 'failed' ? 'Failed' : job.status === 'canceled' ? 'Canceled'
  : job.phase === 'scanning' ? job.operation === 'compress' ? 'Scanning files' : 'Reading archive'
    : job.phase === 'saving' ? 'Saving to storage' : job.phase === 'compressing' ? 'Compressing' : 'Decompressing'

export function useArchiveJobs() {
  const [jobs, setJobs] = useState<ArchiveJob[]>([])
  useEffect(() => {
    let disposed = false, pending = false, timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const refresh = () => {
      clearTimeout(timer)
      if (pending || disposed) return
      pending = true
      void api<ArchiveJob[]>('/archive-jobs', { signal: controller.signal }).then(jobs => { if (!disposed) setJobs(jobs) }).catch(() => {}).finally(() => {
        pending = false
        if (!disposed) timer = setTimeout(refresh, 1000)
      })
    }
    refresh()
    window.addEventListener('fb-archive-jobs-changed', refresh)
    return () => { disposed = true; controller.abort(); clearTimeout(timer); window.removeEventListener('fb-archive-jobs-changed', refresh) }
  }, [])
  const cancel = useCallback(async (id: string) => {
    const job = await api<ArchiveJob>(`/archive-jobs/${id}/cancel`, { method: 'POST' })
    setJobs(previous => previous.map(item => item.id === id ? job : item))
  }, [])
  return { jobs, cancel }
}
