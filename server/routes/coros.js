/** COROS routes — SPEC §6 "COROS". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { Limiter } from '../lib/ratelimit.js'
import { asObject } from '../lib/validate.js'
import { corosStatus, CorosError, disconnect, finishConnect, MAX_DAYS, startConnect, syncUser } from '../lib/coros.js'
import { originAllowed } from '../index.js'

/** Connect attempts per user: 10 / 15 min (each one may register a client and opens a sign-in at COROS). */
const connectByUser = new Limiter({
  max: 10,
  windowMs: 15 * 60 * 1000,
  message: 'Too many COROS connect attempts. Try again in 15 minutes.',
})

const CALLBACK_PATH = '/api/coros/oauth/callback'

function rethrow(err) {
  if (err instanceof CorosError) throw new HttpError(err.status, err.message)
  throw err
}

/** The URL COROS sends the browser back to: this API's own public address. */
function redirectUri(req) {
  if (process.env.COROS_REDIRECT_URI) return process.env.COROS_REDIRECT_URI
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http')
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
  if (!host) throw new HttpError(400, 'Cannot tell this server\'s address for the COROS sign-in.')
  return `${proto}://${host}${CALLBACK_PATH}`
}

/** Only send the browser back to the HealthLog frontend itself. */
function safeReturnTo(value, req) {
  try {
    const u = new URL(String(value))
    if (!['http:', 'https:'].includes(u.protocol) || !originAllowed(u.origin, req.headers.host)) return null
    return u.toString()
  } catch {
    return null
  }
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end()
}

function page(res, status, message) {
  const esc = String(message).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><title>HealthLog</title><p>${esc}</p>`)
}

export function registerCorosRoutes(router) {
  router.get('/api/coros', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, { ok: true, coros: corosStatus(getDb(), user.id) })
  })

  // Step 1: hand back COROS's sign-in URL. HealthLog never sees the COROS password.
  router.post('/api/coros/connect', async ({ req, res }) => {
    const user = requireUser(req)
    connectByUser.consume(user.id)
    const body = asObject((await readJsonBody(req)) ?? {})
    const returnTo = safeReturnTo(body.returnTo, req)
    if (!returnTo) throw new HttpError(400, 'returnTo must be a HealthLog page')
    try {
      const { authorizeUrl } = await startConnect(getDb(), user.id, { redirectUri: redirectUri(req), returnTo })
      sendJson(res, 200, { ok: true, authorizeUrl })
    } catch (err) {
      rethrow(err)
    }
  })

  // Step 2: COROS sends the browser here. No bearer token on a redirect: the
  // one-time `state` from step 1 identifies the user.
  router.get(CALLBACK_PATH, async ({ res, query }) => {
    const result = await finishConnect(getDb(), { code: query.get('code'), state: query.get('state'), error: query.get('error') })
    if (result.returnTo) return redirect(res, result.returnTo)
    page(res, 400, result.message ?? 'This COROS sign-in link is not valid. Start again from HealthLog\'s Settings.')
  })

  router.post('/api/coros/sync', async ({ req, res }) => {
    const user = requireUser(req)
    const body = (await readJsonBody(req)) ?? {}
    const days = body && typeof body === 'object' && body.days !== undefined ? Number(body.days) : undefined
    if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) {
      throw new HttpError(400, `days must be a whole number from 1 to ${MAX_DAYS}`)
    }
    const db = getDb()
    try {
      const result = await syncUser(db, user.id, { days, trigger: 'manual' })
      sendJson(res, 200, { ok: true, result, coros: corosStatus(db, user.id) })
    } catch (err) {
      rethrow(err)
    }
  })

  router.post('/api/coros/disconnect', async ({ req, res }) => {
    const user = requireUser(req)
    const body = (await readJsonBody(req)) ?? {}
    const deleteData = !!(body && typeof body === 'object' && body.deleteData === true)
    const db = getDb()
    const result = await disconnect(db, user.id, { deleteData })
    sendJson(res, 200, { ok: true, ...result, coros: corosStatus(db, user.id) })
  })
}
