import { type Bootstrap, type ChunkAttempt, type UploadSession } from '@/shared/types'
import { api, ApiError, errorMessage, formatBytes } from './api'

export type TransferState = 'queued' | 'hashing' | 'uploading' | 'verifying' | 'retrying' | 'paused' | 'needs-file' | 'completed' | 'failed'
export interface Transfer {
  id: string; name: string; directory: string; size: number; state: TransferState
  hashedBytes: number; sentBytes: number; committedBytes: number; speed: number
  session?: UploadSession; error?: string; retry?: number; file?: File
}

function aborted() { return new DOMException('Transfer paused', 'AbortError') }
function localId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const value = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(aborted())
    const abort = () => { clearTimeout(timer); reject(aborted()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class UploadEngine {
  constructor(private limits: Bootstrap['upload']) {}
  private tasks: Transfer[] = []
  private listeners = new Set<(tasks: Transfer[]) => void>()
  private busy = false
  private disposed = false
  private controllers = new Map<string, AbortController>()
  private manifests = new Map<string, { file: File; hashes: string[]; manifestHash: string }>()
  connections: 1 | 2 | 4 = 1
  onComplete: (task: Transfer) => void = () => {}
  activate() { this.disposed = false }
  setCompleteHandler(handler: (task: Transfer) => void) { this.onComplete = handler }
  setConnections(connections: 1 | 2 | 4) { this.connections = connections }
  subscribe(listener: (tasks: Transfer[]) => void) { this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener) } }
  private snapshot() { return this.tasks.map(task => ({ ...task })) }
  private notify() { const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot) }
  hydrate(sessions: UploadSession[]) {
    for (const session of sessions.filter(s => s.status !== 'canceled')) {
      if (this.tasks.some(t => t.session?.id === session.id)) continue
      this.tasks.push({ id: session.id, name: session.name, directory: session.directory, size: session.size, session,
        state: session.status === 'completed' ? 'completed' : ['failed','canceling'].includes(session.status) ? 'failed' : 'needs-file',
        hashedBytes: 0, sentBytes: 0, committedBytes: session.committedBytes, speed: 0,
        error: session.error ?? (session.status === 'canceling' ? 'Cancellation is pending. Retry canceling this transfer.' : undefined) })
    }
    this.notify()
  }
  add(files: File[], directory: string) {
    for (const file of files) {
      this.tasks.unshift({ id: localId(), name: file.name, directory, size: file.size, file,
        state: file.size > this.limits.maxFileSize ? 'failed' : 'queued', error: file.size > this.limits.maxFileSize ? `The maximum file size is ${formatBytes(this.limits.maxFileSize)}` : undefined,
        hashedBytes: 0, sentBytes: 0, committedBytes: 0, speed: 0 })
    }
    this.notify(); void this.pump()
  }
  resume(id: string, file?: File) {
    const task = this.tasks.find(t => t.id === id)
    if (!task) return
    if (file && file.size !== task.size) { task.error = 'Select the original file. Its size must match.'; this.notify(); return }
    if (file) task.file = file
    if (!task.file) { task.state = 'needs-file'; this.notify(); return }
    if (task.file.size !== task.size) { task.error = 'Select the original file. Its size must match.'; this.notify(); return }
    task.state = 'queued'; task.error = undefined; this.notify(); void this.pump()
  }
  pause(id: string) {
    const task = this.tasks.find(t => t.id === id)
    if (!task || task.state === 'completed') return
    task.state = 'paused'; task.speed = 0
    this.controllers.get(id)?.abort()
    this.notify()
  }
  async cancel(id: string) {
    const task = this.tasks.find(t => t.id === id)
    if (!task) return
    this.pause(id)
    if (task.session) {
      for (let retry = 0; ; retry++) {
        try { await api(`/uploads/${task.session.id}`, { method: 'DELETE' }); break }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'UPLOAD_BUSY' || retry >= 10) throw error
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    }
    this.tasks = this.tasks.filter(t => t !== task); this.manifests.delete(id); this.notify()
  }
  clearCompleted() { this.tasks = this.tasks.filter(t => t.state !== 'completed'); this.notify() }
  dispose() { this.disposed = true; for (const controller of this.controllers.values()) controller.abort(); this.listeners.clear(); this.manifests.clear() }
  private async pump() {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      let task: Transfer | undefined
      while (!this.disposed && (task = this.tasks.find(t => t.state === 'queued'))) {
        const controller = new AbortController(); this.controllers.set(task.id, controller)
        try { await this.run(task, controller.signal) }
        catch (error) {
          if (controller.signal.aborted) { if (task.state !== 'queued') task.state = 'paused' }
          else { task.state = 'failed'; task.error = errorMessage(error) }
          task.speed = 0; task.sentBytes = 0; this.notify()
        } finally { this.controllers.delete(task.id) }
      }
    } finally { this.busy = false }
  }
  private hash(task: Transfer, signal: AbortSignal): Promise<{ hashes: string[]; manifestHash: string }> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' })
      const cleanup = () => { worker.terminate(); signal.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(aborted()) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) return abort()
      worker.onerror = () => { cleanup(); reject(new Error('Could not read this file. Please select it again.')) }
      worker.onmessage = (event: MessageEvent<{ type: string; bytes: number; hashes: string[]; manifestHash: string; message: string }>) => {
        if (event.data.type === 'progress') { task.hashedBytes = event.data.bytes; this.notify() }
        if (event.data.type === 'done') { cleanup(); resolve(event.data) }
        if (event.data.type === 'error') { cleanup(); reject(new Error(event.data.message)) }
      }
      worker.postMessage({ file: task.file, chunkSize: task.session?.chunkSize ?? this.limits.chunkSize })
    })
  }
  private sendPart(url: string, blob: Blob, signal: AbortSignal, progress: (loaded: number) => void) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(aborted())
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      const cleanup = () => signal.removeEventListener('abort', abort)
      xhr.open('PUT', '/api' + url)
      xhr.timeout = 60 * 60 * 1000
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      xhr.setRequestHeader('X-Filebrowser-Request', '1')
      xhr.upload.onprogress = event => progress(event.loaded)
      xhr.onload = () => {
        cleanup()
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else {
          if (xhr.status === 401) window.dispatchEvent(new Event('fb-session-expired'))
          let error = { message: 'Upload connection failed', code: 'CONNECTION_FAILED' }
          try { error = JSON.parse(xhr.responseText) } catch { /* A proxy may return HTML. */ }
          reject(new ApiError(error.message, xhr.status, error.code))
        }
      }
      xhr.onerror = () => { cleanup(); reject(new Error('Network connection interrupted')) }
      xhr.ontimeout = () => { cleanup(); reject(new Error('Upload connection timed out')) }
      xhr.onabort = () => { cleanup(); reject(aborted()) }
      signal.addEventListener('abort', abort, { once: true })
      xhr.send(blob)
    })
  }
  private async run(task: Transfer, signal: AbortSignal) {
    task.state = 'hashing'; task.hashedBytes = 0; task.sentBytes = 0; this.notify()
    const cached = this.manifests.get(task.id)
    const result = cached && cached.file === task.file ? cached : await this.hash(task, signal)
    this.manifests.set(task.id, { ...result, file: task.file! })
    if (task.session && task.session.manifestHash !== result.manifestHash) {
      this.manifests.delete(task.id); task.file = undefined
      throw new Error('The selected file does not match this transfer. Select the original file.')
    }
    if (!task.session) {
      const session = await api<UploadSession>('/uploads', { method: 'POST', signal,
        body: { name: task.name, directory: task.directory, size: task.size, lastModified: task.file!.lastModified, chunkSize: this.limits.chunkSize, hashes: result.hashes } })
      // Replace a hydrated row when a newly selected file resumes an existing manifest.
      this.tasks = this.tasks.filter(t => t === task || t.session?.id !== session.id)
      task.session = session
    }
    let session = await api<UploadSession>(`/uploads/${task.session.id}`, { signal })
    task.committedBytes = session.committedBytes; task.session = session; this.notify()
    let retry = 0
    while (session.nextChunk < session.totalChunks) {
      if (signal.aborted) throw aborted()
      try {
        task.state = 'uploading'; task.sentBytes = 0; task.error = undefined; this.notify()
        const attempt = await api<ChunkAttempt | { committed: true; session: UploadSession }>(`/uploads/${session.id}/chunks/${session.nextChunk}/start`, { method: 'POST', body: { connections: this.connections }, signal })
        if ('committed' in attempt) { session = attempt.session; task.session = session; task.committedBytes = session.committedBytes; continue }
        const attemptController = new AbortController()
        const abortAttempt = () => attemptController.abort()
        signal.addEventListener('abort', abortAttempt, { once: true })
        const progress = new Map<number, number>()
        const started = performance.now()
        try {
          const sends = attempt.parts.map(part => this.sendPart(`/uploads/${session.id}/attempts/${attempt.id}/parts/${part.index}`,
            task.file!.slice(session.nextChunk * session.chunkSize + part.offset, session.nextChunk * session.chunkSize + part.offset + part.size), attemptController.signal, loaded => {
              progress.set(part.index, loaded); task.sentBytes = [...progress.values()].reduce((a, b) => a + b, 0)
              task.speed = task.sentBytes / Math.max((performance.now() - started) / 1000, 0.1); this.notify()
            }).catch(error => { attemptController.abort(); throw error }))
          const outcomes = await Promise.allSettled(sends)
          const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          if (failure) throw failure.reason
        } finally { signal.removeEventListener('abort', abortAttempt) }
        task.state = 'verifying'; this.notify()
        session = await api<UploadSession>(`/uploads/${session.id}/chunks/${session.nextChunk}/commit`, { method: 'POST', signal, body: { attemptId: attempt.id } })
        task.session = session; task.committedBytes = session.committedBytes; task.sentBytes = 0; task.retry = 0; retry = 0; this.notify()
      } catch (error) {
        if (signal.aborted) throw aborted()
        if (error instanceof ApiError && ([401,403,404,507].includes(error.status) || ['UPLOAD_STATE','DESTINATION_EXISTS'].includes(error.code))) throw error
        if (retry >= 8) throw new Error('The connection is still unstable. Your verified progress is saved. Resume when you are ready.', { cause: error })
        // A commit response can be lost after it succeeds. Ask the server before retrying.
        try {
          session = await api<UploadSession>(`/uploads/${session.id}`, { signal })
          task.session = session; task.committedBytes = session.committedBytes
        } catch (statusError) { if (statusError instanceof ApiError && [401,403].includes(statusError.status)) throw statusError }
        task.state = 'retrying'; task.error = errorMessage(error); task.retry = ++retry; task.sentBytes = 0; task.speed = 0; this.notify()
        await delay(Math.min(30_000, 1000 * 2 ** (retry - 1)) * (0.8 + Math.random() * 0.4), signal)
      }
    }
    task.state = 'verifying'; this.notify()
    for (let attempt = 0; ; attempt++) {
      try { session = await api<UploadSession>(`/uploads/${session.id}/complete`, { method: 'POST', signal }); break }
      catch (error) {
        if (signal.aborted || attempt >= 8 || (error instanceof ApiError && [401,403,404,507].includes(error.status))) throw error
        await delay(Math.min(30_000, 1000 * 2 ** attempt), signal)
      }
    }
    task.session = session; task.state = 'completed'; task.committedBytes = task.size; task.sentBytes = 0; task.speed = 0; task.file = undefined; this.manifests.delete(task.id); this.notify(); this.onComplete({ ...task })
  }
}
