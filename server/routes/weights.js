/** Weight entry routes — SPEC §6 "Weights". */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, optionalNumber, optionalString } from '../lib/validate.js'
import { isISODate } from '../lib/metrics.js'
import { weightPayload } from '../lib/shape.js'

function readDate(value, field = 'date') {
  if (typeof value !== 'string' || !isISODate(value.trim())) {
    throw new HttpError(400, `${field} must be a calendar date (YYYY-MM-DD)`)
  }
  return value.trim()
}

function readWeight(value, field = 'weightKg') {
  const n = optionalNumber(value, field, { min: 0.1, max: 700 })
  if (n === undefined) throw new HttpError(400, `${field} is required`)
  return Math.round(n * 100) / 100
}

function findEntry(db, userId, id) {
  return db.prepare('SELECT * FROM weight_entries WHERE id = ? AND user_id = ?').get(id, userId) ?? null
}

export function registerWeightRoutes(router) {
  router.get('/api/weights', async ({ req, res, query }) => {
    const user = requireUser(req)
    const db = getDb()
    const from = query.get('from')
    const to = query.get('to')
    if (from && !isISODate(from)) throw new HttpError(400, 'from must be a calendar date (YYYY-MM-DD)')
    if (to && !isISODate(to)) throw new HttpError(400, 'to must be a calendar date (YYYY-MM-DD)')

    const clauses = ['user_id = ?']
    const params = [user.id]
    if (from) {
      clauses.push('date >= ?')
      params.push(from)
    }
    if (to) {
      clauses.push('date <= ?')
      params.push(to)
    }
    const rows = db
      .prepare(`SELECT * FROM weight_entries WHERE ${clauses.join(' AND ')} ORDER BY date ASC`)
      .all(...params)
    sendJson(res, 200, { ok: true, entries: rows.map(weightPayload) })
  })

  router.post('/api/weights', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const date = readDate(alias(body, 'date'))
    const weightKg = readWeight(alias(body, 'weightKg', 'weight_kg'))
    const note = optionalString(alias(body, 'note'), 'note', { max: 500 }) ?? null

    const db = getDb()
    const existing = db.prepare('SELECT id FROM weight_entries WHERE user_id = ? AND date = ?').get(user.id, date)
    const id = existing?.id ?? randomUUID()

    // Upsert on (user_id, date) — SPEC §6 "upsert on (user_id,date)".
    db.prepare(
      `INSERT INTO weight_entries (id, user_id, date, weight_kg, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         weight_kg = excluded.weight_kg,
         note = excluded.note,
         updated_at = datetime('now')`,
    ).run(id, user.id, date, weightKg, note)

    sendJson(res, 201, { ok: true, entry: weightPayload(findEntry(db, user.id, id)) })
  })

  router.put('/api/weights/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findEntry(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Weight entry not found')

    const body = asObject(await readJsonBody(req))
    const sets = []
    const values = []

    const date = alias(body, 'date')
    if (date !== undefined) {
      const nextDate = readDate(date)
      const clash = db
        .prepare('SELECT id FROM weight_entries WHERE user_id = ? AND date = ? AND id <> ?')
        .get(user.id, nextDate, existing.id)
      if (clash) throw new HttpError(409, 'You already have an entry for that date')
      sets.push('date = ?')
      values.push(nextDate)
    }

    const weightKg = alias(body, 'weightKg', 'weight_kg')
    if (weightKg !== undefined) {
      sets.push('weight_kg = ?')
      values.push(readWeight(weightKg))
    }

    const note = alias(body, 'note')
    if (note !== undefined) {
      sets.push('note = ?')
      values.push(optionalString(note, 'note', { max: 500 }) ?? null)
    }

    if (sets.length === 0) throw new HttpError(400, 'Nothing to update')
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE weight_entries SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(
      ...values,
      existing.id,
      user.id,
    )

    sendJson(res, 200, { ok: true, entry: weightPayload(findEntry(db, user.id, existing.id)) })
  })

  router.delete('/api/weights/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findEntry(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Weight entry not found')
    db.prepare('DELETE FROM weight_entries WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })
}
