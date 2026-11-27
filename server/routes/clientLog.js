/**
 * Client diagnostics — SPEC §6 "Client diagnostics".
 *
 * The browser keeps a small queue of things that went wrong on the device
 * (requests that never got an answer, timeouts, 5xx, uncaught errors, how long
 * an outage lasted) and posts it here once the API is reachable again. Each
 * event becomes one `[client]` journal line, so `scripts/hl client` can line a
 * reported outage up against the server's own view. Nothing is stored in the DB.
 *
 * Sign-in is optional: a failure on the login screen must still be reportable.
 * Every field is whitelisted and clamped; the journal never sees free-form
 * request bodies, tokens or emails.
 */
import { getDb } from '../db.js'
import { bearerToken, sessionUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { clientIp, clientLogByIp } from '../lib/ratelimit.js'

const MAX_EVENTS = 50
const TYPES = new Set(['fetch-fail', 'recovered', 'boot', 'error'])

const str = (value, max) => (typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, max) : undefined)
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined)
const bool = (value) => (typeof value === 'boolean' ? value : undefined)

/** An API path without ids or query strings: `/meals/abc-123?x=1` -> `/meals/:id`. */
function safePath(value) {
  const path = str(value, 120)
  if (!path) return undefined
  return path
    .split('?')[0]
    .split('/')
    .map((part) => (/^[0-9a-f-]{8,}$/i.test(part) || /\d{3,}/.test(part) ? ':id' : part))
    .join('/')
}

/** Keep only known fields with the expected types. Returns null for junk. */
export function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null
  const event = {
    type: raw.type,
    at: str(raw.at, 30),
    path: safePath(raw.path),
    method: str(raw.method, 8),
    kind: str(raw.kind, 12),
    status: num(raw.status),
    ms: num(raw.ms),
    error: str(raw.error, 160),
    online: bool(raw.online),
    visible: bool(raw.visible),
    standalone: bool(raw.standalone),
    net: str(raw.net, 12),
    sinceLoadMs: num(raw.sinceLoadMs),
    firstFailAt: str(raw.firstFailAt, 30),
    failures: num(raw.failures),
    outageMs: num(raw.outageMs),
    source: str(raw.source, 20),
    build: str(raw.build, 40),
    base: str(raw.base, 80),
  }
  for (const key of Object.keys(event)) if (event[key] === undefined) delete event[key]
  return event
}

export function registerClientLogRoutes(router) {
  router.post('/api/client-log', async ({ req, res }) => {
    const ip = clientIp(req)
    clientLogByIp.consume(`ip:${ip}`)
    const body = await readJsonBody(req, { limit: 64 * 1024 })
    if (!Array.isArray(body.events)) throw new HttpError(400, 'events must be an array')

    let who = 'anon'
    const token = bearerToken(req.headers?.authorization)
    if (token) {
      const user = sessionUser(getDb(), token)
      if (user) who = String(user.id).slice(0, 8)
    }

    let accepted = 0
    for (const raw of body.events.slice(0, MAX_EVENTS)) {
      const event = cleanEvent(raw)
      if (!event) continue
      accepted++
      console.log(`[client] user=${who} ip=${ip} ${JSON.stringify(event)}`)
    }
    sendJson(res, 200, { ok: true, accepted })
  })
}
