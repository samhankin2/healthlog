/**
 * In-memory rate limiting — SPEC §5 "Rate limits".
 *
 * Fixed-window counters keyed by a string (IP, account, user id). One process,
 * one box, so a Map is enough; a restart clears the counters, which is fine.
 *
 * Client IP: the API listens on 127.0.0.1 behind Caddy, which sets
 * X-Forwarded-For from the real peer (it does not trust a client-supplied one
 * by default). We only read the header when the TCP peer is loopback, and take
 * the last entry - the one Caddy appended.
 *
 * RATE_LIMIT=off disables every limiter (local experiments only).
 */
import { HttpError } from './http.js'

const DISABLED = ['0', 'off', 'false', 'no'].includes((process.env.RATE_LIMIT || '').trim().toLowerCase())

/** Throws 429 with a Retry-After hint. */
export class RateLimitError extends HttpError {
  constructor(retryAfterSec, message = 'Too many attempts. Try again later.') {
    super(429, message)
    this.retryAfter = Math.max(1, Math.ceil(retryAfterSec))
  }
}

export class Limiter {
  /**
   * @param {{ max: number, windowMs: number, message?: string }} opts
   */
  constructor({ max, windowMs, message }) {
    this.max = max
    this.windowMs = windowMs
    this.message = message
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.hits = new Map()
    // Periodic sweep so the map cannot grow without bound under a scan.
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 10 * 60 * 1000))
    this.timer.unref?.()
  }

  sweep(now = Date.now()) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k)
  }

  entry(key, now) {
    let e = this.hits.get(key)
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs }
      this.hits.set(key, e)
    }
    return e
  }

  /** Throw if `key` is already over the limit (does not count). */
  check(key, now = Date.now()) {
    if (DISABLED || !key) return
    const e = this.hits.get(key)
    if (e && e.resetAt > now && e.count >= this.max) {
      throw new RateLimitError((e.resetAt - now) / 1000, this.message)
    }
  }

  /** Count one hit for `key`. */
  hit(key, now = Date.now()) {
    if (DISABLED || !key) return
    this.entry(key, now).count++
  }

  /** check + hit in one go. */
  consume(key, now = Date.now()) {
    this.check(key, now)
    this.hit(key, now)
  }

  reset(key) {
    this.hits.delete(key)
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Best-effort client IP (see the header comment). */
export function clientIp(req) {
  const peer = req.socket?.remoteAddress || ''
  if (LOOPBACK.has(peer)) {
    const xff = req.headers?.['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.length) return parts[parts.length - 1]
    }
  }
  return peer || 'unknown'
}

const MIN = 60 * 1000

/** Login attempts per client IP: 20 / 15 min. */
export const loginByIp = new Limiter({ max: 20, windowMs: 15 * MIN })
/** Failed logins per account: 10 / 15 min, then the account is paused. */
export const loginFailsByAccount = new Limiter({
  max: 10,
  windowMs: 15 * MIN,
  message: 'Too many failed sign-in attempts for this account. Try again in 15 minutes.',
})
/** Registrations (invite redemption attempts) per IP: 10 / hour. */
export const registerByIp = new Limiter({ max: 10, windowMs: 60 * MIN })
/** AI chat calls per user: 60 / hour (each one is two paid model calls + a judge). */
export const chatByUser = new Limiter({
  max: 60,
  windowMs: 60 * MIN,
  message: 'You have hit the hourly AI limit. Try again a little later.',
})
/** Every authenticated or anonymous API request per IP: 600 / 5 min. A coarse flood guard. */
export const requestsByIp = new Limiter({
  max: 600,
  windowMs: 5 * MIN,
  message: 'Too many requests. Slow down and try again shortly.',
})
