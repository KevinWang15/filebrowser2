import { randomUUID } from 'node:crypto'
import { join, posix, resolve } from 'node:path'
import Fastify, { type FastifyRequest } from 'fastify'
import type { Readable } from 'node:stream'
import cookie from '@fastify/cookie'
import staticFiles from '@fastify/static'
import { z } from 'zod'
import { MAX_CHUNKS, type SystemInfo, type TargetGrant, type TargetAccess, type Permission } from '@/shared/types'
import { VERSION } from '@/shared/version'
import { MAX_NAME_BYTES, MAX_PATH_LENGTH, supportsTextPreview } from '@/shared/file-rules'
import { uploadConfig } from './config'
import { Auth, hashPassword, verifyPassword, requireUser, requireAdmin } from './auth'
import { Store } from './store'
import { HttpError, isFsError } from './errors'
import { Targets, targetSchema } from './targets'
import { normalizePath, requirePermission, scopedPath, validName, uploadingPath } from './storage/paths'
import { Uploads, type UploadFaults } from './uploads'
import { Archives, ArchiveResources } from './archives'
import { DirectoryShares } from './shares/manager'
import { shareNameSchema } from './shares/control'

const passwordSchema = z.string().min(12, 'Use at least 12 characters for your password').max(128)
const usernameSchema = z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, underscores, or hyphens')
const permissionsSchema = z.object({ read: z.boolean(), download: z.boolean(), upload: z.boolean(), create: z.boolean(), rename: z.boolean(), delete: z.boolean() }).strict()
const grantSchema = z.object({ targetId: z.string().uuid(), scope: z.string().max(MAX_PATH_LENGTH), permissions: permissionsSchema }).strict()
const userSchema = z.object({ username: usernameSchema, password: passwordSchema, role: z.enum(['admin','user']), grants: z.array(grantSchema).max(100), disabled: z.boolean().default(false) }).strict()
const idSchema = z.string().uuid()
const indexSchema = z.coerce.number().int().min(0).max(MAX_CHUNKS)

interface AppOptions {
  frontendRoot?: string; logger?: boolean; stateDirectory?: string
  secureCookies?: boolean; publicOrigin?: string; uploadFaults?: UploadFaults
  chunkSize?: number; maxFileSize?: number; setupLocalPath?: string; setupLocalReadOnly?: boolean
  smbEnabled?: boolean; protocolDirectory?: string; smbPublicHost?: string
}

export async function createApp(options: AppOptions = {}) {
  const limits = uploadConfig(options.chunkSize, options.maxFileSize)
  const manifestSchema = z.object({ targetId: idSchema, name: z.string().min(1).max(MAX_NAME_BYTES), directory: z.string().max(MAX_PATH_LENGTH), size: z.number().int().min(0).max(limits.maxFileSize),
    lastModified: z.number().int().min(0), chunkSize: z.literal(limits.chunkSize), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_CHUNKS) }).strict()
    .refine(m => m.hashes.length === Math.ceil(m.size / limits.chunkSize), 'Chunk list does not match the file size')
  const stateDirectory = resolve(options.stateDirectory ?? process.env.FB_STATE_DIR ?? './.filebrowser-state')
  const protocolDirectory = resolve(options.protocolDirectory ?? process.env.FB_SMB_CONTROL_DIR ?? join(stateDirectory, 'protocols'))
  const store = new Store(stateDirectory)
  let targets: Targets
  try { targets = new Targets(store, stateDirectory, options.uploadFaults?.afterPublishLink, [protocolDirectory]) } catch (error) { store.close(); throw error }
  const uploads = new Uploads(store, targets, options.uploadFaults)
  const archives = new Map<string, Promise<Archives>>()
  const archiveResources = new ArchiveResources()
  async function archiveFor(targetId: string) {
    let archive = archives.get(targetId)
    if (!archive) {
      archive = targets.backend(targetId).then(storage => new Archives(storage,
        path => store.retainedUploads().some(row => row.target_id === targetId && uploadingPath(row.path) === path),
        Date.now, user => targets.access(user, targetId, 'download'), archiveResources))
      archives.set(targetId, archive)
      void archive.catch(() => { if (archives.get(targetId) === archive) archives.delete(targetId) })
    }
    return archive
  }
  async function closeArchives(targetId: string) {
    const pending = archives.get(targetId); archives.delete(targetId)
    if (pending) { try { (await pending).close() } catch { /* Initialization failed without allocating archive resources. */ } }
  }
  const auth = new Auth(store, options.secureCookies ?? process.env.FB_SECURE_COOKIES === 'true')
  let shares: DirectoryShares
  try {
    shares = new DirectoryShares(store, targets, protocolDirectory,
    options.smbEnabled ?? process.env.FB_SMB_ENABLED === 'true', options.smbPublicHost || process.env.FB_SMB_PUBLIC_HOST || null)
    await uploads.recover(); await shares.init()
  }
  catch (error) { uploads.close(); await targets.close(); store.close(); throw error }
  const app = Fastify({ logger: options.logger ? { level: process.env.FB_LOG_LEVEL ?? 'info' } : false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 60 * 60 * 1000,
    connectionTimeout: 0, forceCloseConnections: true, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } })
  await app.register(cookie)
  app.decorate('auth', auth)
  app.decorateRequest('currentUser', null)
  // Pass binary streams through untouched: never buffer a 100 MiB chunk in Node memory.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
  const fileMutations = new Set<string>()
  async function mutate<T>(targetId: string, fn: () => Promise<T>) {
    if (fileMutations.has(targetId)) throw new HttpError(409, 'Another file operation is in progress. Retry shortly.', 'STORAGE_BUSY')
    fileMutations.add(targetId)
    try { return await fn() } finally { fileMutations.delete(targetId) }
  }
  function checkActivePath(targetId: string, path: string) {
    shares.blockMutation(targetId, path)
    if (store.retainedUploads().some(u => u.target_id === targetId && [u.path, uploadingPath(u.path)].some(name => name === path || name.startsWith(path + '/')))) throw new HttpError(409, 'This path contains an unfinished transfer. Finish or cancel it first.', 'DESTINATION_BUSY')
  }
  function targetGuard(request: FastifyRequest, access: TargetAccess, permission: Permission) {
    return (user = requireUser(request)) => {
      const current = targets.access(user, access.targetId, permission)
      if (current.scope !== access.scope) throw new HttpError(403, 'Your target scope changed', 'FORBIDDEN')
    }
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin')
    // Use the decoded route identity that Fastify matches, including encoded
    // static segments in public login/setup URLs.
    const path = request.routeOptions.url ?? request.url.split('?')[0]
    if (path.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store')
      if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
        if (request.headers['x-filebrowser-request'] !== '1') throw new HttpError(403, 'Missing request verification header', 'CSRF')
        const origin = request.headers.origin
        const publicOrigin = options.publicOrigin ?? process.env.FB_PUBLIC_ORIGIN
        if (origin && origin !== publicOrigin && origin !== `${request.protocol}://${request.headers.host}`) throw new HttpError(403, 'Requests must come from this application', 'CSRF')
      }
      request.currentUser = auth.authenticate(request)
      if (!['/api/bootstrap','/api/setup','/api/auth/login'].includes(path)) requireUser(request)

    }
  })
  app.setErrorHandler((error, request, reply) => {
    // A download can fail before headers are sent. Reset its binary metadata
    // before returning JSON; otherwise Fastify rejects the error payload.
    reply.removeHeader('Content-Length').removeHeader('Content-Disposition').removeHeader('Content-Range').removeHeader('Accept-Ranges')
    reply.type('application/json; charset=utf-8')
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION' })
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message, code: error.code })
    if (isFsError(error, 'ENOENT')) return reply.code(404).send({ message: 'File or directory not found', code: 'NOT_FOUND' })
    if (isFsError(error, 'EEXIST')) return reply.code(409).send({ message: 'This name already exists', code: 'DESTINATION_EXISTS' })
    if (isFsError(error, 'ENOTEMPTY')) return reply.code(409).send({ message: 'This directory is not empty', code: 'NOT_EMPTY' })
    if (isFsError(error, 'ENOSPC') || isFsError(error, 'EDQUOT')) return reply.code(507).send({ message: 'Storage is full. Free space and resume.', code: 'DISK_FULL' })
    if (isFsError(error, 'EACCES') || isFsError(error, 'EPERM')) return reply.code(403).send({ message: 'Storage access was denied', code: 'STORAGE_PERMISSION' })
    if (isFsError(error, 'EROFS')) return reply.code(403).send({ message: 'Storage is mounted read-only. Enable Read only for this target.', code: 'STORAGE_READ_ONLY' })
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19) return reply.code(409).send({ message: 'This account or destination already exists', code: 'CONFLICT' })
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status >= 500) request.log.error(error)
    return reply.code(status).send({ message: status >= 500 ? 'The operation failed. You can safely retry.' : error instanceof Error ? error.message : 'Request failed', code: 'REQUEST_FAILED' })
  })

  app.get('/health', async () => ({ status: 'ok', commit: process.env.FB_BUILD_COMMIT ?? 'local' }))
  app.get('/api/bootstrap', async request => ({ needsSetup: store.users().length === 0, siteName: store.setting('siteName', 'Filebrowser'), user: request.currentUser,
    targets: request.currentUser ? targets.list(request.currentUser) : [], setupLocalPath: store.users().length ? '' : options.setupLocalPath ?? process.env.FB_SETUP_LOCAL_PATH ?? './data',
    setupLocalReadOnly: !store.users().length && (options.setupLocalReadOnly ?? process.env.FB_SETUP_LOCAL_READ_ONLY === 'true'), upload: limits }))
  app.post('/api/setup', async (request, reply) => mutate('setup', async () => {
    const attempt = auth.throttle(request.ip)
    if (store.users().length) throw new HttpError(409, 'Setup is already complete')
    const body = z.object({ username: usernameSchema, password: passwordSchema, siteName: z.string().trim().min(1).max(60), target: targetSchema.nullable() }).strict().parse(request.body)
    const hash = await hashPassword(body.password)
    const id = randomUUID()
    let createdTarget: string | undefined
    try {
      if (body.target) {
        createdTarget = targets.create(body.target).id
        if (body.target.connection.type === 'local') await targets.backend(createdTarget)
      }
      store.transaction(() => {
        if (store.users().length) throw new HttpError(409, 'Setup is already complete')
        store.db.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'admin',?)")
          .run(id, body.username, hash, new Date().toISOString())
        store.setSetting('siteName', body.siteName)
        store.audit(body.username, 'setup.completed', body.siteName)
      })
    } catch (error) {
      if (createdTarget) await targets.remove(createdTarget)
      throw error
    }
    auth.acceptAttempt(request.ip, attempt)
    auth.createSession(id, reply)
    return reply.code(201).send(store.publicUser(store.user(id)!))
  }))
  app.post('/api/auth/login', async (request, reply) => {
    const attempt = auth.throttle(request.ip)
    const body = z.object({ username: z.string().max(40), password: z.string().max(128) }).strict().parse(request.body)
    const row = store.username(body.username)
    const valid = await verifyPassword(body.password, row?.password_hash ?? 'scrypt$0000000000000000000000000000000000000000000000000000000000000000$' + '0'.repeat(128))
    const current = row ? store.user(row.id) : undefined
    if (!row || !current || current.disabled || current.password_hash !== row.password_hash || !valid) throw new HttpError(401, 'Incorrect username or password', 'LOGIN_FAILED')
    auth.acceptAttempt(request.ip, attempt)
    auth.createSession(row.id, reply)
    store.audit(row.username, 'auth.login', 'Signed in')
    return store.publicUser(current)
  })
  app.post('/api/auth/logout', async (request, reply) => { const user = requireUser(request); auth.logout(request, reply); uploads.revoke(user.id); return reply.code(204).send() })
  app.post('/api/auth/password', async request => {
    const user = requireUser(request)
    const body = z.object({ currentPassword: z.string().max(128), newPassword: passwordSchema }).strict().parse(request.body)
    const attempt = auth.throttle(request.ip)
    const previousHash = store.user(user.id)!.password_hash
    if (!await verifyPassword(body.currentPassword, previousHash)) throw new HttpError(400, 'Current password is incorrect')
    const hash = await hashPassword(body.newPassword)
    store.transaction(() => {
      requireUser(request)
      if (store.user(user.id)!.password_hash !== previousHash) throw new HttpError(409, 'Your password changed. Sign in again before retrying.')
      store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id)
      auth.revoke(user.id)
      uploads.revoke(user.id)
      shares.invalidateCredentials(user.id)
      store.audit(user.username, 'auth.password_changed', 'All sessions revoked')
    })
    auth.acceptAttempt(request.ip, attempt)
    await shares.publish(true)
    return { ok: true }
  })

  app.get<{ Params: { targetId: string }; Querystring: { path?: string } }>('/api/targets/:targetId/files', async request => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId), storage = await targets.backend(targetId); requirePermission(user, 'read')
    const authorize = targetGuard(request, user, 'read')
    const directory = normalizePath(request.query.path ?? '/')
    const entries = await storage.list(scopedPath(user, directory))
    authorize()
    const pending = new Map(store.retainedUploads().filter(row => row.target_id === targetId).map(row => [uploadingPath(row.path), row]))
    for (const [path, upload] of pending) {
      if (posix.dirname(path) !== scopedPath(user, directory) || entries.some(entry => entry.path === path)) continue
      entries.push({ name: posix.basename(path), path, kind: 'file', size: upload.committed_bytes, modifiedAt: upload.updated_at, uploading: true })
    }
    return { targetId, path: directory, entries: entries.map(e => {
      const upload = pending.get(e.path)
      return { ...e, path: posix.join(directory, e.name), ...(upload ? { uploading: true, size: Math.min(e.size, upload.committed_bytes) } : {}) }
    }) }
  })
  // Explicit HEAD routes avoid Fastify's automatic stream draining and prevent
  // its automatic HEAD hook from replacing file lengths with zero.
  app.route<{ Params: { targetId: string }; Querystring: { path?: string; preview?: string } }>({ method: ['GET','HEAD'], url: '/api/targets/:targetId/files/content', handler: async (request, reply) => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId), storage = await targets.backend(targetId)
    const permission = request.query.preview === '1' ? 'read' : 'download'
    requirePermission(user, permission)
    const authorize = targetGuard(request, user, permission)
    const path = scopedPath(user, request.query.path ?? '/')
    if (store.retainedUploads().some(row => row.target_id === targetId && uploadingPath(row.path) === path)) throw new HttpError(409, 'This file is still uploading. Wait for the transfer to finish.', 'FILE_UPLOADING')
    const entry = await storage.stat(path)
    authorize()
    if (entry.kind !== 'file') throw new HttpError(400, 'Only files can be downloaded')
    if (request.query.preview === '1' && !supportsTextPreview(entry)) throw new HttpError(400, 'Preview supports text files up to 1 MiB')
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', request.query.preview === '1' ? 'text/plain; charset=utf-8' : 'application/octet-stream')
    reply.header('Content-Disposition', `${request.query.preview === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(entry.name).replace(/'/g,'%27')}`)
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    let range: { start: number; end: number } | undefined
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
      if (!match || (!match[1] && !match[2]) || entry.size === 0) return reply.code(416).header('Content-Range', `bytes */${entry.size}`).send()
      const start = match[1] ? Number(match[1]) : Math.max(0, entry.size - Number(match[2]))
      const end = match[1] && match[2] ? Math.min(Number(match[2]), entry.size - 1) : entry.size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= entry.size) return reply.code(416).header('Content-Range', `bytes */${entry.size}`).send()
      range = { start, end }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${entry.size}`)
    }
    reply.header('Content-Length', range ? range.end - range.start + 1 : entry.size)
    // Native download clients probe metadata before requesting large payloads.
    if (request.method === 'HEAD') return reply.send()
    return reply.send(auth.guardStream(request, await storage.open(path, range), authorize))
  } })
  function sendArchive(reply: import('fastify').FastifyReply, name: string, stream?: Readable) {
    reply.header('Content-Type', 'application/x-tar').header('Accept-Ranges', 'none')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`)
    if (!stream) return reply.send()
    const disconnect = () => stream.destroy()
    reply.raw.once('close', disconnect)
    stream.once('close', () => reply.raw.removeListener('close', disconnect))
    return reply.send(stream)
  }
  app.route<{ Params: { targetId: string }; Querystring: { path?: string } }>({ method: ['GET','HEAD'], url: '/api/targets/:targetId/files/archive', handler: async (request, reply) => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId); requirePermission(user, 'download')
    if (request.headers.range) return reply.code(416).header('Accept-Ranges', 'none').send()
    const archive = await (await archiveFor(targetId)).prepare(user, [request.query.path ?? '/'], true)
    const authorize = targetGuard(request, user, 'download'); authorize()
    const stream = request.method === 'HEAD' ? undefined : (await archiveFor(targetId)).stream(user, archive)
    return sendArchive(reply, archive.name, stream ? auth.guardStream(request, stream, authorize) : undefined)
  } })
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/files/archive-tickets', async request => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId)
    const { paths } = z.object({ paths: z.array(z.string().max(MAX_PATH_LENGTH)).min(1).max(1000) }).strict().parse(request.body)
    const ticket = await (await archiveFor(targetId)).ticket(user, paths)
    targetGuard(request, user, 'download')()
    return ticket
  })
  app.route<{ Params: { targetId: string; id: string } }>({ method: ['GET','HEAD'], url: '/api/targets/:targetId/files/archives/:id', handler: async (request, reply) => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId); requirePermission(user, 'download')
    if (request.headers.range) return reply.code(416).header('Accept-Ranges', 'none').send()
    const { stream, name } = await (await archiveFor(targetId)).fromTicket(user, idSchema.parse(request.params.id), request.method === 'HEAD')
    const authorize = targetGuard(request, user, 'download')
    if (!stream) authorize()
    return sendArchive(reply, name, stream ? auth.guardStream(request, stream, authorize) : undefined)
  } })
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/files/directories', async request => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId), storage = await targets.backend(targetId); requirePermission(user, 'create')
    const body = z.object({ directory: z.string(), name: z.string(), existOk: z.boolean().optional() }).strict().parse(request.body)
    const path = posix.join(scopedPath(user, body.directory), validName(body.name))
    const authorize = targetGuard(request, user, 'create')
    const existingDirectory = async () => {
      const entry = await storage.stat(path).catch(error => { if (isFsError(error, 'ENOENT')) return null; throw error })
      authorize()
      if (!entry) return false
      if (entry.kind !== 'directory') throw new HttpError(409, 'A file already exists at this folder path.', 'DESTINATION_EXISTS')
      return true
    }
    const created = await mutate(targetId, async () => {
      // Reusing a directory does not mutate it, even when it contains active transfers or shares.
      if (body.existOk && await existingDirectory()) return false
      checkActivePath(targetId, path)
      try { await storage.mkdir(path, authorize) }
      catch (error) { if (body.existOk && isFsError(error, 'EEXIST') && await existingDirectory()) return false; throw error }
      return true
    })
    if (created) store.audit(user.username, 'file.mkdir', path, targetId)
    return { ok: true }
  })
  app.patch<{ Params: { targetId: string } }>('/api/targets/:targetId/files', async request => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId), storage = await targets.backend(targetId); requirePermission(user, 'rename')
    const body = z.object({ path: z.string(), name: z.string() }).strict().parse(request.body)
    const from = scopedPath(user, body.path)
    if (from === user.scope) throw new HttpError(400, 'Cannot rename your root directory')
    const to = posix.join(posix.dirname(from), validName(body.name))
    await mutate(targetId, async () => { checkActivePath(targetId, from); checkActivePath(targetId, to); await storage.move(from, to, targetGuard(request, user, 'rename')) })
    store.audit(user.username, 'file.rename', `${from} → ${to}`, targetId)
    return { ok: true }
  })
  app.delete<{ Params: { targetId: string }; Querystring: { path?: string } }>('/api/targets/:targetId/files', async request => {
    const targetId = idSchema.parse(request.params.targetId)
    const user = targets.access(requireUser(request), targetId), storage = await targets.backend(targetId); requirePermission(user, 'delete')
    const path = scopedPath(user, request.query.path ?? '/')
    if (path === user.scope) throw new HttpError(400, 'Cannot delete your root directory')
    await mutate(targetId, async () => { checkActivePath(targetId, path); await storage.remove(path, targetGuard(request, user, 'delete')) })
    store.audit(user.username, 'file.delete', path, targetId)
    return { ok: true }
  })

  app.get('/api/targets', async request => targets.list(requireUser(request)))
  app.get('/api/admin/targets', async request => { requireAdmin(request); return store.targets().map(row => targets.adminView(row)) })
  app.post('/api/admin/targets', async (request, reply) => {
    const actor = requireAdmin(request), target = targets.create(targetSchema.parse(request.body))
    store.audit(actor.username, 'target.created', target.name, target.id)
    return reply.code(201).send(target)
  })
  app.patch<{ Params: { id: string } }>('/api/admin/targets/:id', async request => {
    const actor = requireAdmin(request), id = idSchema.parse(request.params.id)
    return mutate(id, async () => {
      const target = await targets.update(id, targetSchema.parse(request.body))
      auth.recheckStreams()
      await closeArchives(id)
      store.audit(actor.username, 'target.updated', target.name, id)
      await shares.publish(true)
      return target
    })
  })
  app.delete<{ Params: { id: string } }>('/api/admin/targets/:id', async (request, reply) => {
    const actor = requireAdmin(request), id = idSchema.parse(request.params.id), name = targets.row(id).name
    return mutate(id, async () => {
      await targets.remove(id); auth.recheckStreams(); await closeArchives(id)
      store.audit(actor.username, 'target.deleted', name)
      return reply.code(204).send()
    })
  })
  app.post<{ Params: { id: string } }>('/api/admin/targets/:id/test', async request => {
    requireAdmin(request); const backend = await targets.backend(idSchema.parse(request.params.id))
    if ((await backend.stat('/')).kind !== 'directory') throw new HttpError(400, 'The target root must be a directory')
    requireAdmin(request)
    return { ok: true, capabilities: backend.capabilities }
  })

  app.get('/api/uploads', async request => uploads.list(requireUser(request)))
  app.post('/api/uploads', async (request, reply) => { const manifest = manifestSchema.parse(request.body); return reply.code(201).send(await mutate(manifest.targetId, () => uploads.initialize(requireUser(request), manifest, () => { requireUser(request) }))) })
  app.get<{ Params: { id: string } }>('/api/uploads/:id', async request => uploads.get(requireUser(request), idSchema.parse(request.params.id)))
  app.post<{ Params: { id: string; index: string } }>('/api/uploads/:id/chunks/:index/start', async request => {
    const body = z.object({ connections: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1) }).strict().parse(request.body)
    return uploads.begin(requireUser(request), idSchema.parse(request.params.id), indexSchema.parse(request.params.index), body.connections, () => { requireUser(request) })
  })
  app.put<{ Params: { id: string; attempt: string; part: string } }>('/api/uploads/:id/attempts/:attempt/parts/:part', { bodyLimit: 100 * 1024 * 1024 + 1024 }, async (request, reply) => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new HttpError(415, 'Use application/octet-stream')
    const length = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length'])
    await uploads.receive(requireUser(request), idSchema.parse(request.params.id), idSchema.parse(request.params.attempt), indexSchema.parse(request.params.part), request.raw, length, () => { requireUser(request) })
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string; index: string } }>('/api/uploads/:id/chunks/:index/commit', async request => {
    const body = z.object({ attemptId: idSchema }).strict().parse(request.body)
    return uploads.commit(requireUser(request), idSchema.parse(request.params.id), indexSchema.parse(request.params.index), body.attemptId, () => { requireUser(request) })
  })
  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async request => mutate(store.uploadMetadata(idSchema.parse(request.params.id))?.target_id ?? 'missing', () => uploads.finalize(requireUser(request), idSchema.parse(request.params.id), () => { requireUser(request) })))
  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async request => mutate(store.uploadMetadata(idSchema.parse(request.params.id))?.target_id ?? 'missing', () => uploads.cancel(requireUser(request), idSchema.parse(request.params.id))))

  app.get('/api/admin/users', async request => { requireAdmin(request); return store.users().map(row => store.publicUser(row)) })
  app.get('/api/shares', async request => { const result = await shares.list(requireUser(request)); requireUser(request); return result })
  app.post('/api/admin/shares', async (request, reply) => {
    const actor = requireAdmin(request)
    const body = z.object({ targetId: idSchema, protocol: z.string().max(20).default('smb'), name: shareNameSchema, path: z.string().max(MAX_PATH_LENGTH), ownerId: idSchema }).strict().parse(request.body)
    return reply.code(201).send(await shares.create(actor, body, () => { requireAdmin(request) }))
  })
  app.patch<{ Params: { id: string } }>('/api/admin/shares/:id', async request => {
    const actor = requireAdmin(request)
    const body = z.object({ enabled: z.boolean() }).strict().parse(request.body)
    return shares.setEnabled(actor, idSchema.parse(request.params.id), body.enabled)
  })
  app.post<{ Params: { id: string } }>('/api/admin/shares/:id/credentials', async request => shares.rotate(requireAdmin(request), idSchema.parse(request.params.id), () => { requireAdmin(request) }))
  app.delete<{ Params: { id: string } }>('/api/admin/shares/:id', async (request, reply) => {
    await shares.remove(requireAdmin(request), idSchema.parse(request.params.id), () => { requireAdmin(request) })
    return reply.code(204).send()
  })
  async function validateGrants(role: string, grants: TargetGrant[], existing: TargetGrant[] = []) {
    if (role === 'admin' && grants.length) throw new HttpError(400, 'Administrators have access to all targets; omit individual grants')
    if (new Set(grants.map(grant => grant.targetId)).size !== grants.length) throw new HttpError(400, 'Each target may have only one grant')
    for (const grant of grants) {
      grant.scope = normalizePath(grant.scope)
      targets.row(grant.targetId)
      // Revocation, passwords and permission edits must remain available while
      // storage is offline. Only a newly assigned scope needs a filesystem probe.
      if (existing.some(previous => previous.targetId === grant.targetId && previous.scope === grant.scope)) continue
      if ((await (await targets.backend(grant.targetId)).stat(grant.scope)).kind !== 'directory') throw new HttpError(400, 'A grant scope must be an existing directory')
    }
  }
  app.post('/api/admin/users', async (request, reply) => {
    const actor = requireAdmin(request)
    const body = userSchema.parse(request.body)
    await validateGrants(body.role, body.grants)
    const hash = await hashPassword(body.password)
    const id = randomUUID()
    store.transaction(() => {
      requireAdmin(request)
      store.db.prepare('INSERT INTO users(id,username,password_hash,role,disabled,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, body.username, hash, body.role, Number(body.disabled), new Date().toISOString())
      store.setGrants(id, body.grants)
    })
    store.audit(actor.username, 'user.created', body.username)
    return reply.code(201).send(store.publicUser(store.user(id)!))
  })
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async request => {
    const actor = requireAdmin(request)
    const id = idSchema.parse(request.params.id)
    const previous = store.user(id)
    if (!previous) throw new HttpError(404, 'User not found')
    const body = userSchema.omit({ password: true }).extend({ password: passwordSchema.optional() }).parse(request.body)
    await validateGrants(body.role, body.grants, store.publicUser(previous).grants)
    const hash = body.password ? await hashPassword(body.password) : undefined
    store.transaction(() => {
      requireAdmin(request)
      const current = store.user(id)!
      if (current.role === 'admin' && !current.disabled && (body.role !== 'admin' || body.disabled)) {
        if (store.users().filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new HttpError(409, 'Keep at least one enabled administrator')
      }
      if (actor.id === id && body.disabled) throw new HttpError(409, 'You cannot disable your own account')
      store.db.prepare('UPDATE users SET username=?,password_hash=?,role=?,disabled=? WHERE id=?')
        .run(body.username, hash ?? current.password_hash, body.role, Number(body.disabled), id)
      store.setGrants(id, body.grants)
      uploads.revoke(id)
      auth.revoke(id)
      if (body.password) shares.invalidateCredentials(id)
      store.audit(actor.username, 'user.updated', body.username)
    })
    await shares.publish(true)
    return store.publicUser(store.user(id)!)
  })
  app.get('/api/admin/audit', async request => { requireAdmin(request); return store.audits() })
  app.get('/api/system', async request => {
    const user = requireUser(request)
    const volumes = await Promise.all(targets.list(user).map(async target => {
      try { return { id: target.id, name: target.name, type: target.type, ...await (await targets.backend(target.id)).space(), error: null } }
      catch { return { id: target.id, name: target.name, type: target.type, total: null, available: null, error: 'Target is unavailable' } }
    }))
    requireUser(request)
    const info: SystemInfo = { targets: volumes,
      users: user.role === 'admin' ? store.users().length : 0, activeUploads: user.role === 'admin' ? store.activeUploads().length : store.userUploads(user.id).filter(u => u.status === 'uploading').length, version: VERSION }
    return info
  })
  app.patch('/api/admin/settings', async request => {
    const user = requireAdmin(request)
    const body = z.object({ siteName: z.string().trim().min(1).max(60) }).strict().parse(request.body)
    store.setSetting('siteName', body.siteName)
    store.audit(user.username, 'settings.updated', body.siteName)
    return { ok: true }
  })
  if (options.frontendRoot) {
    await app.register(staticFiles, { root: options.frontendRoot })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/assets/') || request.url.startsWith('/server/') || posix.extname(request.url.split('?')[0]) || request.method !== 'GET') return reply.code(404).send({ message: 'Not found' })
      return reply.sendFile('index.html')
    })
  }
  app.addHook('preClose', async () => { auth.close(); uploads.close(); for (const id of archives.keys()) await closeArchives(id); await shares.close() })
  app.addHook('onClose', async () => { await targets.close(); store.close() })
  return app
}
