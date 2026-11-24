/**
 * The weekly review (M3) and freezer stock — SPEC §6 "Meal planner".
 *
 * A past night is reviewed once: cooked / skipped (or swapped for what we made
 * instead), an opinion per person (`reviews`), and facts about the cook on the
 * plan entry (note, covered lunch, portions frozen, tweak and retry). Freezer
 * stock only changes here and on the freezer page.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { comboKey, findDish } from './meals.js'
import { addDays, entryPayload, releaseFreezer, requireDay } from './week.js'

export const REVIEW_WINDOW_DAYS = 14

function entryRow(db, householdId, id) {
  const row = db.prepare('SELECT * FROM plan_entries WHERE id = ? AND household_id = ?').get(id, householdId)
  if (!row) throw new HttpError(404, 'That night was not found')
  return row
}

function reviewsFor(db, entryId) {
  return db
    .prepare('SELECT rated_as, thumbs, stars FROM reviews WHERE plan_entry_id = ? ORDER BY rated_as')
    .all(entryId)
    .map((r) => ({ ratedAs: r.rated_as, thumbs: r.thumbs ?? null, stars: r.stars ?? null }))
}

function withReviews(db, row) {
  return { ...entryPayload(db, row), reviews: reviewsFor(db, row.id) }
}

/**
 * Nights to review: meals planned for a date before `today` (the client's
 * local date), within the last two weeks, not reviewed yet. Oldest first.
 */
export function reviewQueue(db, householdId, today) {
  requireDay(today, 'today')
  const rows = db
    .prepare(
      `SELECT * FROM plan_entries
        WHERE household_id = ? AND date IS NOT NULL AND date < ? AND date >= ?
          AND kind IN ('dish', 'freezer') AND status = 'planned'
        ORDER BY date`,
    )
    .all(householdId, today, addDays(today, -REVIEW_WINDOW_DAYS))
  return rows.map((r) => withReviews(db, r))
}

const STATUSES = ['planned', 'cooked', 'skipped']

/** Move a freezer item's stock for this cook to `portions` (0 removes stock that's untouched). */
function syncFrozen(db, householdId, row, portions) {
  const item = db.prepare('SELECT * FROM freezer_items WHERE source_entry_id = ?').get(row.id)
  const before = row.frozen_portions ?? 0
  if (item) {
    const left = Math.max(0, item.portions_left + (portions - before))
    if (portions === 0 && item.portions_left === before) db.prepare('DELETE FROM freezer_items WHERE id = ?').run(item.id)
    else db.prepare("UPDATE freezer_items SET portions_left = ?, updated_at = datetime('now') WHERE id = ?").run(left, item.id)
  } else if (portions > 0) {
    const options = db.prepare('SELECT option_id FROM plan_entry_options WHERE plan_entry_id = ? ORDER BY option_id').all(row.id).map((r) => r.option_id)
    db.prepare(
      `INSERT INTO freezer_items (id, household_id, dish_id, option_ids, portions_left, frozen_on, source_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), householdId, row.dish_id, JSON.stringify(options), portions, row.date, row.id)
  }
}

/**
 * Review facts about one night. Fields given change; the rest stay.
 * - status cooked | skipped | planned (undo). A freezer night marked cooked
 *   takes one portion off; anything else gives it back.
 * - swapToDishId (+ swapOptionIds): we made something else; the night becomes that.
 * - cookNote, leftovers, frozenPortions (0–20, fills freezer stock), tweakRetry.
 */
export function updateEntry(db, householdId, id, patch) {
  return withTx(db, () => {
    let row = entryRow(db, householdId, id)
    if (patch.swapToDishId !== undefined) {
      findDish(db, householdId, patch.swapToDishId)
      releaseFreezer(db, row)
      const options = Array.isArray(patch.swapOptionIds) ? patch.swapOptionIds.map(String) : []
      for (const o of options) {
        if (!db.prepare('SELECT 1 FROM dish_options WHERE id = ? AND dish_id = ?').get(o, patch.swapToDishId)) throw new HttpError(400, 'An option does not belong to that meal')
      }
      const was = db.prepare('SELECT name FROM dishes WHERE id = ?').get(row.dish_id)?.name ?? row.raw ?? 'something else'
      db.prepare(
        `UPDATE plan_entries SET kind = 'dish', dish_id = ?, freezer_item_id = NULL, freezer_consumed = 0, status = 'cooked',
           note = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      ).run(patch.swapToDishId, `Planned: ${was}`, id)
      db.prepare('DELETE FROM plan_entry_options WHERE plan_entry_id = ?').run(id)
      db.prepare('DELETE FROM reviews WHERE plan_entry_id = ?').run(id)
      for (const o of options) db.prepare('INSERT OR IGNORE INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)').run(id, o)
      row = entryRow(db, householdId, id)
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`)
      if (row.kind !== 'dish' && row.kind !== 'freezer') throw new HttpError(400, 'Only meal nights are reviewed')
      if (row.kind === 'freezer' && row.freezer_item_id) {
        if (patch.status === 'cooked' && !row.freezer_consumed) {
          db.prepare("UPDATE freezer_items SET portions_left = MAX(portions_left - 1, 0), updated_at = datetime('now') WHERE id = ?").run(row.freezer_item_id)
          db.prepare('UPDATE plan_entries SET freezer_consumed = 1 WHERE id = ?').run(id)
        } else if (patch.status !== 'cooked') {
          releaseFreezer(db, row)
          db.prepare('UPDATE plan_entries SET freezer_consumed = 0 WHERE id = ?').run(id)
        }
      }
      db.prepare(
        `UPDATE plan_entries SET status = ?, reviewed_at = CASE WHEN ? = 'planned' THEN NULL ELSE datetime('now') END,
           updated_at = datetime('now') WHERE id = ?`,
      ).run(patch.status, patch.status, id)
      row = entryRow(db, householdId, id)
    }
    if (patch.frozenPortions !== undefined) {
      const n = patch.frozenPortions
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new HttpError(400, 'frozenPortions must be 0 to 20')
      if (n > 0 && row.kind !== 'dish') throw new HttpError(400, 'Only a cooked meal can be frozen')
      syncFrozen(db, householdId, row, n)
      db.prepare('UPDATE plan_entries SET frozen_portions = ? WHERE id = ?').run(n, id)
    }
    const sets = []
    const values = []
    if (patch.cookNote !== undefined) {
      sets.push('cook_note = ?')
      values.push(patch.cookNote === null ? null : String(patch.cookNote).trim().slice(0, 1000) || null)
    }
    if (patch.leftovers !== undefined) {
      sets.push('leftovers = ?')
      values.push(patch.leftovers ? 1 : 0)
    }
    if (patch.tweakRetry !== undefined) {
      sets.push('tweak_retry = ?')
      values.push(patch.tweakRetry ? 1 : 0)
    }
    if (sets.length) db.prepare(`UPDATE plan_entries SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
    return withReviews(db, entryRow(db, householdId, id))
  })
}

/**
 * The standing-rating key this cook's options map to: '' for a meal without
 * options, the option (one axis) or combination (two axes) when every axis was
 * chosen; null when the cook doesn't pin one variation down.
 */
function ratingKeyFor(db, row) {
  const axes = db.prepare('SELECT DISTINCT axis FROM dish_options WHERE dish_id = ?').all(row.dish_id).map((a) => a.axis)
  const chosen = db.prepare('SELECT option_id FROM plan_entry_options WHERE plan_entry_id = ?').all(row.id).map((r) => r.option_id)
  if (axes.length === 0) return ''
  if (chosen.length !== axes.length) return null
  return comboKey(db, row.dish_id, chosen.join('+'))
}

/**
 * One person's opinion of a cook. It also becomes the standing rating for
 * that meal / variation (marked source 'review'), so first-pass estimates are
 * replaced by real cooks over time. Clearing both removes the opinion.
 */
export function setReview(db, householdId, user, id, { ratedAs, thumbs = null, stars = null }) {
  return withTx(db, () => {
    const row = entryRow(db, householdId, id)
    if (row.kind !== 'dish' && row.kind !== 'freezer') throw new HttpError(400, 'Only meal nights are reviewed')
    const as = ratedAs === 'me' ? user.id : ratedAs
    if (as !== 'both' && !db.prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?').get(householdId, as)) {
      throw new HttpError(400, 'ratedAs must be both, me, or someone in your household')
    }
    if (thumbs !== null && thumbs !== -1 && thumbs !== 1) throw new HttpError(400, 'thumbs must be -1, 1 or null')
    if (stars !== null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new HttpError(400, 'stars must be 1 to 5 or null')

    if (thumbs === null && stars === null) {
      db.prepare('DELETE FROM reviews WHERE plan_entry_id = ? AND rated_as = ?').run(id, as)
    } else {
      db.prepare(
        `INSERT INTO reviews (plan_entry_id, household_id, rated_as, thumbs, stars, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_entry_id, rated_as) DO UPDATE SET thumbs = excluded.thumbs, stars = excluded.stars,
           updated_by = excluded.updated_by, updated_at = datetime('now')`,
      ).run(id, householdId, as, thumbs, stars, user.id)
      const key = ratingKeyFor(db, row)
      if (key !== null) {
        db.prepare(
          `INSERT INTO dish_ratings (household_id, dish_id, option_id, rated_as, thumbs, stars, want, source, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'review', ?)
           ON CONFLICT(dish_id, option_id, rated_as) DO UPDATE SET thumbs = excluded.thumbs, stars = excluded.stars,
             want = 0, source = 'review', updated_by = excluded.updated_by, updated_at = datetime('now')`,
        ).run(householdId, row.dish_id, key, as, thumbs, stars, user.id)
      }
    }
    return withReviews(db, entryRow(db, householdId, id))
  })
}

/* ------------------------------------------------------------------ */
/* Freezer                                                             */
/* ------------------------------------------------------------------ */

function freezerPayload(row) {
  return {
    id: row.id,
    dishId: row.dish_id,
    optionIds: JSON.parse(row.option_ids || '[]'),
    portions: row.portions_left,
    frozenOn: row.frozen_on ?? null,
    fromEntryId: row.source_entry_id ?? null,
  }
}

/** Stock with portions left, oldest first (eat those first). */
export function freezerList(db, householdId) {
  return db
    .prepare('SELECT * FROM freezer_items WHERE household_id = ? AND portions_left > 0 ORDER BY frozen_on IS NULL, frozen_on, created_at')
    .all(householdId)
    .map(freezerPayload)
}

export function addFreezer(db, householdId, { dishId, optionIds = [], portions, frozenOn = null }) {
  findDish(db, householdId, dishId)
  if (!Number.isInteger(portions) || portions < 1 || portions > 20) throw new HttpError(400, 'portions must be 1 to 20')
  const day = frozenOn ? requireDay(frozenOn, 'frozenOn') : null
  for (const o of optionIds) {
    if (!db.prepare('SELECT 1 FROM dish_options WHERE id = ? AND dish_id = ?').get(o, dishId)) throw new HttpError(400, 'An option does not belong to that meal')
  }
  const id = randomUUID()
  db.prepare('INSERT INTO freezer_items (id, household_id, dish_id, option_ids, portions_left, frozen_on) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    householdId,
    dishId,
    JSON.stringify(optionIds),
    portions,
    day,
  )
  return freezerPayload(db.prepare('SELECT * FROM freezer_items WHERE id = ?').get(id))
}

/** Set portions left (manual +1 / −1). 0 empties it; the row stays for history. */
export function setFreezerPortions(db, householdId, id, portions) {
  const row = db.prepare('SELECT * FROM freezer_items WHERE id = ? AND household_id = ?').get(id, householdId)
  if (!row) throw new HttpError(404, "That isn't in the freezer")
  if (!Number.isInteger(portions) || portions < 0 || portions > 50) throw new HttpError(400, 'portions must be 0 to 50')
  db.prepare("UPDATE freezer_items SET portions_left = ?, updated_at = datetime('now') WHERE id = ?").run(portions, id)
  return freezerPayload(db.prepare('SELECT * FROM freezer_items WHERE id = ?').get(id))
}
