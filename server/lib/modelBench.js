/**
 * Model benchmark — SPEC §7 "Model benchmark".
 *
 * Every food message is also sent, in the background, to a panel of extra
 * models (`AI_BENCH_MODELS`). Nothing they say reaches the reply or the saved
 * meal: they exist only to measure how the two models the app actually uses
 * (A and B) compare. Each estimate — primary or benchmark — is one
 * `model_runs` row, and `buildBench()` scores them.
 *
 * Two yardsticks, because there is no lab-measured truth:
 *  - **corrected**: the user changed the numbers (a chat correction, or an
 *    edit of the saved meal). The final saved total is the reference. This is
 *    the closest thing to ground truth, but it is sparse.
 *  - **consensus**: the median of the whole panel. Each model is scored
 *    against the median of the *other* models (leave-one-out), so it is never
 *    graded against itself. Consensus measures agreement, not truth — a panel
 *    can share a blind spot.
 *
 * Cost guard: the benchmark shares the AI key with the real flow, so it never
 * uses the free fallback provider, runs at most MAX_IN_FLIGHT batches at once,
 * and stops for PAUSE_MS after any 402/429 so it cannot eat the quota the
 * primary pair needs.
 */
import { randomUUID } from 'node:crypto'
import { aiConfig, analyseWithModel, analysisMessages, isMocked, mockModelOutput, mockModeFor, normaliseModelOutput, userTextFromPrompt } from '../ai.js'

/** Five extra estimators across sizes and vendors (all on the OpenCode Go endpoint). */
export const DEFAULT_BENCH_MODELS = ['qwen3.8-max', 'kimi-k3', 'gpt-5.6-luna', 'deepseek-v4.1-flash', 'glm-5.3-flash']

const MAX_IN_FLIGHT = 2
const PAUSE_MS = 60 * 60 * 1000
const LIMIT_RE = /HTTP (402|429)\b/
/** A panel estimate this far apart (spread / consensus) counts as a disagreement. */
export const DIFFER_PCT = 20
/** Saved total differing from the proposed total by more than this is a user correction. */
const EDIT_TOLERANCE = { abs: 10, pct: 0.03 }

let inFlight = 0
let pausedUntil = 0
const running = new Set()

export function benchConfig() {
  const raw = (process.env.AI_BENCH_MODELS ?? '').trim()
  const off = ['0', 'off', 'false', 'no', 'none'].includes(raw.toLowerCase())
  const list = off ? [] : raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_BENCH_MODELS
  const ai = aiConfig()
  // The primaries are already measured; asking them twice would only double-count.
  const models = [...new Set(list)].filter((m) => m !== ai.modelA && m !== ai.modelB)
  return { enabled: models.length > 0, models, modelA: ai.modelA, modelB: ai.modelB }
}

/** Rough size class from the model id — a label for the charts, nothing more. */
export function modelTier(model) {
  const m = String(model).toLowerCase()
  if (/flash|mini|nano|haiku|lite|instant|small|\b[1-9]b\b|-8b/.test(m)) return 'small'
  if (/max|pro|opus|ultra|k3$|70b|large/.test(m)) return 'large'
  return 'medium'
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

function runFields(output) {
  if (!output || output.error || !output.total) {
    return { kcal: null, protein_g: null, carbs_g: null, fat_g: null, meal_count: null, confidence: null, error: String(output?.error || 'no output').slice(0, 300) }
  }
  return {
    kcal: output.total.kcal,
    protein_g: output.total.protein_g,
    carbs_g: output.total.carbs_g,
    fat_g: output.total.fat_g,
    meal_count: output.meals?.length || 1,
    confidence: typeof output.confidence === 'number' ? output.confidence : null,
    error: null,
  }
}

export function recordRun(db, { analysisId, userId, model, role, output, latencyMs = null, createdAt = null }) {
  const f = runFields(output)
  db.prepare(
    `INSERT INTO model_runs (id, analysis_id, user_id, model, role, kcal, protein_g, carbs_g, fat_g,
                             meal_count, confidence, latency_ms, error, output, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    randomUUID(), analysisId, userId, String(model), role, f.kcal, f.protein_g, f.carbs_g, f.fat_g,
    f.meal_count, f.confidence, latencyMs == null ? null : Math.round(latencyMs), f.error,
    f.error ? null : JSON.stringify(output), createdAt,
  )
}

/** The two estimates the app used, recorded alongside the benchmark (adds their latency). */
export function recordPrimaryRuns(db, analysisId, userId, result) {
  try {
    recordRun(db, { analysisId, userId, model: result.modelA, role: 'a', output: result.outputA, latencyMs: result.latencyA })
    recordRun(db, { analysisId, userId, model: result.modelB, role: 'b', output: result.outputB, latencyMs: result.latencyB })
  } catch (err) {
    console.error(`model bench: could not record primary runs: ${err?.message || err}`)
  }
}

/* ------------------------------------------------------------------ */
/* Background runner                                                   */
/* ------------------------------------------------------------------ */

/** Deterministic offline stand-in: the mock "agree" answer, nudged ±20% per model. */
function mockBenchOutput(model, userMessage, index) {
  const base = mockModelOutput('A', 'agree')
  let h = 2166136261
  for (const ch of `${model}|${userMessage}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const f = 1 + ((h % 41) - 20) / 100
  const scaled = {
    items: base.items.map((i) => ({ ...i, kcal: i.kcal * f, protein_g: i.protein_g * f, carbs_g: i.carbs_g * f, fat_g: i.fat_g * f })),
    confidence: 0.5 + (index % 4) / 10,
    notes: `mock bench ${model}`,
  }
  if (mockModeFor(userMessage) === 'fail-both' && index === 0) throw new Error('mock failure: bench model unavailable (HTTP 503)')
  return normaliseModelOutput(JSON.stringify(scaled))
}

/**
 * Ask the benchmark panel about one analysis, in the background. Returns the
 * promise (for tests) or null when skipped. Never throws.
 */
export function startBench(db, { analysisId, userId, promptText, userMessage }) {
  const cfg = benchConfig()
  if (!cfg.enabled || Date.now() < pausedUntil || inFlight >= MAX_IN_FLIGHT) return null
  inFlight++
  const p = runBench(db, cfg.models, { analysisId, userId, promptText, userMessage })
    .catch((err) => console.error(`model bench failed: ${err?.message || err}`))
    .finally(() => {
      inFlight--
      running.delete(p)
    })
  running.add(p)
  return p
}

/** Resolves once every background batch has finished (QA + graceful shutdown). */
export function benchIdle() {
  return Promise.allSettled([...running])
}

export function benchPaused() {
  return Date.now() < pausedUntil
}

/**
 * Ask `models` (in parallel) about one prompt and record each answer as a
 * `bench` run. Shared by the live background run and the backfill, so both
 * send exactly what the primary pair was sent. Resolves with
 * `{ ok, failed, limited }` — `limited` when any model hit a 402/429.
 */
async function askPanel(db, models, { analysisId, userId, promptText, userMessage, createdAt = null }) {
  // Never the free fallback: a fallback answer would be a different model under the same name.
  const ai = { ...aiConfig(), fallback: false }
  const messages = analysisMessages(promptText)
  const mocked = isMocked(ai)
  const all = benchConfig().models
  const tally = { ok: 0, failed: 0, limited: false }
  await Promise.all(
    models.map(async (model) => {
      let res
      if (mocked) {
        const index = Math.max(0, all.indexOf(model))
        let output
        try {
          output = mockBenchOutput(model, userMessage, index)
        } catch (err) {
          output = { error: err.message }
        }
        res = { output, latencyMs: 50 * (index + 1) }
      } else {
        res = await analyseWithModel({ variant: 'A', model, messages, sessionId: `healthlog-bench-${userId}`, userMessage, cfg: ai })
      }
      if (LIMIT_RE.test(res.output?.error || '')) tally.limited = true
      if (res.output?.error || !res.output?.total) tally.failed++
      else tally.ok++
      try {
        recordRun(db, { analysisId, userId, model, role: 'bench', output: res.output, latencyMs: res.latencyMs, createdAt })
      } catch (err) {
        // The analysis can be deleted (account removal) while the panel is still thinking.
        if (!/FOREIGN KEY/i.test(err?.message || '')) throw err
      }
    }),
  )
  return tally
}

async function runBench(db, models, input) {
  const tally = await askPanel(db, models, input)
  if (tally.limited) pausedUntil = Date.now() + PAUSE_MS
}

/* ------------------------------------------------------------------ */
/* Backfill: ask the panel about meals logged before it existed        */
/* ------------------------------------------------------------------ */

/**
 * Original analyses (not corrections) missing a successful answer from one or
 * more panel models. Oldest first.
 */
export function backfillTargets(db, { userId = null, days = null, models = benchConfig().models, retryFailed = false, limit = null } = {}) {
  const where = ['a.revises_id IS NULL', "a.prompt_text NOT LIKE '%Your previous estimate was:%'"]
  const params = []
  if (userId) {
    where.push('a.user_id = ?')
    params.push(userId)
  }
  if (days) {
    where.push("a.created_at >= datetime('now', ?)")
    params.push(`-${Math.floor(days)} days`)
  }
  const rows = db
    .prepare(`SELECT a.id, a.user_id, a.prompt_text, a.created_at FROM analyses a WHERE ${where.join(' AND ')} ORDER BY a.created_at, a.rowid`)
    .all(...params)
  const have = db.prepare("SELECT model, error FROM model_runs WHERE analysis_id = ? AND role = 'bench'")
  const out = []
  for (const row of rows) {
    const runs = have.all(row.id)
    const done = new Set(runs.filter((r) => !r.error || !retryFailed).map((r) => r.model))
    const missing = models.filter((m) => !done.has(m))
    if (missing.length) out.push({ ...row, missing })
    if (limit && out.length >= limit) break
  }
  return out
}

/**
 * Run the panel over earlier meals, one meal at a time (its models in
 * parallel), with a pause between meals. Stops at the first 402/429 so the
 * quota the live app needs is left alone; re-running continues where it
 * stopped, because only missing answers are asked for. Runs are stamped with
 * the analysis's own time, so the date-range filters still place them right.
 */
export async function backfillBench(db, { userId = null, days = null, limit = null, models = null, retryFailed = false, dryRun = false, delayMs = 1000, onProgress = () => {} } = {}) {
  const panel = models?.length ? models : benchConfig().models
  const targets = backfillTargets(db, { userId, days, models: panel, retryFailed, limit })
  const summary = { meals: targets.length, calls: targets.reduce((n, t) => n + t.missing.length, 0), done: 0, ok: 0, failed: 0, stoppedOnLimit: false }
  if (dryRun || !targets.length) return summary
  const dropFailed = db.prepare("DELETE FROM model_runs WHERE analysis_id = ? AND role = 'bench' AND model = ? AND error IS NOT NULL")
  for (const [i, t] of targets.entries()) {
    if (retryFailed) for (const m of t.missing) dropFailed.run(t.id, m)
    const tally = await askPanel(db, t.missing, {
      analysisId: t.id,
      userId: t.user_id,
      promptText: t.prompt_text,
      userMessage: userTextFromPrompt(t.prompt_text),
      createdAt: t.created_at,
    })
    summary.done++
    summary.ok += tally.ok
    summary.failed += tally.failed
    onProgress({ index: i + 1, total: targets.length, target: t, tally })
    if (tally.limited) {
      summary.stoppedOnLimit = true
      break
    }
    if (delayMs && i < targets.length - 1) await new Promise((r) => setTimeout(r, delayMs))
  }
  return summary
}

/* ------------------------------------------------------------------ */
/* Scoring (pure over rows)                                            */
/* ------------------------------------------------------------------ */

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10)

export function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const isRevisionPrompt = (text) => String(text || '').includes('Your previous estimate was:')

function runFromStoredOutput(model, role, text) {
  const out = safeJson(text)
  const f = runFields(out && !out.error ? normaliseModelOutput(JSON.stringify(out)) : out)
  return { model, role, kcal: f.kcal, proteinG: f.protein_g, carbsG: f.carbs_g, fatG: f.fat_g, mealCount: f.meal_count, confidence: f.confidence, latencyMs: null, error: f.error }
}

function runFromRow(row) {
  return {
    model: row.model, role: row.role, kcal: row.kcal, proteinG: row.protein_g, carbsG: row.carbs_g, fatG: row.fat_g,
    mealCount: row.meal_count, confidence: row.confidence, latencyMs: row.latency_ms, error: row.error,
  }
}

const isoTs = (sql) => (sql ? `${String(sql).replace(' ', 'T')}Z` : null)
const pct = (x, ref) => (ref > 0 && Number.isFinite(x) ? ((x - ref) / ref) * 100 : null)

/**
 * Everything the benchmark view needs for one user.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function buildBench(db, userId, { days = 90, now = Date.now() } = {}) {
  const cfg = benchConfig()
  const since = new Date(now - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19)

  const analyses = db
    .prepare(
      `SELECT id, prompt_text, model_a, model_b, result_a, result_b, reconciled, revises_id, created_at
         FROM analyses WHERE user_id = ? AND created_at >= ? ORDER BY created_at, rowid`,
    )
    .all(userId, since)

  const runsBy = new Map()
  for (const row of db.prepare('SELECT * FROM model_runs WHERE user_id = ? AND created_at >= ? ORDER BY created_at').all(userId, since)) {
    if (!runsBy.has(row.analysis_id)) runsBy.set(row.analysis_id, [])
    runsBy.get(row.analysis_id).push(runFromRow(row))
  }

  const saved = new Map()
  for (const row of db
    .prepare(
      `SELECT analysis_id, SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, COUNT(*) AS n
         FROM meals WHERE user_id = ? AND analysis_id IS NOT NULL GROUP BY analysis_id`,
    )
    .all(userId)) saved.set(row.analysis_id, row)

  // Latest correction of each analysis (a chain: original → correction → correction …).
  const childOf = new Map()
  const byId = new Map(analyses.map((a) => [a.id, a]))
  for (const a of analyses) if (a.revises_id) childOf.set(a.revises_id, a)

  const roleOf = (model) => (model === cfg.modelA ? 'a' : model === cfg.modelB ? 'b' : cfg.models.includes(model) ? 'bench' : 'other')

  const logs = []
  for (const a of analyses) {
    if (a.revises_id || isRevisionPrompt(a.prompt_text)) continue

    // Runs: the recorded rows, with A/B rebuilt from the analysis for rows that predate recording.
    const stored = runsBy.get(a.id) ?? []
    const runs = [...stored]
    if (!stored.some((r) => r.role === 'a')) runs.push(runFromStoredOutput(a.model_a, 'a', a.result_a))
    if (!stored.some((r) => r.role === 'b')) runs.push(runFromStoredOutput(a.model_b, 'b', a.result_b))
    for (const r of runs) r.role = roleOf(r.model) === 'other' ? (r.role === 'bench' ? 'bench' : 'other') : roleOf(r.model)

    const proposed = safeJson(a.reconciled)?.total ?? null
    let final = a
    for (let guard = 0; childOf.has(final.id) && guard < 50; guard++) final = childOf.get(final.id)
    const finalProposed = final === a ? proposed : safeJson(final.reconciled)?.total ?? null
    const s = saved.get(final.id)

    let reference = null
    let outcome = s ? 'accepted' : 'unsaved'
    if (s && finalProposed) {
      const diff = Math.abs(s.kcal - finalProposed.kcal)
      const edited = diff > Math.max(EDIT_TOLERANCE.abs, EDIT_TOLERANCE.pct * finalProposed.kcal)
      if (final !== a || edited) {
        reference = { kcal: r1(s.kcal), proteinG: r1(s.protein_g), source: final !== a ? 'chat correction' : 'edited meal' }
        outcome = 'corrected'
      }
    }

    const valid = runs.filter((r) => r.kcal != null && r.kcal > 0)
    const consensus = valid.length >= 3 ? median(valid.map((r) => r.kcal)) : null
    const consensusProtein = valid.length >= 3 ? median(valid.map((r) => r.proteinG)) : null
    for (const r of runs) {
      r.devPct = r.kcal != null && consensus ? r1(pct(r.kcal, consensus)) : null
      const others = valid.filter((o) => o !== r)
      const loo = r.kcal != null && others.length >= 2 ? median(others.map((o) => o.kcal)) : null
      r.looDevPct = loo ? r1(pct(r.kcal, loo)) : null
      const looP = r.proteinG != null && others.length >= 2 ? median(others.map((o) => o.proteinG)) : null
      r.looProteinDiffG = looP != null ? r1(r.proteinG - looP) : null
      r.refDevPct = reference && r.kcal != null ? r1(pct(r.kcal, reference.kcal)) : null
    }
    const kcals = valid.map((r) => r.kcal)
    const spreadPct = consensus && kcals.length >= 2 ? r1(((Math.max(...kcals) - Math.min(...kcals)) / consensus) * 100) : null
    const runA = runs.find((r) => r.role === 'a')
    const runB = runs.find((r) => r.role === 'b')
    const abPct = runA?.kcal && runB?.kcal ? r1((Math.abs(runA.kcal - runB.kcal) / Math.max(runA.kcal, runB.kcal)) * 100) : null

    logs.push({
      id: a.id,
      createdAt: isoTs(a.created_at),
      text: userTextFromPrompt(a.prompt_text).slice(0, 160),
      logged: proposed ? { kcal: r1(proposed.kcal), proteinG: r1(proposed.protein_g) } : null,
      loggedDevPct: proposed && consensus ? r1(pct(proposed.kcal, consensus)) : null,
      loggedRefDevPct: proposed && reference ? r1(pct(proposed.kcal, reference.kcal)) : null,
      loggedProteinDiffG: proposed && consensusProtein != null ? r1(proposed.protein_g - consensusProtein) : null,
      consensusKcal: r1(consensus),
      spreadPct,
      abPct,
      differed: spreadPct != null && spreadPct > DIFFER_PCT,
      outcome,
      reference,
      runs: runs.sort((x, y) => order(x.role) - order(y.role) || x.model.localeCompare(y.model)),
    })
  }

  const models = summarise(logs)
  return {
    config: { enabled: cfg.enabled, paused: benchPaused(), modelA: cfg.modelA, modelB: cfg.modelB, bench: cfg.models, differPct: DIFFER_PCT },
    days,
    totals: {
      logs: logs.length,
      benchmarked: logs.filter((l) => l.consensusKcal != null && l.runs.some((r) => r.role === 'bench')).length,
      differed: logs.filter((l) => l.differed).length,
      corrected: logs.filter((l) => l.outcome === 'corrected').length,
      accepted: logs.filter((l) => l.outcome === 'accepted').length,
      // How far apart the models are on a typical meal.
      medianSpreadPct: r1(median(logs.map((l) => l.spreadPct).filter((x) => x != null))),
      medianAbPct: r1(median(logs.map((l) => l.abPct).filter((x) => x != null))),
    },
    models,
    pairs: pairMatrix(logs, models.filter((m) => m.role !== 'logged').map((m) => m.model)),
    logs: logs.slice(-300).reverse(),
  }
}

const ROLE_ORDER = { logged: 0, a: 1, b: 2, bench: 3, other: 4 }
const order = (role) => ROLE_ORDER[role] ?? 9

function stats(devs) {
  const v = devs.filter((d) => d != null && Number.isFinite(d))
  if (!v.length) return { n: 0, medianAbsPct: null, biasPct: null, within10: null, within20: null }
  return {
    n: v.length,
    medianAbsPct: r1(median(v.map(Math.abs))),
    biasPct: r1(median(v)),
    within10: r1((v.filter((d) => Math.abs(d) <= 10).length / v.length) * 100),
    within20: r1((v.filter((d) => Math.abs(d) <= 20).length / v.length) * 100),
  }
}

function summarise(logs) {
  const byModel = new Map()
  for (const l of logs) {
    for (const r of l.runs) {
      if (!byModel.has(r.model)) byModel.set(r.model, { model: r.model, role: r.role, runs: [] })
      byModel.get(r.model).runs.push(r)
    }
  }
  const out = [...byModel.values()].map(({ model, role, runs }) => {
    const failures = runs.filter((r) => r.kcal == null).length
    const lat = runs.map((r) => r.latencyMs).filter((x) => x != null)
    return {
      model,
      role,
      tier: modelTier(model),
      runs: runs.length,
      failures,
      failRate: r1((failures / runs.length) * 100),
      medianLatencyMs: lat.length ? Math.round(median(lat)) : null,
      consensus: stats(runs.map((r) => r.looDevPct)),
      corrected: stats(runs.map((r) => r.refDevPct)),
      proteinMedianAbsG: r1(median(runs.map((r) => r.looProteinDiffG).filter((x) => x != null).map(Math.abs))),
    }
  })
  const withLogged = logs.filter((l) => l.logged)
  out.push({
    model: 'Logged value',
    role: 'logged',
    tier: null,
    runs: withLogged.length,
    failures: 0,
    failRate: 0,
    medianLatencyMs: null,
    consensus: stats(withLogged.map((l) => l.loggedDevPct)),
    corrected: stats(withLogged.map((l) => l.loggedRefDevPct)),
    proteinMedianAbsG: r1(median(withLogged.map((l) => l.loggedProteinDiffG).filter((x) => x != null).map(Math.abs))),
  })
  return out.sort((x, y) => order(x.role) - order(y.role) || (x.consensus.medianAbsPct ?? 999) - (y.consensus.medianAbsPct ?? 999))
}

/** Median pairwise gap (% of the larger) between every two models, over logs where both answered. */
function pairMatrix(logs, models) {
  const cells = models.map((ma) =>
    models.map((mb) => {
      if (ma === mb) return { pct: 0, n: 0 }
      const gaps = []
      for (const l of logs) {
        const ka = l.runs.find((r) => r.model === ma)?.kcal
        const kb = l.runs.find((r) => r.model === mb)?.kcal
        if (ka > 0 && kb > 0) gaps.push((Math.abs(ka - kb) / Math.max(ka, kb)) * 100)
      }
      return { pct: r1(median(gaps)), n: gaps.length }
    }),
  )
  return { models, cells }
}
