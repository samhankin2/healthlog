/**
 * Meal planner routes — SPEC §6 "Meal planner".
 *
 * Every planner route resolves the caller's household first and scopes all
 * reads and writes to it. The mealplan frontend (its own repo) is the client.
 */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { asObject } from '../lib/validate.js'
import { ensureHousehold, householdPayload } from '../lib/planner/household.js'
import { addAlias, addNote, createMeal, mealsPayload, setHidden, setRating, updateMeal } from '../lib/planner/meals.js'
import { matchLine, parseWeek } from '../lib/planner/match.js'
import { clearSlot, copyWeek, linkSlot, moveSlot, requireDay, setSlot, weekDays, weekdayOf, weekPayload } from '../lib/planner/week.js'
import { addFreezer, freezerList, reviewQueue, setFreezerPortions, setReview, updateEntry } from '../lib/planner/review.js'
import { deletePhoto, photoFile, readRawBody, savePhoto } from '../lib/planner/photos.js'
import { historyPayload, parseReviewLine, snooze } from '../lib/planner/insights.js'
import fs from 'node:fs'
import { addItem, clearChecked, removeItem, shoppingPayload, updateItem } from '../lib/planner/shopping.js'

/** The caller and their household id; use at the top of every planner route. */
export function plannerContext(req) {
  const user = requireUser(req)
  const db = getDb()
  return { user, db, householdId: ensureHousehold(db, user) }
}

const nullableInt = (value, field) => {
  if (value === undefined || value === null) return value ?? null
  if (!Number.isInteger(value)) throw new HttpError(400, `${field} must be a whole number or null`)
  return value
}

const mealPayload = (db, householdId, id) => mealsPayload(db, householdId).find((m) => m.id === id)

export function registerPlannerRoutes(router) {
  router.get('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })

  router.put('/api/planner/household', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    if (body.weekStartDay !== undefined) {
      if (!Number.isInteger(body.weekStartDay) || body.weekStartDay < 0 || body.weekStartDay > 6) {
        throw new HttpError(400, 'weekStartDay must be 0 (Monday) to 6 (Sunday)')
      }
      db.prepare('UPDATE households SET week_start_day = ? WHERE id = ?').run(body.weekStartDay, householdId)
    }
    sendJson(res, 200, { ok: true, household: householdPayload(db, user, householdId) })
  })

  /* ---------- meals ---------- */

  router.get('/api/planner/meals', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, meals: mealsPayload(db, householdId) })
  })

  router.post('/api/planner/meals', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const { id, created } = createMeal(db, householdId, body.name)
    sendJson(res, created ? 201 : 200, { ok: true, created, meal: mealPayload(db, householdId, id) })
  })

  router.put('/api/planner/meals/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    updateMeal(db, householdId, params.id, {
      tags: body.tags,
      suggestedTags: body.suggestedTags,
      effort: body.effort === undefined ? undefined : nullableInt(body.effort, 'effort'),
      tips: body.tips,
      neverSuggest: body.neverSuggest,
      regularEveryDays: body.regularEveryDays === undefined ? undefined : nullableInt(body.regularEveryDays, 'regularEveryDays'),
      coverPhotoId: body.coverPhotoId,
      archived: body.archived === undefined ? undefined : Boolean(body.archived),
    })
    // An archived meal drops out of the payload: null.
    sendJson(res, 200, { ok: true, meal: mealPayload(db, householdId, params.id) ?? null })
  })

  router.post('/api/planner/meals/:id/aliases', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, alias: addAlias(db, householdId, params.id, body.alias) })
  })

  router.put('/api/planner/ratings', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    if (typeof body.dishId !== 'string') throw new HttpError(400, 'dishId is required')
    if (typeof body.ratedAs !== 'string') throw new HttpError(400, 'ratedAs is required')
    const rating = setRating(db, householdId, user, {
      dishId: body.dishId,
      optionId: typeof body.optionId === 'string' && body.optionId ? body.optionId : null,
      ratedAs: body.ratedAs,
      thumbs: nullableInt(body.thumbs, 'thumbs'),
      stars: nullableInt(body.stars, 'stars'),
      want: body.want === true,
    })
    sendJson(res, 200, { ok: true, rating })
  })

  router.put('/api/planner/meals/:id/hidden', async ({ req, res, params }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, hidden: setHidden(db, householdId, user, params.id, body.optionId, body.hidden !== false) })
  })

  router.post('/api/planner/meals/:id/notes', async ({ req, res, params }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 201, { ok: true, note: addNote(db, householdId, user, params.id, body.body) })
  })

  /* ---------- the week ---------- */

  router.get('/api/planner/week', async ({ req, res, query }) => {
    const { db, householdId } = plannerContext(req)
    const start = requireDay(query?.get('start'), 'start')
    sendJson(res, 200, { ok: true, week: weekPayload(db, householdId, start) })
  })

  router.put('/api/planner/slots/:date', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const entry = setSlot(db, householdId, params.date, {
      kind: body.kind ?? 'dish',
      dishId: body.dishId ?? null,
      optionIds: body.optionIds ?? [],
      note: body.note ?? null,
      raw: body.raw ?? null,
      freezerItemId: body.freezerItemId ?? null,
    })
    sendJson(res, 200, { ok: true, entry })
  })

  // A night typed like a note: saved as the words at once, linked to a meal when code is sure.
  router.put('/api/planner/slots/:date/text', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const line = await matchLine(db, householdId, String(body.text ?? ''))
    if (line.kind === null) {
      clearSlot(db, householdId, params.date)
      return sendJson(res, 200, { ok: true, entry: null, pending: false })
    }
    const sure = line.kind !== 'dish' || (line.dishId && line.confidence >= 0.85)
    const entry = setSlot(db, householdId, params.date, {
      kind: line.kind,
      dishId: sure ? line.dishId : null,
      optionIds: sure ? line.optionIds : [],
      raw: line.raw,
    })
    sendJson(res, 200, { ok: true, entry, pending: !sure })
  })

  // In the background, after /text: try harder (AI, with our meals) to find the meal.
  router.post('/api/planner/slots/:date/match', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    requireDay(params.date)
    const row = db.prepare("SELECT raw, dish_id, kind FROM plan_entries WHERE household_id = ? AND slot = 'dinner' AND date = ?").get(householdId, params.date)
    if (!row || row.kind !== 'dish' || row.dish_id || !row.raw) return sendJson(res, 200, { ok: true, matched: false, entry: null, candidates: [] })
    const line = await matchLine(db, householdId, row.raw, { useAi: true })
    const candidates = line.candidates.slice(0, 2)
    // Only if the words haven't changed meanwhile.
    const still = db.prepare("SELECT raw, dish_id FROM plan_entries WHERE household_id = ? AND slot = 'dinner' AND date = ?").get(householdId, params.date)
    if (line.dishId && line.confidence >= 0.7 && still?.raw === row.raw && !still.dish_id) {
      const entry = linkSlot(db, householdId, params.date, line.dishId, line.optionIds)
      return sendJson(res, 200, { ok: true, matched: true, by: line.by, entry, candidates })
    }
    sendJson(res, 200, { ok: true, matched: false, entry: null, candidates })
  })

  // "Not this" / "Did you mean": point a typed night at a meal, or at none.
  router.put('/api/planner/slots/:date/link', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const entry = linkSlot(db, householdId, params.date, body.dishId ? String(body.dishId) : null, Array.isArray(body.optionIds) ? body.optionIds : [])
    sendJson(res, 200, { ok: true, entry })
  })

  router.delete('/api/planner/slots/:date', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    clearSlot(db, householdId, params.date)
    sendJson(res, 200, { ok: true, cleared: params.date })
  })

  router.post('/api/planner/slots/move', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, ...moveSlot(db, householdId, String(body.from ?? ''), String(body.to ?? '')) })
  })

  router.post('/api/planner/week/copy', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const from = requireDay(body.from, 'from')
    const to = requireDay(body.to, 'to')
    const copied = copyWeek(db, householdId, from, to)
    sendJson(res, 200, { ok: true, copied, week: weekPayload(db, householdId, to) })
  })

  router.post('/api/planner/parse-week', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const start = requireDay(body.start, 'start')
    const text = String(body.text ?? '')
    if (!text.trim()) throw new HttpError(400, 'Type the week first')
    if (text.length > 2000) throw new HttpError(400, 'That is too long for one week')
    const days = weekDays(start)
    const items = await parseWeek(db, householdId, text, days, days.map(weekdayOf), { useAi: body.ai !== false })
    sendJson(res, 200, { ok: true, items })
  })
  /* ---------- the review (M3) ---------- */

  router.get('/api/planner/review', async ({ req, res, query }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, entries: reviewQueue(db, householdId, requireDay(query?.get('today'), 'today')) })
  })

  router.put('/api/planner/entries/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const entry = updateEntry(db, householdId, params.id, {
      status: body.status,
      swapToDishId: body.swapToDishId,
      swapOptionIds: body.swapOptionIds,
      cookNote: body.cookNote,
      leftovers: body.leftovers,
      frozenPortions: body.frozenPortions,
      tweakRetry: body.tweakRetry,
    })
    sendJson(res, 200, { ok: true, entry })
  })

  router.put('/api/planner/entries/:id/review', async ({ req, res, params }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    if (typeof body.ratedAs !== 'string') throw new HttpError(400, 'ratedAs is required')
    const entry = setReview(db, householdId, user, params.id, {
      ratedAs: body.ratedAs,
      thumbs: nullableInt(body.thumbs, 'thumbs'),
      stars: nullableInt(body.stars, 'stars'),
    })
    sendJson(res, 200, { ok: true, entry })
  })

  /* ---------- freezer ---------- */

  router.get('/api/planner/freezer', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, items: freezerList(db, householdId) })
  })

  router.post('/api/planner/freezer', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const item = addFreezer(db, householdId, {
      dishId: String(body.dishId ?? ''),
      optionIds: Array.isArray(body.optionIds) ? body.optionIds.map(String) : [],
      portions: body.portions,
      frozenOn: body.frozenOn ?? null,
    })
    sendJson(res, 201, { ok: true, item })
  })

  router.put('/api/planner/freezer/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, item: setFreezerPortions(db, householdId, params.id, body.portions) })
  })

  /* ---------- photos ---------- */

  // Body: the JPEG itself (the phone resizes first). Query: dishId, entryId?
  router.post('/api/planner/photos', async ({ req, res, query }) => {
    const { user, db, householdId } = plannerContext(req)
    const type = String(req.headers['content-type'] ?? '')
    if (!/^image\/jpe?g\b/.test(type)) throw new HttpError(415, 'Send the photo as image/jpeg')
    const bytes = await readRawBody(req)
    const photo = savePhoto(db, householdId, user, { dishId: String(query?.get('dishId') ?? ''), entryId: query?.get('entryId') || null, bytes })
    sendJson(res, 201, { ok: true, photo })
  })

  // Images can't send the bearer token from an <img>, so the app fetches them as blobs.
  router.get('/api/planner/photos/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const file = photoFile(db, householdId, params.id)
    const data = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(data.length), 'cache-control': 'private, max-age=31536000, immutable' })
    res.end(data)
  })

  router.delete('/api/planner/photos/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    deletePhoto(db, householdId, params.id)
    sendJson(res, 200, { ok: true, deleted: params.id })
  })

  /* ---------- one-line review, suggestions ---------- */

  router.post('/api/planner/parse-review', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const today = requireDay(body.today, 'today')
    const text = String(body.text ?? '').trim()
    if (!text) throw new HttpError(400, 'Say how the week went first')
    if (text.length > 1000) throw new HttpError(400, 'That is too long for one line')
    const queue = reviewQueue(db, householdId, today)
    if (queue.length === 0) throw new HttpError(409, 'Nothing to review')
    sendJson(res, 200, { ok: true, ...(await parseReviewLine(db, householdId, queue, text)) })
  })

  router.get('/api/planner/history', async ({ req, res }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, ...historyPayload(db, householdId) })
  })

  router.put('/api/planner/meals/:id/snooze', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const until = snooze(db, householdId, params.id, { today: String(body.today ?? ''), days: body.days ?? 21 })
    sendJson(res, 200, { ok: true, until })
  })

  /* ---------- shopping (M5) ---------- */

  router.get('/api/planner/shopping', async ({ req, res, query }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, ...shoppingPayload(db, householdId, requireDay(query?.get('week'), 'week')) })
  })

  router.post('/api/planner/shopping/items', async ({ req, res }) => {
    const { user, db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    const item = await addItem(db, householdId, user, {
      week: String(body.week ?? ''),
      name: body.name,
      qty: body.qty ?? null,
      dishId: typeof body.dishId === 'string' && body.dishId ? body.dishId : null,
      section: body.section ?? null,
    })
    sendJson(res, 201, { ok: true, item })
  })

  router.put('/api/planner/shopping/items/:id', async ({ req, res, params }) => {
    const { db, householdId } = plannerContext(req)
    const body = asObject(await readJsonBody(req))
    sendJson(res, 200, { ok: true, item: updateItem(db, householdId, params.id, { checked: body.checked, qty: body.qty, section: body.section }) })
  })

  router.delete('/api/planner/shopping/items/:id', async ({ req, res, params, query }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, item: removeItem(db, householdId, params.id, query?.get('dishId') || null) })
  })

  router.delete('/api/planner/shopping/checked', async ({ req, res, query }) => {
    const { db, householdId } = plannerContext(req)
    sendJson(res, 200, { ok: true, cleared: clearChecked(db, householdId, requireDay(query?.get('week'), 'week')) })
  })
}
