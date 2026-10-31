/** Phase routes — SPEC §6 "Phases". */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, optionalString, requireString } from '../lib/validate.js'
import { isISODate } from '../lib/metrics.js'
import { phasePayload } from '../lib/shape.js'

const DEFAULT_COLOR = '#3b82f6'

function readDate(value, field) {
  if (typeof value !== 'string' || !isISODate(value.trim())) {
    throw new HttpError(400, `${field} must be a calendar date (YYYY-MM-DD)`)
  }
  return value.trim()
}

function readColor(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return DEFAULT_COLOR
  const s = String(value).trim()
  if (!/^#[0-9a-fA-F]{3,8}$/.test(s)) throw new HttpError(400, 'color must be a hex colour like #3b82f6')
  return s
}

function findPhase(db, userId, id) {
  return db.prepare('SELECT * FROM phases WHERE id = ? AND user_id = ?').get(id, userId) ?? null
}

export function registerPhaseRoutes(router) {
  router.get('/api/phases', async ({ req, res }) => {
    const user = requireUser(req)
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM phases WHERE user_id = ? ORDER BY start_date ASC, created_at ASC')
      .all(user.id)
    sendJson(res, 200, { ok: true, phases: rows.map(phasePayload) })
  })

  router.post('/api/phases', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const name = requireString(alias(body, 'name'), 'name', { max: 100 })
    const startDate = readDate(alias(body, 'startDate', 'start_date'), 'startDate')
    const rawEnd = alias(body, 'endDate', 'end_date')
    const endDate = rawEnd === undefined || rawEnd === null || rawEnd === '' ? null : readDate(rawEnd, 'endDate')
    if (endDate && endDate < startDate) throw new HttpError(400, 'endDate cannot be before startDate')
    const color = readColor(alias(body, 'color')) ?? DEFAULT_COLOR

    const db = getDb()
    const id = randomUUID()
    db.prepare('INSERT INTO phases (id, user_id, name, color, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      user.id,
      name,
      color,
      startDate,
      endDate,
    )
    sendJson(res, 201, { ok: true, phase: phasePayload(findPhase(db, user.id, id)) })
  })

  router.put('/api/phases/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findPhase(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Phase not found')

    const body = asObject(await readJsonBody(req))
    const sets = []
    const values = []

    const name = alias(body, 'name')
    if (name !== undefined) {
      sets.push('name = ?')
      values.push(requireString(name, 'name', { max: 100 }))
    }

    const color = readColor(alias(body, 'color'))
    if (color !== undefined) {
      sets.push('color = ?')
      values.push(color)
    }

    const startRaw = alias(body, 'startDate', 'start_date')
    let startDate = existing.start_date
    if (startRaw !== undefined) {
      startDate = readDate(startRaw, 'startDate')
      sets.push('start_date = ?')
      values.push(startDate)
    }

    const endRaw = alias(body, 'endDate', 'end_date')
    let endDate = existing.end_date
    if (endRaw !== undefined) {
      endDate = endRaw === null || endRaw === '' ? null : readDate(endRaw, 'endDate')
      sets.push('end_date = ?')
      values.push(endDate)
    }
    if (endDate && endDate < startDate) throw new HttpError(400, 'endDate cannot be before startDate')

    if (sets.length === 0) throw new HttpError(400, 'Nothing to update')
    db.prepare(`UPDATE phases SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, existing.id, user.id)
    sendJson(res, 200, { ok: true, phase: phasePayload(findPhase(db, user.id, existing.id)) })
  })

  router.delete('/api/phases/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findPhase(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Phase not found')
    db.prepare('DELETE FROM phases WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })
}
