/**
 * COROS sync — SPEC §6 "COROS". COROS has no API for individuals (its partner
 * API needs an approved application), so this drives the endpoints the COROS
 * Training Hub web app uses (as the community clients Pinta365/coros and
 * cygnusb/coros-mcp document). Private and unsupported: COROS can change it.
 *
 * Credentials:
 *   - The password is used once, in memory, by POST /api/coros/connect: the
 *     login sends its MD5, as the web app does. Neither is stored, logged or
 *     echoed. Only the access token (plus the region host, the COROS user id and
 *     the email) is kept, in $DATA_DIR/coros/<userId>/session.json (0600,
 *     outside the DB, so `backup pull` never carries it off the box).
 *   - There is no refresh token. When COROS rejects the token (result 1019,
 *     e.g. after a sign-in to Training Hub elsewhere) the status becomes
 *     `needs_login`, the session file is deleted and nothing syncs until the
 *     user connects again from Settings. It never logs in on its own.
 *   - Only the web API. The mobile API (the only source of sleep stages) is not
 *     used: signing in to it logs the user's phone app out.
 *
 * Load on COROS (it rate-limits, numbers undocumented):
 *   - Scheduled syncs every COROS_SYNC_INTERVAL_HOURS (default 4, minimum 2)
 *     from COROS_SYNC_HOUR (default 6) to midnight, nothing overnight.
 *   - One sync = one EvoLab call plus one call per 100 activities.
 *   - HTTP 429 (or a gateway error page) backs off COROS_BACKOFF_HOURS (default
 *     6); every sync, manual included, is refused until then.
 *
 * What it syncs: activities, and per day resting HR, overnight HRV and VO2max.
 * All of it goes through storeGarmin(..., { source: 'coros' }), the one writer
 * of watch rows. No steps, calories burned per day or sleep: the web API has
 * none of them.
 *
 * Env: COROS=off, COROS_BASE (tests point it at a fake server; replaces the
 * region hosts), COROS_SYNC_HOUR, COROS_SYNC_INTERVAL_HOURS, COROS_BACKOFF_HOURS.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, withTx } from '../db.js'
import { storeGarmin } from './garminStore.js'
import { addDays, today } from './metrics.js'

const PROVIDER = 'coros'
const SESSION_FILE = 'session.json'
const REQUEST_TIMEOUT_MS = 30_000
export const MAX_DAYS = 180
/** The first sync backfills this many days. */
const BACKFILL_DAYS = 90
/** Later syncs re-read this many days, so late uploads and edits still arrive. */
const WINDOW_DAYS = 7
const PAGE_SIZE = 100
const MAX_PAGES = 20
const USER_AGENT = 'Mozilla/5.0 (compatible; HealthLog personal sync)'
/** Training Hub API hosts per region. A token only works on the host that issued it. */
const REGION_HOSTS = ['https://teamapi.coros.com', 'https://teameuapi.coros.com', 'https://teamcnapi.coros.com']

const isOff = (v) => ['0', 'off', 'false', 'no'].includes(String(v || '').trim().toLowerCase())
const envNum = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' && process.env[name] !== undefined ? Number(process.env[name]) : fallback)

function hosts() {
  const base = (process.env.COROS_BASE || '').replace(/\/+$/, '')
  return base ? [base] : REGION_HOSTS
}

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
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class CorosError extends Error {
  /** @param {'bad_login'|'needs_login'|'rate_limited'|'error'|'unavailable'|'busy'} code */
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
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

/** @returns {{ host: string, accessToken: string, corosUserId: string|null, email: string|null, savedAt: string } | null} */
export function readSession(userId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(userId), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.accessToken && parsed.host) return parsed
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
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const INVALID_TOKEN = '1019'

/** One Training Hub call. Resolves with the parsed body ({ result, message, data }). */
async function call(host, route, { method = 'GET', token, query, body } = {}) {
  const url = `${host}${route}${query ? `?${new URLSearchParams(query)}` : ''}`
  let res
  try {
    res = await fetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { accesstoken: token } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new CorosError('error', `Could not reach COROS (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`)
  }
  const text = await res.text()
  if (res.status === 429) throw new CorosError('rate_limited', 'COROS is rate-limiting requests.', 429)
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (!parsed || typeof parsed !== 'object') {
    // A gateway error page instead of JSON is how COROS throttles as often as a 429.
    if (res.status === 503 || res.status === 502 || /<html/i.test(text.slice(0, 200))) {
      throw new CorosError('rate_limited', `COROS answered with an error page (HTTP ${res.status}); treating it as rate limiting.`, 429)
    }
    throw new CorosError('error', `COROS answered unexpectedly (${route}, HTTP ${res.status}).`)
  }
  return parsed
}

/** A call on a signed-in session: unwraps `data`, maps an invalid token to needs_login. */
async function authed(session, route, options = {}) {
  const parsed = await call(session.host, route, { ...options, token: session.accessToken })
  if (String(parsed.result) === INVALID_TOKEN) throw new CorosError('needs_login', 'COROS ended the session. Connect again in Settings.', 409)
  if (String(parsed.result) !== '0000') {
    throw new CorosError('error', `COROS refused ${route}: ${String(parsed.message || parsed.result || 'unknown error').slice(0, 200)}`)
  }
  return parsed.data ?? {}
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const ymd = (day) => day.replaceAll('-', '')

/**
 * Log in with email + password, finding the account's region: a login on the
 * wrong region's host can hand out a token that every later call rejects, so
 * each host's token is checked with one cheap call. The password lives only in
 * this call.
 * @returns {Promise<{ host: string, accessToken: string, corosUserId: string|null }>}
 */
export async function login(email, password) {
  const pwd = md5(password)
  let lastMessage = null
  for (const host of hosts()) {
    const parsed = await call(host, '/account/login', { method: 'POST', body: { account: email, accountType: 2, pwd } })
    if (String(parsed.result) !== '0000' || !parsed.data?.accessToken) {
      lastMessage = String(parsed.message || parsed.result || 'login refused').slice(0, 200)
      continue
    }
    const session = { host, accessToken: String(parsed.data.accessToken), corosUserId: parsed.data.userId ? String(parsed.data.userId) : null }
    try {
      const day = ymd(today())
      await authed(session, '/activity/query', { query: { size: 1, pageNumber: 1, startDay: day, endDay: day } })
      return session
    } catch (e) {
      if (e instanceof CorosError && e.code === 'needs_login') continue // wrong region
      throw e
    }
  }
  throw new CorosError('bad_login', `COROS: ${lastMessage ?? 'the login was not accepted in any region'}`, 400)
}

/* ------------------------------------------------------------------ */
/* Fetch + normalise                                                   */
/* ------------------------------------------------------------------ */

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const pos = (v) => {
  const x = fin(v)
  return x !== null && x > 0 ? x : null
}

/** 20261114 -> '2026-11-14' (null for anything else). */
export function corosDay(v) {
  const m = String(v ?? '').match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * COROS sportType -> the activity type keys the app already knows (Garmin's
 * typeKeys). Best effort from community clients; an unknown code is 'other'.
 */
const SPORT_TYPES = {
  100: 'running', 101: 'indoor_running', 102: 'trail_running', 103: 'track_running', 104: 'hiking', 105: 'mountaineering',
  200: 'road_biking', 201: 'indoor_cycling', 202: 'cycling', 203: 'gravel_cycling', 204: 'mountain_biking', 205: 'e_bike',
  299: 'cycling', 300: 'lap_swimming', 301: 'open_water_swimming', 400: 'cardio', 401: 'cardio', 402: 'strength_training',
  403: 'indoor_rowing', 404: 'elliptical', 405: 'stair_climbing', 500: 'resort_skiing', 501: 'resort_snowboarding',
  502: 'backcountry_skiing', 503: 'cross_country_skiing', 700: 'rowing', 701: 'indoor_rowing', 702: 'whitewater',
  704: 'flatwater', 705: 'windsurfing', 706: 'speed_surfing', 800: 'indoor_climbing', 801: 'bouldering', 900: 'walking',
  901: 'jump_rope', 10000: 'multi_sport', 10001: 'multi_sport', 10002: 'other', 10003: 'walking',
}

/** Epoch seconds + COROS's timezone (quarter-hours east of UTC) -> 'YYYY-MM-DDTHH:MM:SS' local. */
export function localStart(epochS, tzQuarters) {
  const s = fin(epochS)
  if (s === null || s <= 0) return null
  const offsetMin = (fin(tzQuarters) ?? 0) * 15
  return new Date((s + offsetMin * 60) * 1000).toISOString().slice(0, 19)
}

/** One /activity/query list item -> a storeGarmin activity row. Pure, for tests. */
export function normaliseActivity(a) {
  const startLocal = localStart(a?.startTime, a?.startTimezone)
  if (!a?.labelId || !startLocal) return null
  const sport = fin(a.sportType)
  const distanceM = pos(a.distance)
  const movingS = pos(a.workoutTime)
  const durationS = pos(a.totalTime) ?? movingS
  const kcalRaw = pos(a.calorie)
  return {
    externalId: String(a.labelId),
    startLocal,
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : null,
    type: sport !== null ? SPORT_TYPES[sport] ?? 'other' : 'other',
    durationS,
    movingS,
    distanceM,
    // The list reports calories in small calories.
    kcal: kcalRaw !== null ? Math.round(kcalRaw / 100) / 10 : null,
    avgHr: pos(a.avgHr),
    maxHr: pos(a.maxHr),
    elevationGainM: pos(a.ascent),
    // `avgSpeed` is a pace (s/km) despite its name; distance over moving time is unambiguous.
    avgSpeedMps: distanceM && (movingS ?? durationS) ? Math.round((distanceM / (movingS ?? durationS)) * 1000) / 1000 : null,
    trainingLoad: pos(a.trainingLoad),
  }
}

/** /analyse/query data -> { days, metrics } for storeGarmin, limited to [from, to]. Pure, for tests. */
export function normaliseAnalyse(data, from, to) {
  const inRange = (day) => !!day && day >= from && day <= to
  const days = []
  for (const d of Array.isArray(data?.dayList) ? data.dayList : []) {
    const day = corosDay(d?.happenDay)
    if (!inRange(day)) continue
    days.push({ day, restingHr: pos(d.rhr), hrvNight: pos(d.avgSleepHrv) })
  }
  const metrics = []
  for (const d of Array.isArray(data?.t7dayList) ? data.t7dayList : []) {
    const day = corosDay(d?.happenDay)
    if (!inRange(day)) continue
    const vo2max = pos(d.vo2max)
    if (vo2max !== null) metrics.push({ day, vo2max })
  }
  return { days, metrics }
}

async function fetchActivities(session, from, to) {
  const out = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await authed(session, '/activity/query', { query: { size: PAGE_SIZE, pageNumber: page, startDay: ymd(from), endDay: ymd(to) } })
    const list = Array.isArray(data.dataList) ? data.dataList : []
    for (const a of list) {
      const row = normaliseActivity(a)
      if (row && row.startLocal.slice(0, 10) >= from && row.startLocal.slice(0, 10) <= to) out.push(row)
    }
    const totalPages = fin(data.totalPage) ?? 1
    if (list.length < PAGE_SIZE || page >= totalPages) break
  }
  return out
}

async function fetchRange(session, from, to) {
  const analyse = await authed(session, '/analyse/query', { query: { startDay: ymd(from), endDay: ymd(to) } })
  const { days, metrics } = normaliseAnalyse(analyse, from, to)
  const activities = await fetchActivities(session, from, to)
  return { days, metrics, activities }
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
    email: session?.email ?? null,
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
/* Connect / sync / disconnect                                         */
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

/** Log in, keep the token (never the password), then run the first sync. */
export async function connect(db, userId, email, password) {
  if (!corosAvailable()) throw new CorosError('unavailable', 'COROS sync is switched off on this server.', 503)
  if (running.has(userId)) throw new CorosError('busy', 'A COROS sync is already running.', 409)
  const before = stateRow(db, userId)
  if (before?.backoff_until && Date.parse(before.backoff_until) > Date.now()) {
    throw new CorosError('rate_limited', `COROS is rate-limiting requests; try again after ${before.backoff_until}.`, 429)
  }
  const session = await login(email, password)
  writeSession(userId, { ...session, email })
  // A fresh login clears an old failure, and a reconnect after a gap backfills again.
  saveState(db, userId, { status: 'connected', last_error: null, backoff_until: null })
  console.log(`[coros] connected for ${userId}`)
  return syncUser(db, userId, { trigger: 'connect' })
}

/** Stop syncing. `deleteData` also removes the activities and days COROS wrote. */
export function disconnect(db, userId, { deleteData = false } = {}) {
  deleteSession(userId)
  db.prepare('DELETE FROM integrations WHERE user_id = ? AND provider = ?').run(userId, PROVIDER)
  const deleted = { days: 0, activities: 0 }
  if (deleteData) {
    withTx(db, () => {
      deleted.activities = Number(db.prepare("DELETE FROM activities WHERE user_id = ? AND source = 'coros'").run(userId).changes)
      // daily_wellness has no source column: remove the wellness rows of the days COROS owned.
      db.prepare("DELETE FROM daily_wellness WHERE user_id = ? AND day IN (SELECT day FROM daily_activity WHERE user_id = ? AND source = 'coros')").run(userId, userId)
      deleted.days = Number(db.prepare("DELETE FROM daily_activity WHERE user_id = ? AND source = 'coros'").run(userId).changes)
    })
  }
  console.log(`[coros] disconnected for ${userId}${deleteData ? ` (${deleted.activities} activities, ${deleted.days} days removed)` : ''}`)
  return { deleted }
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
    const payload = await fetchRange(session, from, to)
    const counts = storeGarmin(db, userId, payload, { source: PROVIDER })
    saveState(db, userId, { status: 'connected', last_success_at: new Date().toISOString(), last_error: null, backoff_until: null })
    console.log(`[coros] ${trigger} sync ok for ${userId}: ${counts.days} days, ${counts.activities} activities (${from}..${to})`)
    return { ok: true, from, to, days: counts.days, activities: counts.activities, sleep: 0 }
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
