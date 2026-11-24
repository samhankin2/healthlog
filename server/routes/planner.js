/**
 * Meal planner routes — SPEC §6 "Meal planner".
 *
 * Every planner route resolves the caller's household first and scopes all
 * reads and writes to it. The mealplan frontend (its own repo) is the client.
 */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { asObject } from '../lib/validate.js'
import { ensureHousehold, householdPayload } from '../lib/planner/household.js'
import { addAlias, addNote, createMeal, mealsPayload, setHidden, setRating, updateMeal } from '../lib/planner/meals.js'
import { parseWeek } from '../lib/planner/match.js'
import { clearSlot, copyWeek, requireDay, setSlot, weekDays, weekdayOf, weekPayload } from '../lib/planner/week.js'

/** The caller and their household id; use at the top of every planner route. */
export function plannerContext(req) {
  const user = requireUser(req)
  const db = getDb()
  return { user, db, householdId: ensureHousehold(db, user) }
}

const nullableInt = (value, field) => {
  if (value === undefined || value === null) return value ?? null
  if (!Number.isInteger(value)) throw new HttpError(400, `${field} must be a whole number or null`)
  return value
}

const mealPayload = (db, householdId, id) => mealsPayload(db, householdId).find((m) => m.id === id)

export function registerPlannerRoutes(router) {
  router.get('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })

  router.put('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    if (body.weekStartDay !== undefined) {
      if (!Number.isInteger(body.weekStartDay) || body.weekStartDay < 0 || body.weekStartDay > 6) {
        throw new HttpError(400, 'weekStartDay must be 0 (Monday) to 6 (Sunday)')
      }
      db.prepare('UPDATE households SET week_start_day = ? WHERE id = ?').run(body.weekStartDay, householdId)
    }
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })

  /* ---------- meals ---------- */

  router.get('/api/planner/meals', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, meals: mealsPayload(db, householdId) })
  })

  router.post('/api/planner/meals', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const { id, created } = createMeal(db, householdId, body.name)
    sendJson(res, created ? 201 : 200, { ok: true, created, meal: mealPayload(db, householdId, id) })
  })

  router.put('/api/planner/meals/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    updateMeal(db, householdId, params.id, {
      tags: body.tags,
      suggestedTags: body.suggestedTags,
      effort: body.effort === undefined ? undefined : nullableInt(body.effort, 'effort'),
      tips: body.tips,
      neverSuggest: body.neverSuggest,
      archived: body.archived === undefined ? undefined : Boolean(body.archived),
    })
    // An archived meal drops out of the payload: null.
    sendJson(res, 200, { ok: true, meal: mealPayload(db, householdId, params.id) ?? null })
  })

  router.post('/api/planner/meals/:id/aliases', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, alias: addAlias(db, householdId, params.id, body.alias) })
  })

  router.put('/api/planner/ratings', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    if (typeof body.dishId !== 'string') throw new HttpError(400, 'dishId is required')
    if (typeof body.ratedAs !== 'string') throw new HttpError(400, 'ratedAs is required')
    const rating = setRating(db, householdId, user, {
      dishId: body.dishId,
      optionId: typeof body.optionId === 'string' && body.optionId ? body.optionId : null,
      ratedAs: body.ratedAs,
      thumbs: nullableInt(body.thumbs, 'thumbs'),
      stars: nullableInt(body.stars, 'stars'),
      want: body.want === true,
    })
    sendJson(res, 200, { ok: true, rating })
  })

  router.put('/api/planner/meals/:id/hidden', async ({ req, res, params }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, hidden: setHidden(db, householdId, user, params.id, body.optionId, body.hidden !== false) })
  })

  router.post('/api/planner/meals/:id/notes', async ({ req, res, params }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 201, { ok: true, note: addNote(db, householdId, user, params.id, body.body) })
  })

  /* ---------- the week ---------- */

  router.get('/api/planner/week', async ({ req, res, query }) => {
    const { db, householdId } = plannerContext(req)
    const start = requireDay(query?.get('start'), 'start')
    sendJson(res, 200, { ok: true, week: weekPayload(db, householdId, start) })
  })

  router.put('/api/planner/slots/:date', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const entry = setSlot(db, householdId, params.date, {
      kind: body.kind ?? 'dish',
      dishId: body.dishId ?? null,
      optionIds: body.optionIds ?? [],
      note: body.note ?? null,
      raw: body.raw ?? null,
    })
    sendJson(res, 200, { ok: true, entry })
  })

  router.delete('/api/planner/slots/:date', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    clearSlot(db, householdId, params.date)
    sendJson(res, 200, { ok: true, cleared: params.date })
  })

  router.post('/api/planner/week/copy', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const from = requireDay(body.from, 'from')
    const to = requireDay(body.to, 'to')
    const copied = copyWeek(db, householdId, from, to)
    sendJson(res, 200, { ok: true, copied, week: weekPayload(db, householdId, to) })
  })

  router.post('/api/planner/parse-week', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const start = requireDay(body.start, 'start')
    const text = String(body.text ?? '')
    if (!text.trim()) throw new HttpError(400, 'Type the week first')
    if (text.length > 2000) throw new HttpError(400, 'That is too long for one week')
    const days = weekDays(start)
    const items = await parseWeek(db, householdId, text, days, days.map(weekdayOf), { useAi: body.ai !== false })
    sendJson(res, 200, { ok: true, items })
  })
}
