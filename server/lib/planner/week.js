/**
 * The weekly plan: one dinner slot per date (SPEC §6 "Meal planner").
 * App entries have a date; imported history does not, so it never shows here.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { findDish } from './meals.js'

export const SLOT = 'dinner'
export const NIGHT_KINDS = ['dish', 'freezer', 'out', 'leftovers', 'takeaway']

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Validate a YYYY-MM-DD calendar date (UTC arithmetic: no time zones involved). */
export function requireDay(value, field = 'date') {
  const s = String(value ?? '')
  const d = new Date(`${s}T00:00:00Z`)
  if (!DAY_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new HttpError(400, `${field} must be a date like 2026-11-23`)
  }
  return s
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(day) {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

export function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

export function entryPayload(db, row) {
  const optionIds = db.prepare('SELECT option_id FROM plan_entry_options WHERE plan_entry_id = ? ORDER BY option_id').all(row.id).map((r) => r.option_id)
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    kind: row.kind,
    status: row.status,
    dishId: row.dish_id ?? null,
    optionIds,
    note: row.note ?? null,
    raw: row.raw ?? null,
    freezerItemId: row.freezer_item_id ?? null,
    cookNote: row.cook_note ?? null,
    leftovers: Boolean(row.leftovers),
    frozenPortions: row.frozen_portions ?? 0,
    tweakRetry: Boolean(row.tweak_retry),
    reviewedAt: row.reviewed_at ?? null,
    updatedAt: row.updated_at ?? row.created_at,
  }
}

export function weekPayload(db, householdId, start) {
  const end = addDays(start, 6)
  const rows = db
    .prepare('SELECT * FROM plan_entries WHERE household_id = ? AND slot = ? AND date BETWEEN ? AND ? ORDER BY date')
    .all(householdId, SLOT, start, end)
  return { start, end, entries: rows.map((r) => entryPayload(db, r)) }
}

function slotRow(db, householdId, date) {
  return db.prepare('SELECT * FROM plan_entries WHERE household_id = ? AND slot = ? AND date = ?').get(householdId, SLOT, date)
}

/** Options for a night: must belong to the dish, at most one per axis. */
function cleanOptionIds(db, dishId, optionIds) {
  if (!Array.isArray(optionIds) || optionIds.length === 0) return []
  const axes = new Set()
  const out = []
  for (const id of new Set(optionIds.map(String))) {
    const o = db.prepare('SELECT axis FROM dish_options WHERE id = ? AND dish_id = ?').get(id, dishId)
    if (!o) throw new HttpError(400, 'An option does not belong to that meal')
    if (axes.has(o.axis)) throw new HttpError(400, 'Pick one option per axis')
    axes.add(o.axis)
    out.push(id)
  }
  return out
}

/** A freezer night whose portion was taken off gives it back (the night changed or went). */
export function releaseFreezer(db, row) {
  if (row.freezer_item_id && row.freezer_consumed) {
    db.prepare("UPDATE freezer_items SET portions_left = portions_left + 1, updated_at = datetime('now') WHERE id = ?").run(row.freezer_item_id)
  }
}

/** Set (create or replace) one night. */
export function setSlot(db, householdId, date, { kind = 'dish', dishId = null, optionIds = [], note = null, raw = null, freezerItemId = null }) {
  requireDay(date)
  if (!NIGHT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${NIGHT_KINDS.join(', ')}`)
  if (kind === 'freezer') {
    // A freezer night eats the dish that was frozen, in the variation it was frozen as.
    const item = db.prepare('SELECT * FROM freezer_items WHERE id = ? AND household_id = ?').get(String(freezerItemId ?? ''), householdId)
    if (!item) throw new HttpError(404, "That isn't in the freezer")
    dishId = item.dish_id
    optionIds = JSON.parse(item.option_ids || '[]')
  } else {
    freezerItemId = null
  }
  const rawText = raw === null || raw === undefined ? null : String(raw).trim().slice(0, 200) || null
  // Typed like a note, not matched to a meal yet: the words are the plan.
  const unmatched = kind === 'dish' && !dishId && Boolean(rawText)
  if ((kind === 'dish' && !unmatched) || kind === 'freezer') {
    if (typeof dishId !== 'string' || !dishId) throw new HttpError(400, 'dishId (or the words, as raw) is required for a meal night')
    findDish(db, householdId, dishId)
  }
  const hasMeal = (kind === 'dish' || kind === 'freezer') && !unmatched
  const options = hasMeal ? cleanOptionIds(db, dishId, optionIds) : []
  const noteText = note === null || note === undefined ? null : String(note).trim().slice(0, 500) || null

  return withTx(db, () => {
    const existing = slotRow(db, householdId, date)
    let id = existing?.id
    if (existing) {
      // A new plan for the night starts its review over (a portion already eaten goes back).
      releaseFreezer(db, existing)
      db.prepare(
        `UPDATE plan_entries SET kind = ?, dish_id = ?, note = ?, raw = COALESCE(?, raw), status = 'planned', freezer_item_id = ?,
           freezer_consumed = 0, reviewed_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(kind, hasMeal ? dishId : null, noteText, rawText, freezerItemId, id)
      db.prepare('DELETE FROM plan_entry_options WHERE plan_entry_id = ?').run(id)
      db.prepare('DELETE FROM reviews WHERE plan_entry_id = ?').run(id)
    } else {
      id = randomUUID()
      db.prepare(
        `INSERT INTO plan_entries (id, household_id, date, slot, dish_id, kind, status, source, raw, note, freezer_item_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'planned', 'app', ?, ?, ?, datetime('now'))`,
      ).run(id, householdId, date, SLOT, hasMeal ? dishId : null, kind, rawText, noteText, freezerItemId)
    }
    const link = db.prepare('INSERT INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)')
    for (const o of options) link.run(id, o)
    return entryPayload(db, db.prepare('SELECT * FROM plan_entries WHERE id = ?').get(id))
  })
}

export function clearSlot(db, householdId, date) {
  requireDay(date)
  const existing = slotRow(db, householdId, date)
  if (existing) releaseFreezer(db, existing)
  db.prepare('DELETE FROM plan_entries WHERE household_id = ? AND slot = ? AND date = ?').run(householdId, SLOT, date)
}

/**
 * Move a night to another date (drag and drop). Onto an empty night it moves;
 * onto a planned night the two swap. The entries themselves move, so options,
 * notes, reviews and freezer links go with them.
 */
export function moveSlot(db, householdId, from, to) {
  requireDay(from, 'from')
  requireDay(to, 'to')
  if (from === to) return { moved: 0 }
  return withTx(db, () => {
    const a = slotRow(db, householdId, from)
    const b = slotRow(db, householdId, to)
    if (!a && !b) return { moved: 0 }
    const setDate = db.prepare("UPDATE plan_entries SET date = ?, updated_at = datetime('now') WHERE id = ?")
    // A parking date first: (household, date, slot) is unique.
    if (a) setDate.run('0001-01-01', a.id)
    if (b) setDate.run(from, b.id)
    if (a) setDate.run(to, a.id)
    return { moved: (a ? 1 : 0) + (b ? 1 : 0), swapped: Boolean(a && b) }
  })
}

/**
 * Link a typed night to a meal (or unlink it with dishId null), keeping the
 * words, note and status as they are.
 */
export function linkSlot(db, householdId, date, dishId, optionIds = []) {
  requireDay(date)
  const row = slotRow(db, householdId, date)
  if (!row || row.kind !== 'dish') throw new HttpError(404, 'No meal night to match on that date')
  if (dishId) findDish(db, householdId, dishId)
  const options = dishId ? cleanOptionIds(db, dishId, optionIds) : []
  return withTx(db, () => {
    db.prepare("UPDATE plan_entries SET dish_id = ?, updated_at = datetime('now') WHERE id = ?").run(dishId || null, row.id)
    db.prepare('DELETE FROM plan_entry_options WHERE plan_entry_id = ?').run(row.id)
    const link = db.prepare('INSERT INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)')
    for (const o of options) link.run(row.id, o)
    return entryPayload(db, db.prepare('SELECT * FROM plan_entries WHERE id = ?').get(row.id))
  })
}

/** Copy a week's nights into another week's empty nights (never overwrites). */
export function copyWeek(db, householdId, from, to) {
  requireDay(from, 'from')
  requireDay(to, 'to')
  let copied = 0
  withTx(db, () => {
    const source = weekPayload(db, householdId, from).entries
    for (const e of source) {
      const offset = Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
      const date = addDays(to, offset)
      if (slotRow(db, householdId, date)) continue
      const id = randomUUID()
      db.prepare(
        `INSERT INTO plan_entries (id, household_id, date, slot, dish_id, kind, status, source, raw, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'planned', 'app', ?, ?, datetime('now'))`,
      ).run(id, householdId, date, SLOT, e.dishId, e.kind === 'freezer' ? 'dish' : e.kind, e.raw, e.note)
      for (const o of e.optionIds) db.prepare('INSERT INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)').run(id, o)
      copied++
    }
  })
  return copied
}
