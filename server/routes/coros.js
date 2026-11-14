/** COROS routes — SPEC §6 "COROS". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { Limiter } from '../lib/ratelimit.js'
import { asObject, requireString } from '../lib/validate.js'
import { connect, corosStatus, CorosError, disconnect, MAX_DAYS, syncUser } from '../lib/coros.js'

/** Logins we relay to COROS, per user: 5 / 15 min. Keeps a typo loop from hammering their login. */
const connectByUser = new Limiter({
  max: 5,
  windowMs: 15 * 60 * 1000,
  message: 'Too many COROS sign-in attempts. Try again in 15 minutes.',
})

function rethrow(err) {
  if (err instanceof CorosError) throw new HttpError(err.status, err.message)
  throw err
}

export function registerCorosRoutes(router) {
  router.get('/api/coros', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, { ok: true, coros: corosStatus(getDb(), user.id) })
  })

  // The password is used for this one login and dropped: only the access
  // token is kept. Never log or echo the body.
  router.post('/api/coros/connect', async ({ req, res }) => {
    const user = requireUser(req)
    connectByUser.consume(user.id)
    const body = asObject(await readJsonBody(req))
    const email = requireString(body.email, 'email', { max: 254 })
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password || password.length > 512) throw new HttpError(400, 'password is required')
    const db = getDb()
    try {
      const result = await connect(db, user.id, email, password)
      sendJson(res, 200, { ok: true, result, coros: corosStatus(db, user.id) })
    } catch (err) {
      rethrow(err)
    }
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
    const result = disconnect(db, user.id, { deleteData })
    sendJson(res, 200, { ok: true, ...result, coros: corosStatus(db, user.id) })
  })
}
