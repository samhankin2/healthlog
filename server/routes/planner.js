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
import { addNote, mealsPayload, setHidden, setRating, updateMeal } from '../lib/planner/meals.js'

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

export function registerPlannerRoutes(router) {
  router.get('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })

  router.get('/api/planner/meals', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, meals: mealsPayload(db, householdId) })
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
    const meal = mealsPayload(db, householdId).find((m) => m.id === params.id) ?? null
    sendJson(res, 200, { ok: true, meal })
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
}
