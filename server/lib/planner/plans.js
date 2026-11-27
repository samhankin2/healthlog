/**
 * Meal plans (SPEC §6 "Meal planner"): you start one whenever you like, on
 * any night, and it runs for as many nights as you say (seven to begin
 * with). Starting the next plan ends the one before it on the night before.
 * The newest plan is the current one. A plan's shopping list is keyed by its
 * first night and runs to its last.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { addDays, requireDay } from './week.js'

export const MAX_NIGHTS = 28
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

function payload(row) {
  return { id: row.id, start: row.start_date, nights: row.nights, end: addDays(row.start_date, row.nights - 1) }
}

/** Newest first. */
export function plansList(db, householdId) {
  return db
    .prepare('SELECT * FROM meal_plans WHERE household_id = ? ORDER BY start_date DESC LIMIT 60')
    .all(householdId)
    .map(payload)
}

function syncShopping(db, householdId, plan) {
  db.prepare('UPDATE shopping_lists SET ends_on = ? WHERE household_id = ? AND week_start = ?').run(plan.end, householdId, plan.start)
}

function clampNights(n) {
  const nights = Number(n)
  if (!Number.isInteger(nights) || nights < 1 || nights > MAX_NIGHTS) throw new HttpError(400, `A plan is 1 to ${MAX_NIGHTS} nights`)
  return nights
}

/** Start a plan on any night. A plan already running past it ends the night before; one on the same night is replaced. */
export function startPlan(db, householdId, { start, nights = 7 }) {
  requireDay(start, 'start')
  let n = clampNights(nights)
  return withTx(db, () => {
    for (const p of db.prepare('SELECT * FROM meal_plans WHERE household_id = ?').all(householdId)) {
      const end = addDays(p.start_date, p.nights - 1)
      if (p.start_date >= start) {
        // A later plan: this one stops before it.
        if (p.start_date === start) db.prepare('DELETE FROM meal_plans WHERE id = ?').run(p.id)
        else n = Math.min(n, daysBetween(start, p.start_date))
      } else if (end >= start) {
        const kept = daysBetween(p.start_date, start)
        db.prepare('UPDATE meal_plans SET nights = ? WHERE id = ?').run(kept, p.id)
        syncShopping(db, householdId, payload({ ...p, nights: kept }))
      }
    }
    const id = randomUUID()
    db.prepare('INSERT INTO meal_plans (id, household_id, start_date, nights) VALUES (?, ?, ?, ?)').run(id, householdId, start, n)
    const plan = payload(db.prepare('SELECT * FROM meal_plans WHERE id = ?').get(id))
    syncShopping(db, householdId, plan)
    return plan
  })
}

/** One more night, or one fewer; never running into the next plan. */
export function setPlanNights(db, householdId, id, nights) {
  let n = clampNights(nights)
  return withTx(db, () => {
    const row = db.prepare('SELECT * FROM meal_plans WHERE id = ? AND household_id = ?').get(String(id), householdId)
    if (!row) throw new HttpError(404, 'That plan was not found')
    const next = db.prepare('SELECT start_date FROM meal_plans WHERE household_id = ? AND start_date > ? ORDER BY start_date LIMIT 1').get(householdId, row.start_date)
    if (next) n = Math.min(n, daysBetween(row.start_date, next.start_date))
    db.prepare('UPDATE meal_plans SET nights = ? WHERE id = ?').run(n, row.id)
    const plan = payload({ ...row, nights: n })
    syncShopping(db, householdId, plan)
    return plan
  })
}

/** A plan's last night, for the shopping list of the plan starting on `start`. */
export function planEndFor(db, householdId, start) {
  const row = db.prepare('SELECT * FROM meal_plans WHERE household_id = ? AND start_date = ?').get(householdId, start)
  return row ? addDays(row.start_date, row.nights - 1) : null
}
