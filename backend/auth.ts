import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { User } from '@/shared/types'
import { HttpError } from './errors'
import { Store, type UserRow } from './store'

declare module 'fastify' {
  interface FastifyRequest { currentUser: User | null }
  interface FastifyInstance { auth: Auth }
}

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
interface StreamSource extends AsyncIterable<unknown> {
  destroy(error?: Error): unknown
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
}
export async function hashPassword(password: string) {
  const salt = randomBytes(32).toString('hex')
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, value] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !value) return false
  const expected = Buffer.from(value, 'hex')
  const actual = await derive(password, salt)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export class Auth {
  private attempts = new Map<string, { count: number; expires: number }>()
  private streams = new Set<{ stream: Readable; check: () => void }>()
  constructor(private store: Store, private secure: boolean) {}
  throttle(ip: string) {
    const now = Date.now()
    const previous = this.attempts.get(ip)
    if (previous && previous.expires > now && previous.count >= 15) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.', 'RATE_LIMIT')
    if (this.attempts.size > 10_000) {
      for (const [key, entry] of this.attempts) if (entry.expires <= now) this.attempts.delete(key)
      if (this.attempts.size > 10_000) throw new HttpError(429, 'Please try again later', 'RATE_LIMIT')
    }
    const attempt = previous && previous.expires > now ? { ...previous, count: previous.count + 1 } : { count: 1, expires: now + 15 * 60 * 1000 }
    this.attempts.set(ip, attempt)
    return attempt.expires
  }
  acceptAttempt(ip: string, window: number) {
    const attempt = this.attempts.get(ip)
    if (!attempt || attempt.expires !== window) return
    // Refund only this verified request. Earlier failures from the same IP
    // remain counted, including when several requests finish concurrently.
    if (attempt.count <= 1) this.attempts.delete(ip)
    else this.attempts.set(ip, { ...attempt, count: attempt.count - 1 })
  }
  authenticate(request: FastifyRequest): User | null {
    const token = request.cookies.fb_session
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
    const row = this.store.db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.hash=? AND sessions.expires_at>? AND users.disabled=0`).get(tokenHash(token), Date.now()) as unknown as UserRow | undefined
    return row ? this.store.publicUser(row) : null
  }
  createSession(userId: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('hex')
    this.store.db.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + SESSION_LIFETIME)
    reply.setCookie('fb_session', token, { httpOnly: true, secure: this.secure, sameSite: 'strict', path: '/', maxAge: SESSION_LIFETIME / 1000 })
  }
  logout(request: FastifyRequest, reply: FastifyReply) {
    if (request.cookies.fb_session) this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(request.cookies.fb_session))
    this.recheckStreams()
    reply.clearCookie('fb_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: this.secure })
  }
  revoke(userId: string) { this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); this.recheckStreams() }
  guardStream(request: FastifyRequest, source: StreamSource, authorize: (user: User) => void): Readable {
    const check = () => { authorize(requireUser(request)) }
    try { check() } catch (error) { source.destroy(); throw error }
    const stream = new Transform({ transform(bytes, _encoding, callback) {
      try { check(); callback(null, bytes) } catch (error) { callback(error instanceof Error ? error : new Error('Access revoked')) }
    } })
    const active = { stream, check }
    this.streams.add(active)
    stream.on('error', () => { /* The HTTP consumer handles the stream error. */ })
    stream.once('close', () => { this.streams.delete(active); source.destroy() })
    void pipeline(source, stream).catch(error => stream.destroy(error))
    return stream
  }
  recheckStreams() {
    for (const { stream, check } of this.streams) {
      try { check() } catch (error) { stream.destroy(error instanceof Error ? error : new Error('Access revoked')) }
    }
  }
  close() { for (const { stream } of this.streams) stream.destroy() }
}

export function requireUser(request: FastifyRequest): User {
  // Bodies, password hashing and storage calls may wait after onRequest. The
  // original cookie must still identify an enabled account at every boundary.
  const user = request.server.auth.authenticate(request)
  if (!user) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
  request.currentUser = user
  return user
}
export function requireAdmin(request: FastifyRequest): User {
  const user = requireUser(request)
  if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required', 'FORBIDDEN')
  return user
}
