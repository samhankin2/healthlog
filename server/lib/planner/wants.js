/**
 * The want-to-make list (SPEC §6 "Meal planner", "Want to make"): a scratch
 * pad of lines typed like notes, each with how much we want it. A line is
 * linked to a meal when code is sure, or later in the background; until then
 * the words are the want. Cooking the meal ticks it off.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { findDish } from './meals.js'
import { cleanOptionIds } from './week.js'

export const LEVELS = [1, 2, 3] // some day | keen | really want
const MAX_BODY = 500
const MAX_OPEN = 200

const parseIds = (text) => {
  try {
    const v = JSON.parse(text ?? '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export function wantPayload(row) {
  return {
    id: row.id,
    text: row.body,
    level: row.level,
    dishId: row.dish_id ?? null,
    optionIds: parseIds(row.option_ids),
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    done: Boolean(row.done_at),
  }
}

export function cleanBody(value) {
  const text = String(value ?? '').replace(/\r/g, '').trim().slice(0, MAX_BODY)
  if (!text) throw new HttpError(400, 'Type what you want to make')
  return text
}

export function cleanLevel(value, fallback = 2) {
  if (value === undefined || value === null) return fallback
  if (!LEVELS.includes(value)) throw new HttpError(400, 'level must be 1 (some day), 2 (keen) or 3 (really want)')
  return value
}

export function wantRow(db, householdId, id) {
  const row = db.prepare('SELECT * FROM want_list WHERE id = ? AND household_id = ?').get(String(id), householdId)
  if (!row) throw new HttpError(404, 'Not on the want-to-make list')
  return row
}

/** Open lines in the order they were typed. */
export function wantsPayload(db, householdId) {
  return db
    .prepare('SELECT * FROM want_list WHERE household_id = ? AND done_at IS NULL ORDER BY position, created_at')
    .all(householdId)
    .map(wantPayload)
}

export function addWant(db, householdId, user, { text, level, dishId = null, optionIds = [] }) {
  const body = cleanBody(text)
  const lvl = cleanLevel(level)
  if (dishId) findDish(db, householdId, dishId)
  const options = dishId ? cleanOptionIds(db, dishId, optionIds) : []
  return withTx(db, () => {
    const open = db.prepare('SELECT COUNT(*) AS n, MAX(position) AS top FROM want_list WHERE household_id = ? AND done_at IS NULL').get(householdId)
    if (open.n >= MAX_OPEN) throw new HttpError(400, 'The list is full: tick some off first')
    const id = randomUUID()
    db.prepare(
      `INSERT INTO want_list (id, household_id, body, level, dish_id, option_ids, position, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, householdId, body, lvl, dishId || null, JSON.stringify(options), (open.top ?? -1) + 1, user.id)
    return wantPayload(wantRow(db, householdId, id))
  })
}

/**
 * Change a line. New words drop the old meal unless `dishId` comes with them
 * (the caller re-matches); `dishId` alone is "did you mean" / "not this".
 */
export function updateWant(db, householdId, id, patch) {
  const row = wantRow(db, householdId, id)
  const sets = []
  const values = []
  if (patch.text !== undefined) {
    const body = cleanBody(patch.text)
    sets.push('body = ?')
    values.push(body)
    if (body !== row.body && patch.dishId === undefined) sets.push("dish_id = NULL, option_ids = '[]'")
  }
  if (patch.level !== undefined) {
    sets.push('level = ?')
    values.push(cleanLevel(patch.level))
  }
  if (patch.dishId !== undefined) {
    const dishId = patch.dishId ? String(patch.dishId) : null
    if (dishId) findDish(db, householdId, dishId)
    sets.push('dish_id = ?', 'option_ids = ?')
    values.push(dishId, JSON.stringify(dishId ? cleanOptionIds(db, dishId, patch.optionIds ?? []) : []))
  }
  if (patch.done !== undefined) {
    sets.push(patch.done ? "done_at = COALESCE(done_at, datetime('now'))" : 'done_at = NULL')
  }
  if (sets.length) {
    db.prepare(`UPDATE want_list SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, row.id)
  }
  return wantPayload(wantRow(db, householdId, id))
}

export function removeWant(db, householdId, id) {
  const row = wantRow(db, householdId, id)
  db.prepare('DELETE FROM want_list WHERE id = ?').run(row.id)
  return row.id
}

/**
 * Cooked it: ticks off open lines for that meal. A line naming a variation is
 * ticked only when what we cooked includes it ("Dirty cabbage (Korean)" stays
 * after a Chinese one).
 */
export function tickOffCooked(db, householdId, dishId, cookedOptionIds) {
  const cooked = new Set(cookedOptionIds)
  const rows = db.prepare('SELECT id, option_ids FROM want_list WHERE household_id = ? AND dish_id = ? AND done_at IS NULL').all(householdId, dishId)
  const tick = db.prepare("UPDATE want_list SET done_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
  let n = 0
  for (const r of rows) {
    if (parseIds(r.option_ids).every((o) => cooked.has(o))) {
      tick.run(r.id)
      n++
    }
  }
  return n
}
