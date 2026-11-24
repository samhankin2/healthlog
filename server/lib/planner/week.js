/**
 * The weekly plan: one dinner slot per date (SPEC §6 "Meal planner").
 * App entries have a date; imported history does not, so it never shows here.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { findDish } from './meals.js'

export const SLOT = 'dinner'
export const NIGHT_KINDS = ['dish', 'out', 'leftovers', 'takeaway']

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

function entryPayload(db, row) {
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

/** Set (create or replace) one night. */
export function setSlot(db, householdId, date, { kind = 'dish', dishId = null, optionIds = [], note = null, raw = null }) {
  requireDay(date)
  if (!NIGHT_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${NIGHT_KINDS.join(', ')}`)
  if (kind === 'dish') {
    if (typeof dishId !== 'string' || !dishId) throw new HttpError(400, 'dishId is required for a meal night')
    findDish(db, householdId, dishId)
  }
  const options = kind === 'dish' ? cleanOptionIds(db, dishId, optionIds) : []
  const noteText = note === null || note === undefined ? null : String(note).trim().slice(0, 500) || null
  const rawText = raw === null || raw === undefined ? null : String(raw).trim().slice(0, 200) || null

  return withTx(db, () => {
    const existing = slotRow(db, householdId, date)
    let id = existing?.id
    if (existing) {
      db.prepare(
        `UPDATE plan_entries SET kind = ?, dish_id = ?, note = ?, raw = COALESCE(?, raw), status = 'planned', updated_at = datetime('now') WHERE id = ?`,
      ).run(kind, kind === 'dish' ? dishId : null, noteText, rawText, id)
      db.prepare('DELETE FROM plan_entry_options WHERE plan_entry_id = ?').run(id)
    } else {
      id = randomUUID()
      db.prepare(
        `INSERT INTO plan_entries (id, household_id, date, slot, dish_id, kind, status, source, raw, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'planned', 'app', ?, ?, datetime('now'))`,
      ).run(id, householdId, date, SLOT, kind === 'dish' ? dishId : null, kind, rawText, noteText)
    }
    const link = db.prepare('INSERT INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)')
    for (const o of options) link.run(id, o)
    return entryPayload(db, db.prepare('SELECT * FROM plan_entries WHERE id = ?').get(id))
  })
}

export function clearSlot(db, householdId, date) {
  requireDay(date)
  db.prepare('DELETE FROM plan_entries WHERE household_id = ? AND slot = ? AND date = ?').run(householdId, SLOT, date)
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
      ).run(id, householdId, date, SLOT, e.dishId, e.kind, e.raw, e.note)
      for (const o of e.optionIds) db.prepare('INSERT INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)').run(id, o)
      copied++
    }
  })
  return copied
}
