import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClearedOperations, Operation, OperationProgress, User } from '@/shared/types'
import { HttpError } from '../errors'
import { Store } from '../store'

export interface OperationResource { targetId: string; scope: string; paths: string[] }
export interface OperationContext {
  readonly operation: Readonly<Operation>
  readonly directory: string
  readonly signal: AbortSignal
  check: () => void
  report: (progress: Partial<OperationProgress>, force?: boolean) => void
}
export interface OperationPlan {
  title: string; description: string; unit?: string; resource?: OperationResource; timeoutMs: number
  check: () => void
  validate: (context: OperationContext) => Promise<void>
  execute: (context: OperationContext) => Promise<void>
}
export type OperationHandler = (user: User, input: unknown) => OperationPlan
interface OperationRow { id: string; user_id: string; target_id: string | null; scope: string | null; data: string }
interface Running {
  operation: Operation; userId: string; resource?: OperationResource
  abort: AbortController; done: Promise<void>
}
export const pathsOverlap = (a: string, b: string) => a === b || a === '/' || b === '/' || a.startsWith(b + '/') || b.startsWith(a + '/')

/** Owns operation lifecycle and persistence; handlers supply the work and its resource policy. */
export class Operations {
  private running = new Map<string, Running>()
  private closed = false
  private directory: string
  constructor(private store: Store, stateDirectory: string, private handlers: Readonly<Record<string, OperationHandler>>,
    private resourceAccess: (user: User, targetId: string, scope: string) => boolean,
    private mutate: <T>(key: string, work: () => Promise<T>) => Promise<T>,
    private onError: (error: unknown) => void) {
    this.directory = join(stateDirectory, 'operations-work')
  }
  async init() {
    for (const row of this.store.db.prepare('SELECT data FROM operations').all() as unknown as Pick<OperationRow, 'data'>[]) {
      const operation = JSON.parse(row.data) as Operation
      if (operation.status === 'running') {
        operation.status = 'failed'; operation.error = 'Server restarted. Start this operation again. Output may be incomplete.'
        operation.updatedAt = new Date().toISOString(); this.save(operation)
      }
    }
    await rm(this.directory, { recursive: true, force: true })
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
  }
  list(user: User): Operation[] {
    const rows = this.store.db.prepare('SELECT * FROM operations WHERE user_id=? ORDER BY rowid DESC').all(user.id) as unknown as OperationRow[]
    return rows.filter(row => row.target_id === null || this.resourceAccess(user, row.target_id, row.scope!))
      .map(row => ({ ...(this.running.get(row.id)?.operation ?? JSON.parse(row.data) as Operation) }))
  }
  blockMutation(targetId: string, path: string) {
    for (const { resource } of this.running.values()) if (resource?.targetId === targetId && resource.paths.some(reserved => pathsOverlap(reserved, path))) {
      throw new HttpError(409, 'This path is in use by an operation. Wait or cancel it first.', 'OPERATION_BUSY')
    }
  }
  private save(operation: Operation) { this.store.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(operation), operation.id) }
  async start(user: User, type: string, input: unknown): Promise<Operation> {
    if (this.closed) throw new HttpError(503, 'Server is stopping')
    const handler = Object.hasOwn(this.handlers, type) ? this.handlers[type] : undefined
    if (!handler) throw new HttpError(400, 'Unknown operation type')
    const plan = handler(user, input)
    return this.mutate(plan.resource?.targetId ?? 'operations:' + user.id, async () => {
      if (this.closed) throw new HttpError(503, 'Server is stopping')
      if (this.running.size >= 2 || [...this.running.values()].some(active => active.userId === user.id)) throw new HttpError(429, 'Another operation is running. Wait or cancel it first.')
      for (const path of plan.resource?.paths ?? []) this.blockMutation(plan.resource!.targetId, path)
      const now = new Date().toISOString()
      const operation: Operation = { id: randomUUID(), type, title: plan.title, description: plan.description, unit: plan.unit ?? 'item',
        targetId: plan.resource?.targetId ?? null, status: 'running', phase: 'Preparing', progress: null, warning: null,
        processedBytes: 0, totalBytes: null, processedItems: 0, totalItems: null, currentItem: '', error: null, createdAt: now, updatedAt: now }
      let finish!: () => void
      const active: Running = { operation, userId: user.id, resource: plan.resource, abort: new AbortController(), done: new Promise(resolve => { finish = resolve }) }
      this.running.set(operation.id, active)
      let lastSaved = 0
      const context: OperationContext = { operation, directory: join(this.directory, operation.id), signal: active.abort.signal,
        check: () => {
          active.abort.signal.throwIfAborted()
          const account = this.store.user(user.id)
          if (!account || account.disabled) throw new HttpError(403, 'Account access was revoked')
          plan.check()
        },
        report: (progress, force = false) => {
          context.check(); Object.assign(operation, progress)
          if (operation.progress !== null) operation.progress = Math.max(0, Math.min(0.999, operation.progress))
          operation.updatedAt = new Date().toISOString()
          if (force || Date.now() - lastSaved >= 500) { this.save(operation); lastSaved = Date.now() }
        },
      }
      try {
        context.check(); await plan.validate(context); context.check()
        this.store.db.prepare('INSERT INTO operations(id,user_id,target_id,scope,data) VALUES(?,?,?,?,?)')
          .run(operation.id, user.id, plan.resource?.targetId ?? null, plan.resource?.scope ?? null, JSON.stringify(operation))
        void this.run(active, plan, context).then(finish, error => { this.onError(error); finish() })
        return { ...operation }
      } catch (error) { this.running.delete(operation.id); finish(); throw error }
    })
  }
  private async run(active: Running, plan: OperationPlan, context: OperationContext) {
    const { operation, abort } = active
    let status: Operation['status'] = 'completed'
    const guard = setInterval(() => { try { context.check() } catch (error) { abort.abort(error) } }, 500).unref()
    const timeout = setTimeout(() => abort.abort(new Error('Operation exceeded its time limit')), plan.timeoutMs).unref()
    try {
      await mkdir(context.directory, { mode: 0o700 }); context.check()
      await plan.execute(context); context.check()
    } catch (error) {
      status = abort.signal.aborted && abort.signal.reason === 'canceled' ? 'canceled' : 'failed'
      const reason = abort.signal.aborted ? abort.signal.reason : error
      operation.error = status === 'canceled' ? null : reason instanceof Error ? reason.message : 'Operation failed'
    } finally {
      clearInterval(guard); clearTimeout(timeout)
      await rm(context.directory, { recursive: true, force: true }).catch(() => { status = 'failed'; operation.error = 'Temporary operation data could not be removed.' })
      operation.status = status; operation.updatedAt = new Date().toISOString()
      if (status === 'completed') { operation.phase = 'Finished'; operation.progress = 1; operation.currentItem = ''; operation.warning = null }
      try { this.save(operation) } finally { this.running.delete(operation.id) }
    }
  }
  async cancel(user: User, id: string): Promise<Operation> {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=? AND user_id=?').get(id, user.id) as unknown as OperationRow | undefined
    if (!row) throw new HttpError(404, 'Operation not found')
    const active = this.running.get(id)
    if (active) { active.abort.abort('canceled'); await active.done; return { ...active.operation } }
    return JSON.parse(row.data) as Operation
  }
  clear(user: User, id?: string): ClearedOperations {
    return this.store.transaction(() => {
      const rows = this.store.db.prepare('SELECT id,data FROM operations WHERE user_id=?' + (id ? ' AND id=?' : '')).all(...(id ? [user.id, id] : [user.id])) as unknown as Pick<OperationRow, 'id' | 'data'>[]
      if (id && !rows.length) throw new HttpError(404, 'Operation not found')
      if (id && JSON.parse(rows[0].data).status === 'running') throw new HttpError(409, 'Cancel the operation before clearing it', 'OPERATION_RUNNING')
      const clearedIds = rows.filter(row => JSON.parse(row.data).status !== 'running').map(row => row.id)
      const remove = this.store.db.prepare('DELETE FROM operations WHERE id=? AND user_id=?')
      for (const clearedId of clearedIds) remove.run(clearedId, user.id)
      return { clearedIds }
    })
  }
  async stopTarget(targetId: string) {
    const active = [...this.running.values()].filter(item => item.resource?.targetId === targetId)
    for (const item of active) item.abort.abort('canceled')
    await Promise.all(active.map(item => item.done))
  }
  async close() {
    this.closed = true
    for (const active of this.running.values()) active.abort.abort(new Error('Server stopped. Start this operation again.'))
    await Promise.all([...this.running.values()].map(active => active.done))
  }
}
