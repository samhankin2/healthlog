/**
 * Small input-validation helpers. Every failure throws HttpError(400) with a
 * human message naming the offending field.
 */
import { HttpError } from './http.js'

export function requireString(value, field, { max = 500, min = 1 } = {}) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (s.length < min) throw new HttpError(400, `${field} is required`)
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`)
  return s
}

export function optionalString(value, field, { max = 5000 } = {}) {
  if (value === undefined) return undefined
  if (value === null) return null
  const s = String(value).trim()
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`)
  return s === '' ? null : s
}

/**
 * Coerce to a finite number. `undefined` means "not supplied" and is returned
 * as undefined; `null` is returned as null when `nullable` is true.
 */
export function optionalNumber(value, field, { min = -Infinity, max = Infinity, nullable = false, integer = false } = {}) {
  if (value === undefined) return undefined
  if (value === null || value === '') {
    if (nullable) return null
    throw new HttpError(400, `${field} must be a number`)
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`)
  if (n < min) throw new HttpError(400, `${field} must be at least ${min}`)
  if (n > max) throw new HttpError(400, `${field} must be at most ${max}`)
  return integer ? Math.round(n) : n
}

export function requireNumber(value, field, opts = {}) {
  const n = optionalNumber(value, field, { nullable: false, ...opts })
  if (n === undefined) throw new HttpError(400, `${field} is required`)
  return n
}

/** Clamp an integer query param into [min, max] with a fallback. */
export function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/** True when the body is a JSON object (arrays are not objects here). */
export function asObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object')
  }
  return body
}

/** Pick the first defined value among camelCase / snake_case aliases. */
export function alias(body, ...keys) {
  for (const k of keys) {
    if (body[k] !== undefined) return body[k]
  }
  return undefined
}
