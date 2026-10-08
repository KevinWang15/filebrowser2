import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pack, type Pack } from 'tar-stream'
import type { FileEntry, TargetAccess } from '@/shared/types'
import type { StorageBackend } from './storage/interface'
import { normalizePath, requirePermission, scopedPath } from './storage/paths'
import { HttpError } from './errors'

interface Selection { path: string; entry: FileEntry }
interface Archive { selections: Selection[]; base: string; name: string }
interface Ticket { user: string; targetId: string; scope: string; paths: string[]; expiresAt: number; owner: Archives }

/** One application-wide budget; target managers retain separate ownership. */
export class ArchiveResources {
  readonly tickets = new Map<string, Ticket>()
  readonly active = new Map<Pack, { user: string; owner: Archives }>()
}

/** Stream a live filesystem view. No archive staging file or full-tree manifest. */
export class Archives {
  private closed = false

  constructor(private storage: StorageBackend, private pending: (path: string) => boolean,
    private now: () => number = Date.now, private refresh: (user: TargetAccess) => TargetAccess = user => user,
    private resources: ArchiveResources = new ArchiveResources()) {}

  async prepare(user: TargetAccess, paths: string[], directoryOnly = false): Promise<Archive> {
    requirePermission(user, 'download')
    if (!paths.length || paths.length > 1000 || Buffer.byteLength(JSON.stringify(paths)) > 64 * 1024) {
      throw new HttpError(400, 'Select between 1 and 1000 items (up to 64 KiB of paths)')
    }
    const selections: Selection[] = []
    for (const path of new Set(paths.map(normalizePath))) {
      const storedPath = scopedPath(user, path)
      if (this.pending(storedPath)) throw new HttpError(409, 'This file is still uploading', 'FILE_UPLOADING')
      const entry = await this.storage.stat(storedPath)
      if (directoryOnly && entry.kind !== 'directory') throw new HttpError(400, 'Choose a directory')
      selections.push({ path, entry })
    }
    const roots = selections.filter(selection => !selections.some(parent => parent !== selection && parent.entry.kind === 'directory' &&
      (parent.path === '/' || selection.path.startsWith(parent.path + '/'))))
    let base = roots.length === 1 && roots[0].entry.kind === 'directory' ? roots[0].path : posix.dirname(roots[0].path)
    while (roots.some(root => root.path !== base && !root.path.startsWith(base === '/' ? '/' : base + '/'))) base = posix.dirname(base)
    const name = roots.length === 1 ? (roots[0].entry.name || 'files') + '.tar' : 'selection.tar'
    return { selections: roots, base, name }
  }

  async ticket(user: TargetAccess, paths: string[]) {
    await this.prepare(user, paths)
    if (this.closed) throw new HttpError(503, 'Server is stopping. Retry shortly.')
    this.prune()
    if (this.resources.tickets.size >= 64 || [...this.resources.tickets.values()].filter(ticket => ticket.user === user.id).length >= 8) {
      throw new HttpError(429, 'Too many pending archive downloads. Try again shortly.')
    }
    const id = randomUUID(), expiresAt = this.now() + 120_000
    this.resources.tickets.set(id, { user: user.id, targetId: user.targetId, scope: user.scope, paths: [...paths], expiresAt, owner: this })
    return { url: `/api/targets/${user.targetId}/files/archives/${id}`, expiresAt }
  }

  async fromTicket(user: TargetAccess, id: string, headOnly = false) {
    this.prune()
    const ticket = this.resources.tickets.get(id)
    if (!ticket || ticket.owner !== this || ticket.targetId !== user.targetId || ticket.user !== user.id) throw new HttpError(404, 'Archive link expired. Start the download again.')
    if (ticket.scope !== user.scope) throw new HttpError(403, 'Your file scope changed. Start the download again.')
    const archive = await this.prepare(user, ticket.paths)
    if (headOnly) return { name: archive.name }
    // Synchronous slot acquisition and consumption prevent concurrent ticket replay.
    if (this.resources.tickets.get(id) !== ticket) throw new HttpError(404, 'Archive link was already used')
    const stream = this.stream(user, archive)
    this.resources.tickets.delete(id)
    return { stream, name: archive.name }
  }

  stream(user: TargetAccess, archive: Archive): Pack {
    if (this.closed) throw new HttpError(503, 'Server is stopping. Retry shortly.')
    if (this.resources.active.size >= 8 || [...this.resources.active.values()].filter(slot => slot.user === user.id).length >= 2) {
      throw new HttpError(429, 'Too many active archive downloads. Try again shortly.')
    }
    const output = pack(), abort = new AbortController()
    this.resources.active.set(output, { user: user.id, owner: this })
    output.on('error', () => { /* The HTTP consumer receives the stream error. */ })
    output.once('close', () => { abort.abort(); this.resources.active.delete(output) })
    const produce = async () => {
      for (const selection of archive.selections) {
        const root = scopedPath(user, selection.path)
        const entries = selection.entry.kind === 'directory' ? this.storage.walk(root) : [selection.entry]
        // Include selected directories in mixed selections, including empty ones.
        if (selection.entry.kind === 'directory' && selection.path !== archive.base) {
          await this.append(output, selection.entry, posix.relative(archive.base, selection.path), abort.signal)
        }
        for await (const entry of entries) {
          abort.signal.throwIfAborted()
          const current = this.refresh(user)
          if (current.scope !== user.scope) throw new HttpError(403, 'Your target scope changed')
          if (this.pending(entry.path)) continue
          const virtual = '/' + posix.relative(user.scope, entry.path)
          await this.append(output, entry, posix.relative(archive.base, virtual), abort.signal)
        }
      }
      output.finalize()
    }
    void produce().catch(error => output.destroy(error instanceof Error ? error : new Error('Archive download failed')))
    return output
  }

  private async append(output: Pack, entry: FileEntry, name: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const source = entry.kind === 'file' ? await this.storage.open(entry.path) : Readable.from([])
    try {
      signal.throwIfAborted()
      const target = output.entry({ name: entry.kind === 'directory' ? name + '/' : name,
        type: entry.kind === 'directory' ? 'directory' : 'file', size: entry.kind === 'file' ? entry.size : 0,
        mtime: new Date(entry.modifiedAt), mode: entry.kind === 'directory' ? 0o755 : 0o644 })
      await pipeline(source, target, { signal })
    } finally { source.destroy() }
  }

  private prune() { for (const [id, ticket] of this.resources.tickets) if (ticket.expiresAt <= this.now()) this.resources.tickets.delete(id) }
  close() {
    this.closed = true
    for (const [id, ticket] of this.resources.tickets) if (ticket.owner === this) this.resources.tickets.delete(id)
    for (const [stream, slot] of this.resources.active) if (slot.owner === this) stream.destroy()
  }
}
