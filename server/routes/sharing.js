/**
 * Partner sharing routes — SPEC §6 "Partner sharing".
 *
 * A user links one partner (both must name each other), then offers a logged
 * meal to them. The partner sees it in an inbox and either adds it to their
 * own log — with their own corrections — or dismisses it. While an offer is
 * pending it reads the sender's meal live, so a correction the sender makes
 * after sharing is what the partner sees.
 */
import { randomUUID } from 'node:crypto'
import { getDb, withTx } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { asObject, alias } from '../lib/validate.js'
import { attachItems, findMeal, insertMeal } from '../lib/meals.js'
import { linkedPartner, partnerLink, partnerPayload, shortName } from '../lib/partners.js'
import { iso } from '../lib/shape.js'
import { resolveDay, readMealInput } from './meals.js'

const MAX_PENDING = 50

function shareFor(db, userId, id) {
  const share = db.prepare('SELECT * FROM shared_meals WHERE id = ? AND to_user_id = ?').get(id, userId)
  if (!share) throw new HttpError(404, 'Shared meal not found')
  return share
}

export function registerSharingRoutes(router) {
  router.get('/api/partner', async ({ req, res }) => {
    const user = requireUser(req)
    sendJson(res, 200, { ok: true, partner: partnerPayload(partnerLink(getDb(), user.id)) })
  })

  router.put('/api/partner', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const email = String(alias(body, 'email') ?? '').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new HttpError(400, 'That email address does not look valid')
    }
    if (email.toLowerCase() === String(user.email).toLowerCase()) {
      throw new HttpError(400, 'Use your partner’s email, not your own')
    }
    const db = getDb()
    db.prepare(
      `INSERT INTO partners (user_id, partner_email) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET partner_email = excluded.partner_email, created_at = datetime('now')`,
    ).run(user.id, email)
    sendJson(res, 200, { ok: true, partner: partnerPayload(partnerLink(db, user.id)) })
  })

  router.delete('/api/partner', async ({ req, res }) => {
    const user = requireUser(req)
    getDb().prepare('DELETE FROM partners WHERE user_id = ?').run(user.id)
    sendJson(res, 200, { ok: true, partner: null })
  })

  // Offer one of my meals to my linked partner. Idempotent per meal.
  router.post('/api/meals/:id/share', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const meal = db.prepare('SELECT id FROM meals WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!meal) throw new HttpError(404, 'Meal not found')
    const partner = linkedPartner(db, user.id)
    if (!partner) throw new HttpError(409, 'Link a partner in Settings first')

    const existing = db
      .prepare('SELECT * FROM shared_meals WHERE source_meal_id = ? AND to_user_id = ?')
      .get(meal.id, partner.id)
    if (existing) {
      // Re-offering a dismissed meal puts it back in the inbox.
      if (existing.status === 'dismissed') {
        db.prepare("UPDATE shared_meals SET status = 'pending', resolved_at = NULL, created_at = datetime('now') WHERE id = ?").run(existing.id)
      }
      const status = existing.status === 'dismissed' ? 'pending' : existing.status
      sendJson(res, 200, { ok: true, share: { id: existing.id, status, to: shortName(partner) } })
      return
    }
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM shared_meals WHERE to_user_id = ? AND status = 'pending'")
      .get(partner.id).n
    if (pending >= MAX_PENDING) throw new HttpError(409, `${shortName(partner)} already has ${MAX_PENDING} meals waiting`)

    const id = randomUUID()
    db.prepare('INSERT INTO shared_meals (id, from_user_id, to_user_id, source_meal_id) VALUES (?, ?, ?, ?)').run(
      id,
      user.id,
      partner.id,
      meal.id,
    )
    sendJson(res, 201, { ok: true, share: { id, status: 'pending', to: shortName(partner) } })
  })

  // My inbox: pending offers from my currently linked partner, oldest first.
  router.get('/api/shared-meals', async ({ req, res }) => {
    const user = requireUser(req)
    const db = getDb()
    const partner = linkedPartner(db, user.id)
    if (!partner) {
      sendJson(res, 200, { ok: true, shares: [] })
      return
    }
    const rows = db
      .prepare(
        `SELECT s.id AS share_id, s.created_at AS shared_at, m.*
           FROM shared_meals s JOIN meals m ON m.id = s.source_meal_id
          WHERE s.to_user_id = ? AND s.from_user_id = ? AND s.status = 'pending'
          ORDER BY s.created_at ASC, s.rowid ASC LIMIT ?`,
      )
      .all(user.id, partner.id, MAX_PENDING)
    const meals = attachItems(db, rows)
    const from = { name: shortName(partner) }
    const shares = rows.map((row, i) => {
      // The sender's own bookkeeping is not the recipient's business.
      const meal = { ...meals[i] }
      delete meal.analysisId
      delete meal.sharedStatus
      delete meal.confidence
      return { id: row.share_id, from, sharedAt: iso(row.shared_at), meal }
    })
    sendJson(res, 200, { ok: true, shares })
  })

  // Add a shared meal to my log. The body may correct any meal field (name,
  // day, kcal, macros, items); anything left out is copied from the original.
  router.post('/api/shared-meals/:id/accept', async ({ req, res, params }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const db = getDb()
    const share = shareFor(db, user.id, params.id)
    if (share.status === 'accepted' && share.meal_id) {
      const meal = findMeal(db, user.id, share.meal_id)
      if (meal) {
        sendJson(res, 200, { ok: true, meal })
        return
      }
    }
    const partner = linkedPartner(db, user.id)
    if (!partner || partner.id !== share.from_user_id) throw new HttpError(404, 'Shared meal not found')
    const source = db.prepare('SELECT * FROM meals WHERE id = ?').get(share.source_meal_id)
    if (!source) throw new HttpError(404, 'Shared meal not found')

    const input = readMealInput({ ...body, source: 'shared' }, { existing: source })
    const items =
      input.items !== undefined
        ? input.items
        : db.prepare('SELECT * FROM meal_items WHERE meal_id = ? ORDER BY rowid').all(source.id).map((i) => ({
            name: i.name,
            quantity: i.quantity,
            kcal: i.kcal,
            proteinG: i.protein_g,
            carbsG: i.carbs_g,
            fatG: i.fat_g,
          }))
    const day = resolveDay(body, source.day)
    const eatenAtRaw = alias(body, 'eatenAt', 'eaten_at')
    const eatenAt =
      typeof eatenAtRaw === 'string' && eatenAtRaw.trim()
        ? eatenAtRaw.trim()
        : day === source.day
          ? source.eaten_at
          : `${day}T12:00:00.000Z`

    const mealId = withTx(db, () => {
      const id = insertMeal(db, user.id, { ...input, items, day, eatenAt, confidence: null, analysisId: null })
      db.prepare("UPDATE shared_meals SET status = 'accepted', meal_id = ?, resolved_at = datetime('now') WHERE id = ?").run(
        id,
        share.id,
      )
      return id
    })
    sendJson(res, 201, { ok: true, meal: findMeal(db, user.id, mealId) })
  })

  router.post('/api/shared-meals/:id/dismiss', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const share = shareFor(db, user.id, params.id)
    if (share.status === 'pending') {
      db.prepare("UPDATE shared_meals SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?").run(share.id)
    }
    sendJson(res, 200, { ok: true, dismissed: share.id })
  })
}
