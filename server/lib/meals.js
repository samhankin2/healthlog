/**
 * Shared meal helpers (used by the meals route, the chat pipeline and the CSV
 * import commit). Keeps the row↔payload mapping in one place.
 */
import { randomUUID } from 'node:crypto'
import { mealPayload } from './shape.js'

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10
const nonNeg = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Normalise one item from a request body / AI output. */
export function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  return {
    foodId: raw.foodId ?? raw.food_id ?? null,
    name: name.slice(0, 200),
    quantity: raw.quantity === undefined || raw.quantity === null ? null : String(raw.quantity).slice(0, 100),
    kcal: r1(nonNeg(raw.kcal)),
    proteinG: r1(nonNeg(raw.proteinG ?? raw.protein_g)),
    carbsG: r1(nonNeg(raw.carbsG ?? raw.carbs_g)),
    fatG: r1(nonNeg(raw.fatG ?? raw.fat_g)),
  }
}

/** Normalise a list of items, dropping entries without a name. */
export function normaliseItems(items) {
  if (!Array.isArray(items)) return []
  return items.map(normaliseItem).filter(Boolean)
}

/** Attach item rows to meal rows (single query, no N+1). */
export function attachItems(db, mealRows) {
  if (mealRows.length === 0) return []
  const ids = mealRows.map((m) => m.id)
  const placeholders = ids.map(() => '?').join(', ')
  const itemRows = db
    .prepare(`SELECT * FROM meal_items WHERE meal_id IN (${placeholders}) ORDER BY rowid ASC`)
    .all(...ids)
  const byMeal = new Map()
  for (const row of itemRows) {
    if (!byMeal.has(row.meal_id)) byMeal.set(row.meal_id, [])
    byMeal.get(row.meal_id).push(row)
  }
  return mealRows.map((row) => mealPayload(row, byMeal.get(row.id) ?? []))
}

/** Fetch one meal (scoped to the user) with its items. */
export function findMeal(db, userId, id) {
  const row = db.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) return null
  return attachItems(db, [row])[0]
}

/** Insert a meal row and its items. Returns the new meal id. */
export function insertMeal(db, userId, input) {
  const id = randomUUID()
  const items = normaliseItems(input.items)
  db.prepare(
    `INSERT INTO meals (id, user_id, eaten_at, day, name, description, kcal, protein_g, carbs_g, fat_g,
                        fiber_g, source, confidence, analysis_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.eatenAt,
    input.day,
    input.name,
    input.description ?? null,
    r1(input.kcal),
    r1(input.proteinG),
    r1(input.carbsG),
    r1(input.fatG),
    input.fiberG === undefined || input.fiberG === null ? null : r1(input.fiberG),
    input.source ?? 'ai',
    input.confidence === undefined || input.confidence === null ? null : Number(input.confidence),
    input.analysisId ?? null,
  )
  insertItems(db, id, items)
  return id
}

/** Insert meal_items rows for a meal. */
export function insertItems(db, mealId, items) {
  if (!items || items.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO meal_items (id, meal_id, food_id, name, quantity, kcal, protein_g, carbs_g, fat_g)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const item of items) {
    stmt.run(randomUUID(), mealId, item.foodId ?? null, item.name, item.quantity ?? null, item.kcal, item.proteinG, item.carbsG, item.fatG)
  }
}

/** Delete and re-insert the items of a meal. */
export function replaceItems(db, mealId, items) {
  db.prepare('DELETE FROM meal_items WHERE meal_id = ?').run(mealId)
  insertItems(db, mealId, items)
}

/** Sum items into a total (used when a meal's macros are omitted). */
export function totalsFromItems(items) {
  const t = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 }
  for (const i of items) {
    t.kcal += i.kcal
    t.proteinG += i.proteinG
    t.carbsG += i.carbsG
    t.fatG += i.fatG
  }
  return { kcal: r1(t.kcal), proteinG: r1(t.proteinG), carbsG: r1(t.carbsG), fatG: r1(t.fatG) }
}

/** Meals for a user, newest first, with items. */
export function listMeals(db, userId, { day = null, limit = 50, offset = 0 } = {}) {
  const rows = day
    ? db
        .prepare('SELECT * FROM meals WHERE user_id = ? AND day = ? ORDER BY eaten_at ASC, rowid ASC LIMIT ? OFFSET ?')
        .all(userId, day, limit, offset)
    : db
        .prepare('SELECT * FROM meals WHERE user_id = ? ORDER BY day DESC, eaten_at DESC, rowid DESC LIMIT ? OFFSET ?')
        .all(userId, limit, offset)
  return attachItems(db, rows)
}
