/**
 * Planner helpers for the one-line review (M3) and suggestions (M4) —
 * SPEC §6 "Meal planner", §7 "Planner AI tasks".
 */
import { askJson } from '../../ai.js'
import { HttpError } from '../http.js'
import { findDish, normaliseName } from './meals.js'
import { addDays, requireDay } from './week.js'

/* ------------------------------------------------------------------ */
/* One-line review                                                     */
/* ------------------------------------------------------------------ */

const SKIP_RE = /\b(skip(ped)?|didn'?t (make|have|cook|do|eat)|never made|no time|ordered in|got takeaway|ate out|went out)\b/
const WORDS = [
  [/\b(amazing|incredible|loved|love it|banger|perfect|best|so good|delicious|10\/10)\b/, 5],
  [/\b(great|really good|very good|lovely|tasty|yum)\b/, 4],
  [/\b(good|nice|solid|decent|enjoyed|liked)\b/, 4],
  [/\b(ok|okay|fine|meh|average|alright|not bad)\b/, 3],
  [/\b(bland|dry|too much faff|faff|not great|disappointing|overcooked|too spicy|too salty|boring)\b/, 2],
  [/\b(bad|awful|horrible|hated|disgusting|never again|gross)\b/, 1],
]

function scoreOf(text) {
  for (const [re, stars] of WORDS) if (re.test(text)) return stars
  return null
}

/** Name words long enough to spot in a sentence ("dirty cabbage" → dirty, cabbage). */
const keyWords = (name) => normaliseName(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4)

/**
 * Code reading of a one-line review. Clauses split on commas, "but", "except";
 * a clause naming a meal applies to it; "all"/"everything" applies to the rest.
 * Returns [{ entryId, status, stars, thumbs, note }].
 */
export function readReviewLine(text, entries) {
  const clauses = normaliseName(text)
    .split(/\s*(?:,|;|\.|\bbut\b|\bexcept\b|\bapart from\b|\bthough\b|\band\b)\s*/)
    .map((c) => c.trim())
    .filter(Boolean)
  const byEntry = new Map()
  let everything = null
  let lastNamed = [] // "the risotto, too much faff": an opinion right after a meal is about that meal
  // Only tips become cook notes ("too much faff", "needs more salt"); plain opinions are the stars.
  const noteOf = (clause) => (/\b(too|more|less|needs?|next time|add|use|without|instead)\b/.test(clause) ? clause : null)
  for (const clause of clauses) {
    const named = entries.filter((e) => keyWords(e.name).some((w) => clause.includes(w)))
    const skipped = SKIP_RE.test(clause)
    const stars = scoreOf(clause)
    const general = /\b(all|everything|every|rest|others|the lot)\b/.test(clause)
    if (named.length) {
      for (const e of named) {
        const prev = byEntry.get(e.id) ?? {}
        byEntry.set(e.id, { ...prev, skipped: prev.skipped || skipped, stars: stars ?? prev.stars ?? null, note: noteOf(clause) ?? prev.note ?? null })
      }
      lastNamed = named
    } else if (general || clauses.length === 1) {
      everything = { skipped, stars }
      lastNamed = []
    } else if (lastNamed.length && (stars != null || skipped || noteOf(clause))) {
      for (const e of lastNamed) {
        const prev = byEntry.get(e.id) ?? {}
        byEntry.set(e.id, { ...prev, skipped: prev.skipped || skipped, stars: prev.stars ?? stars ?? null, note: noteOf(clause) ?? prev.note ?? null })
      }
    }
  }
  const out = []
  for (const e of entries) {
    const hit = byEntry.get(e.id) ?? (everything ? { ...everything, note: null } : null)
    if (!hit) continue
    if (hit.skipped) out.push({ entryId: e.id, status: 'skipped', stars: null, thumbs: null, note: null })
    else if (hit.stars != null) {
      out.push({ entryId: e.id, status: 'cooked', stars: hit.stars, thumbs: hit.stars >= 3 ? 1 : -1, note: byEntry.has(e.id) ? hit.note : null })
    } else if (byEntry.has(e.id)) out.push({ entryId: e.id, status: 'cooked', stars: null, thumbs: null, note: hit.note })
  }
  return out
}

const REVIEW_SYSTEM = [
  'You read a one-line review of a week of home-cooked dinners and turn it into per-dinner results.',
  'You get the dinners as lines "id | weekday date | meal" and the review text.',
  'For each dinner the text says something about (directly, or via "all"/"everything"/"the rest"), return:',
  'status "cooked" or "skipped"; for cooked, stars 1-5 (5 loved, 4 good, 3 ok, 2 not great, 1 never again) if the',
  'text gives an opinion, else null; thumbs 1 (make again) or -1 (don\'t) if clear, else follow stars (3+ is 1);',
  'and note: a short cook note only if the text gives a concrete tip (e.g. "too salty", "needs more garlic").',
  'Leave out dinners the text does not cover. JSON: {"items":[{"entryId":"…","status":"cooked","stars":4,"thumbs":1,"note":null}]}',
].join('\n')

/** Proposed results for the review queue from one line of text. AI when available, code otherwise. */
export async function parseReviewLine(db, householdId, entries, text) {
  const named = entries.map((e) => ({
    id: e.id,
    date: e.date,
    name: db.prepare('SELECT name FROM dishes WHERE id = ? AND household_id = ?').get(e.dishId, householdId)?.name ?? e.raw ?? 'dinner',
  }))
  const fallback = readReviewLine(text, named)
  const lines = named.map((e) => `${e.id} | ${e.date} | ${e.name}`).join('\n')
  const res = await askJson({ system: REVIEW_SYSTEM, user: `Dinners:\n${lines}\n\nReview: ${text}`, mock: undefined, timeoutMs: 25000 })
  if (!res.ok || !Array.isArray(res.data?.items)) return { items: fallback, by: 'code' }
  const ids = new Set(named.map((e) => e.id))
  const items = []
  for (const it of res.data.items) {
    if (!ids.has(it?.entryId)) continue
    const status = it.status === 'skipped' ? 'skipped' : 'cooked'
    const stars = Number.isInteger(it.stars) && it.stars >= 1 && it.stars <= 5 ? it.stars : null
    const thumbs = it.thumbs === 1 || it.thumbs === -1 ? it.thumbs : stars ? (stars >= 3 ? 1 : -1) : null
    const note = typeof it.note === 'string' && it.note.trim() ? it.note.trim().slice(0, 200) : null
    items.push({ entryId: it.entryId, status, stars: status === 'cooked' ? stars : null, thumbs: status === 'cooked' ? thumbs : null, note })
  }
  return { items, by: 'ai' }
}

/* ------------------------------------------------------------------ */
/* Suggestions: history and snoozes                                    */
/* ------------------------------------------------------------------ */

/**
 * What the phone needs to rank suggestions beyond the meals payload: dated
 * cooks (for "this time last year" and recency) and how many weeks the Notes
 * import covered (so undated counts become a rough cadence).
 */
export function historyPayload(db, householdId) {
  const entries = db
    .prepare(
      `SELECT dish_id, date FROM plan_entries
        WHERE household_id = ? AND date IS NOT NULL AND dish_id IS NOT NULL AND kind IN ('dish', 'freezer') AND status = 'cooked'
        ORDER BY date`,
    )
    .all(householdId)
    .map((r) => ({ dishId: r.dish_id, date: r.date }))
  // import_key is notes:<source>:<week>:<index>; count distinct <source>:<week>.
  const keys = db.prepare('SELECT import_key FROM plan_entries WHERE household_id = ? AND import_key IS NOT NULL').all(householdId)
  const distinct = new Set(keys.map((k) => k.import_key.split(':').slice(0, 3).join(':')))
  return { entries, importedWeeks: distinct.size }
}

/** "Not now": keep a meal out of suggestions until `until` (default 3 weeks from today). 0 days clears it. */
export function snooze(db, householdId, dishId, { today, days = 21 }) {
  findDish(db, householdId, dishId)
  requireDay(today, 'today')
  if (!Number.isInteger(days) || days < 0 || days > 365) throw new HttpError(400, 'days must be 0 to 365')
  if (days === 0) {
    db.prepare('DELETE FROM suggestion_snoozes WHERE household_id = ? AND dish_id = ?').run(householdId, dishId)
    return null
  }
  const until = addDays(today, days)
  db.prepare(
    `INSERT INTO suggestion_snoozes (household_id, dish_id, until) VALUES (?, ?, ?)
     ON CONFLICT(household_id, dish_id) DO UPDATE SET until = excluded.until`,
  ).run(householdId, dishId, until)
  return until
}
