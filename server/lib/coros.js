/**
 * COROS sync — SPEC §6 "COROS". Uses COROS's official self-service route for
 * apps: OAuth 2.0 + the COROS MCP server (server/lib/corosMcp.js), whose text
 * replies server/lib/corosParse.js turns into rows. Everything is written by
 * storeGarmin(..., { source: 'coros' }), the one writer of watch rows.
 *
 * Connecting:
 *   POST /api/coros/connect -> an authorize URL (PKCE, state). The browser goes
 *   to COROS, the user signs in there (HealthLog never sees the password) and
 *   approves, and COROS redirects to GET /api/coros/oauth/callback, which
 *   swaps the code for tokens and sends the browser back to Settings. The first
 *   sync then runs in the background.
 *
 * Tokens: $DATA_DIR/coros/<userId>/session.json (0600, outside the DB, so
 * `backup pull` never carries them off the box). The access token is refreshed
 * a day before it expires, or on a 401; refresh tokens rotate. A refused
 * refresh means `needs_login`: the session file is deleted and nothing syncs
 * until the user connects again.
 *
 * Load on COROS (no published MCP limits): scheduled syncs every
 * COROS_SYNC_INTERVAL_HOURS (default 4, minimum 2) from COROS_SYNC_HOUR
 * (default 6) to midnight; a normal sync is about eight tool calls plus one
 * detail call per new activity (at most MAX_DETAILS). HTTP 429 backs off
 * COROS_BACKOFF_HOURS (default 6). FIT files are never fetched (COROS allows
 * 50 a day).
 *
 * Env: COROS=off, COROS_MCP_URL (tests), COROS_REDIRECT_URI (override the
 * callback URL derived from the request), COROS_SYNC_HOUR,
 * COROS_SYNC_INTERVAL_HOURS, COROS_BACKOFF_HOURS.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, withTx } from '../db.js'
import { storeGarmin } from './garminStore.js'
import { addDays, today } from './metrics.js'
import { authorizeUrl, CorosError, discover, ensureClient, exchangeCode, openMcp, pkce, refreshTokens, revoke } from './corosMcp.js'
import { parseActivityDetail, parseDailyHealth, parseFitness, parseHrv, parsePerDay, parseSleep, parseSportRecords } from './corosParse.js'

export { CorosError } from './corosMcp.js'

const PROVIDER = 'coros'
const SESSION_FILE = 'session.json'
export const MAX_DAYS = 180
/** The first sync backfills this many days (sleep and activities; some daily metrics only reach back a week). */
const BACKFILL_DAYS = 90
/** Later syncs re-read this many days, so late uploads still arrive. */
const WINDOW_DAYS = 7
/** New activities per sync that get a detail call (calories, heart rate). */
const MAX_DETAILS = 30
const PENDING_TTL_MS = 15 * 60_000
const REFRESH_BEFORE_MS = 24 * 3600_000

const isOff = (v) => ['0', 'off', 'false', 'no'].includes(String(v || '').trim().toLowerCase())
const envNum = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' && process.env[name] !== undefined ? Number(process.env[name]) : fallback)

export function corosAvailable() {
  return !isOff(process.env.COROS)
}

function syncHour() {
  return envNum('COROS_SYNC_HOUR', 6)
}

function syncIntervalHours() {
  return Math.max(2, envNum('COROS_SYNC_INTERVAL_HOURS', 4))
}

/* ------------------------------------------------------------------ */
/* Session file                                                        */
/* ------------------------------------------------------------------ */

export function sessionDir(userId) {
  return path.join(dataDir(), 'coros', userId)
}

function sessionPath(userId) {
  return path.join(sessionDir(userId), SESSION_FILE)
}

/** @returns {{ resource: string, issuer: string, redirectUri: string, accessToken: string, refreshToken: string|null, expiresAt: string, connectedAt: string } | null} */
export function readSession(userId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(userId), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.accessToken && parsed.resource) return parsed
  } catch {
    /* none */
  }
  return null
}

function writeSession(userId, session) {
  fs.mkdirSync(sessionDir(userId), { recursive: true, mode: 0o700 })
  const file = sessionPath(userId)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...session, savedAt: new Date().toISOString() }), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function deleteSession(userId) {
  fs.rmSync(sessionDir(userId), { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function stateRow(db, userId) {
  return db.prepare('SELECT * FROM integrations WHERE user_id = ? AND provider = ?').get(userId, PROVIDER) ?? null
}

function saveState(db, userId, fields) {
  db.prepare('INSERT OR IGNORE INTO integrations (user_id, provider, status) VALUES (?, ?, ?)').run(userId, PROVIDER, 'never')
  for (const [col, value] of Object.entries(fields)) {
    db.prepare(`UPDATE integrations SET ${col} = ? WHERE user_id = ? AND provider = ?`).run(value, userId, PROVIDER)
  }
}

/** Status payload for GET /api/coros. */
export function corosStatus(db, userId) {
  const row = stateRow(db, userId)
  const session = readSession(userId)
  const backoffUntil = row?.backoff_until && Date.parse(row.backoff_until) > Date.now() ? row.backoff_until : null
  let status = row?.status ?? 'never'
  if (!session) status = row ? 'needs_login' : 'never'
  return {
    available: corosAvailable(),
    connected: !!session && status !== 'needs_login',
    connectedAt: session?.connectedAt ?? null,
    status, // 'never' | 'connected' | 'needs_login' | 'rate_limited' | 'error'
    syncing: running.has(userId),
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    lastError: row?.last_error ?? null,
    backoffUntil,
    syncHour: syncHour(),
    syncIntervalHours: syncIntervalHours(),
  }
}

/* ------------------------------------------------------------------ */
/* Connect (authorization code + PKCE)                                 */
/* ------------------------------------------------------------------ */

/** state -> { userId, verifier, redirectUri, returnTo, expires } */
const pending = new Map()

function prunePending() {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k)
}

/** Step 1: the URL the browser should open. */
export async function startConnect(db, userId, { redirectUri, returnTo }) {
  if (!corosAvailable()) throw new CorosError('unavailable', 'COROS sync is switched off on this server.', 503)
  const before = stateRow(db, userId)
  if (before?.backoff_until && Date.parse(before.backoff_until) > Date.now()) {
    throw new CorosError('rate_limited', `COROS is rate-limiting requests; try again after ${before.backoff_until}.`, 429)
  }
  const meta = await discover()
  const client = await ensureClient(meta, redirectUri)
  const { verifier, challenge } = pkce()
  const state = randomBytes(24).toString('base64url')
  prunePending()
  for (const [k, v] of pending) if (v.userId === userId) pending.delete(k) // one attempt at a time
  pending.set(state, { userId, verifier, redirectUri, returnTo, expires: Date.now() + PENDING_TTL_MS })
  return { authorizeUrl: authorizeUrl(meta, client, { redirectUri, state, challenge }) }
}

/**
 * Step 2: COROS redirected back. Swaps the code for tokens and starts the first
 * sync in the background. Returns where to send the browser.
 * @returns {Promise<{ userId: string|null, returnTo: string|null, ok: boolean, message?: string }>}
 */
export async function finishConnect(db, { code, state, error }) {
  prunePending()
  const p = state ? pending.get(state) : null
  if (!p) return { userId: null, returnTo: null, ok: false, message: 'This COROS sign-in link has expired. Start again from Settings.' }
  pending.delete(state)
  if (error || !code) {
    saveState(db, p.userId, { last_error: `COROS sign-in was not completed (${String(error || 'no code').slice(0, 80)}).` })
    return { userId: p.userId, returnTo: p.returnTo, ok: false }
  }
  try {
    const meta = await discover()
    const client = await ensureClient(meta, p.redirectUri)
    const tokens = await exchangeCode(meta, client, { code, verifier: p.verifier, redirectUri: p.redirectUri })
    writeSession(p.userId, { resource: meta.resource, issuer: meta.issuer, redirectUri: p.redirectUri, ...tokens, connectedAt: new Date().toISOString() })
    saveState(db, p.userId, { status: 'connected', last_error: null, backoff_until: null, last_success_at: null })
    console.log(`[coros] connected for ${p.userId}`)
  } catch (e) {
    if (!(e instanceof CorosError)) throw e
    saveState(db, p.userId, { last_error: String(e.message).slice(0, 500) })
    console.error(`[coros] connect failed for ${p.userId}: ${e.message}`)
    return { userId: p.userId, returnTo: p.returnTo, ok: false, message: e.message }
  }
  syncUser(db, p.userId, { trigger: 'connect' }).catch((e) => console.error(`[coros] first sync failed for ${p.userId}: ${e.message}`))
  return { userId: p.userId, returnTo: p.returnTo, ok: true }
}

/** Stop syncing: revoke at COROS (best effort), forget the tokens; `deleteData` also removes what COROS wrote. */
export async function disconnect(db, userId, { deleteData = false } = {}) {
  const session = readSession(userId)
  if (session) {
    try {
      const meta = await discover()
      const client = await ensureClient(meta, session.redirectUri)
      await revoke(meta, client, session.refreshToken || session.accessToken)
    } catch {
      /* best effort */
    }
  }
  deleteSession(userId)
  db.prepare('DELETE FROM integrations WHERE user_id = ? AND provider = ?').run(userId, PROVIDER)
  const deleted = { days: 0, activities: 0, sleep: 0 }
  if (deleteData) {
    withTx(db, () => {
      deleted.activities = Number(db.prepare("DELETE FROM activities WHERE user_id = ? AND source = 'coros'").run(userId).changes)
      // daily_wellness and sleep_nights have no source column: remove those of the days COROS owned.
      const owned = "SELECT day FROM daily_activity WHERE user_id = ? AND source = 'coros'"
      db.prepare(`DELETE FROM daily_wellness WHERE user_id = ? AND day IN (${owned})`).run(userId, userId)
      deleted.sleep = Number(db.prepare(`DELETE FROM sleep_nights WHERE user_id = ? AND day IN (${owned})`).run(userId, userId).changes)
      deleted.days = Number(db.prepare("DELETE FROM daily_activity WHERE user_id = ? AND source = 'coros'").run(userId).changes)
    })
  }
  console.log(`[coros] disconnected for ${userId}${deleteData ? ` (${JSON.stringify(deleted)} removed)` : ''}`)
  return { deleted }
}

/* ------------------------------------------------------------------ */
/* MCP with automatic refresh                                          */
/* ------------------------------------------------------------------ */

async function refreshSession(userId, session) {
  const meta = await discover()
  const client = await ensureClient(meta, session.redirectUri)
  const tokens = await refreshTokens(meta, client, session.refreshToken)
  Object.assign(session, tokens)
  writeSession(userId, session) // the old refresh token is spent: save the new one at once
  return session
}

/** Run `fn(mcp)` on a fresh MCP session, refreshing the token first if due and once more on a 401. */
async function withMcp(userId, session, fn) {
  if (Date.parse(session.expiresAt) - Date.now() < REFRESH_BEFORE_MS) await refreshSession(userId, session)
  try {
    return await fn(await openMcp(session.resource, session.accessToken))
  } catch (e) {
    if (!(e instanceof CorosError) || e.code !== 'unauthorized') throw e
    await refreshSession(userId, session)
    try {
      return await fn(await openMcp(session.resource, session.accessToken))
    } catch (e2) {
      if (e2 instanceof CorosError && e2.code === 'unauthorized') throw new CorosError('needs_login', 'COROS rejected the connection. Connect again in Settings.', 409)
      throw e2
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

const ymd = (day) => day.replaceAll('-', '')

/** [from, to] in chunks of at most `size` days. */
function chunks(from, to, size) {
  const out = []
  let start = from
  while (start <= to) {
    const end = addDays(start, size - 1) < to ? addDays(start, size - 1) : to
    out.push([start, end])
    start = addDays(end, 1)
  }
  return out
}

function spanDays(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

/**
 * Pull [from, to] through the MCP tools. One tool failing (other than auth or
 * rate limiting) does not sink the sync: it is skipped and reported.
 */
async function fetchRange(mcp, from, to, knownActivityIds) {
  const warnings = []
  const span = spanDays(from, to)
  const tool = async (name, args) => {
    try {
      return (await mcp.callTool(name, args)).text
    } catch (e) {
      if (e instanceof CorosError && e.code !== 'error') throw e
      warnings.push(`${name}: ${e.message}`.slice(0, 200))
      return ''
    }
  }
  /** Tools that only take "recent days": ask for the span, fall back to a week if COROS refuses. */
  const recent = async (name) => {
    const before = warnings.length
    const text = await tool(name, { days: span })
    if (text || span <= 7) return text
    warnings.length = before
    return tool(name, { days: 7 })
  }

  const inRange = (r) => r.day >= from && r.day <= to

  // Activities, then details for the ones not stored yet.
  const activities = []
  for (const [a, b] of chunks(from, to, 31)) activities.push(...parseSportRecords(await tool('querySportRecords', { startDate: ymd(a), endDate: ymd(b), limit: 200 })))
  let details = 0
  for (const act of activities) {
    if (details >= MAX_DETAILS || knownActivityIds.has(act.externalId) || !act.labelId || act.sportType === null) continue
    details++
    const extra = parseActivityDetail(await tool('getActivityDetail', { labelId: act.labelId, sportType: act.sportType }))
    for (const [k, v] of Object.entries(extra)) if (v !== null && (act[k] === null || act[k] === undefined)) act[k] = v
  }

  const sleepRows = []
  const sleepDays = []
  for (const [a, b] of chunks(from, to, 31)) {
    const parsed = parseSleep(await tool('querySleepOverview', { startDate: ymd(a), endDate: ymd(b) }))
    sleepRows.push(...parsed.sleep)
    sleepDays.push(...parsed.days)
  }
  const hrv = []
  for (const [a, b] of chunks(from, to, 7)) hrv.push(...parseHrv(await tool('querySleepHrv', { startDate: ymd(a), endDate: ymd(b) })))
  const daily = parseDailyHealth(await recent('queryDailyHealthData'))
  const rhr = parsePerDay(await recent('queryRestingHeartRate'), /resting|rhr|heart rate/)
  const stress = parsePerDay(await recent('queryStressLevel'), /stress/, /max|high|low|time/)
  const fitness = parseFitness(await tool('queryFitnessAssessmentOverview', {}))

  // One row per day, later sources filling only what earlier ones left empty.
  const byDay = new Map()
  const put = (day, fields) => {
    if (!byDay.has(day)) byDay.set(day, { day })
    const row = byDay.get(day)
    for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && (row[k] === null || row[k] === undefined)) row[k] = v
  }
  for (const r of daily.filter(inRange)) put(r.day, { steps: r.steps, activeKcal: r.activeKcal, totalKcal: r.totalKcal, bmrKcal: r.bmrKcal, stressAvg: r.stressAvg, restingHr: r.restingHr })
  for (const r of rhr.filter(inRange)) put(r.day, { restingHr: r.value })
  for (const r of stress.filter(inRange)) put(r.day, { stressAvg: r.value })
  for (const r of hrv.filter(inRange)) put(r.day, { hrvNight: r.hrvNight, hrvStatus: r.hrvStatus })
  for (const r of sleepDays.filter(inRange)) put(r.day, { sleepSeconds: r.sleepSeconds })

  return {
    days: [...byDay.values()],
    sleep: sleepRows.filter(inRange),
    metrics: fitness.vo2max !== null ? [{ day: to, vo2max: fitness.vo2max }] : [],
    activities: activities.filter((a) => a.startLocal.slice(0, 10) >= from && a.startLocal.slice(0, 10) <= to),
    warnings,
  }
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const running = new Set()

/** Days to fetch. Pure, for tests. */
export function syncRange(lastSuccessAt, todayDay, days) {
  if (days) {
    const span = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(days)) || 1))
    return { from: addDays(todayDay, -(span - 1)), to: todayDay }
  }
  const span = lastSuccessAt ? WINDOW_DAYS : BACKFILL_DAYS
  return { from: addDays(todayDay, -(span - 1)), to: todayDay }
}

/**
 * Sync one user. Throws CorosError for refusals (not connected, busy, backing
 * off); a failed fetch is recorded in the state and returned, not thrown.
 */
export async function syncUser(db, userId, { days, trigger = 'manual' } = {}) {
  if (!corosAvailable()) throw new CorosError('unavailable', 'COROS sync is switched off on this server.', 503)
  const session = readSession(userId)
  const before = stateRow(db, userId)
  if (!session || before?.status === 'needs_login') throw new CorosError('needs_login', 'COROS is not connected. Connect it in Settings.', 409)
  if (running.has(userId)) throw new CorosError('busy', 'A COROS sync is already running.', 409)
  if (before?.backoff_until && Date.parse(before.backoff_until) > Date.now()) {
    throw new CorosError('rate_limited', `COROS is rate-limiting requests; syncing is paused until ${before.backoff_until}.`, 429)
  }

  const { from, to } = syncRange(before?.last_success_at ?? null, today(), days)
  running.add(userId)
  saveState(db, userId, { last_attempt_at: new Date().toISOString() })
  try {
    const known = new Set(db.prepare("SELECT external_id FROM activities WHERE user_id = ? AND source = 'coros'").all(userId).map((r) => r.external_id))
    const payload = await withMcp(userId, session, (mcp) => fetchRange(mcp, from, to, known))
    const counts = storeGarmin(db, userId, payload, { source: PROVIDER })
    const warning = payload.warnings.length ? `Partly synced; COROS refused: ${payload.warnings.join('; ')}`.slice(0, 500) : null
    saveState(db, userId, { status: 'connected', last_success_at: new Date().toISOString(), last_error: warning, backoff_until: null })
    if (warning) console.error(`[coros] ${trigger} sync for ${userId}: ${warning}`)
    console.log(`[coros] ${trigger} sync ok for ${userId}: ${counts.days} days, ${counts.sleep} nights, ${counts.activities} activities (${from}..${to})`)
    return { ok: true, from, to, days: counts.days, sleep: counts.sleep, activities: counts.activities, warnings: payload.warnings }
  } catch (e) {
    if (!(e instanceof CorosError)) throw e
    const kind = ['needs_login', 'rate_limited'].includes(e.code) ? e.code : 'error'
    const fields = { status: kind, last_error: String(e.message).slice(0, 500) }
    if (kind === 'rate_limited') fields.backoff_until = new Date(Date.now() + envNum('COROS_BACKOFF_HOURS', 6) * 3600_000).toISOString()
    if (kind === 'needs_login') deleteSession(userId)
    saveState(db, userId, fields)
    console.error(`[coros] ${trigger} sync failed for ${userId}: ${kind} - ${fields.last_error}`)
    return { ok: false, error: kind, message: fields.last_error, from, to }
  } finally {
    running.delete(userId)
  }
}

/**
 * The raw text of every tool the sync uses, for tuning the parsers against a
 * real account (`node server/cli.js coros dump`). Read-only.
 */
export async function dumpRaw(db, userId, { days = 3 } = {}) {
  const session = readSession(userId)
  if (!session) throw new CorosError('needs_login', 'COROS is not connected for this user.', 409)
  const to = today()
  const from = addDays(to, -(Math.max(1, days) - 1))
  return withMcp(userId, session, async (mcp) => {
    const out = [['tools/list', (await mcp.tools()).join(', ')]]
    const calls = [
      ['querySportRecords', { startDate: ymd(from), endDate: ymd(to), limit: 5 }],
      ['querySleepOverview', { startDate: ymd(from), endDate: ymd(to) }],
      ['querySleepHrv', { startDate: ymd(from), endDate: ymd(to) }],
      ['queryDailyHealthData', { days }],
      ['queryRestingHeartRate', { days }],
      ['queryStressLevel', { days }],
      ['queryFitnessAssessmentOverview', {}],
    ]
    for (const [name, args] of calls) {
      try {
        const r = await mcp.callTool(name, args)
        out.push([`${name} ${JSON.stringify(args)}`, r.text + (r.structured ? `\n[structuredContent] ${JSON.stringify(r.structured)}` : '')])
      } catch (e) {
        out.push([`${name} ${JSON.stringify(args)}`, `ERROR: ${e.message}`])
      }
    }
    const first = parseSportRecords(out[1][1])[0]
    if (first?.labelId && first.sportType !== null) {
      const args = { labelId: first.labelId, sportType: first.sportType }
      try {
        out.push([`getActivityDetail ${JSON.stringify(args)}`, (await mcp.callTool('getActivityDetail', args)).text])
      } catch (e) {
        out.push([`getActivityDetail ${JSON.stringify(args)}`, `ERROR: ${e.message}`])
      }
    }
    return out
  })
}

/** Should the scheduler try this user now? Pure, for tests. */
export function dueForSync(row, now = new Date(), hour = 6, intervalHours = 4) {
  if (now.getHours() < hour) return false
  if (!row || row.status === 'needs_login') return false
  if (row.backoff_until && Date.parse(row.backoff_until) > now.getTime()) return false
  if (!row.last_attempt_at) return true
  return now.getTime() - Date.parse(row.last_attempt_at) >= Math.max(2, intervalHours) * 3600_000
}

/** Scheduled sync inside the server process. Returns a stop function. */
export function scheduleCorosSync(db) {
  if (!corosAvailable()) return () => {}
  const tick = async () => {
    let users = []
    try {
      users = fs.readdirSync(path.join(dataDir(), 'coros'))
    } catch {
      return
    }
    for (const userId of users) {
      if (running.has(userId) || !readSession(userId)) continue
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) continue
      if (!dueForSync(stateRow(db, userId), new Date(), syncHour(), syncIntervalHours())) continue
      try {
        await syncUser(db, userId, { trigger: 'scheduled' })
      } catch (e) {
        console.error(`[coros] scheduled sync skipped for ${userId}: ${e.message}`)
      }
    }
  }
  const first = setTimeout(tick, 120_000)
  const timer = setInterval(tick, 15 * 60_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
