/**
 * Chat / AI routes — SPEC §6 "Chat / AI" and SPEC §7.
 *
 * POST /api/chat runs the dual-model pipeline, stores the assistant message,
 * and (unless `save: false`) stores the meal. Retrying the same request with an
 * `Idempotency-Key` header (or `clientId` in the body) within 2 minutes returns
 * the original response instead of running the models again.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { alias, asObject, clampInt, requireString } from '../lib/validate.js'
import { isISODate, sumIntake, today } from '../lib/metrics.js'
import { chatMessagePayload } from '../lib/shape.js'
import { analysisPayload, runAnalysis, userTextFromPrompt } from '../ai.js'
import { findMeal, insertMeal } from '../lib/meals.js'
import { chatByUser } from '../lib/ratelimit.js'

/** In-memory idempotency cache: `${userId}|${key}` → {at, body}. */
const replyCache = new Map()
const REPLY_TTL_MS = 2 * 60 * 1000
const REPLY_CACHE_MAX = 200

function cacheGet(key) {
  const hit = replyCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > REPLY_TTL_MS) {
    replyCache.delete(key)
    return null
  }
  return hit.body
}

function cacheSet(key, body) {
  if (replyCache.size >= REPLY_CACHE_MAX) {
    const oldest = replyCache.keys().next().value
    if (oldest) replyCache.delete(oldest)
  }
  replyCache.set(key, { at: Date.now(), body })
}

/** Human-readable assistant reply: reconciled numbers + comparison + assumptions. */
function assistantText(result) {
  const reconciled = result.reconciled
  if (!reconciled) {
    if (/HTTP (402|429)/.test(result.error || '')) {
      return (
        'The AI usage limit has been reached for now (limits reset every few hours). ' +
        'Nothing was saved — please try again later.'
      )
    }
    const why = result.error ? ` (${result.error})` : ''
    return (
      `Sorry — I couldn't estimate that one${why}. Nothing was saved. ` +
      'Try describing the meal again with rough portions, e.g. "2 eggs on toast with butter".'
    )
  }
  const t = reconciled.total
  const groups = reconciled.meals ?? []
  const lines = [
    groups.length > 1
      ? `Logged ${groups.length} separate meals, about ${Math.round(t.kcal)} kcal in total:`
      : `About ${Math.round(t.kcal)} kcal — protein ${Math.round(t.protein_g)} g, carbs ${Math.round(t.carbs_g)} g, fat ${Math.round(t.fat_g)} g.`,
  ]
  if (groups.length > 1) {
    for (const g of groups) {
      const gt = g.total
      lines.push(
        `• ${g.name || mealName(g, '')} — ${Math.round(gt.kcal)} kcal (protein ${Math.round(gt.protein_g)} g, carbs ${Math.round(gt.carbs_g)} g, fat ${Math.round(gt.fat_g)} g)`,
      )
    }
  }
  lines.push('', result.comparison)

  const notes =
    result.chosen === 'B'
      ? result.outputB?.notes
      : result.chosen === 'A' || result.chosen === 'mean'
        ? (result.outputA?.notes || result.outputB?.notes)
        : null
  if (notes) lines.push('', `Assumption: ${notes}`)

  if ((reconciled.meals ?? []).length <= 1 && Array.isArray(reconciled.items) && reconciled.items.length > 0) {
    const parts = reconciled.items.map((i) => `${i.name}${i.quantity ? ` (${i.quantity})` : ''} — ${Math.round(i.kcal)} kcal`)
    lines.push('', `Breakdown: ${parts.join('; ')}.`)
  }
  return lines.join('\n')
}

/** Short meal title: the item names if we have them, else the message. */
function mealName(reconciled, message) {
  const names = (reconciled?.items ?? []).map((i) => i.name).filter(Boolean)
  const fromItems = names.slice(0, 3).join(', ')
  const base = fromItems || String(message)
  return base.length > 80 ? `${base.slice(0, 77)}...` : base
}

export function registerChatRoutes(router) {
  router.get('/api/chat/messages', async ({ req, res, query }) => {
    const user = requireUser(req)
    const db = getDb()
    const limit = clampInt(query.get('limit'), 1, 500, 100)
    const before = query.get('before')

    const params = [user.id]
    let sql = 'SELECT * FROM chat_messages WHERE user_id = ?'
    if (before) {
      // Accept ISO-8601; stored timestamps are `YYYY-MM-DD HH:MM:SS` (UTC).
      const sqlTs = String(before).replace('T', ' ').replace('Z', '').slice(0, 19)
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlTs)) {
        throw new HttpError(400, 'before must be an ISO-8601 timestamp')
      }
      sql += ' AND created_at < ?'
      params.push(sqlTs)
    }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params).reverse() // oldest → newest
    sendJson(res, 200, { ok: true, messages: rows.map(chatMessagePayload) })
  })

  router.post('/api/chat', async ({ req, res }) => {
    const body = asObject(await readJsonBody(req))
    const user = requireUser(req)
    const db = getDb()

    const message = requireString(alias(body, 'message'), 'message', { max: 4000 })
    const dayRaw = alias(body, 'day')
    if (dayRaw !== undefined && dayRaw !== null && dayRaw !== '' && !isISODate(String(dayRaw))) {
      throw new HttpError(400, 'day must be a calendar date (YYYY-MM-DD)')
    }
    const day = dayRaw ? String(dayRaw) : today()
    const save = body.save !== false

    // Correcting an earlier estimate ("you've underestimated the rice"): the
    // models get their previous answer plus the user's correction.
    let previous = null
    let analysisMessage = message
    const reviseId = alias(body, 'reviseAnalysisId')
    if (reviseId) {
      const row = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(String(reviseId), user.id)
      if (!row) throw new HttpError(404, 'The estimate you are correcting was not found')
      try {
        previous = JSON.parse(row.reconciled)
      } catch {
        previous = null
      }
      const original = userTextFromPrompt(row.prompt_text)
      if (previous && original) analysisMessage = `${original}\nCorrection: ${message}`
      else previous = null
    }

    const idemKey = req.headers['idempotency-key'] || alias(body, 'clientId')
    const cacheKey = idemKey ? `${user.id}|${String(idemKey)}` : null
    if (cacheKey) {
      const cached = cacheGet(cacheKey)
      if (cached) {
        sendJson(res, 200, cached)
        return
      }
    }

    // Counted after the idempotency replay, so a retried request is free.
    chatByUser.consume(`user:${user.id}`)

    const profileRow = db.prepare('SELECT * FROM profile WHERE user_id = ?').get(user.id)
    const latestWeight = db
      .prepare('SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1')
      .get(user.id)
    const mealsToday = db
      .prepare('SELECT kcal, protein_g, carbs_g, fat_g FROM meals WHERE user_id = ? AND day = ?')
      .all(user.id, day)
      .map((m) => ({ kcal: m.kcal, proteinG: m.protein_g, carbsG: m.carbs_g, fatG: m.fat_g }))
    const intake = sumIntake(mealsToday)
    const profileForPrompt = profileRow
      ? {
          currentWeightKg: latestWeight ? Number(latestWeight.weight_kg) : (profileRow.start_weight_kg ?? null),
          goalWeightKg: profileRow.goal_weight_kg ?? null,
          kcalTarget: profileRow.kcal_target ?? null,
          heightCm: profileRow.height_cm ?? null,
          sex: profileRow.sex ?? null,
          age: profileRow.age ?? null,
        }
      : null

    // Record the user's message before doing any slow work.
    const userMsgId = randomUUID()
    db.prepare('INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, ?, ?)').run(
      userMsgId,
      user.id,
      'user',
      message,
    )

    const result = await runAnalysis({
      user,
      message: analysisMessage,
      previous,
      profile: profileForPrompt,
      intake,
      day,
      sessionId: `healthlog-${user.id}`,
    })

    const analysisId = randomUUID()
    let mealId = null
    let meal = null
    let meals = []

    if (result.reconciled && save) {
      const confidence =
        result.chosen === 'B'
          ? result.outputB?.confidence
          : result.chosen === 'A' || result.chosen === 'mean'
            ? result.outputA?.confidence
            : null
      // One saved meal per group the models identified (a dish, a shake, a coffee…).
      const groups = result.reconciled.meals?.length
        ? result.reconciled.meals
        : [{ name: null, items: result.reconciled.items ?? [], total: result.reconciled.total }]
      const baseTime = Date.now()
      const mealIds = groups.map((g, index) => {
        const id = insertMeal(db, user.id, {
          eatenAt: new Date(baseTime + index).toISOString(),
          day,
          name: g.name || mealName(g, analysisMessage),
          description: groups.length > 1 ? `${g.name || mealName(g, analysisMessage)} — from: ${analysisMessage}` : analysisMessage,
          kcal: g.total.kcal,
          proteinG: g.total.protein_g,
          carbsG: g.total.carbs_g,
          fatG: g.total.fat_g,
          source: 'ai',
          confidence: typeof confidence === 'number' ? confidence : null,
          analysisId,
          items: (g.items ?? []).map((i) => ({
            name: i.name,
            quantity: i.quantity,
            kcal: i.kcal,
            proteinG: i.protein_g,
            carbsG: i.carbs_g,
            fatG: i.fat_g,
          })),
        })
        db.prepare('UPDATE meals SET analysis_id = ? WHERE id = ?').run(analysisId, id)
        return id
      })
      mealId = mealIds[0]
      meals = mealIds.map((id) => findMeal(db, user.id, id))
      meal = meals[0]
    }

    db.prepare(
      `INSERT INTO analyses (id, user_id, meal_id, prompt_text, model_a, model_b, result_a, result_b,
                             reconciled, comparison, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      analysisId,
      user.id,
      mealId,
      result.promptText,
      result.modelA,
      result.modelB,
      JSON.stringify(result.outputA),
      JSON.stringify(result.outputB),
      JSON.stringify(result.reconciled),
      result.comparison,
      result.error,
    )

    const analysisRow = db.prepare('SELECT * FROM analyses WHERE id = ?').get(analysisId)

    const assistantId = randomUUID()
    db.prepare(
      'INSERT INTO chat_messages (id, user_id, role, content, meal_id, analysis_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(assistantId, user.id, 'assistant', assistantText(result), mealId, analysisId)
    const assistantRow = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(assistantId)

    const payload = {
      ok: true,
      message: chatMessagePayload(assistantRow),
      meal,
      meals,
      analysis: analysisPayload(analysisRow),
    }
    if (cacheKey) cacheSet(cacheKey, payload)
    sendJson(res, 200, payload)
  })
}
