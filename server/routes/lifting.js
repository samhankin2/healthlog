/** Lifting routes — SPEC §6 "Lifting". */
import { randomUUID } from 'node:crypto'
import { getDb, withTx, nowSql } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, optionalNumber, optionalString, requireNumber, requireString } from '../lib/validate.js'
import { isISODate } from '../lib/metrics.js'
import {
  EQUIPMENT, MUSCLES, SET_KINDS, ensureDefaultRoutine, ensureStarterLibrary, exercisePayload, loadWorkouts, routinePayload,
} from '../lib/lifting.js'

const MAX_SETS = 400
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/

function readId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new HttpError(400, `${field} must be an id of 8-64 letters, digits, - or _`)
  return value
}

function readEnum(value, field, allowed, fallback) {
  if (value === undefined) return fallback
  const s = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!allowed.includes(s)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`)
  return s
}

/** An ISO timestamp from the client's clock, normalised; null/'' clears it. */
function readTimestamp(value, field) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const t = typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN
  if (!Number.isFinite(t)) throw new HttpError(400, `${field} must be an ISO timestamp`)
  return new Date(t).toISOString()
}

function findExercise(db, userId, id) {
  return db.prepare('SELECT * FROM exercises WHERE id = ? AND user_id = ?').get(id, userId) ?? null
}

/** Rep range from a body: both set (1–50, max ≥ min) or both null. undefined = not sent. */
function readRepRange(body, existing = null) {
  const min = optionalNumber(alias(body, 'repMin', 'rep_min'), 'repMin', { min: 1, max: 50, nullable: true, integer: true })
  const max = optionalNumber(alias(body, 'repMax', 'rep_max'), 'repMax', { min: 1, max: 50, nullable: true, integer: true })
  if (min === undefined && max === undefined) return undefined
  const lo = min === undefined ? existing?.rep_min ?? null : min
  const hi = max === undefined ? existing?.rep_max ?? null : max
  if ((lo === null) !== (hi === null)) throw new HttpError(400, 'Set both repMin and repMax, or neither')
  if (lo !== null && hi < lo) throw new HttpError(400, 'repMax must be at least repMin')
  return { lo, hi }
}

export function registerLiftingRoutes(router) {
  // Everything the Lifting tab needs in one payload: a few thousand sets a year
  // is small, and the analysis runs on the device.
  router.get('/api/lifting', async ({ req, res, query }) => {
    const user = requireUser(req)
    const from = query.get('from')
    const to = query.get('to')
    if ((from && !isISODate(from)) || (to && !isISODate(to))) throw new HttpError(400, 'from and to must be calendar dates (YYYY-MM-DD)')
    const db = getDb()
    withTx(db, () => {
      ensureStarterLibrary(db, user.id)
      ensureDefaultRoutine(db, user.id)
    })
    const exercises = db.prepare('SELECT * FROM exercises WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(user.id)
    const routines = db.prepare('SELECT * FROM routines WHERE user_id = ? AND deleted_at IS NULL ORDER BY position, created_at').all(user.id)
    sendJson(res, 200, { ok: true, exercises: exercises.map(exercisePayload), workouts: loadWorkouts(db, user.id, { from, to }), routines: routines.map(routinePayload) })
  })

  /* ---------------- exercises ---------------- */

  // Idempotent: a known id returns the stored row; a name that already exists
  // (case-insensitive) returns that exercise — un-archived — so a phone that
  // created one offline can map its local id onto it.
  router.post('/api/lifting/exercises', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const id = body.id === undefined ? randomUUID() : readId(body.id, 'id')
    const name = requireString(alias(body, 'name'), 'name', { max: 80 })
    const muscle = readEnum(alias(body, 'muscle'), 'muscle', MUSCLES, 'other')
    const equipment = readEnum(alias(body, 'equipment'), 'equipment', EQUIPMENT, 'barbell')
    const incrementKg = optionalNumber(alias(body, 'incrementKg', 'increment_kg'), 'incrementKg', { min: 0.25, max: 50, nullable: true }) ?? null
    const repRange = readRepRange(body) ?? { lo: null, hi: null }

    const db = getDb()
    const byId = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id)
    if (byId) {
      if (byId.user_id !== user.id) throw new HttpError(409, 'That id is already taken')
      sendJson(res, 200, { ok: true, exercise: exercisePayload(byId) })
      return
    }
    const byName = db.prepare('SELECT * FROM exercises WHERE user_id = ? AND name = ? COLLATE NOCASE').get(user.id, name)
    if (byName) {
      if (byName.archived_at) db.prepare('UPDATE exercises SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowSql(), byName.id)
      sendJson(res, 200, { ok: true, exercise: exercisePayload(findExercise(db, user.id, byName.id)) })
      return
    }
    db.prepare('INSERT INTO exercises (id, user_id, name, muscle, equipment, increment_kg, rep_min, rep_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, user.id, name, muscle, equipment, incrementKg, repRange.lo, repRange.hi)
    sendJson(res, 201, { ok: true, exercise: exercisePayload(findExercise(db, user.id, id)) })
  })

  router.put('/api/lifting/exercises/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findExercise(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Exercise not found')
    const body = asObject(await readJsonBody(req))
    const sets = []
    const values = []
    if (body.name !== undefined) {
      const name = requireString(body.name, 'name', { max: 80 })
      const clash = db.prepare('SELECT id FROM exercises WHERE user_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(user.id, name, existing.id)
      if (clash) throw new HttpError(409, 'You already have an exercise with that name')
      sets.push('name = ?'); values.push(name)
    }
    if (body.muscle !== undefined) { sets.push('muscle = ?'); values.push(readEnum(body.muscle, 'muscle', MUSCLES)) }
    if (body.equipment !== undefined) { sets.push('equipment = ?'); values.push(readEnum(body.equipment, 'equipment', EQUIPMENT)) }
    const inc = optionalNumber(alias(body, 'incrementKg', 'increment_kg'), 'incrementKg', { min: 0.25, max: 50, nullable: true })
    if (inc !== undefined) { sets.push('increment_kg = ?'); values.push(inc) }
    const repRange = readRepRange(body, existing)
    if (repRange !== undefined) { sets.push('rep_min = ?', 'rep_max = ?'); values.push(repRange.lo, repRange.hi) }
    if (body.archived !== undefined) { sets.push('archived_at = ?'); values.push(body.archived ? nowSql() : null) }
    if (sets.length === 0) throw new HttpError(400, 'Nothing to update')
    sets.push('updated_at = ?'); values.push(nowSql())
    db.prepare(`UPDATE exercises SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, existing.id, user.id)
    sendJson(res, 200, { ok: true, exercise: exercisePayload(findExercise(db, user.id, existing.id)) })
  })

  // An exercise with logged sets is archived (its history stays); an unused one is deleted.
  router.delete('/api/lifting/exercises/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = findExercise(db, user.id, params.id)
    if (!existing) throw new HttpError(404, 'Exercise not found')
    const used = db.prepare('SELECT 1 FROM workout_sets WHERE exercise_id = ? LIMIT 1').get(existing.id)
    if (used) {
      db.prepare('UPDATE exercises SET archived_at = ?, updated_at = ? WHERE id = ?').run(nowSql(), nowSql(), existing.id)
      sendJson(res, 200, { ok: true, archived: existing.id })
      return
    }
    db.prepare('DELETE FROM exercises WHERE id = ? AND user_id = ?').run(existing.id, user.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })

  /* ---------------- workouts ---------------- */

  router.get('/api/lifting/workouts/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const [workout] = loadWorkouts(getDb(), user.id, { id: params.id })
    if (!workout) throw new HttpError(404, 'Workout not found')
    sendJson(res, 200, { ok: true, workout })
  })

  // Upsert the whole workout, sets included (replace-all). The phone saves after
  // every logged set and retries until it lands, so this must be idempotent.
  router.put('/api/lifting/workouts/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const id = readId(params.id, 'id')
    const body = asObject(await readJsonBody(req))
    const day = alias(body, 'day')
    if (typeof day !== 'string' || !isISODate(day)) throw new HttpError(400, 'day must be a calendar date (YYYY-MM-DD)')
    const name = optionalString(alias(body, 'name'), 'name', { max: 80 }) ?? null
    const notes = optionalString(alias(body, 'notes'), 'notes', { max: 2000 }) ?? null
    const startedAt = readTimestamp(alias(body, 'startedAt', 'started_at'), 'startedAt') ?? null
    const endedAt = readTimestamp(alias(body, 'endedAt', 'ended_at'), 'endedAt') ?? null
    const rawSets = body.sets ?? []
    if (!Array.isArray(rawSets)) throw new HttpError(400, 'sets must be a list')
    if (rawSets.length > MAX_SETS) throw new HttpError(400, `A workout can hold at most ${MAX_SETS} sets`)

    const db = getDb()
    const owner = db.prepare('SELECT user_id FROM workouts WHERE id = ?').get(id)
    if (owner && owner.user_id !== user.id) throw new HttpError(404, 'Workout not found')

    const exerciseIds = new Set(db.prepare('SELECT id FROM exercises WHERE user_id = ?').all(user.id).map((r) => r.id))
    const seen = new Set()
    const sets = rawSets.map((raw, i) => {
      const s = asObject(raw)
      const setId = readId(s.id, `sets[${i}].id`)
      if (seen.has(setId)) throw new HttpError(400, `sets[${i}].id is repeated`)
      seen.add(setId)
      const exerciseId = alias(s, 'exerciseId', 'exercise_id')
      if (typeof exerciseId !== 'string' || !exerciseIds.has(exerciseId)) throw new HttpError(400, `sets[${i}].exerciseId is not one of your exercises`)
      return {
        id: setId,
        exerciseId,
        weightKg: requireNumber(alias(s, 'weightKg', 'weight_kg') ?? 0, `sets[${i}].weightKg`, { min: 0, max: 1000 }),
        reps: requireNumber(s.reps, `sets[${i}].reps`, { min: 0, max: 200, integer: true }),
        rpe: optionalNumber(s.rpe, `sets[${i}].rpe`, { min: 1, max: 10, nullable: true }) ?? null,
        kind: readEnum(s.kind, `sets[${i}].kind`, SET_KINDS, 'working'),
        doneAt: readTimestamp(alias(s, 'doneAt', 'done_at'), `sets[${i}].doneAt`) ?? null,
      }
    })

    const status = owner ? 200 : 201
    withTx(db, () => {
      if (owner) {
        db.prepare('UPDATE workouts SET day = ?, name = ?, notes = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?').run(day, name, notes, startedAt, endedAt, nowSql(), id)
        db.prepare('DELETE FROM workout_sets WHERE workout_id = ?').run(id)
      } else {
        db.prepare('INSERT INTO workouts (id, user_id, day, name, notes, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, user.id, day, name, notes, startedAt, endedAt)
      }
      const clash = db.prepare('SELECT workout_id FROM workout_sets WHERE id = ?')
      const insert = db.prepare('INSERT INTO workout_sets (id, workout_id, exercise_id, position, weight_kg, reps, rpe, kind, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      sets.forEach((s, position) => {
        if (clash.get(s.id)) throw new HttpError(409, `Set id ${s.id} belongs to another workout`)
        insert.run(s.id, id, s.exerciseId, position, s.weightKg, s.reps, s.rpe, s.kind, s.doneAt)
      })
    })
    const [workout] = loadWorkouts(db, user.id, { id })
    sendJson(res, status, { ok: true, workout })
  })

  router.delete('/api/lifting/workouts/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM workouts WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!existing) throw new HttpError(404, 'Workout not found')
    db.prepare('DELETE FROM workouts WHERE id = ?').run(existing.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })

  /* ---------------- routines ---------------- */

  // Replace-all upsert with a client id, like workouts.
  router.put('/api/lifting/routines/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const id = readId(params.id, 'id')
    const body = asObject(await readJsonBody(req))
    const name = requireString(alias(body, 'name'), 'name', { max: 60 })
    const position = optionalNumber(alias(body, 'position'), 'position', { min: 0, max: 1000, integer: true }) ?? 0
    if (!Array.isArray(body.items)) throw new HttpError(400, 'items must be a list')
    if (body.items.length > 40) throw new HttpError(400, 'A routine can have at most 40 exercises')
    const db = getDb()
    const owned = new Set(db.prepare('SELECT id FROM exercises WHERE user_id = ?').all(user.id).map((r) => r.id))
    const mine = (v, field) => {
      if (typeof v !== 'string' || !owned.has(v)) throw new HttpError(400, `${field} is not one of your exercises`)
      return v
    }
    const items = body.items.map((raw, i) => {
      const item = asObject(raw)
      const alts = item.alternatives === undefined ? [] : item.alternatives
      if (!Array.isArray(alts) || alts.length > 5) throw new HttpError(400, `items[${i}].alternatives must be a list of up to 5`)
      return { exerciseId: mine(item.exerciseId, `items[${i}].exerciseId`), alternatives: [...new Set(alts.map((a, j) => mine(a, `items[${i}].alternatives[${j}]`)))] }
    })
    const existing = db.prepare('SELECT user_id FROM routines WHERE id = ?').get(id)
    if (existing && existing.user_id !== user.id) throw new HttpError(404, 'Routine not found')
    if (existing) db.prepare('UPDATE routines SET name = ?, items = ?, position = ?, deleted_at = NULL, updated_at = ? WHERE id = ?').run(name, JSON.stringify(items), position, nowSql(), id)
    else db.prepare('INSERT INTO routines (id, user_id, name, items, position) VALUES (?, ?, ?, ?, ?)').run(id, user.id, name, JSON.stringify(items), position)
    sendJson(res, existing ? 200 : 201, { ok: true, routine: routinePayload(db.prepare('SELECT * FROM routines WHERE id = ?').get(id)) })
  })

  router.delete('/api/lifting/routines/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM routines WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(params.id, user.id)
    if (!existing) throw new HttpError(404, 'Routine not found')
    db.prepare('UPDATE routines SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowSql(), nowSql(), existing.id)
    sendJson(res, 200, { ok: true, deleted: existing.id })
  })
}
