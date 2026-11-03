/** Garmin + activities routes — SPEC §6 "Garmin". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { activityPayload, dailyActivityPayload, garminStatus, GarminSyncError, syncUser } from '../lib/garmin.js'
import { addDays, isISODate, today } from '../lib/metrics.js'

export function registerGarminRoutes(router) {
  router.get('/api/garmin', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, { ok: true, garmin: garminStatus(getDb(), user.id) })
  })

  // Manual "sync now". Resumes saved tokens only - it can never trigger a
  // Garmin password login, and it respects the rate-limit backoff.
  router.post('/api/garmin/sync', async ({ req, res }) => {
    const user = requireUser(req)
    const body = (await readJsonBody(req)) ?? {}
    const days = body && typeof body === 'object' && body.days !== undefined ? Number(body.days) : undefined
    if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= 120)) {
      throw new HttpError(400, 'days must be a whole number from 1 to 120')
    }
    const db = getDb()
    try {
      const result = await syncUser(db, user.id, { days, trigger: 'manual' })
      sendJson(res, 200, { ok: true, result, garmin: garminStatus(db, user.id) })
    } catch (err) {
      if (err instanceof GarminSyncError) throw new HttpError(err.status, err.message)
      throw err
    }
  })

  router.get('/api/activities', async ({ req, res, query }) => {
    const user = requireUser(req)
    const limit = Math.max(1, Math.min(200, Math.round(Number(query.get('limit') ?? 50)) || 50))
    const before = query.get('before')
    const db = getDb()
    const rows = before
      ? db.prepare('SELECT * FROM activities WHERE user_id = ? AND start_local < ? ORDER BY start_local DESC LIMIT ?').all(user.id, before, limit)
      : db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY start_local DESC LIMIT ?').all(user.id, limit)
    sendJson(res, 200, { ok: true, activities: rows.map(activityPayload) })
  })

  router.get('/api/activity/daily', async ({ req, res, query }) => {
    const user = requireUser(req)
    const to = query.get('to') || today()
    const from = query.get('from') || addDays(to, -29)
    if (!isISODate(from) || !isISODate(to)) throw new HttpError(400, 'from and to must be calendar dates (YYYY-MM-DD)')
    const rows = getDb()
      .prepare('SELECT * FROM daily_activity WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY day ASC')
      .all(user.id, from, to)
    sendJson(res, 200, { ok: true, days: rows.map(dailyActivityPayload) })
  })
}
