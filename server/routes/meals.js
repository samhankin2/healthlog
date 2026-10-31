/** Meal routes — SPEC §6 "Meals and foods". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, clampInt, optionalNumber, optionalString, requireString } from '../lib/validate.js'
import { isISODate, today } from '../lib/metrics.js'
import { findMeal, insertMeal, listMeals, replaceItems, totalsFromItems, normaliseItems } from '../lib/meals.js'

const SOURCES = ['ai', 'manual', 'import', 'saved_food']

/** Derive the local calendar day for a meal. */
export function resolveDay(body, fallback = today()) {
  const explicit = alias(body, 'day')
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const d = String(explicit).trim()
    if (!isISODate(d)) throw new HttpError(400, 'day must be a calendar date (YYYY-MM-DD)')
    return d
  }
  const eatenAt = alias(body, 'eatenAt', 'eaten_at')
  if (typeof eatenAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(eatenAt)) return eatenAt.slice(0, 10)
  return fallback
}

/** Build an insert payload from a request body. */
export function readMealInput(body, { existing = null } = {}) {
  const items = alias(body, 'items') !== undefined ? normaliseItems(alias(body, 'items')) : existing ? undefined : []
  const sums = items && items.length > 0 ? totalsFromItems(items) : null

  const requireOr = (value, field, current, fallback) => {
    const n = optionalNumber(value, field, { min: 0, max: 100000, nullable: true })
    if (n === undefined) return current !== undefined && current !== null ? Number(current) : fallback
    return n === null ? 0 : n
  }

  const kcalField = alias(body, 'kcal')
  const kcal = requireOr(kcalField, 'kcal', existing?.kcal, sums?.kcal ?? 0)

  const nameValue = alias(body, 'name')
  const name =
    nameValue !== undefined ? requireString(nameValue, 'name', { max: 200 }) : existing ? existing.name : null
  if (!name) throw new HttpError(400, 'name is required')

  const fiberG = optionalNumber(alias(body, 'fiberG', 'fiber_g'), 'fiberG', { min: 0, max: 10000, nullable: true })
  const confidence = optionalNumber(alias(body, 'confidence'), 'confidence', { min: 0, max: 1, nullable: true })

  const sourceRaw = alias(body, 'source')
  if (sourceRaw !== undefined && sourceRaw !== null && !SOURCES.includes(String(sourceRaw))) {
    throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`)
  }

  const description = optionalString(alias(body, 'description'), 'description', { max: 2000 })

  return {
    name,
    description: description !== undefined ? description : (existing?.description ?? null),
    kcal,
    proteinG: requireOr(alias(body, 'proteinG', 'protein_g'), 'proteinG', existing?.protein_g, sums?.proteinG ?? 0),
    carbsG: requireOr(alias(body, 'carbsG', 'carbs_g'), 'carbsG', existing?.carbs_g, sums?.carbsG ?? 0),
    fatG: requireOr(alias(body, 'fatG', 'fat_g'), 'fatG', existing?.fat_g, sums?.fatG ?? 0),
    fiberG: fiberG !== undefined ? fiberG : (existing?.fiber_g ?? null),
    source: sourceRaw !== undefined && sourceRaw !== null ? String(sourceRaw) : (existing?.source ?? 'manual'),
    confidence: confidence !== undefined ? confidence : (existing?.confidence ?? null),
    items,
  }
}

export function registerMealRoutes(router) {
  router.get('/api/meals', async ({ req, res, query }) => {
    const user = requireUser(req)
    const db = getDb()
    const day = query.get('day')
    if (day && !isISODate(day)) throw new HttpError(400, 'day must be a calendar date (YYYY-MM-DD)')
    const limit = clampInt(query.get('limit'), 1, 200, 50)
    const offset = clampInt(query.get('offset'), 0, 100000, 0)
    sendJson(res, 200, { ok: true, meals: listMeals(db, user.id, { day: day || null, limit, offset }) })
  })

  router.post('/api/meals', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const db = getDb()

    const day = resolveDay(body)
    const eatenAtRaw = alias(body, 'eatenAt', 'eaten_at')
    const eatenAt =
      typeof eatenAtRaw === 'string' && eatenAtRaw.trim() ? eatenAtRaw.trim() : `${day}T12:00:00.000Z`
    const input = readMealInput(body)
    const id = insertMeal(db, user.id, { ...input, day, eatenAt })
    sendJson(res, 201, { ok: true, meal: findMeal(db, user.id, id) })
  })

  router.put('/api/meals/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = db.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!existing) throw new HttpError(404, 'Meal not found')

    const body = asObject(await readJsonBody(req))
    const input = readMealInput(body, { existing })
    const day = resolveDay(body, existing.day)
    const eatenAtRaw = alias(body, 'eatenAt', 'eaten_at')
    const eatenAt =
      typeof eatenAtRaw === 'string' && eatenAtRaw.trim() ? eatenAtRaw.trim() : existing.eaten_at

    db.prepare(
      `UPDATE meals SET eaten_at = ?, day = ?, name = ?, description = ?, kcal = ?, protein_g = ?, carbs_g = ?,
                        fat_g = ?, fiber_g = ?, source = ?, confidence = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`,
    ).run(
      eatenAt,
      day,
      input.name,
      input.description,
      input.kcal,
      input.proteinG,
      input.carbsG,
      input.fatG,
      input.fiberG,
      input.source,
      input.confidence,
      existing.id,
      user.id,
    )

    if (input.items !== undefined) replaceItems(db, existing.id, input.items)

    sendJson(res, 200, { ok: true, meal: findMeal(db, user.id, existing.id) })
  })

  router.delete('/api/meals/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM meals WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!existing) throw new HttpError(404, 'Meal not found')
    db.prepare('DELETE FROM meals WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })
}
