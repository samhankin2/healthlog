/**
 * AI food-logging pipeline (SPEC.md §7).
 *
 * Two models estimate a meal independently and in parallel; their numbers are
 * reconciled deterministically in code. A third ("judge") model writes the
 * comparison prose *only* when the two estimates disagree by more than 15%,
 * and never blocks the reply (it has its own timeout + deterministic fallback).
 *
 * Mocking: set `AI_MOCK=1` (or leave `OPENCODE_API_KEY` unset) to run entirely
 * offline with canned, deliberately *different* model A / model B outputs.
 * Modes can be forced with the AI_MOCK value or with markers in the message:
 *   AI_MOCK=agree|disagree|fail-a|fail-both
 *   "#disagree" / "#fail-a" / "#fail-both" in the user message
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'
const DEFAULT_MODEL_A = 'claude-haiku-5-5'
const DEFAULT_MODEL_B = 'gemini-4-argon'
const DEFAULT_JUDGE_MODEL = 'minimax-m3.1-flash'
// Free-tier fallback: used when the primary call fails because the key is out
// of credit / rate limited. Free models live on the non-"go" endpoint.
const DEFAULT_FALLBACK_BASE_URL = 'https://opencode.ai/inference/openai/v1'
const DEFAULT_FALLBACK_MODEL_A = 'deepseek-v4.1-flash-free'
const DEFAULT_FALLBACK_MODEL_B = 'glm-5.3-flash-free'
const DEFAULT_FALLBACK_JUDGE_MODEL = 'nemotron-3.5-lightning-free'
// 401/403 auth, 402 payment required, 429 rate/usage limit.
const FALLBACK_STATUSES = new Set([401, 402, 403, 429])
// Measured against the live OpenCode Go endpoint: a two-model nutrition
// analysis can take 5-25 s per model (gemini-4-argon is the slow one), and the
// judge model burns extra tokens on reasoning. The old 25 s/1200-token budget
// truncated responses to an empty string on reasoning-heavy models.
const MODEL_TIMEOUT_MS = 45000
const JUDGE_TIMEOUT_MS = 30000
const AGREEMENT_TOLERANCE = 0.15 // ratio, not percent
const MAX_TOKENS = 2000

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export function aiConfig() {
  return {
    baseUrl: (process.env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: process.env.OPENCODE_API_KEY || '',
    modelA: process.env.AI_MODEL_A || DEFAULT_MODEL_A,
    modelB: process.env.AI_MODEL_B || DEFAULT_MODEL_B,
    judgeModel: process.env.AI_JUDGE_MODEL || DEFAULT_JUDGE_MODEL,
    mock: (process.env.AI_MOCK || '').trim().toLowerCase(),
    fallback: !['0', 'off', 'false', 'no'].includes((process.env.AI_FALLBACK || '').trim().toLowerCase()),
    fallbackBaseUrl: (process.env.AI_FALLBACK_BASE_URL || DEFAULT_FALLBACK_BASE_URL).replace(/\/+$/, ''),
    fallbackModelA: process.env.AI_FALLBACK_MODEL_A || DEFAULT_FALLBACK_MODEL_A,
    fallbackModelB: process.env.AI_FALLBACK_MODEL_B || DEFAULT_FALLBACK_MODEL_B,
    fallbackJudgeModel: process.env.AI_FALLBACK_JUDGE_MODEL || DEFAULT_FALLBACK_JUDGE_MODEL,
  }
}

/** True when requests should be served from the canned mock instead of the network. */
export function isMocked(cfg = aiConfig()) {
  if (cfg.mock && cfg.mock !== '0' && cfg.mock !== 'false' && cfg.mock !== 'no') return true
  return !cfg.apiKey
}

/**
 * Which mock scenario to play. Precedence: explicit AI_MOCK mode, then markers
 * in the user's message, then "agree".
 */
export function mockModeFor(text, cfg = aiConfig()) {
  const fromEnv = cfg.mock
  if (['agree', 'disagree', 'fail-a', 'fail-b', 'fail-both'].includes(fromEnv)) return fromEnv
  const msg = String(text || '')
  if (/#fail-both\b/i.test(msg)) return 'fail-both'
  if (/#fail-a\b/i.test(msg)) return 'fail-a'
  if (/#fail-b\b/i.test(msg)) return 'fail-b'
  if (/#disagree\b/i.test(msg)) return 'disagree'
  return 'agree'
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

function systemPrompt() {
  return [
    'You estimate the calories and macronutrients of a meal described in plain language.',
    'Reply with STRICT JSON only — no prose, no markdown, no code fences.',
    'JSON shape:',
    '{"items":[{"name":"2 eggs","quantity":"2 large","kcal":144,"protein_g":12.6,"carbs_g":1.2,"fat_g":9.6}],',
    ' "total":{"kcal":320,"protein_g":18,"carbs_g":30,"fat_g":12},',
    ' "confidence":0.7,',
    ' "notes":"assumed scrambled eggs, no oil"}',
    'Rules: all numbers are non-negative; kcal are kilocalories; macros are grams;',
    '`total` must be the sum of `items`; `confidence` is 0..1 and reflects how well the',
    'description pins down portions; `notes` is one short sentence listing assumptions.',
  ].join('\n')
}

/**
 * @param {{message: string, intake?: object|null, profile?: object|null, day?: string}} ctx
 */
export function buildPrompt({ message, intake = null, profile = null, day = null }) {
  const lines = []
  if (day) lines.push(`Local day: ${day}`)
  if (intake) {
    lines.push(
      `Already logged today: ${Math.round(intake.kcal || 0)} kcal, ` +
        `${round1(intake.proteinG || 0)} g protein, ${round1(intake.carbsG || 0)} g carbs, ` +
        `${round1(intake.fatG || 0)} g fat.`,
    )
  }
  if (profile) {
    const bits = []
    if (profile.currentWeightKg != null) bits.push(`current weight ${round1(profile.currentWeightKg)} kg`)
    if (profile.goalWeightKg != null) bits.push(`goal weight ${round1(profile.goalWeightKg)} kg`)
    if (profile.kcalTarget != null) bits.push(`daily kcal target ${Math.round(profile.kcalTarget)}`)
    if (profile.heightCm != null) bits.push(`height ${round1(profile.heightCm)} cm`)
    if (profile.sex) bits.push(`sex ${profile.sex}`)
    if (profile.age != null) bits.push(`age ${profile.age}`)
    if (bits.length) lines.push(`Profile: ${bits.join(', ')}.`)
  }
  lines.push('')
  lines.push('The user said:')
  lines.push(String(message || '').slice(0, 2000))
  lines.push('')
  lines.push('Estimate this meal. Return only the JSON object described in the system prompt.')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

/**
 * One OpenAI-compatible chat completion call.
 * Never throws — returns `{ ok: true, content }` or `{ ok: false, error }`.
 */
async function chatCompletion({ model, messages, timeoutMs, jsonMode, sessionId, cfg, baseUrl = cfg.baseUrl }) {
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        'x-opencode-session': sessionHeader(sessionId),
        'user-agent': 'healthlog/1.0',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: jsonMode ? MAX_TOKENS : 400,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const text = await safeText(res)
      return { ok: false, status: res.status, error: `HTTP ${res.status} from ${model}${text ? `: ${text.slice(0, 200)}` : ''}` }
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: `Empty response from ${model}` }
    }
    return { ok: true, content }
  } catch (err) {
    const name = err?.name || ''
    const msg = err?.message || String(err)
    if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|aborted/i.test(msg)) {
      return { ok: false, error: `${model} timed out after ${timeoutMs} ms` }
    }
    return { ok: false, error: `${model} request failed: ${msg}` }
  }
}

/**
 * chatCompletion with a free-model fallback. If the primary call fails because
 * the key is out of usage / rate limited / rejected, retry once with
 * `fallbackModel` on the free endpoint. Resolves with the model actually used.
 */
async function chatWithFallback({ model, fallbackModel, ...rest }) {
  const first = await chatCompletion({ model, ...rest })
  const cfg = rest.cfg
  if (first.ok || !cfg.fallback || !FALLBACK_STATUSES.has(first.status) || !fallbackModel) {
    return { ...first, model }
  }
  const second = await chatCompletion({ model: fallbackModel, ...rest, baseUrl: cfg.fallbackBaseUrl })
  if (second.ok) return { ...second, model: fallbackModel, fellBack: true }
  return { ...second, model: fallbackModel, error: `${first.error}; fallback: ${second.error}` }
}

function sessionHeader(id) {
  return id || `healthlog-${randomUUID()}`
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* Parsing / normalising                                               */
/* ------------------------------------------------------------------ */

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10

/** Tolerant JSON parse: strips ``` fences, then falls back to the outermost braces. */
export function parseLooseJson(text) {
  if (typeof text !== 'string') return null
  let s = text.trim()
  if (!s) return null
  s = s.replace(/```[a-zA-Z0-9_-]*/g, '').trim()
  try {
    return JSON.parse(s)
  } catch {
    /* fall through */
  }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^0-9.+-]/g, ''))
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

function normaliseItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  return {
    name: name.slice(0, 200),
    quantity: raw.quantity == null ? null : String(raw.quantity).slice(0, 100),
    kcal: round1(num(raw.kcal)),
    protein_g: round1(num(raw.protein_g ?? raw.proteinG)),
    carbs_g: round1(num(raw.carbs_g ?? raw.carbsG)),
    fat_g: round1(num(raw.fat_g ?? raw.fatG)),
  }
}

export function sumItems(items) {
  const t = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  for (const i of items) {
    t.kcal += num(i.kcal)
    t.protein_g += num(i.protein_g)
    t.carbs_g += num(i.carbs_g)
    t.fat_g += num(i.fat_g)
  }
  return { kcal: round1(t.kcal), protein_g: round1(t.protein_g), carbs_g: round1(t.carbs_g), fat_g: round1(t.fat_g) }
}

function normaliseTotal(raw) {
  if (!raw || typeof raw !== 'object') return null
  const hasAny = ['kcal', 'protein_g', 'carbs_g', 'fat_g', 'proteinG', 'carbsG', 'fatG'].some(
    (k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '',
  )
  if (!hasAny) return null
  return {
    kcal: round1(num(raw.kcal)),
    protein_g: round1(num(raw.protein_g ?? raw.proteinG)),
    carbs_g: round1(num(raw.carbs_g ?? raw.carbsG)),
    fat_g: round1(num(raw.fat_g ?? raw.fatG)),
  }
}

/**
 * Turn one model's raw text into `{items,total,confidence,notes}` or `{error}`.
 */
export function normaliseModelOutput(content) {
  const parsed = parseLooseJson(content)
  if (!parsed || typeof parsed !== 'object') return { error: 'unparseable JSON' }

  const items = Array.isArray(parsed.items) ? parsed.items.map(normaliseItem).filter(Boolean) : []
  let total = normaliseTotal(parsed.total)
  if (!total && items.length > 0) total = sumItems(items)
  if (!total) return { error: 'no totals in model output' }

  const rawConf = Number(parsed.confidence)
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.5
  const notes = typeof parsed.notes === 'string' ? parsed.notes.trim().slice(0, 500) : ''

  return { items, total, confidence, notes }
}

const isModelOutput = (o) => Boolean(o && !o.error && o.total)

/* ------------------------------------------------------------------ */
/* Reconciliation (pure + deterministic)                               */
/* ------------------------------------------------------------------ */

function scaleItems(items, fromTotal, toTotal) {
  if (!Array.isArray(items) || items.length === 0) return []
  const ratio = (from, to) => (Number(from) > 0 ? Number(to) / Number(from) : 1)
  const rk = ratio(fromTotal?.kcal, toTotal?.kcal)
  const rp = ratio(fromTotal?.protein_g, toTotal?.protein_g)
  const rc = ratio(fromTotal?.carbs_g, toTotal?.carbs_g)
  const rf = ratio(fromTotal?.fat_g, toTotal?.fat_g)
  return items.map((i) => ({
    name: i.name,
    quantity: i.quantity ?? null,
    kcal: round1(num(i.kcal) * rk),
    protein_g: round1(num(i.protein_g) * rp),
    carbs_g: round1(num(i.carbs_g) * rc),
    fat_g: round1(num(i.fat_g) * rf),
  }))
}

/** Agreement bucket from the percentage delta (SPEC §7: 10% / 25%). */
export function agreementBucket(deltaPct) {
  if (deltaPct <= 10) return 'high'
  if (deltaPct <= 25) return 'medium'
  return 'low'
}

/**
 * Reconcile two normalised model outputs. Deterministic, no I/O.
 *
 * Rules (SPEC §7 step 4):
 *  - both valid, ratio within 15% → mean of totals (and of each macro)
 *  - both valid, further apart   → the more confident model (tie → the more
 *    conservative estimate, i.e. the lower kcal, since with two values the
 *    median is equidistant from both)
 *  - one valid → that one
 *  - neither → reconciled = null
 *
 * Items always come from the "chosen" model, scaled to the reconciled totals.
 *
 * @returns {{reconciled: object|null, chosen: 'A'|'B'|'mean'|null,
 *            deltaPct: number, agreement: 'high'|'medium'|'low',
 *            single: boolean, reason: string}}
 */
export function reconcile(a, b) {
  const validA = isModelOutput(a)
  const validB = isModelOutput(b)

  if (!validA && !validB) {
    return { reconciled: null, chosen: null, deltaPct: 0, agreement: 'low', single: false, reason: 'both-failed' }
  }
  if (validA && !validB) {
    return {
      reconciled: { items: a.items ?? [], total: { ...a.total } },
      chosen: 'A',
      deltaPct: 0,
      agreement: 'low',
      single: true,
      reason: 'only-one-model',
    }
  }
  if (!validA && validB) {
    return {
      reconciled: { items: b.items ?? [], total: { ...b.total } },
      chosen: 'B',
      deltaPct: 0,
      agreement: 'low',
      single: true,
      reason: 'only-one-model',
    }
  }

  const kcalA = a.total.kcal
  const kcalB = b.total.kcal
  const max = Math.max(kcalA, kcalB)
  const ratio = max > 0 ? Math.abs(kcalA - kcalB) / max : 0
  const deltaPct = Math.round(ratio * 1000) / 10
  const agreement = agreementBucket(deltaPct)

  if (ratio <= AGREEMENT_TOLERANCE) {
    const total = {
      kcal: round1((kcalA + kcalB) / 2),
      protein_g: round1((a.total.protein_g + b.total.protein_g) / 2),
      carbs_g: round1((a.total.carbs_g + b.total.carbs_g) / 2),
      fat_g: round1((a.total.fat_g + b.total.fat_g) / 2),
    }
    // Items come from the more confident model, scaled onto the mean totals.
    const confA = Number(a.confidence) || 0
    const confB = Number(b.confidence) || 0
    const src = confB > confA ? { output: b, label: 'B' } : { output: a, label: 'A' }
    const items = scaleItems(src.output.items ?? [], src.output.total, total)
    return {
      reconciled: { items, total },
      chosen: 'mean',
      deltaPct,
      agreement,
      single: false,
      reason: 'mean',
    }
  }

  const confA = Number(a.confidence) || 0
  const confB = Number(b.confidence) || 0
  // Higher confidence wins; on a tie keep the more conservative (lower kcal) estimate.
  const pickB = confB > confA + 1e-9 || (Math.abs(confB - confA) <= 1e-9 && kcalB < kcalA)
  const src = pickB ? b : a
  const items = scaleItems(src.items ?? [], src.total, src.total)
  return {
    reconciled: { items, total: { ...src.total } },
    chosen: pickB ? 'B' : 'A',
    deltaPct,
    agreement,
    single: false,
    reason: 'confidence',
  }
}

/* ------------------------------------------------------------------ */
/* Comparison prose                                                    */
/* ------------------------------------------------------------------ */

function fmtConfidence(c) {
  const n = Number(c)
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

/** Deterministic comparison string — used whenever the judge is not called or fails. */
export function deterministicComparison(a, b, recon) {
  const validA = isModelOutput(a)
  const validB = isModelOutput(b)

  if (!validA && !validB) {
    const why = [a?.error, b?.error].filter(Boolean).join('; ')
    return `Both models failed to analyse that meal${why ? ` (${why})` : ''}. Nothing was saved.`
  }
  if (validA && !validB) {
    return (
      `Model A: ${Math.round(a.total.kcal)} kcal (confidence ${fmtConfidence(a.confidence)}). ` +
      `Model B was unavailable. Using Model A.`
    )
  }
  if (!validA && validB) {
    return (
      `Model B: ${Math.round(b.total.kcal)} kcal (confidence ${fmtConfidence(b.confidence)}). ` +
      `Model A was unavailable. Using Model B.`
    )
  }

  const apart = Math.round(recon.deltaPct)
  const which = recon.chosen === 'mean' ? 'both (averaged)' : `Model ${recon.chosen}`
  return (
    `Model A: ${Math.round(a.total.kcal)} kcal (confidence ${fmtConfidence(a.confidence)}). ` +
    `Model B: ${Math.round(b.total.kcal)} kcal (confidence ${fmtConfidence(b.confidence)}). ` +
    `${apart}% apart — using ${which}.`
  )
}

/* ------------------------------------------------------------------ */
/* Mock                                                                */
/* ------------------------------------------------------------------ */

const MOCK_AGREE_A = {
  items: [
    { name: 'mock main dish', quantity: '1 serving', kcal: 280, protein_g: 18, carbs_g: 30, fat_g: 10 },
    { name: 'mock side', quantity: '1 serving', kcal: 120, protein_g: 8, carbs_g: 12, fat_g: 4 },
  ],
  total: { kcal: 400, protein_g: 26, carbs_g: 42, fat_g: 14 },
  confidence: 0.8,
  notes: 'mock A: assumed a medium portion with no added oil',
}

const MOCK_AGREE_B = {
  items: [
    { name: 'mock main dish', quantity: '1 serving', kcal: 300, protein_g: 16, carbs_g: 32, fat_g: 11 },
    { name: 'mock side', quantity: '1 serving', kcal: 140, protein_g: 8, carbs_g: 16, fat_g: 5 },
  ],
  total: { kcal: 440, protein_g: 24, carbs_g: 48, fat_g: 16 },
  confidence: 0.6,
  notes: 'mock B: counted a teaspoon of cooking oil',
}

const MOCK_DISAGREE_A = {
  items: [{ name: 'mock main dish', quantity: '1 serving', kcal: 300, protein_g: 20, carbs_g: 30, fat_g: 10 }],
  total: { kcal: 300, protein_g: 20, carbs_g: 30, fat_g: 10 },
  confidence: 0.85,
  notes: 'mock A: assumed a small portion',
}

const MOCK_DISAGREE_B = {
  items: [{ name: 'mock main dish', quantity: '1 serving', kcal: 520, protein_g: 35, carbs_g: 55, fat_g: 18 }],
  total: { kcal: 520, protein_g: 35, carbs_g: 55, fat_g: 18 },
  confidence: 0.55,
  notes: 'mock B: assumed a large portion plus oil and dressing',
}

/** Canned model output for a mock mode. Throws to simulate a failed model. */
export function mockModelOutput(variant, mode) {
  const A = variant === 'A'
  if (mode === 'fail-both') throw new Error(`mock failure: model ${variant} unavailable (HTTP 503)`)
  if (mode === 'fail-a' && A) throw new Error('mock failure: model A unavailable (HTTP 503)')
  if (mode === 'fail-b' && !A) throw new Error('mock failure: model B unavailable (HTTP 503)')

  if (mode === 'disagree') return A ? { ...MOCK_DISAGREE_A } : { ...MOCK_DISAGREE_B }
  // fail-a → B still answers; fail-b → A still answers; agree → both answer.
  return A ? { ...MOCK_AGREE_A } : { ...MOCK_AGREE_B }
}

export const MOCK_JUDGE_TEXT =
  'MOCK JUDGE: both models agree on the food and differ only on the portion size and the cooking oil. ' +
  'The most likely wrong assumption is the oil. Verdict: the lower estimate is the safer choice.'

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ask one model and normalise its answer. Always resolves (never rejects).
 * @returns {Promise<{output: object, raw: string}>}
 */
export async function analyseWithModel({ variant, model, messages, sessionId, userMessage, cfg }) {
  try {
    if (isMocked(cfg)) {
      const mode = mockModeFor(userMessage, cfg)
      const output = mockModelOutput(variant, mode)
      return { output: normaliseModelOutput(JSON.stringify(output)), raw: JSON.stringify(output), model }
    }
    const res = await chatWithFallback({
      model,
      fallbackModel: variant === 'B' ? cfg.fallbackModelB : cfg.fallbackModelA,
      messages,
      timeoutMs: MODEL_TIMEOUT_MS,
      jsonMode: true,
      sessionId,
      cfg,
    })
    if (!res.ok) return { output: { error: res.error }, raw: JSON.stringify({ error: res.error }), model: res.model }

    const output = normaliseModelOutput(res.content)
    if (output.error) return { output, raw: res.content, model: res.model }
    return { output, raw: JSON.stringify(output), model: res.model }
  } catch (err) {
    const message = err?.message || String(err)
    return { output: { error: message }, raw: JSON.stringify({ error: message }), model }
  }
}

/**
 * Ask the judge model for a short written comparison. Returns a string, or null
 * when the call failed/timed out — the caller then uses
 * `deterministicComparison()` instead. Never throws.
 */
export async function judgeComparison({ a, b, recon, sessionId, message, cfg }) {
  try {
    if (isMocked(cfg)) {
      if (mockModeFor(message, cfg) === 'fail-both') return null
      return MOCK_JUDGE_TEXT
    }
    const prompt = [
      'Two nutrition models estimated the same meal and were reconciled in code.',
      '',
      `Model A said: ${JSON.stringify(a)}`,
      `Model B said: ${JSON.stringify(b)}`,
      `Reconciled totals: ${JSON.stringify(recon.reconciled?.total ?? null)}`,
      `They are ${recon.deltaPct}% apart; the value used came from ${recon.chosen}.`,
      '',
      'Write a comparison for the user in under 120 words, plain text only:',
      'what they agree on, where they differ, which assumption is most likely wrong, and the final verdict.',
    ].join('\n')

    const res = await chatWithFallback({
      model: cfg.judgeModel,
      fallbackModel: cfg.fallbackJudgeModel,
      messages: [
        { role: 'system', content: 'You compare two nutrition estimates. Be concise and concrete.' },
        { role: 'user', content: prompt },
      ],
      timeoutMs: JUDGE_TIMEOUT_MS,
      jsonMode: false,
      sessionId,
      cfg,
    })
    if (!res.ok) return null
    const text = res.content.trim().replace(/^```[a-zA-Z]*\s*|\s*```$/g, '')
    return text ? text.slice(0, 1200) : null
  } catch {
    return null
  }
}

/**
 * Run the full dual-model analysis for one chat message.
 *
 * @param {{user: object, message: string, profile?: object|null, intake?: object|null,
 *          day?: string|null, sessionId?: string}} input
 * @returns {Promise<{
 *   promptText: string, modelA: string, modelB: string,
 *   outputA: object, outputB: object, reconciled: object|null,
 *   comparison: string, agreement: string, deltaPct: number,
 *   chosen: string|null, error: string|null, judgeUsed: boolean
 * }>}
 */
export async function runAnalysis({ user, message, profile = null, intake = null, day = null, sessionId = null }) {
  const cfg = aiConfig()
  const promptText = buildPrompt({ message, intake, profile, day })
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: promptText },
  ]
  const sid = sessionId || `healthlog-${user?.id || 'anon'}`

  // Parallel, and neither rejection can escape: both helpers always resolve.
  const [settledA, settledB] = await Promise.allSettled([
    analyseWithModel({ variant: 'A', model: cfg.modelA, messages, sessionId: sid, userMessage: message, cfg }),
    analyseWithModel({ variant: 'B', model: cfg.modelB, messages, sessionId: sid, userMessage: message, cfg }),
  ])

  const fallback = (which, err) => ({
    output: { error: `${which} failed: ${err?.message || 'unknown error'}` },
    raw: JSON.stringify({ error: String(err?.message || 'unknown error') }),
  })
  const resA = settledA.status === 'fulfilled' ? settledA.value : fallback('Model A', settledA.reason)
  const resB = settledB.status === 'fulfilled' ? settledB.value : fallback('Model B', settledB.reason)

  const recon = reconcile(resA.output, resB.output)

  // The judge only runs when the two valid models disagree by more than 15%.
  let comparison = null
  let judgeUsed = false
  if (!recon.single && recon.reconciled && recon.deltaPct > 15) {
    comparison = await judgeComparison({ a: resA.output, b: resB.output, recon, sessionId: sid, message, cfg })
    judgeUsed = comparison !== null
  }
  if (!comparison) comparison = deterministicComparison(resA.output, resB.output, recon)

  let error = null
  if (!recon.reconciled) {
    error = [resA.output?.error, resB.output?.error].filter(Boolean).join('; ') || 'Both models failed'
  }

  return {
    promptText,
    modelA: resA.model || cfg.modelA,
    modelB: resB.model || cfg.modelB,
    outputA: resA.output,
    outputB: resB.output,
    reconciled: recon.reconciled,
    comparison,
    agreement: recon.agreement,
    deltaPct: recon.deltaPct,
    chosen: recon.chosen,
    error,
    judgeUsed,
  }
}

/* ------------------------------------------------------------------ */
/* DB row → API payload                                                */
/* ------------------------------------------------------------------ */

function safeParse(text, fallback = null) {
  if (typeof text !== 'string') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Shape an `analyses` row for the API (SPEC §6). `agreement` / `deltaPct` are
 * recomputed from the stored model outputs, so they cannot drift.
 */
export function analysisPayload(row) {
  if (!row) return null
  const outputA = safeParse(row.result_a, { error: 'missing model A output' })
  const outputB = safeParse(row.result_b, { error: 'missing model B output' })
  const recon = reconcile(outputA, outputB)
  return {
    id: row.id,
    modelA: row.model_a,
    modelB: row.model_b,
    modelAOutput: outputA,
    modelBOutput: outputB,
    reconciled: safeParse(row.reconciled, null),
    comparison: row.comparison ?? '',
    agreement: recon.agreement,
    deltaPct: recon.deltaPct,
    error: row.error ?? null,
    createdAt: row.created_at ? `${String(row.created_at).replace(' ', 'T')}Z` : null,
  }
}
