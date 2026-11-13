/** Cronometer routes — SPEC §6 "Cronometer". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { Limiter } from '../lib/ratelimit.js'
import { asObject, requireString } from '../lib/validate.js'
import { connect, cronometerStatus, CronometerError, disconnect, syncUser } from '../lib/cronometer.js'

/** Logins we relay to Cronometer, per user: 5 / 15 min. Keeps a typo loop from hammering their login. */
const connectByUser = new Limiter({
  max: 5,
  windowMs: 15 * 60 * 1000,
  message: 'Too many Cronometer sign-in attempts. Try again in 15 minutes.',
})

function rethrow(err) {
  if (err instanceof CronometerError) throw new HttpError(err.status, err.message)
  throw err
}

export function registerCronometerRoutes(router) {
  router.get('/api/cronometer', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, { ok: true, cronometer: cronometerStatus(getDb(), user.id) })
  })

  // The password is used for this one login and dropped: only the session
  // cookies are kept. Never log or echo the body.
  router.post('/api/cronometer/connect', async ({ req, res }) => {
    const user = requireUser(req)
    connectByUser.consume(user.id)
    const body = asObject(await readJsonBody(req))
    const email = requireString(body.email, 'email', { max: 254 })
    const password = typeof body.password === 'string' ? body.password : ''
    if (!password || password.length > 512) throw new HttpError(400, 'password is required')
    const db = getDb()
    try {
      const result = await connect(db, user.id, email, password)
      sendJson(res, 200, { ok: true, result, cronometer: cronometerStatus(db, user.id) })
    } catch (err) {
      rethrow(err)
    }
  })

  router.post('/api/cronometer/sync', async ({ req, res }) => {
    const user = requireUser(req)
    const body = (await readJsonBody(req)) ?? {}
    const days = body && typeof body === 'object' && body.days !== undefined ? Number(body.days) : undefined
    if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      throw new HttpError(400, 'days must be a whole number from 1 to 365')
    }
    const db = getDb()
    try {
      const result = await syncUser(db, user.id, { days, trigger: 'manual' })
      sendJson(res, 200, { ok: true, result, cronometer: cronometerStatus(db, user.id) })
    } catch (err) {
      rethrow(err)
    }
  })

  router.post('/api/cronometer/disconnect', async ({ req, res }) => {
    const user = requireUser(req)
    const body = (await readJsonBody(req)) ?? {}
    const deleteMeals = !!(body && typeof body === 'object' && body.deleteMeals === true)
    const db = getDb()
    const result = await disconnect(db, user.id, { deleteMeals })
    sendJson(res, 200, { ok: true, ...result, cronometer: cronometerStatus(db, user.id) })
  })
}
