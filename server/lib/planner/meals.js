/**
 * Meal planner: the household's meals, their options, standing ratings,
 * tags, notes to Claude, and the Notes-history import. SPEC §6 "Meal planner".
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'

/** Alias key: lower case, single spaces, no trailing punctuation. */
export function normaliseName(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.,;:-]+$/g, '')
    .trim()
}

const parseList = (text) => {
  try {
    const v = JSON.parse(text || '[]')
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

export const MAX_TAGS = 20
const MAX_TAG_LENGTH = 30

/** Validate a tag list: trimmed, de-duplicated (case-insensitive), at most 20 of 30 chars. */
export function cleanTags(value, field = 'tags') {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list`)
  const seen = new Set()
  const out = []
  for (const raw of value) {
    const tag = String(raw ?? '').trim().replace(/\s+/g, ' ')
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH) throw new HttpError(400, `A tag can be at most ${MAX_TAG_LENGTH} characters`)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  if (out.length > MAX_TAGS) throw new HttpError(400, `At most ${MAX_TAGS} tags per meal`)
  return out
}

export function findDish(db, householdId, id) {
  const dish = db.prepare('SELECT * FROM dishes WHERE id = ? AND household_id = ?').get(id, householdId)
  if (!dish) throw new HttpError(404, 'Meal not found')
  return dish
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Every meal in the household with options, history counts, ratings and notes. */
export function mealsPayload(db, householdId) {
  const dishes = db
    .prepare('SELECT * FROM dishes WHERE household_id = ? AND archived_at IS NULL ORDER BY name COLLATE NOCASE')
    .all(householdId)
  const byId = new Map()
  const meals = dishes.map((d) => {
    const meal = {
      id: d.id,
      name: d.name,
      family: d.family ?? null,
      tags: parseList(d.tags),
      suggestedTags: parseList(d.suggested_tags),
      effort: d.default_effort ?? null,
      tips: d.tips ?? null,
      link: d.link ?? null,
      neverSuggest: Boolean(d.never_suggest),
      aliases: [],
      options: [],
      cooked: 0,
      lastCooked: null,
      ratings: [],
      hidden: [],
      notes: [],
    }
    byId.set(d.id, meal)
    return meal
  })

  for (const r of db
    .prepare('SELECT a.dish_id, a.alias FROM dish_aliases a WHERE a.household_id = ? ORDER BY a.alias')
    .all(householdId)) {
    const meal = byId.get(r.dish_id)
    if (meal && r.alias !== normaliseName(meal.name)) meal.aliases.push(r.alias)
  }
  for (const o of db
    .prepare(
      `SELECT o.* FROM dish_options o JOIN dishes d ON d.id = o.dish_id
        WHERE d.household_id = ? ORDER BY o.axis, o.position, o.name`,
    )
    .all(householdId)) {
    byId.get(o.dish_id)?.options.push({ id: o.id, axis: o.axis, name: o.name })
  }
  for (const c of db
    .prepare(
      `SELECT dish_id, COUNT(*) AS n, MAX(date) AS last FROM plan_entries
        WHERE household_id = ? AND kind = 'dish' AND status = 'cooked' AND dish_id IS NOT NULL
        GROUP BY dish_id`,
    )
    .all(householdId)) {
    const meal = byId.get(c.dish_id)
    if (meal) {
      meal.cooked = c.n
      meal.lastCooked = c.last ?? null
    }
  }
  for (const r of db.prepare('SELECT * FROM dish_ratings WHERE household_id = ?').all(householdId)) {
    byId.get(r.dish_id)?.ratings.push({
      optionId: r.option_id || null,
      ratedAs: r.rated_as,
      thumbs: r.thumbs ?? null,
      stars: r.stars ?? null,
      want: Boolean(r.want),
    })
  }
  for (const h of db.prepare('SELECT dish_id, option_id FROM dish_hidden_options WHERE household_id = ? ORDER BY option_id').all(householdId)) {
    byId.get(h.dish_id)?.hidden.push(h.option_id)
  }
  for (const n of db
    .prepare(
      `SELECT n.*, u.display_name, u.email FROM planner_notes n LEFT JOIN users u ON u.id = n.created_by
        WHERE n.household_id = ? AND n.dish_id IS NOT NULL ORDER BY n.created_at, n.rowid`,
    )
    .all(householdId)) {
    byId.get(n.dish_id)?.notes.push(notePayload(n))
  }
  return meals
}

function notePayload(n) {
  return {
    id: n.id,
    body: n.body,
    reply: n.reply ?? null,
    resolved: Boolean(n.resolved_at),
    createdAt: n.created_at,
    createdBy: n.created_by ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

/** Tags, suggested tags, effort, tips, archived. Only the fields given change. */
export function updateMeal(db, householdId, id, patch) {
  findDish(db, householdId, id)
  const sets = []
  const values = []
  if (patch.tags !== undefined) {
    sets.push('tags = ?')
    values.push(JSON.stringify(cleanTags(patch.tags)))
  }
  if (patch.suggestedTags !== undefined) {
    sets.push('suggested_tags = ?')
    values.push(JSON.stringify(cleanTags(patch.suggestedTags, 'suggestedTags')))
  }
  if (patch.effort !== undefined) {
    if (patch.effort !== null && ![1, 2, 3].includes(patch.effort)) throw new HttpError(400, 'effort must be 1, 2, 3 or null')
    sets.push('default_effort = ?')
    values.push(patch.effort)
  }
  if (patch.tips !== undefined) {
    const tips = patch.tips === null ? null : String(patch.tips).trim().slice(0, 2000) || null
    sets.push('tips = ?')
    values.push(tips)
  }
  if (patch.neverSuggest !== undefined) {
    sets.push('never_suggest = ?')
    values.push(patch.neverSuggest ? 1 : 0)
  }
  if (patch.archived !== undefined) {
    // Removed from the list; history, ratings and aliases stay, so it can come back.
    sets.push(patch.archived ? "archived_at = COALESCE(archived_at, datetime('now'))" : 'archived_at = NULL')
  }
  if (sets.length === 0) return
  sets.push("updated_at = datetime('now')")
  db.prepare(`UPDATE dishes SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
}

/**
 * A rating target below the meal: one option id, or a combination of options
 * from different axes joined with '+' ("<style id>+<protein id>"). Returned
 * with the ids sorted, so the same combination always has the same key.
 */
export function comboKey(db, dishId, key) {
  const ids = [...new Set(String(key).split('+').filter(Boolean))].sort()
  if (ids.length === 0 || ids.length > 3) throw new HttpError(400, 'optionId must name 1 to 3 options')
  const axes = new Set()
  for (const id of ids) {
    const option = db.prepare('SELECT axis FROM dish_options WHERE id = ? AND dish_id = ?').get(id, dishId)
    if (!option) throw new HttpError(404, 'Option not found')
    if (axes.has(option.axis)) throw new HttpError(400, 'A combination takes one option per axis')
    axes.add(option.axis)
  }
  return ids.join('+')
}

/**
 * Upsert one standing rating. `ratedAs` is 'both' or a household member's id.
 * `want` marks a variation not had yet that we want to make: it carries no
 * thumbs or stars (a score clears it). Clearing everything deletes the rating.
 */
export function setRating(db, householdId, user, { dishId, optionId = null, ratedAs, thumbs = null, stars = null, want = false }) {
  findDish(db, householdId, dishId)
  optionId = optionId ? comboKey(db, dishId, optionId) : null
  let as = ratedAs === 'me' ? user.id : ratedAs
  if (as !== 'both') {
    const member = db.prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?').get(householdId, as)
    if (!member) throw new HttpError(400, 'ratedAs must be both, me, or someone in your household')
  }
  if (thumbs !== null && thumbs !== -1 && thumbs !== 1) throw new HttpError(400, 'thumbs must be -1, 1 or null')
  if (stars !== null && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) throw new HttpError(400, 'stars must be 1 to 5 or null')
  if (want && (thumbs !== null || stars !== null)) throw new HttpError(400, 'want takes no thumbs or stars')

  const key = [dishId, optionId ?? '', as]
  if (thumbs === null && stars === null && !want) {
    db.prepare('DELETE FROM dish_ratings WHERE dish_id = ? AND option_id = ? AND rated_as = ?').run(...key)
    return null
  }
  db.prepare(
    `INSERT INTO dish_ratings (household_id, dish_id, option_id, rated_as, thumbs, stars, want, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dish_id, option_id, rated_as) DO UPDATE SET
       thumbs = excluded.thumbs, stars = excluded.stars, want = excluded.want,
       updated_by = excluded.updated_by, updated_at = datetime('now')`,
  ).run(householdId, ...key, thumbs, stars, want ? 1 : 0, user.id)
  return { optionId: optionId ?? null, ratedAs: as, thumbs, stars, want: Boolean(want) }
}

/**
 * Take a variation or combination off a meal's list ("never had it"), or put
 * it back. Household-wide; its ratings are kept and return with it.
 */
export function setHidden(db, householdId, user, dishId, optionId, hidden) {
  findDish(db, householdId, dishId)
  if (typeof optionId !== 'string' || !optionId) throw new HttpError(400, 'optionId is required')
  const key = comboKey(db, dishId, optionId)
  if (hidden) {
    db.prepare(
      `INSERT INTO dish_hidden_options (household_id, dish_id, option_id, hidden_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(dish_id, option_id) DO NOTHING`,
    ).run(householdId, dishId, key, user.id)
  } else {
    db.prepare('DELETE FROM dish_hidden_options WHERE dish_id = ? AND option_id = ?').run(dishId, key)
  }
  return db.prepare('SELECT option_id FROM dish_hidden_options WHERE dish_id = ? ORDER BY option_id').all(dishId).map((r) => r.option_id)
}

export const MAX_NOTE = 2000

export function addNote(db, householdId, user, dishId, body) {
  findDish(db, householdId, dishId)
  const text = String(body ?? '').trim()
  if (!text) throw new HttpError(400, 'Write something first')
  if (text.length > MAX_NOTE) throw new HttpError(400, `A note can be at most ${MAX_NOTE} characters`)
  const id = randomUUID()
  db.prepare('INSERT INTO planner_notes (id, household_id, dish_id, body, created_by) VALUES (?, ?, ?, ?, ?)').run(
    id,
    householdId,
    dishId,
    text,
    user.id,
  )
  return notePayload(db.prepare('SELECT * FROM planner_notes WHERE id = ?').get(id))
}

/* ------------------------------------------------------------------ */
/* Import (server/cli.js planner import)                               */
/* ------------------------------------------------------------------ */

const IMPORT_KINDS = new Set(['dish', 'out', 'leftovers', 'takeaway'])

function findDishByName(db, householdId, name) {
  const key = normaliseName(name)
  return (
    db.prepare('SELECT d.* FROM dish_aliases a JOIN dishes d ON d.id = a.dish_id WHERE a.household_id = ? AND a.alias = ?').get(householdId, key) ??
    db.prepare('SELECT * FROM dishes WHERE household_id = ? AND lower(name) = ?').get(householdId, key)
  )
}

/**
 * Load a draft (data/notes-import/draft.json) into a household. Safe to run
 * again: meals match by name or alias, options by (axis, name), history rows
 * by import key. Existing tags, effort and ratings are never overwritten.
 */
export function importDraft(db, householdId, draft, { dryRun = false } = {}) {
  if (!draft || !Array.isArray(draft.dishes) || !Array.isArray(draft.weeks)) throw new Error('not a draft: needs dishes[] and weeks[]')
  const stats = { mealsCreated: 0, mealsMatched: 0, aliasesAdded: 0, optionsAdded: 0, historyAdded: 0, historySkipped: 0, problems: [] }

  const run = () => {
    const dishIds = new Map() // draft name -> dish id
    const optionIds = new Map() // `${dishId}|${axis}|${name}` -> option id
    const addAlias = db.prepare('INSERT OR IGNORE INTO dish_aliases (household_id, alias, dish_id) VALUES (?, ?, ?)')

    for (const item of draft.dishes) {
      const name = String(item.name ?? '').trim()
      if (!name) continue
      let dish = findDishByName(db, householdId, name)
      if (dish) {
        stats.mealsMatched++
        db.prepare(
          // Suggestions only fill an untouched meal, so re-importing never undoes our choices.
          `UPDATE dishes SET suggested_tags = CASE WHEN suggested_tags = '[]' AND tags = '[]' THEN ? ELSE suggested_tags END,
                  tips = COALESCE(tips, ?), link = COALESCE(link, ?), family = COALESCE(family, ?), updated_at = datetime('now') WHERE id = ?`,
        ).run(JSON.stringify(cleanTags(item.suggestedTags ?? [])), item.tips ?? null, item.link ?? null, item.family ?? null, dish.id)
      } else {
        const id = randomUUID()
        db.prepare('INSERT INTO dishes (id, household_id, name, family, suggested_tags, tips, link) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id,
          householdId,
          name,
          item.family ?? null,
          JSON.stringify(cleanTags(item.suggestedTags ?? [])),
          item.tips ?? null,
          item.link ?? null,
        )
        dish = { id }
        stats.mealsCreated++
      }
      dishIds.set(name, dish.id)
      for (const a of [name, ...(item.aliases ?? [])]) {
        const key = normaliseName(a)
        if (key && Number(addAlias.run(householdId, key, dish.id).changes) > 0) stats.aliasesAdded++
      }
      for (const [axis, names] of Object.entries(item.options ?? {})) {
        names.forEach((optName, position) => {
          const existing = db.prepare('SELECT id FROM dish_options WHERE dish_id = ? AND axis = ? AND name = ?').get(dish.id, axis, optName)
          let optionId = existing?.id
          if (!optionId) {
            optionId = randomUUID()
            db.prepare('INSERT INTO dish_options (id, dish_id, axis, name, position) VALUES (?, ?, ?, ?, ?)').run(optionId, dish.id, axis, optName, position)
            stats.optionsAdded++
          }
          optionIds.set(`${dish.id}|${axis}|${optName}`, optionId)
        })
      }
    }

    let order = 0
    const insertEntry = db.prepare(
      `INSERT OR IGNORE INTO plan_entries (id, household_id, date, import_order, import_key, slot, dish_id, kind, status, source, raw, cook_name)
       VALUES (?, ?, NULL, ?, ?, 'dinner', ?, ?, 'cooked', 'notes', ?, ?)`,
    )
    const linkOption = db.prepare('INSERT OR IGNORE INTO plan_entry_options (plan_entry_id, option_id) VALUES (?, ?)')
    for (const week of draft.weeks) {
      ;(week.entries ?? []).forEach((e, index) => {
        order++
        const kind = e.dish ? 'dish' : e.kind
        if (!IMPORT_KINDS.has(kind)) return // nothing / unclear nights are not history
        const dishId = e.dish ? dishIds.get(e.dish) : null
        if (e.dish && !dishId) {
          stats.problems.push(`week ${week.source}/${week.week}: unknown meal "${e.dish}"`)
          return
        }
        const id = randomUUID()
        const key = `notes:${week.source}:${week.week}:${index}`
        const added = Number(insertEntry.run(id, householdId, order, key, dishId, kind, e.raw ?? null, e.cook ?? null).changes) > 0
        if (!added) {
          stats.historySkipped++
          return
        }
        stats.historyAdded++
        for (const [axis, optName] of Object.entries(e.options ?? {})) {
          const optionId = optionIds.get(`${dishId}|${axis}|${optName}`)
          if (optionId) linkOption.run(id, optionId)
          else stats.problems.push(`week ${week.source}/${week.week}: "${e.dish}" has no option ${axis}: ${optName}`)
        }
      })
    }
    if (dryRun) throw Object.assign(new Error('dry run'), { dryRun: true })
  }

  try {
    withTx(db, run)
  } catch (err) {
    if (!err?.dryRun) throw err
  }
  return stats
}

/* ------------------------------------------------------------------ */
/* Split: turn a meal's options into meals of their own                */
/* ------------------------------------------------------------------ */

/**
 * Each option of a one-axis meal becomes its own meal ("<meal> <option>"),
 * in a family (section) named after the meal. History cooked with that option,
 * matching aliases, and ratings of that option move with it; the meal keeps
 * any history without an option and can be renamed (`restName`).
 */
export function splitOptions(db, householdId, mealName, { family = null, restName = null, dryRun = false } = {}) {
  const dish = findDishByName(db, householdId, mealName)
  if (!dish) throw new Error(`no meal called "${mealName}"`)
  const options = db.prepare('SELECT * FROM dish_options WHERE dish_id = ? ORDER BY axis, position, name').all(dish.id)
  if (options.length === 0) throw new Error(`"${dish.name}" has no options to split`)
  if (new Set(options.map((o) => o.axis)).size > 1) throw new Error(`"${dish.name}" has more than one axis; split supports one`)
  const familyName = family ?? dish.name
  const result = { created: [], historyMoved: 0, ratingsMoved: 0, aliasesMoved: 0, rest: restName ?? dish.name }

  const run = () => {
    for (const o of options) {
      const name = `${dish.name} ${o.name.toLowerCase()}`
      const clash = findDishByName(db, householdId, name)
      if (clash && clash.id !== dish.id) throw new Error(`a meal called "${name}" already exists`)
      db.prepare('DELETE FROM dish_aliases WHERE household_id = ? AND alias = ?').run(householdId, normaliseName(name))
      const id = randomUUID()
      db.prepare(
        `INSERT INTO dishes (id, household_id, name, family, tags, suggested_tags, tips, link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, householdId, name, familyName, dish.tags, dish.suggested_tags, dish.tips, dish.link)
      db.prepare('INSERT OR IGNORE INTO dish_aliases (household_id, alias, dish_id) VALUES (?, ?, ?)').run(householdId, normaliseName(name), id)
      result.created.push(name)

      const entries = db.prepare('SELECT plan_entry_id AS id FROM plan_entry_options WHERE option_id = ?').all(o.id)
      for (const e of entries) db.prepare('UPDATE plan_entries SET dish_id = ? WHERE id = ?').run(id, e.id)
      result.historyMoved += entries.length
      result.ratingsMoved += Number(
        db.prepare("UPDATE dish_ratings SET dish_id = ?, option_id = '' WHERE dish_id = ? AND option_id = ?").run(id, dish.id, o.id).changes,
      )
      // "Sandwiches" also claims "pulled pork sandwich".
      const stem = normaliseName(o.name).replace(/(es|s)$/, '')
      for (const a of db.prepare('SELECT alias FROM dish_aliases WHERE household_id = ? AND dish_id = ?').all(householdId, dish.id)) {
        if (stem && a.alias.includes(stem)) {
          db.prepare('UPDATE dish_aliases SET dish_id = ? WHERE household_id = ? AND alias = ?').run(id, householdId, a.alias)
          result.aliasesMoved++
        }
      }
      // Hidden keys naming this option go with it: the new meal is the option itself.
      db.prepare("DELETE FROM dish_hidden_options WHERE dish_id = ? AND (option_id = ? OR '+' || option_id || '+' LIKE '%+' || ? || '+%')").run(dish.id, o.id, o.id)
      db.prepare('DELETE FROM dish_options WHERE id = ?').run(o.id) // cascades its plan_entry_options
    }
    db.prepare("UPDATE dishes SET name = ?, family = ?, updated_at = datetime('now') WHERE id = ?").run(restName ?? dish.name, familyName, dish.id)
    if (restName) db.prepare('INSERT OR IGNORE INTO dish_aliases (household_id, alias, dish_id) VALUES (?, ?, ?)').run(householdId, normaliseName(restName), dish.id)
    if (dryRun) throw Object.assign(new Error('dry run'), { dryRun: true })
  }
  try {
    withTx(db, run)
  } catch (err) {
    if (!err?.dryRun) throw err
  }
  return result
}

/* ------------------------------------------------------------------ */
/* Notes for Claude (server/cli.js planner notes / reply)              */
/* ------------------------------------------------------------------ */

export function listNotes(db, { all = false } = {}) {
  return db
    .prepare(
      `SELECT n.id, d.name AS meal, n.body, n.reply, n.created_at, n.resolved_at,
              COALESCE(u.display_name, u.email) AS by_user
         FROM planner_notes n
         LEFT JOIN dishes d ON d.id = n.dish_id
         LEFT JOIN users u ON u.id = n.created_by
        ${all ? '' : 'WHERE n.resolved_at IS NULL'}
        ORDER BY n.created_at, n.rowid`,
    )
    .all()
}

export function replyToNote(db, id, { reply, resolve = false }) {
  const note = db.prepare('SELECT id FROM planner_notes WHERE id = ?').get(id)
  if (!note) throw new Error(`no note with id ${id}`)
  db.prepare(`UPDATE planner_notes SET reply = COALESCE(?, reply), resolved_at = CASE WHEN ? THEN datetime('now') ELSE resolved_at END WHERE id = ?`).run(
    reply ?? null,
    resolve ? 1 : 0,
    id,
  )
}
