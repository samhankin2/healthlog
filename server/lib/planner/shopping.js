/**
 * The shopping list builder (M5) — SPEC §6 "Meal planner".
 *
 * One list per week. Items are typed per meal (night by night) or as extras;
 * the same item for two meals is one line ("Onions · Mon, Thu"). Sections are
 * Market (the actual market: only ever set by us), Cold (fridge, freezer and
 * supermarket produce) and Ambient (pantry, household). A section we set is
 * remembered; a new word is guessed from a word list, then AI, then Ambient.
 */
import { randomUUID } from 'node:crypto'
import { askJson } from '../../ai.js'
import { withTx } from '../../db.js'
import { HttpError } from '../http.js'
import { findDish, normaliseName } from './meals.js'
import { addDays, requireDay } from './week.js'

export const SECTIONS = ['market', 'cold', 'ambient']

/* ------------------------------------------------------------------ */
/* Guessing a section                                                  */
/* ------------------------------------------------------------------ */

// Checked first: packaging and pantry words win over the food ("tinned tomatoes" is Ambient).
const AMBIENT = [
  'tin', 'tinned', 'can', 'canned', 'jar', 'dried', 'powder', 'paste', 'sauce', 'stock', 'cube', 'flake', 'black pepper', 'peppercorn',
  'rice', 'pasta', 'spaghetti', 'penne', 'linguine', 'orzo', 'noodle', 'lasagna sheet', 'lasagne sheet', 'couscous', 'quinoa', 'polenta', 'barley',
  'flour', 'sugar', 'salt', 'oil', 'vinegar', 'honey', 'syrup', 'spice', 'seasoning', 'cumin', 'turmeric', 'paprika', 'cinnamon',
  'chickpea', 'lentil', 'kidney bean', 'black bean', 'butter bean', 'baked bean', 'mixed bean', 'coconut milk', 'passata',
  'oat', 'cereal', 'cracker', 'biscuit', 'chip', 'crisp', 'nut', 'cashew', 'pistachio', 'walnut', 'date', 'raisin',
  'coffee', 'tea', 'wine', 'beer', 'kombucha', 'soy', 'miso', 'gochujang', 'tahini', 'harissa', 'curry block', 'yeast', 'baking',
  'wrap', 'tortilla', 'bread', 'sourdough', 'bun', 'bagel', 'pita', 'rice paper', 'rice cake',
  'soap', 'toilet', 'tissue', 'paper towel', 'detergent', 'bag', 'foil', 'cling', 'toothpaste', 'tablet', 'panadol', 'battery', 'tampon', 'condom',
]
// Fridge, freezer and supermarket produce.
const COLD = [
  'frozen', 'milk', 'yogurt', 'yoghurt', 'cheese', 'parmesan', 'parm', 'feta', 'halloumi', 'paneer', 'ricotta', 'mozzarella', 'cream', 'butter', 'labneh',
  'egg', 'chicken', 'beef', 'pork', 'lamb', 'mince', 'steak', 'bacon', 'sausage', 'chorizo', 'ham', 'kangaroo', 'turkey',
  'prawn', 'shrimp', 'salmon', 'fish', 'barramundi', 'tuna steak', 'tofu', 'tempeh', 'kimchi', 'hummus', 'pesto', 'dumpling',
  'avo', 'avocado', 'capsicum', 'pepper', 'tomato', 'tom', 'edamame', 'zucchini', 'zuchini', 'courgette', 'eggplant', 'aubergine', 'broccoli', 'broccolini',
  'cauliflower', 'cabbage', 'carrot', 'celery', 'cucumber', 'spinach', 'kale', 'lettuce', 'leaves', 'leaf', 'rocket', 'salad',
  'coriander', 'parsley', 'mint', 'basil', 'dill', 'thyme', 'rosemary', 'herb', 'ginger', 'garlic', 'chilli', 'chillies', 'jalapeno', 'lemongrass', 'lemon grass',
  'lemon', 'lime', 'potato', 'pumpkin', 'leek', 'mushroom', 'onion', 'shallot', 'spring onion', 'green bean', 'snow pea', 'pea', 'corn', 'asparagus', 'beetroot', 'brussels', 'fennel', 'sprout',
  'berry', 'berries', 'banana', 'apple', 'orange', 'pear', 'peach', 'mango', 'grape', 'pomegranate', 'fig', 'watermelon', 'veg', 'fruit',
]

const hasWord = (text, word) => new RegExp(`(^|[^a-z])${word.replace(/ /g, '\\s+')}(e?s)?($|[^a-z])`).test(text)

/** Word-list guess: 'cold' | 'ambient' | null when it doesn't know the item. */
export function guessSection(name) {
  const t = normaliseName(name)
  if (hasWord(t, 'frozen')) return 'cold'
  if (AMBIENT.some((w) => hasWord(t, w))) return 'ambient'
  if (COLD.some((w) => hasWord(t, w))) return 'cold'
  return null
}

const SECTION_SYSTEM = [
  'You sort Australian grocery items for a home shopping list.',
  'Answer "cold" for anything kept in the fridge or freezer AND for fresh produce (fruit, vegetables, herbs);',
  'answer "ambient" for pantry, tins, jars, dry goods, bread, drinks and household items.',
  'JSON: {"items":[{"name":"…","section":"cold"}]}',
].join('\n')

async function aiSection(name) {
  const res = await askJson({ system: SECTION_SYSTEM, user: `Items:\n${name}`, mock: undefined, timeoutMs: 8000 })
  const s = res.ok && Array.isArray(res.data?.items) ? res.data.items[0]?.section : null
  return s === 'cold' || s === 'ambient' ? s : null
}

/** Remembered section, else word list, else AI, else Ambient. Guesses are remembered too (as guesses). */
async function sectionFor(db, householdId, key, name) {
  const known = db.prepare('SELECT section FROM item_sections WHERE household_id = ? AND name_key = ?').get(householdId, key)
  if (known) return known.section
  const section = guessSection(name) ?? (await aiSection(name)) ?? 'ambient'
  db.prepare('INSERT OR IGNORE INTO item_sections (household_id, name_key, section, source) VALUES (?, ?, ?, ?)').run(householdId, key, section, 'guess')
  return section
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

const itemKey = (name) => normaliseName(name).replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()

function itemPayload(row) {
  return {
    id: row.id,
    name: row.name,
    section: row.section,
    qty: row.qty ?? null,
    dishIds: JSON.parse(row.dish_ids || '[]'),
    checked: Boolean(row.checked),
    updatedAt: row.updated_at,
  }
}

function listRow(db, householdId, week, { create = false, user = null } = {}) {
  let row = db.prepare('SELECT * FROM shopping_lists WHERE household_id = ? AND week_start = ?').get(householdId, week)
  if (!row && create) {
    const id = randomUUID()
    db.prepare('INSERT INTO shopping_lists (id, household_id, week_start, created_by) VALUES (?, ?, ?, ?)').run(id, householdId, week, user?.id ?? null)
    row = db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(id)
  }
  return row
}

const SECTION_ORDER = "CASE section WHEN 'market' THEN 0 WHEN 'cold' THEN 1 ELSE 2 END"

/**
 * The week's list plus what the builder needs: the meal nights (out,
 * leftovers, takeaway and freezer nights need no shopping) and each meal's
 * usual items.
 */
export function shoppingPayload(db, householdId, week) {
  requireDay(week, 'week')
  const list = listRow(db, householdId, week)
  const items = list
    ? db.prepare(`SELECT * FROM shopping_items WHERE list_id = ? ORDER BY ${SECTION_ORDER}, checked, lower(name)`).all(list.id).map(itemPayload)
    : []
  const nights = db
    .prepare(
      `SELECT p.id, p.date, p.dish_id, p.kind FROM plan_entries p
        WHERE p.household_id = ? AND p.slot = 'dinner' AND p.date BETWEEN ? AND ? AND p.kind = 'dish' AND p.dish_id IS NOT NULL
        ORDER BY p.date`,
    )
    .all(householdId, week, addDays(week, 6))
    .map((n) => ({
      entryId: n.id,
      date: n.date,
      dishId: n.dish_id,
      optionIds: db.prepare('SELECT option_id FROM plan_entry_options WHERE plan_entry_id = ? ORDER BY option_id').all(n.id).map((r) => r.option_id),
    }))
  const usual = {}
  for (const dishId of new Set(nights.map((n) => n.dishId))) {
    usual[dishId] = db
      .prepare('SELECT name, qty FROM dish_usual_items WHERE dish_id = ? ORDER BY updated_at DESC, name LIMIT 30')
      .all(dishId)
      .map((u) => ({ name: u.name, qty: u.qty ?? null }))
  }
  return { week, items, nights, usual }
}

/**
 * Add an item (for a meal, or as an extra). The same item already on the
 * list becomes one line: the meal is added to it and amounts join ("2 + 1").
 */
export async function addItem(db, householdId, user, { week, name, qty = null, dishId = null, section = null }) {
  requireDay(week, 'week')
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!clean) throw new HttpError(400, 'Type an item')
  if (clean.length > 80) throw new HttpError(400, 'An item can be at most 80 characters')
  const key = itemKey(clean)
  if (!key) throw new HttpError(400, 'Type an item')
  if (section !== null && !SECTIONS.includes(section)) throw new HttpError(400, `section must be one of ${SECTIONS.join(', ')}`)
  if (dishId) findDish(db, householdId, dishId)
  const amount = qty === null || qty === undefined ? null : String(qty).trim().slice(0, 30) || null
  // Sections can involve a slow guess; do it before the write transaction.
  const chosen = section ?? (await sectionFor(db, householdId, key, clean))

  return withTx(db, () => {
    const list = listRow(db, householdId, week, { create: true, user })
    const existing = db.prepare('SELECT * FROM shopping_items WHERE list_id = ? AND name_key = ?').get(list.id, key)
    if (existing) {
      const dishIds = JSON.parse(existing.dish_ids || '[]')
      const fresh = dishId && !dishIds.includes(dishId)
      if (fresh) dishIds.push(dishId)
      const joined = amount && (fresh || !dishId) ? [existing.qty, amount].filter(Boolean).join(' + ') : existing.qty
      db.prepare(
        "UPDATE shopping_items SET dish_ids = ?, qty = ?, checked = 0, section = COALESCE(?, section), updated_at = datetime('now') WHERE id = ?",
      ).run(JSON.stringify(dishIds), joined, section, existing.id)
    } else {
      db.prepare('INSERT INTO shopping_items (id, list_id, name, name_key, section, qty, dish_ids) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID(),
        list.id,
        clean,
        key,
        chosen,
        amount,
        JSON.stringify(dishId ? [dishId] : []),
      )
    }
    if (section) remember(db, householdId, key, section)
    // Next time this meal is on the plan, this is part of "the usual".
    if (dishId) {
      db.prepare(
        `INSERT INTO dish_usual_items (household_id, dish_id, name_key, name, qty) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dish_id, name_key) DO UPDATE SET name = excluded.name, qty = excluded.qty, updated_at = datetime('now')`,
      ).run(householdId, dishId, key, clean, amount)
    }
    return itemPayload(db.prepare('SELECT * FROM shopping_items WHERE list_id = ? AND name_key = ?').get(list.id, key))
  })
}

function remember(db, householdId, key, section) {
  db.prepare(
    `INSERT INTO item_sections (household_id, name_key, section, source) VALUES (?, ?, ?, 'set')
     ON CONFLICT(household_id, name_key) DO UPDATE SET section = excluded.section, source = 'set'`,
  ).run(householdId, key, section)
}

function itemRow(db, householdId, id) {
  const row = db
    .prepare('SELECT i.* FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id WHERE i.id = ? AND l.household_id = ?')
    .get(id, householdId)
  if (!row) throw new HttpError(404, 'That item is not on the list')
  return row
}

/** Tick, rename, change amount or section (a section change is remembered for next time). */
export function updateItem(db, householdId, id, patch) {
  const row = itemRow(db, householdId, id)
  const sets = []
  const values = []
  if (patch.checked !== undefined) {
    sets.push('checked = ?')
    values.push(patch.checked ? 1 : 0)
  }
  if (patch.qty !== undefined) {
    sets.push('qty = ?')
    values.push(patch.qty === null ? null : String(patch.qty).trim().slice(0, 30) || null)
  }
  if (patch.section !== undefined) {
    if (!SECTIONS.includes(patch.section)) throw new HttpError(400, `section must be one of ${SECTIONS.join(', ')}`)
    sets.push('section = ?')
    values.push(patch.section)
    remember(db, householdId, row.name_key, patch.section)
  }
  if (sets.length) db.prepare(`UPDATE shopping_items SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id)
  return itemPayload(db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id))
}

/**
 * Take an item off. With `dishId`, only that meal's claim goes (the line
 * stays while another meal still needs it); without, the line goes.
 */
export function removeItem(db, householdId, id, dishId = null) {
  const row = itemRow(db, householdId, id)
  const dishIds = JSON.parse(row.dish_ids || '[]')
  if (dishId && dishIds.length > 1) {
    db.prepare("UPDATE shopping_items SET dish_ids = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(dishIds.filter((d) => d !== dishId)), id)
    return itemPayload(db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id))
  }
  db.prepare('DELETE FROM shopping_items WHERE id = ?').run(id)
  return null
}

export function clearChecked(db, householdId, week) {
  requireDay(week, 'week')
  const list = listRow(db, householdId, week)
  if (!list) return 0
  return Number(db.prepare('DELETE FROM shopping_items WHERE list_id = ? AND checked = 1').run(list.id).changes)
}

/** Load known sections (e.g. what we buy at the market, from the Notes). Admin: cli planner sections. */
export function rememberSections(db, householdId, items) {
  let n = 0
  withTx(db, () => {
    for (const it of items) {
      const key = itemKey(it?.name ?? '')
      if (!key || !SECTIONS.includes(it.section)) continue
      remember(db, householdId, key, it.section)
      n++
    }
  })
  return n
}
