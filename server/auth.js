/**
 * Auth: invite codes, scrypt password hashing, bearer sessions.
 * See SPEC.md §5.
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { getDb, ensureProfile } from './db.js'
import { HttpError } from './lib/http.js'

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LEN = 64
const SALT_LEN = 16
export const SESSION_TTL_DAYS = 90

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

/** Hash a password as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password) {
  const salt = randomBytes(SALT_LEN)
  const hash = scryptSync(String(password), salt, KEY_LEN, SCRYPT)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

/** Constant-time password check. Returns false for malformed stored hashes. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  let salt
  let expected
  try {
    salt = Buffer.from(parts[1], 'hex')
    expected = Buffer.from(parts[2], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  let actual
  try {
    actual = scryptSync(String(password), salt, expected.length, SCRYPT)
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/* ------------------------------------------------------------------ */
/* Invite codes                                                        */
/* ------------------------------------------------------------------ */

// Crockford-ish alphabet: no 0/O/1/I to keep codes readable when typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode() {
  const bytes = randomBytes(12)
  let out = ''
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    if (i === 3 || i === 7) out += '-'
  }
  return `HL-${out}`
}

/** Normalise a user-supplied code: trim, upper-case, drop surrounding spaces. */
export function normaliseInviteCode(code) {
  return String(code ?? '')
    .trim()
    .toUpperCase()
}

/** Create an invite code row and return it. */
export function createInvite(db = getDb(), { note = null } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode()
    const existing = db.prepare('SELECT id FROM invite_codes WHERE code = ?').get(code)
    if (existing) continue
    const id = randomUUID()
    db.prepare('INSERT INTO invite_codes (id, code, note) VALUES (?, ?, ?)').run(id, code, note)
    return { id, code, note }
  }
  throw new Error('Could not generate a unique invite code')
}

/** Look up an invite by code (normalised). Returns the row or null. */
export function findInvite(db, code) {
  return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(normaliseInviteCode(code)) ?? null
}

/** All invite codes, newest first. */
export function listInvites(db = getDb()) {
  return db.prepare('SELECT * FROM invite_codes ORDER BY created_at DESC, rowid DESC').all()
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email ?? '').trim()) ?? null
}

export function findUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null
}

/** Public user shape returned by the API. */
export function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? null,
    createdAt: toIso(row.created_at),
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function sqlTimestamp(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Create a session and return the raw (unhashed) bearer token. */
export function createSession(db, userId, userAgent = null) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400000)
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), userId, hashToken(token), sqlTimestamp(expiresAt), userAgent)
  return token
}

/** Resolve a raw bearer token to its user row, or null. Expired sessions are ignored. */
export function sessionUser(db, token) {
  if (!token) return null
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled_at IS NULL`,
    )
    .get(hashToken(token))
  return row ?? null
}

/** Delete a session by its raw token. */
export function deleteSession(db, token) {
  if (!token) return
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
}

/** Drop expired sessions (cheap housekeeping, called on login). */
export function pruneSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run()
}

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim())
  return m ? m[1].trim() : null
}

/**
 * Require a signed-in user. Throws `HttpError(401, "Not signed in")` otherwise.
 * @param {import('node:http').IncomingMessage} req
 */
export function requireUser(req) {
  const token = bearerToken(req.headers?.authorization)
  if (!token) throw new HttpError(401, 'Not signed in')
  const db = getDb()
  const user = sessionUser(db, token)
  if (!user) throw new HttpError(401, 'Not signed in')
  return user
}

/* ------------------------------------------------------------------ */
/* Registration helpers                                                */
/* ------------------------------------------------------------------ */

/** Validate an email/password pair, throwing 400s with human messages. */
export function validateCredentials(email, password) {
  const e = String(email ?? '').trim()
  if (!e) throw new HttpError(400, 'Email is required')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'That email address does not look valid')
  if (e.length > 254) throw new HttpError(400, 'That email address is too long')
  const p = String(password ?? '')
  if (p.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
  if (p.length > 200) throw new HttpError(400, 'Password is too long')
  return { email: e, password: p }
}

/** Create a user row (caller handles invite consumption). */
export function insertUser(db, { email, password, displayName = null }) {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    id,
    email,
    hashPassword(password),
    displayName,
  )
  ensureProfile(db, id)
  return findUserById(db, id)
}

/** Convert a SQLite `YYYY-MM-DD HH:MM:SS` (UTC) string into an ISO string. */
export function toIso(value) {
  if (!value) return null
  if (typeof value !== 'string') return null
  if (value.includes('T')) return value
  return `${value.replace(' ', 'T')}Z`
}
