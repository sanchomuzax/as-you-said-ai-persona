import { createHmac, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function createSessionToken(username: string, secret: string, now = Date.now()): string {
  const payload = `${username}:${now + SESSION_TTL_MS}`
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload, secret)}`
}

export function verifySessionToken(token: string, secret: string, now = Date.now()): string | null {
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature) return null
  const payload = Buffer.from(encoded, 'base64url').toString()
  const expected = sign(payload, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const idx = payload.lastIndexOf(':')
  const username = payload.slice(0, idx)
  const expires = Number(payload.slice(idx + 1))
  if (!Number.isFinite(expires) || now > expires) return null
  return username
}

export function checkCredentials(
  username: string,
  password: string,
  expectedUser: string,
  expectedPass: string
): boolean {
  return safeEqual(username, expectedUser) && safeEqual(password, expectedPass)
}

/** Simple in-memory login rate limiter (per source IP). */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(private readonly maxAttempts = 10, private readonly windowMs = 15 * 60 * 1000) {}

  allowed(ip: string, now = Date.now()): boolean {
    const entry = this.attempts.get(ip)
    if (!entry || now > entry.resetAt) return true
    return entry.count < this.maxAttempts
  }

  recordFailure(ip: string, now = Date.now()): void {
    const entry = this.attempts.get(ip)
    if (!entry || now > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + this.windowMs })
    } else {
      this.attempts.set(ip, { count: entry.count + 1, resetAt: entry.resetAt })
    }
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
