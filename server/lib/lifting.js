/**
 * Lifting — SPEC §6 "Lifting": vocabulary, the starter exercise library and
 * row → payload mappers. Analysis (e1RM, progression, load) is client-side in
 * src/lib/lifting.ts; the server only stores and validates.
 */
import { randomUUID } from 'node:crypto'
import { iso } from './shape.js'

export const MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'calves', 'core', 'other']
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'other']
export const SET_KINDS = ['working', 'warmup', 'drop', 'failure']

/** Seeded once for a user with an empty library, so the first session needs no setup. */
const STARTER = [
  ['Bench press', 'chest', 'barbell'],
  ['Incline bench press', 'chest', 'barbell'],
  ['Dumbbell bench press', 'chest', 'dumbbell'],
  ['Incline dumbbell press', 'chest', 'dumbbell'],
  ['Chest press', 'chest', 'machine'],
  ['Cable fly', 'chest', 'cable'],
  ['Push-up', 'chest', 'bodyweight'],
  ['Deadlift', 'back', 'barbell'],
  ['Barbell row', 'back', 'barbell'],
  ['Dumbbell row', 'back', 'dumbbell'],
  ['Pull-up', 'back', 'bodyweight'],
  ['Chin-up', 'back', 'bodyweight'],
  ['Lat pulldown', 'back', 'cable'],
  ['Seated cable row', 'back', 'cable'],
  ['Chest-supported row', 'back', 'machine'],
  ['Overhead press', 'shoulders', 'barbell'],
  ['Dumbbell shoulder press', 'shoulders', 'dumbbell'],
  ['Lateral raise', 'shoulders', 'dumbbell'],
  ['Cable lateral raise', 'shoulders', 'cable'],
  ['Rear delt fly', 'shoulders', 'dumbbell'],
  ['Face pull', 'shoulders', 'cable'],
  ['Barbell curl', 'biceps', 'barbell'],
  ['Dumbbell curl', 'biceps', 'dumbbell'],
  ['Hammer curl', 'biceps', 'dumbbell'],
  ['Cable curl', 'biceps', 'cable'],
  ['Preacher curl', 'biceps', 'machine'],
  ['Triceps pushdown', 'triceps', 'cable'],
  ['Overhead triceps extension', 'triceps', 'cable'],
  ['Skull crusher', 'triceps', 'barbell'],
  ['Close-grip bench press', 'triceps', 'barbell'],
  ['Dips', 'triceps', 'bodyweight'],
  ['Back squat', 'quads', 'barbell'],
  ['Front squat', 'quads', 'barbell'],
  ['Leg press', 'quads', 'machine'],
  ['Hack squat', 'quads', 'machine'],
  ['Leg extension', 'quads', 'machine'],
  ['Bulgarian split squat', 'quads', 'dumbbell'],
  ['Goblet squat', 'quads', 'dumbbell'],
  ['Walking lunge', 'quads', 'dumbbell'],
  ['Romanian deadlift', 'hamstrings', 'barbell'],
  ['Lying leg curl', 'hamstrings', 'machine'],
  ['Seated leg curl', 'hamstrings', 'machine'],
  ['Hip thrust', 'glutes', 'barbell'],
  ['Standing calf raise', 'calves', 'machine'],
  ['Seated calf raise', 'calves', 'machine'],
  ['Hanging leg raise', 'core', 'bodyweight'],
  ['Cable crunch', 'core', 'cable'],
  ['Ab wheel rollout', 'core', 'bodyweight'],
  ['Inverted row', 'back', 'bodyweight'],
  ['Incline dumbbell curl', 'biceps', 'dumbbell'],
]

/**
 * The routine every user starts with (seeded once; edit or delete it in the
 * app). Each entry: [name, muscle, equipment, alternatives as [name, muscle, equipment]].
 */
const DEFAULT_ROUTINE = {
  name: 'Upper body',
  items: [
    ['Incline dumbbell press', 'chest', 'dumbbell', [['Bench press', 'chest', 'barbell']]],
    ['Pull-up', 'back', 'bodyweight'],
    ['Inverted row', 'back', 'bodyweight'],
    ['Dumbbell shoulder press', 'shoulders', 'dumbbell'],
    ['Incline dumbbell curl', 'biceps', 'dumbbell'],
    ['Skull crusher', 'triceps', 'barbell'],
    ['Overhead triceps extension', 'triceps', 'cable'],
    ['Hanging leg raise', 'core', 'bodyweight'],
    ['Lateral raise', 'shoulders', 'dumbbell'],
  ],
}

/** The id of the user's exercise with this name, creating (or un-hiding) it. */
function exerciseIdByName(db, userId, [name, muscle, equipment]) {
  const row = db.prepare('SELECT id, archived_at FROM exercises WHERE user_id = ? AND name = ? COLLATE NOCASE').get(userId, name)
  if (row) {
    if (row.archived_at) db.prepare('UPDATE exercises SET archived_at = NULL WHERE id = ?').run(row.id)
    return row.id
  }
  const id = randomUUID()
  db.prepare('INSERT INTO exercises (id, user_id, name, muscle, equipment) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, muscle, equipment)
  return id
}

/** Seed the default routine for a user who has never had a routine (deleted ones count). */
export function ensureDefaultRoutine(db, userId) {
  if (db.prepare('SELECT 1 FROM routines WHERE user_id = ? LIMIT 1').get(userId)) return
  const items = DEFAULT_ROUTINE.items.map(([name, muscle, equipment, alts = []]) => ({
    exerciseId: exerciseIdByName(db, userId, [name, muscle, equipment]),
    alternatives: alts.map((a) => exerciseIdByName(db, userId, a)),
  }))
  db.prepare('INSERT INTO routines (id, user_id, name, items, position) VALUES (?, ?, ?, ?, 0)').run(randomUUID(), userId, DEFAULT_ROUTINE.name, JSON.stringify(items))
}

export function routinePayload(row) {
  let items = []
  try { items = JSON.parse(row.items) } catch { /* corrupt row: empty */ }
  return { id: row.id, name: row.name, items, position: Number(row.position), updatedAt: iso(row.updated_at) }
}

/** Seed the starter library for a user who has never had one. */
export function ensureStarterLibrary(db, userId) {
  const any = db.prepare('SELECT 1 FROM exercises WHERE user_id = ? LIMIT 1').get(userId)
  if (any) return
  const insert = db.prepare('INSERT OR IGNORE INTO exercises (id, user_id, name, muscle, equipment) VALUES (?, ?, ?, ?, ?)')
  for (const [name, muscle, equipment] of STARTER) insert.run(randomUUID(), userId, name, muscle, equipment)
}

const num = (v) => (v === null || v === undefined ? null : Number(v))

export function exercisePayload(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    muscle: row.muscle,
    equipment: row.equipment,
    incrementKg: num(row.increment_kg),
    repMin: num(row.rep_min),
    repMax: num(row.rep_max),
    archived: Boolean(row.archived_at),
    createdAt: iso(row.created_at),
  }
}

export function setPayload(row) {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    weightKg: Number(row.weight_kg),
    reps: Number(row.reps),
    rpe: num(row.rpe),
    kind: row.kind,
    doneAt: row.done_at ?? null,
  }
}

export function workoutPayload(row, sets = []) {
  if (!row) return null
  return {
    id: row.id,
    day: row.day,
    name: row.name ?? null,
    notes: row.notes ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    sets: sets.map(setPayload),
  }
}

/** Workouts for a user (optionally a day range), each with its sets in order. */
export function loadWorkouts(db, userId, { from = null, to = null, id = null } = {}) {
  const where = ['user_id = ?']
  const args = [userId]
  if (id) { where.push('id = ?'); args.push(id) }
  if (from) { where.push('day >= ?'); args.push(from) }
  if (to) { where.push('day <= ?'); args.push(to) }
  const rows = db.prepare(`SELECT * FROM workouts WHERE ${where.join(' AND ')} ORDER BY day ASC, started_at ASC, created_at ASC`).all(...args)
  if (rows.length === 0) return []
  const byWorkout = new Map(rows.map((r) => [r.id, []]))
  const sets = db
    .prepare(`SELECT s.* FROM workout_sets s JOIN workouts w ON w.id = s.workout_id WHERE ${where.map((c) => `w.${c}`).join(' AND ')} ORDER BY s.workout_id, s.position`)
    .all(...args)
  for (const s of sets) byWorkout.get(s.workout_id)?.push(s)
  return rows.map((r) => workoutPayload(r, byWorkout.get(r.id)))
}
