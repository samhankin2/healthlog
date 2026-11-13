/** Meal routes — SPEC §6 "Meals and foods". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, clampInt, optionalNumber, optionalString, requireString } from '../lib/validate.js'
import { isISODate, today } from '../lib/metrics.js'
import { findMeal, insertMeal, listMeals, replaceItems, totalsFromItems, normaliseItems } from '../lib/meals.js'

const SOURCES = ['ai', 'manual', 'import', 'saved_food', 'cronometer']

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

    // A meal saved from a chat reply ("Save meal" after "Ask again") carries the
    // analysis it came from. The link is what lets the chat show it as saved,
    // and it makes the save idempotent: a double tap returns the same meal.
    // One analysis can describe several meals (a dish and a coffee), saved as
    // parts 0..n-1 in order; part k is "already saved" only when the analysis
    // has more than k meals, so the second part is inserted, not deduped.
    const analysisRaw = alias(body, 'analysisId', 'analysis_id')
    let analysisId = null
    if (analysisRaw !== undefined && analysisRaw !== null) {
      analysisId = requireString(analysisRaw, 'analysisId', { max: 64 })
      const owned = db.prepare('SELECT id FROM analyses WHERE id = ? AND user_id = ?').get(analysisId, user.id)
      if (!owned) throw new HttpError(400, 'analysisId does not match one of your analyses')
      const partRaw = alias(body, 'analysisPart', 'analysis_part')
      const part = partRaw === undefined || partRaw === null ? 0 : Number(partRaw)
      if (!Number.isInteger(part) || part < 0 || part > 50) {
        throw new HttpError(400, 'analysisPart must be a whole number from 0 to 50')
      }
      const already = db
        .prepare('SELECT id FROM meals WHERE analysis_id = ? AND user_id = ? ORDER BY eaten_at, created_at LIMIT 1 OFFSET ?')
        .get(analysisId, user.id, part)
      if (already) {
        sendJson(res, 200, { ok: true, meal: findMeal(db, user.id, already.id) })
        return
      }
    }

    const id = insertMeal(db, user.id, { ...input, day, eatenAt, analysisId })
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
