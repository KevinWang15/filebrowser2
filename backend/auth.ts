import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { User } from '@/shared/types'
import { HttpError } from './errors'
import { Store, publicUser, type UserRow } from './store'

declare module 'fastify' {
  interface FastifyRequest { currentUser: User | null }
}

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex')
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
  constructor(private store: Store, private secure: boolean) {}
  throttle(ip: string) {
    const now = Date.now()
    const previous = this.attempts.get(ip)
    if (previous && previous.expires > now && previous.count >= 15) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.', 'RATE_LIMIT')
    if (this.attempts.size > 10_000) {
      for (const [key, entry] of this.attempts) if (entry.expires <= now) this.attempts.delete(key)
      if (this.attempts.size > 10_000) throw new HttpError(429, 'Please try again later', 'RATE_LIMIT')
    }
    this.attempts.set(ip, previous && previous.expires > now ? { ...previous, count: previous.count + 1 } : { count: 1, expires: now + 15 * 60 * 1000 })
  }
  authenticate(request: FastifyRequest): User | null {
    const token = request.cookies.fb_session
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
    const row = this.store.db.prepare(`SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.hash=? AND sessions.expires_at>? AND users.disabled=0`).get(tokenHash(token), Date.now()) as unknown as UserRow | undefined
    return row ? publicUser(row) : null
  }
  createSession(userId: string, reply: FastifyReply) {
    const token = randomBytes(32).toString('hex')
    this.store.db.prepare('INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + SESSION_LIFETIME)
    reply.setCookie('fb_session', token, { httpOnly: true, secure: this.secure, sameSite: 'strict', path: '/', maxAge: SESSION_LIFETIME / 1000 })
  }
  logout(request: FastifyRequest, reply: FastifyReply) {
    if (request.cookies.fb_session) this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(request.cookies.fb_session))
    reply.clearCookie('fb_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: this.secure })
  }
  revoke(userId: string) { this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId) }
}

export function requireUser(request: FastifyRequest): User {
  if (!request.currentUser) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED')
  return request.currentUser
}
export function requireAdmin(request: FastifyRequest): User {
  const user = requireUser(request)
  if (user.role !== 'admin') throw new HttpError(403, 'Administrator access is required', 'FORBIDDEN')
  return user
}
