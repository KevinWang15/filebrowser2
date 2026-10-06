import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import staticFiles from '@fastify/static'
import { z } from 'zod'
import { MAX_CHUNKS, FULL_PERMISSIONS, type SystemInfo } from '@/shared/types'
import { storageLocations, uploadConfig } from './config'
import { Auth, hashPassword, verifyPassword, requireUser, requireAdmin } from './auth'
import { Store, publicUser } from './store'
import { HttpError, isFsError } from './errors'
import { LocalStorage } from './storage/local'
import { normalizePath, requirePermission, scopedPath, validName, uploadingPath } from './storage/paths'
import { Uploads, type UploadFaults } from './uploads'

const passwordSchema = z.string().min(12, 'Use at least 12 characters for your password').max(128)
const usernameSchema = z.string().trim().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, underscores, or hyphens')
const permissionsSchema = z.object({ read: z.boolean(), download: z.boolean(), upload: z.boolean(), create: z.boolean(), rename: z.boolean(), delete: z.boolean() }).strict()
const userSchema = z.object({ username: usernameSchema, password: passwordSchema, role: z.enum(['admin','user']), scope: z.string().max(4096), permissions: permissionsSchema, disabled: z.boolean().default(false) }).strict()
const idSchema = z.string().uuid()
const indexSchema = z.coerce.number().int().min(0).max(MAX_CHUNKS)

export interface AppOptions {
  frontendRoot?: string; logger?: boolean; storageRoot?: string; stateDirectory?: string
  secureCookies?: boolean; publicOrigin?: string; uploadFaults?: UploadFaults
  chunkSize?: number; maxFileSize?: number
}

export async function createApp(options: AppOptions = {}) {
  const limits = uploadConfig(options.chunkSize, options.maxFileSize)
  const manifestSchema = z.object({ name: z.string().min(1).max(255), directory: z.string().max(4096), size: z.number().int().min(0).max(limits.maxFileSize),
    lastModified: z.number().int().min(0), chunkSize: z.literal(limits.chunkSize), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_CHUNKS) }).strict()
    .refine(m => m.hashes.length === Math.ceil(m.size / limits.chunkSize), 'Chunk list does not match the file size')
  const { storageRoot, stateDirectory } = storageLocations(options.storageRoot, options.stateDirectory)
  const storage = new LocalStorage(storageRoot, options.uploadFaults?.afterPublishLink)
  await storage.init()
  const store = new Store(stateDirectory)
  const previousRoot = store.setting('storageRoot')
  if (previousRoot && previousRoot !== storageRoot) { store.close(); throw new Error('Storage root differs from the recorded root. Use a separate state directory for another storage root.') }
  try { await storage.lock() } catch (error) { store.close(); throw error }
  store.setSetting('storageRoot', storageRoot)
  const uploads = new Uploads(store, storage, options.uploadFaults)
  try { await uploads.recover() } catch (error) { uploads.close(); storage.close(); store.close(); throw error }
  const auth = new Auth(store, options.secureCookies ?? process.env.FB_SECURE_COOKIES === 'true')
  const app = Fastify({ logger: options.logger ? { level: process.env.FB_LOG_LEVEL ?? 'info' } : false, bodyLimit: 2 * 1024 * 1024, requestTimeout: 60 * 60 * 1000,
    connectionTimeout: 0, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } })
  await app.register(cookie)
  app.decorateRequest('currentUser', null)
  // Pass binary streams through untouched: never buffer a 100 MiB chunk in Node memory.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
  let fileMutation = false
  async function mutate<T>(fn: () => Promise<T>) {
    if (fileMutation) throw new HttpError(409, 'Another file operation is in progress. Retry shortly.', 'STORAGE_BUSY')
    fileMutation = true
    try { return await fn() } finally { fileMutation = false }
  }
  function checkActivePath(path: string) {
    if (store.retainedUploads().some(u => [u.path, uploadingPath(u.path)].some(name => name === path || name.startsWith(path + '/')))) throw new HttpError(409, 'This path contains an unfinished transfer. Finish or cancel it first.', 'DESTINATION_BUSY')
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin')
    const path = request.url.split('?')[0]
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
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION' })
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ message: error.message, code: error.code })
    if (isFsError(error, 'ENOENT')) return reply.code(404).send({ message: 'File or directory not found', code: 'NOT_FOUND' })
    if (isFsError(error, 'EEXIST')) return reply.code(409).send({ message: 'This name already exists', code: 'DESTINATION_EXISTS' })
    if (isFsError(error, 'ENOTEMPTY')) return reply.code(409).send({ message: 'This directory is not empty', code: 'NOT_EMPTY' })
    if (isFsError(error, 'ENOSPC') || isFsError(error, 'EDQUOT')) return reply.code(507).send({ message: 'Storage is full. Free space and resume.', code: 'DISK_FULL' })
    if (isFsError(error, 'EACCES') || isFsError(error, 'EPERM')) return reply.code(403).send({ message: 'Storage access was denied', code: 'STORAGE_PERMISSION' })
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT')) return reply.code(409).send({ message: 'This account or destination already exists', code: 'CONFLICT' })
    if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19) return reply.code(409).send({ message: 'This account or destination already exists', code: 'CONFLICT' })
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500
    if (status >= 500) request.log.error(error)
    return reply.code(status).send({ message: status >= 500 ? 'The operation failed. You can safely retry.' : error instanceof Error ? error.message : 'Request failed', code: 'REQUEST_FAILED' })
  })

  app.get('/health', async () => ({ status: 'ok', commit: process.env.QUICKDEPLOY_COMMIT ?? 'local' }))
  app.get('/api/bootstrap', async request => ({ needsSetup: store.users().length === 0, siteName: store.setting('siteName', 'Filebrowser'), user: request.currentUser,
    upload: limits }))
  app.post('/api/setup', async (request, reply) => {
    auth.throttle(request.ip)
    if (store.users().length) throw new HttpError(409, 'Setup is already complete')
    const body = z.object({ username: usernameSchema, password: passwordSchema, siteName: z.string().trim().min(1).max(60) }).strict().parse(request.body)
    const hash = await hashPassword(body.password)
    const id = randomUUID()
    store.transaction(() => {
      if (store.users().length) throw new HttpError(409, 'Setup is already complete')
      store.db.prepare('INSERT INTO users(id,username,password_hash,role,scope,permissions,created_at) VALUES(?,?,?,\'admin\',\'/\',?,?)')
        .run(id, body.username, hash, JSON.stringify(FULL_PERMISSIONS), new Date().toISOString())
      store.setSetting('siteName', body.siteName)
      store.audit(body.username, 'setup.completed', body.siteName)
    })
    auth.createSession(id, reply)
    return reply.code(201).send(publicUser(store.user(id)!))
  })
  app.post('/api/auth/login', async (request, reply) => {
    auth.throttle(request.ip)
    const body = z.object({ username: z.string().max(40), password: z.string().max(128) }).strict().parse(request.body)
    const row = store.username(body.username)
    const valid = await verifyPassword(body.password, row?.password_hash ?? 'scrypt$0000000000000000000000000000000000000000000000000000000000000000$' + '0'.repeat(128))
    const current = row ? store.user(row.id) : undefined
    if (!row || !current || current.disabled || current.password_hash !== row.password_hash || !valid) throw new HttpError(401, 'Incorrect username or password', 'LOGIN_FAILED')
    auth.createSession(row.id, reply)
    store.audit(row.username, 'auth.login', 'Signed in')
    return publicUser(row)
  })
  app.post('/api/auth/logout', async (request, reply) => { auth.logout(request, reply); return reply.code(204).send() })
  app.post('/api/auth/password', async request => {
    const user = requireUser(request)
    const body = z.object({ currentPassword: z.string().max(128), newPassword: passwordSchema }).strict().parse(request.body)
    auth.throttle(request.ip)
    if (!await verifyPassword(body.currentPassword, store.user(user.id)!.password_hash)) throw new HttpError(400, 'Current password is incorrect')
    const hash = await hashPassword(body.newPassword)
    store.transaction(() => {
      store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id)
      auth.revoke(user.id)
      store.audit(user.username, 'auth.password_changed', 'All sessions revoked')
    })
    return { ok: true }
  })

  app.get<{ Querystring: { path?: string } }>('/api/files', async request => {
    const user = requireUser(request); requirePermission(user, 'read')
    const directory = normalizePath(request.query.path ?? '/')
    const entries = await storage.list(scopedPath(user, directory))
    const pending = new Map(store.retainedUploads().map(row => [uploadingPath(row.path), row]))
    return { path: directory, entries: entries.map(e => {
      const upload = pending.get(e.path)
      return { ...e, path: posix.join(directory, e.name), ...(upload ? { uploading: true, size: Math.min(e.size, upload.committed_bytes) } : {}) }
    }) }
  })
  app.get<{ Querystring: { path?: string; preview?: string } }>('/api/files/content', async (request, reply) => {
    const user = requireUser(request)
    requirePermission(user, request.query.preview === '1' ? 'read' : 'download')
    const path = scopedPath(user, request.query.path ?? '/')
    if (store.retainedUploads().some(row => uploadingPath(row.path) === path)) throw new HttpError(409, 'This file is still uploading. Wait for the transfer to finish.', 'FILE_UPLOADING')
    const entry = await storage.stat(path)
    if (entry.kind !== 'file') throw new HttpError(400, 'Only files can be downloaded')
    const safeText = /\.(txt|md|json|csv|log|yaml|yml|toml|ini|ts|js|css|scss|xml)$/i.test(entry.name)
    if (request.query.preview === '1' && (!safeText || entry.size > 1024 * 1024)) throw new HttpError(400, 'Preview supports text files up to 1 MiB')
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
    return reply.send(await storage.open(path, range))
  })
  app.post('/api/files/directories', async request => {
    const user = requireUser(request); requirePermission(user, 'create')
    const body = z.object({ directory: z.string(), name: z.string() }).strict().parse(request.body)
    const path = posix.join(scopedPath(user, body.directory), validName(body.name))
    await mutate(async () => { checkActivePath(path); await storage.mkdir(path) })
    store.audit(user.username, 'file.mkdir', path)
    return { ok: true }
  })
  app.patch('/api/files', async request => {
    const user = requireUser(request); requirePermission(user, 'rename')
    const body = z.object({ path: z.string(), name: z.string() }).strict().parse(request.body)
    const from = scopedPath(user, body.path)
    if (from === user.scope) throw new HttpError(400, 'Cannot rename your root directory')
    const to = posix.join(posix.dirname(from), validName(body.name))
    await mutate(async () => { checkActivePath(from); checkActivePath(to); await storage.move(from, to) })
    store.audit(user.username, 'file.rename', `${from} → ${to}`)
    return { ok: true }
  })
  app.delete<{ Querystring: { path?: string } }>('/api/files', async request => {
    const user = requireUser(request); requirePermission(user, 'delete')
    const path = scopedPath(user, request.query.path ?? '/')
    if (path === user.scope) throw new HttpError(400, 'Cannot delete your root directory')
    await mutate(async () => { checkActivePath(path); await storage.remove(path) })
    store.audit(user.username, 'file.delete', path)
    return { ok: true }
  })

  app.get('/api/uploads', async request => uploads.list(requireUser(request)))
  app.post('/api/uploads', async (request, reply) => reply.code(201).send(await mutate(() => uploads.initialize(requireUser(request), manifestSchema.parse(request.body)))))
  app.get<{ Params: { id: string } }>('/api/uploads/:id', async request => uploads.get(requireUser(request), idSchema.parse(request.params.id)))
  app.post<{ Params: { id: string; index: string } }>('/api/uploads/:id/chunks/:index/start', async request => {
    const body = z.object({ connections: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1) }).strict().parse(request.body)
    return uploads.begin(requireUser(request), idSchema.parse(request.params.id), indexSchema.parse(request.params.index), body.connections)
  })
  app.put<{ Params: { id: string; attempt: string; part: string } }>('/api/uploads/:id/attempts/:attempt/parts/:part', { bodyLimit: 100 * 1024 * 1024 + 1024 }, async (request, reply) => {
    if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new HttpError(415, 'Use application/octet-stream')
    const length = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length'])
    await uploads.receive(requireUser(request), idSchema.parse(request.params.id), idSchema.parse(request.params.attempt), indexSchema.parse(request.params.part), request.raw, length)
    return reply.code(204).send()
  })
  app.post<{ Params: { id: string; index: string } }>('/api/uploads/:id/chunks/:index/commit', async request => {
    const body = z.object({ attemptId: idSchema }).strict().parse(request.body)
    return uploads.commit(requireUser(request), idSchema.parse(request.params.id), indexSchema.parse(request.params.index), body.attemptId)
  })
  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async request => mutate(() => uploads.finalize(requireUser(request), idSchema.parse(request.params.id))))
  app.delete<{ Params: { id: string } }>('/api/uploads/:id', async request => mutate(() => uploads.cancel(requireUser(request), idSchema.parse(request.params.id))))

  app.get('/api/admin/users', async request => { requireAdmin(request); return store.users().map(publicUser) })
  app.post('/api/admin/users', async (request, reply) => {
    const actor = requireAdmin(request)
    const body = userSchema.parse(request.body)
    const scope = body.role === 'admin' ? '/' : normalizePath(body.scope)
    if ((await storage.stat(scope)).kind !== 'directory') throw new HttpError(400, 'User scope must be an existing directory')
    const hash = await hashPassword(body.password)
    const id = randomUUID()
    store.db.prepare('INSERT INTO users(id,username,password_hash,role,scope,permissions,disabled,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, body.username, hash, body.role, scope, JSON.stringify(body.role === 'admin' ? FULL_PERMISSIONS : body.permissions), Number(body.disabled), new Date().toISOString())
    store.audit(actor.username, 'user.created', body.username)
    return reply.code(201).send(publicUser(store.user(id)!))
  })
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async request => {
    const actor = requireAdmin(request)
    const id = idSchema.parse(request.params.id)
    const previous = store.user(id)
    if (!previous) throw new HttpError(404, 'User not found')
    const body = userSchema.omit({ password: true }).extend({ password: passwordSchema.optional() }).parse(request.body)
    const scope = body.role === 'admin' ? '/' : normalizePath(body.scope)
    if ((await storage.stat(scope)).kind !== 'directory') throw new HttpError(400, 'User scope must be an existing directory')
    const hash = body.password ? await hashPassword(body.password) : previous.password_hash
    store.transaction(() => {
      const current = store.user(id)!
      if (current.role === 'admin' && !current.disabled && (body.role !== 'admin' || body.disabled)) {
        if (store.users().filter(u => u.role === 'admin' && !u.disabled).length <= 1) throw new HttpError(409, 'Keep at least one enabled administrator')
      }
      if (actor.id === id && body.disabled) throw new HttpError(409, 'You cannot disable your own account')
      store.db.prepare('UPDATE users SET username=?,password_hash=?,role=?,scope=?,permissions=?,disabled=? WHERE id=?')
        .run(body.username, hash, body.role, scope, JSON.stringify(body.role === 'admin' ? FULL_PERMISSIONS : body.permissions), Number(body.disabled), id)
      auth.revoke(id)
      store.audit(actor.username, 'user.updated', body.username)
    })
    return publicUser(store.user(id)!)
  })
  app.get('/api/admin/audit', async request => { requireAdmin(request); return store.audits() })
  app.get('/api/system', async request => {
    const user = requireUser(request)
    const space = await storage.space()
    const info: SystemInfo = { storage: { name: storage.name, type: storage.type, ...space, capabilities: Object.entries(storage.capabilities).filter(([,v]) => v).map(([k]) => k) },
      users: user.role === 'admin' ? store.users().length : 0, activeUploads: user.role === 'admin' ? store.activeUploads().length : store.userUploads(user.id).filter(u => u.status === 'uploading').length, version: '0.1.0' }
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
  app.addHook('preClose', async () => { uploads.close() })
  app.addHook('onClose', async () => { store.close(); storage.close() })
  return app
}
