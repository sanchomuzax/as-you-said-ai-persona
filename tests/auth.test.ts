import { describe, it, expect } from 'vitest'
import {
  createSessionToken,
  verifySessionToken,
  checkCredentials,
  LoginRateLimiter
} from '../src/auth.js'

const SECRET = 'test-secret-at-least-16-chars'

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const token = createSessionToken('admin', SECRET)
    expect(verifySessionToken(token, SECRET)).toBe('admin')
  })

  it('rejects a tampered token', () => {
    const token = createSessionToken('admin', SECRET)
    expect(verifySessionToken(token + 'x', SECRET)).toBeNull()
    expect(verifySessionToken('garbage', SECRET)).toBeNull()
  })

  it('rejects a token signed with another secret', () => {
    const token = createSessionToken('admin', 'another-secret-16-chars!')
    expect(verifySessionToken(token, SECRET)).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = createSessionToken('admin', SECRET, Date.now() - 13 * 60 * 60 * 1000)
    expect(verifySessionToken(token, SECRET)).toBeNull()
  })
})

describe('checkCredentials', () => {
  it('accepts matching and rejects non-matching credentials', () => {
    expect(checkCredentials('u', 'p12345678', 'u', 'p12345678')).toBe(true)
    expect(checkCredentials('u', 'wrong', 'u', 'p12345678')).toBe(false)
    expect(checkCredentials('x', 'p12345678', 'u', 'p12345678')).toBe(false)
  })
})

describe('LoginRateLimiter', () => {
  it('blocks after max failures and resets after the window', () => {
    const rl = new LoginRateLimiter(3, 1000)
    const now = 1_000_000
    expect(rl.allowed('1.2.3.4', now)).toBe(true)
    rl.recordFailure('1.2.3.4', now)
    rl.recordFailure('1.2.3.4', now)
    rl.recordFailure('1.2.3.4', now)
    expect(rl.allowed('1.2.3.4', now)).toBe(false)
    expect(rl.allowed('5.6.7.8', now)).toBe(true)
    expect(rl.allowed('1.2.3.4', now + 1001)).toBe(true)
  })
})
