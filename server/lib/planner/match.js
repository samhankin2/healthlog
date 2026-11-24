/**
 * Matching typed meal text to the household's meals (SPEC §6 "Meal planner",
 * §7 "Planner AI tasks"). Code first: exact names and aliases, then token
 * overlap with option words picked out. AI only sees what code couldn't place.
 */
import { askJson } from '../../ai.js'
import { normaliseName } from './meals.js'

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] // index 0 = Monday
const DAY_RE = /^(mon(day)?|tue(s|sday)?|wed(nesday|s)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b[\s:.\-–—]*/i
const STOP = new Set(['with', 'w', 'and', 'the', 'a', 'of', 'in', 'on', '+', '&', 'for', '1', '2'])

const tokens = (text) =>
  normaliseName(text)
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(' ')
    // Crude singular so "tacos" meets "taco"; applied to both sides, so it only has to be consistent.
    .map((t) => t.replace(/'s$/, ''))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .filter((t) => t && !STOP.has(t))

/** Night kinds typed as text. null = an empty night ("-", "nothing"). */
export function kindOf(text) {
  const t = normaliseName(text)
  if (/^(-+|—+|x+|nothing|none|tbc|tbd|\?)$/.test(t) || t === '') return null
  if (/^(out|eating out|eat out|dinner out|restaurant|not in|away|pub)$/.test(t)) return 'out'
  if (/^(left ?overs?|leftover night)$/.test(t)) return 'leftovers'
  if (/^(take ?away|takeout|take out|delivery|order in)$/.test(t)) return 'takeaway'
  return 'dish'
}

/** Everything the matcher needs about the household's meals, read once per request. */
export function buildIndex(db, householdId) {
  const dishes = db.prepare('SELECT id, name FROM dishes WHERE household_id = ? AND archived_at IS NULL').all(householdId)
  const byId = new Map(dishes.map((d) => [d.id, { id: d.id, name: d.name, names: [normaliseName(d.name)], options: [] }]))
  for (const a of db.prepare('SELECT alias, dish_id FROM dish_aliases WHERE household_id = ?').all(householdId)) {
    byId.get(a.dish_id)?.names.push(a.alias)
  }
  for (const o of db
    .prepare('SELECT o.id, o.dish_id, o.axis, o.name FROM dish_options o JOIN dishes d ON d.id = o.dish_id WHERE d.household_id = ?')
    .all(householdId)) {
    byId.get(o.dish_id)?.options.push({ id: o.id, axis: o.axis, name: o.name, tokens: tokens(o.name) })
  }
  const exact = new Map()
  for (const d of byId.values()) for (const n of d.names) if (!exact.has(n)) exact.set(n, d.id)
  return { byId, exact }
}

/** Options whose words appear in the text, at most one per axis. */
function pickOptions(dish, textTokens) {
  const chosen = new Map()
  for (const o of dish.options) {
    if (o.tokens.length && o.tokens.every((t) => textTokens.includes(t)) && !chosen.has(o.axis)) chosen.set(o.axis, o.id)
  }
  return [...chosen.values()]
}

/**
 * Match one meal description. Returns the best guess and up to 3 candidates:
 * { dishId, optionIds, confidence 0..1, candidates: [{dishId, name, confidence}] }.
 */
export function matchMeal(index, text) {
  const key = normaliseName(text)
  const textTokens = tokens(text)
  if (index.exact.has(key)) {
    const dish = index.byId.get(index.exact.get(key))
    return { dishId: dish.id, optionIds: pickOptions(dish, textTokens), confidence: 1, candidates: [{ dishId: dish.id, name: dish.name, confidence: 1 }] }
  }
  const scored = []
  for (const dish of index.byId.values()) {
    const optionWords = new Set(dish.options.flatMap((o) => o.tokens))
    let best = 0
    for (const n of dish.names) {
      const nameTokens = tokens(n)
      if (nameTokens.length === 0) continue
      const hit = nameTokens.filter((t) => textTokens.includes(t)).length
      if (hit === 0) continue
      const coverName = hit / nameTokens.length // how much of the meal's name was typed
      const extra = textTokens.filter((t) => !nameTokens.includes(t) && !optionWords.has(t)).length
      const coverText = 1 - extra / Math.max(textTokens.length, 1) // how much of the text is explained
      best = Math.max(best, coverName * 0.7 + coverText * 0.3)
    }
    if (best > 0) scored.push({ dishId: dish.id, name: dish.name, confidence: Math.round(best * 100) / 100 })
  }
  scored.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
  const top = scored[0]
  if (!top || top.confidence < 0.5) return { dishId: null, optionIds: [], confidence: 0, candidates: scored.slice(0, 3) }
  return { dishId: top.dishId, optionIds: pickOptions(index.byId.get(top.dishId), textTokens), confidence: top.confidence, candidates: scored.slice(0, 3) }
}

/**
 * Split a typed week into nights. Day names ("mon katsu", "Tuesday: dahl") pin
 * an item to that day; the rest fill the remaining nights in order.
 * `days` are the week's dates in order and `weekdays` their 0=Monday indexes.
 */
export function splitWeek(text, days, weekdays) {
  const parts = String(text ?? '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 21)
  const placed = new Map()
  const floating = []
  for (const raw of parts) {
    const m = raw.match(DAY_RE)
    const rest = m ? raw.slice(m[0].length).trim() : raw
    if (m) {
      const idx = DAY_NAMES.indexOf(m[1].slice(0, 3).toLowerCase())
      const pos = weekdays.indexOf(idx)
      if (pos >= 0 && !placed.has(pos)) {
        placed.set(pos, { raw: rest || raw, typed: raw })
        continue
      }
    }
    floating.push({ raw: rest || raw, typed: raw })
  }
  for (let pos = 0; pos < days.length && floating.length; pos++) if (!placed.has(pos)) placed.set(pos, floating.shift())
  return [...placed]
    .sort((a, b) => a[0] - b[0])
    .map(([pos, item]) => ({ date: days[pos], raw: item.raw, typed: item.typed }))
}

const AI_SYSTEM = [
  'You match short meal descriptions from a weekly dinner plan to a household\'s known meals.',
  'You get the meals as lines "id | name | other names | options" and the items as lines "index: text".',
  'For each item return the id of the meal it means, or null with a short newName when it is clearly a new meal.',
  'Prefer an existing meal when the text is a nickname, misspelling or vague description of it ("that lentil thing" may be Dahl).',
  'Also return the option names mentioned (only ones listed for that meal) and confidence 0..1.',
  'JSON shape: {"items":[{"index":0,"dishId":"…"|null,"newName":"…"|null,"options":["Prawn"],"confidence":0.8}]}',
].join('\n')

/** Ask AI about items code couldn't place confidently. Mutates `items`. Never throws. */
async function aiAssist(index, items) {
  const unsure = items.filter((it) => it.kind === 'dish' && it.confidence < 0.85)
  if (unsure.length === 0) return
  const meals = [...index.byId.values()]
    .map((d) => `${d.id} | ${d.name} | ${d.names.slice(1, 6).join(', ')} | ${d.options.map((o) => o.name).join(', ')}`)
    .join('\n')
  const asked = unsure.map((it, i) => `${i}: ${it.raw}`).join('\n')
  const res = await askJson({ system: AI_SYSTEM, user: `Meals:\n${meals}\n\nItems:\n${asked}`, mock: undefined, timeoutMs: 25000 })
  if (!res.ok || !Array.isArray(res.data?.items)) return
  for (const r of res.data.items) {
    const it = unsure[r?.index]
    if (!it) continue
    const dish = typeof r.dishId === 'string' ? index.byId.get(r.dishId) : null
    const confidence = Math.max(0, Math.min(1, Number(r.confidence) || 0.6))
    if (dish && confidence >= it.confidence) {
      const wanted = new Set((Array.isArray(r.options) ? r.options : []).map((s) => String(s).toLowerCase()))
      const perAxis = new Map()
      for (const o of dish.options) if (wanted.has(o.name.toLowerCase()) && !perAxis.has(o.axis)) perAxis.set(o.axis, o.id)
      Object.assign(it, { dishId: dish.id, optionIds: [...perAxis.values()], confidence, newName: null, by: 'ai' })
    } else if (!dish && !it.dishId && typeof r.newName === 'string' && r.newName.trim()) {
      Object.assign(it, { newName: r.newName.trim().slice(0, 80), by: 'ai' })
    }
  }
}

/** Typed week → proposed nights for the confirm sheet. */
export async function parseWeek(db, householdId, text, days, weekdays, { useAi = true } = {}) {
  const index = buildIndex(db, householdId)
  const items = splitWeek(text, days, weekdays).map((p) => {
    const kind = kindOf(p.raw)
    if (kind !== 'dish') return { ...p, kind, dishId: null, optionIds: [], confidence: 1, candidates: [], newName: null, by: 'code' }
    const m = matchMeal(index, p.raw)
    const newName = m.dishId ? null : p.raw.replace(/\?+$/, '').trim().replace(/^./, (c) => c.toUpperCase())
    return { ...p, kind, ...m, newName, by: 'code' }
  })
  if (useAi) await aiAssist(index, items)
  return items.filter((it) => it.kind !== null)
}
