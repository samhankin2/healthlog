/** Saved-foods routes — SPEC §6 "Meals and foods". */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, optionalNumber, optionalString, requireString } from '../lib/validate.js'
import { foodPayload } from '../lib/shape.js'

function macro(value, field) {
  const n = optionalNumber(value, field, { min: 0, max: 100000 })
  return n === undefined ? 0 : n
}

export function registerFoodRoutes(router) {
  router.get('/api/foods', async ({ req, res }) => {
    const user = requireUser(req)
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM foods WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC')
      .all(user.id)
    sendJson(res, 200, { ok: true, foods: rows.map(foodPayload) })
  })

  router.post('/api/foods', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const name = requireString(alias(body, 'name'), 'name', { max: 200 })
    const serving = optionalString(alias(body, 'serving'), 'serving', { max: 100 }) ?? null
    const kcal = macro(alias(body, 'kcal'), 'kcal')
    const proteinG = macro(alias(body, 'proteinG', 'protein_g'), 'proteinG')
    const carbsG = macro(alias(body, 'carbsG', 'carbs_g'), 'carbsG')
    const fatG = macro(alias(body, 'fatG', 'fat_g'), 'fatG')

    const db = getDb()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO foods (id, user_id, name, serving, kcal, protein_g, carbs_g, fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, user.id, name, serving, kcal, proteinG, carbsG, fatG)

    const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(id)
    sendJson(res, 201, { ok: true, food: foodPayload(row) })
  })

  router.delete('/api/foods/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM foods WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!existing) throw new HttpError(404, 'Food not found')
    db.prepare('DELETE FROM foods WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })
}
