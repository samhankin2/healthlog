/**
 * Meal planner routes — SPEC §6 "Meal planner".
 *
 * Every planner route resolves the caller's household first and scopes all
 * reads and writes to it. The mealplan frontend (its own repo) is the client.
 */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { sendJson } from '../lib/http.js'
import { ensureHousehold, householdPayload } from '../lib/planner/household.js'

/** The caller and their household id; use at the top of every planner route. */
export function plannerContext(req) {
  const user = requireUser(req)
  const db = getDb()
  return { user, db, householdId: ensureHousehold(db, user) }
}

export function registerPlannerRoutes(router) {
  router.get('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })
}
