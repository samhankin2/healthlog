/**
 * Cronometer sync — SPEC §6 "Cronometer". Cronometer has no public API for
 * individuals, so this drives the same endpoints its web app uses (the flow
 * gocronometer documents): form login -> GWT `authenticate` -> a short-lived
 * export token -> the CSV export.
 *
 * Credentials:
 *   - The password is used once, in memory, by POST /api/cronometer/connect.
 *     It is never stored, logged or echoed. Only the session cookies are kept,
 *     in $DATA_DIR/cronometer/<userId>/session.json (0600, outside the DB, so
 *     `backup pull` never carries them off the box).
 *   - When Cronometer ends the session the status becomes `needs_login` and
 *     syncing stops until the user connects again from Settings.
 *
 * Load on Cronometer (it allows ~10 exports per account per day):
 *   - One export per sync. Scheduled syncs every CRONOMETER_SYNC_INTERVAL_HOURS
 *     (default 4, minimum 2) from CRONOMETER_SYNC_HOUR (default 6) to midnight.
 *   - A hard cap of CRONOMETER_DAILY_EXPORTS (default 8) per user per local day,
 *     manual syncs included, leaving room for exports made on cronometer.com.
 *   - A failed export or a rejected request backs off CRONOMETER_BACKOFF_HOURS
 *     (default 6) when Cronometer answers 429.
 *
 * What it syncs: the food diary ("servings" export). Each sync replaces the
 * Cronometer meals of every day in its range, so edits and deletions made in
 * Cronometer carry over. Meals logged in HealthLog itself are never touched.
 *
 * Env: CRONOMETER=off, CRONOMETER_BASE (tests point it at a fake server),
 * CRONOMETER_SYNC_HOUR, CRONOMETER_SYNC_INTERVAL_HOURS, CRONOMETER_DAILY_EXPORTS,
 * CRONOMETER_BACKOFF_HOURS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, withTx } from '../db.js'
import { parseCsv } from './csv.js'
import { insertMeal } from './meals.js'
import { addDays, isISODate, today } from './metrics.js'

const PROVIDER = 'cronometer'
const SESSION_FILE = 'session.json'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_DAYS = 365
/** The first sync backfills this many days. */
const BACKFILL_DAYS = 90
/** Later syncs re-read this many days, so late edits in Cronometer still arrive. */
const WINDOW_DAYS = 7
const USER_AGENT = 'Mozilla/5.0 (compatible; HealthLog personal sync)'

/** Last known GWT values, used when discovery fails. They change with Cronometer releases. */
const FALLBACK_GWT = { permutation: '0EFF06F8710774B34D04BFA3409289E9', policy: 'B82D6F42004DB8749BB1C2080E1A4479' }
const GWT_DISCOVERY_TTL_MS = 6 * 3600_000

const isOff = (v) => ['0', 'off', 'false', 'no'].includes(String(v || '').trim().toLowerCase())
const envNum = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' && process.env[name] !== undefined ? Number(process.env[name]) : fallback)

function base() {
  return (process.env.CRONOMETER_BASE || 'https://cronometer.com').replace(/\/+$/, '')
}

export function cronometerAvailable() {
  return !isOff(process.env.CRONOMETER)
}

function syncHour() {
  return envNum('CRONOMETER_SYNC_HOUR', 6)
}

function syncIntervalHours() {
  return Math.max(2, envNum('CRONOMETER_SYNC_INTERVAL_HOURS', 4))
}

function dailyExports() {
  return Math.max(1, Math.min(10, envNum('CRONOMETER_DAILY_EXPORTS', 8)))
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class CronometerError extends Error {
  /** @param {'bad_login'|'needs_login'|'rate_limited'|'error'|'unavailable'|'busy'|'budget'} code */
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
  return path.join(dataDir(), 'cronometer', userId)
}

function sessionPath(userId) {
  return path.join(sessionDir(userId), SESSION_FILE)
}

/** @returns {{ cookies: Record<string,string>, cronometerUserId: string, email: string|null, savedAt: string } | null} */
export function readSession(userId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath(userId), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.cookies && parsed.cronometerUserId) return parsed
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
/* HTTP with a tiny cookie jar                                         */
/* ------------------------------------------------------------------ */

class Jar {
  constructor(cookies = {}) {
    /** @type {Record<string,string>} */
    this.cookies = { ...cookies }
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const line of list) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // An expired / emptied cookie is Cronometer clearing it.
      if (!value || /max-age=0\b|expires=thu, 01 jan 1970/i.test(line)) delete this.cookies[name]
      else this.cookies[name] = value
    }
  }

  header() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function http(jar, url, { method = 'GET', headers = {}, body } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      body,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, ...(jar && Object.keys(jar.cookies).length ? { cookie: jar.header() } : {}), ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new CronometerError('error', `Could not reach Cronometer (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`)
  }
  jar?.absorb(res)
  if (res.status === 429) throw new CronometerError('rate_limited', 'Cronometer is rate-limiting requests.', 429)
  return { status: res.status, text: await res.text() }
}

/* ------------------------------------------------------------------ */
/* GWT                                                                 */
/* ------------------------------------------------------------------ */

let gwtCache = null // { permutation, policy, at }

/** Read the current permutation + RPC policy hash from Cronometer's app files. */
async function gwtValues({ fresh = false } = {}) {
  if (!fresh && gwtCache && Date.now() - gwtCache.at < GWT_DISCOVERY_TTL_MS) return gwtCache
  try {
    const loader = await http(null, `${base()}/cronometer/cronometer.nocache.js`)
    const permutation = loader.status === 200 ? loader.text.match(/['"]([0-9A-F]{32})['"]/)?.[1] : null
    if (permutation) {
      const app = await http(null, `${base()}/cronometer/${permutation}.cache.js`)
      const policy = app.status === 200 ? app.text.match(/['"]app['"]\s*,\s*['"]([0-9A-F]{32})['"]/)?.[1] : null
      if (policy) {
        gwtCache = { permutation, policy, at: Date.now() }
        return gwtCache
      }
    }
    console.error('[cronometer] could not discover GWT values; using the last known ones')
  } catch (e) {
    console.error(`[cronometer] GWT discovery failed: ${e.message}`)
  }
  gwtCache = { ...FALLBACK_GWT, at: Date.now() }
  return gwtCache
}

const SERVICE = 'com.cronometer.shared.rpc.CronometerService'

function gwtBody(policy, kind, args) {
  const moduleBase = `${base()}/cronometer/`
  if (kind === 'authenticate') {
    return `7|0|5|${moduleBase}|${policy}|${SERVICE}|authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|${args.tzOffset}|`
  }
  if (kind === 'token') {
    return `7|0|8|${moduleBase}|${policy}|${SERVICE}|generateAuthorizationToken|java.lang.String/2004016611|I|com.cronometer.shared.user.AuthScope/2065601159|${args.nonce}|1|2|3|4|4|5|6|6|7|8|${args.userId}|3600|7|2|`
  }
  if (kind === 'logout') {
    return `7|0|6|${moduleBase}|${policy}|${SERVICE}|logout|java.lang.String/2004016611|${args.nonce}|1|2|3|4|1|5|6|`
  }
  throw new Error(`unknown GWT call ${kind}`)
}

/** One GWT call; retries once with freshly discovered values if the policy went stale. */
async function gwt(jar, kind, args) {
  for (const fresh of [false, true]) {
    const values = await gwtValues({ fresh })
    const res = await http(jar, `${base()}/cronometer/app`, {
      method: 'POST',
      headers: {
        'content-type': 'text/x-gwt-rpc; charset=UTF-8',
        'x-gwt-module-base': `${base()}/cronometer/`,
        'x-gwt-permutation': values.permutation,
      },
      body: gwtBody(values.policy, kind, args),
    })
    const stale = /IncompatibleRemoteServiceException|SerializationException/.test(res.text)
    if (stale && !fresh) continue
    if (/NotLoggedInException/.test(res.text)) throw new CronometerError('needs_login', 'Cronometer ended the session. Connect again in Settings.', 409)
    if (res.status !== 200 || !res.text.startsWith('//OK')) {
      throw new CronometerError('error', `Cronometer's app API answered unexpectedly (${kind}, HTTP ${res.status}).`)
    }
    return res.text
  }
  throw new CronometerError('error', 'Cronometer changed its app API; the sync needs an update.')
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Minutes east of UTC (gocronometer sends -300 for US Eastern): the negated JS getTimezoneOffset. */
function tzOffset() {
  return -new Date().getTimezoneOffset() || 0
}

async function authenticate(jar) {
  const text = await gwt(jar, 'authenticate', { tzOffset: tzOffset() })
  const userId = text.match(/^\/\/OK\[(\d+),/)?.[1]
  if (!userId) throw new CronometerError('needs_login', 'Cronometer did not accept the session. Connect again in Settings.', 409)
  return userId
}

/**
 * Log in with email + password. The password lives only in this call.
 * @returns {Promise<{ cookies: Record<string,string>, cronometerUserId: string }>}
 */
export async function login(email, password) {
  const jar = new Jar()
  const page = await http(jar, `${base()}/login/`)
  const csrf =
    page.text.match(/name=["']anticsrf["'][^>]*value=["']([^"']+)["']/i)?.[1] ??
    page.text.match(/value=["']([^"']+)["'][^>]*name=["']anticsrf["']/i)?.[1]
  if (page.status !== 200 || !csrf) throw new CronometerError('error', 'Cronometer\'s login page changed; the sync needs an update.')

  const form = new URLSearchParams({ anticsrf: csrf, password, username: email })
  const res = await http(jar, `${base()}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base(), referer: `${base()}/login/` },
    body: form.toString(),
  })
  let parsed = null
  try {
    parsed = JSON.parse(res.text)
  } catch {
    /* not JSON */
  }
  if (parsed?.error) throw new CronometerError('bad_login', `Cronometer: ${String(parsed.error).slice(0, 200)}`, 400)
  if (res.status !== 200 || !parsed) throw new CronometerError('error', `Cronometer's login answered unexpectedly (HTTP ${res.status}).`)
  if (!jar.cookies.sesnonce) {
    throw new CronometerError('bad_login', 'Cronometer did not start a session. Accounts with two-factor sign-in are not supported.', 400)
  }
  const cronometerUserId = await authenticate(jar)
  return { cookies: jar.cookies, cronometerUserId }
}

/** Download the servings CSV for [from, to]. Refreshes the session cookies in `session`. */
async function exportServings(session, from, to) {
  const jar = new Jar(session.cookies)
  const userId = await authenticate(jar)
  if (!jar.cookies.sesnonce) throw new CronometerError('needs_login', 'Cronometer ended the session. Connect again in Settings.', 409)
  const tokenText = await gwt(jar, 'token', { nonce: jar.cookies.sesnonce, userId })
  const token = tokenText.match(/"([^"]+)"/)?.[1]
  if (!token) throw new CronometerError('error', 'Cronometer did not issue an export token.')
  const query = new URLSearchParams({ end: to, generate: 'servings', nonce: token, start: from })
  const res = await http(jar, `${base()}/export?${query}`, {
    headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-origin' },
  })
  session.cookies = jar.cookies
  session.cronometerUserId = userId
  if (res.status !== 200) throw new CronometerError('error', `Cronometer refused the export (HTTP ${res.status}). It allows about 10 exports a day.`)
  if (!/\bfood\b/i.test(res.text.slice(0, 2000))) throw new CronometerError('error', 'Cronometer\'s export did not look like a food diary.')
  return res.text
}

async function logout(session) {
  const jar = new Jar(session.cookies)
  if (!jar.cookies.sesnonce) return
  try {
    await gwt(jar, 'logout', { nonce: jar.cookies.sesnonce })
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* CSV -> meals                                                        */
/* ------------------------------------------------------------------ */

const GROUP_TIMES = { breakfast: [8, 0], lunch: [12, 30], dinner: [19, 0], snacks: [15, 30] }

/** "8:15 AM", "08:15", "20:15" -> [h, m] or null. */
export function parseClock(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2])
  const ampm = m[3]?.toLowerCase().replace(/\./g, '')
  if (ampm === 'pm' && h < 12) h += 12
  if (ampm === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return [h, min]
}

function num(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Servings CSV -> one meal per (day, group), servings as items. Pure, for tests.
 * @returns {{ meals: Array<{day:string, group:string, eatenAt:string, items:object[], fiberG:number}>, rows: number }}
 */
export function servingsToMeals(csvText) {
  const { headers, rows } = parseCsv(csvText)
  // Header names vary a little (case, spacing, kJ vs kcal, Date vs Day): compare a normalised form.
  const norm = (h) => String(h ?? '').replace(/\u00a0/g, ' ').trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')')
  const normHeaders = headers.map(norm)
  const col = (...names) => {
    for (const name of names) {
      const i = normHeaders.indexOf(norm(name))
      if (i >= 0) return i
    }
    return -1
  }
  const kcalCol = col('Energy (kcal)', 'Calories (kcal)', 'Calories', 'Energy')
  const kjCol = kcalCol < 0 ? col('Energy (kJ)') : -1
  const idx = {
    day: col('Day', 'Date'),
    time: col('Time'),
    group: col('Group', 'Meal'),
    name: col('Food Name', 'Food', 'Name'),
    amount: col('Amount', 'Serving'),
    kcal: kcalCol >= 0 ? kcalCol : kjCol,
    protein: col('Protein (g)', 'Protein'),
    carbs: col('Carbs (g)', 'Net Carbs (g)', 'Carbohydrates (g)', 'Carbs'),
    fat: col('Fat (g)', 'Fat'),
    fiber: col('Fiber (g)', 'Fibre (g)', 'Fiber', 'Fibre'),
  }
  // An account set to kilojoules exports "Energy (kJ)".
  const energyScale = kcalCol < 0 && kjCol >= 0 ? 1 / 4.184 : 1
  const missing = [idx.day < 0 && 'Day', idx.name < 0 && 'Food Name', idx.kcal < 0 && 'Energy'].filter(Boolean)
  if (missing.length) {
    const seen = headers.slice(0, 15).map((h) => String(h).trim()).join(', ')
    throw new CronometerError('error', `Cronometer's export is missing the ${missing.join(', ')} column (it sent: ${seen.slice(0, 300)}).`)
  }

  /** @type {Map<string, {day:string, group:string, clocks:number[][], items:object[], fiberG:number}>} */
  const byMeal = new Map()
  let count = 0
  for (const row of rows) {
    const day = String(row[idx.day] ?? '').trim().slice(0, 10)
    const name = String(row[idx.name] ?? '').trim()
    if (!isISODate(day) || !name) continue
    const group = (idx.group >= 0 ? String(row[idx.group] ?? '').trim() : '') || 'Uncategorized'
    const key = `${day}\u0000${group}`
    if (!byMeal.has(key)) byMeal.set(key, { day, group, clocks: [], items: [], fiberG: 0 })
    const meal = byMeal.get(key)
    const clock = idx.time >= 0 ? parseClock(row[idx.time]) : null
    if (clock) meal.clocks.push(clock)
    meal.items.push({
      name,
      quantity: idx.amount >= 0 ? String(row[idx.amount] ?? '').trim() || null : null,
      kcal: Math.round(num(row[idx.kcal]) * energyScale * 10) / 10,
      proteinG: idx.protein >= 0 ? num(row[idx.protein]) : 0,
      carbsG: idx.carbs >= 0 ? num(row[idx.carbs]) : 0,
      fatG: idx.fat >= 0 ? num(row[idx.fat]) : 0,
    })
    meal.fiberG += idx.fiber >= 0 ? num(row[idx.fiber]) : 0
    count++
  }

  const meals = [...byMeal.values()].map((m) => {
    const [y, mo, d] = m.day.split('-').map(Number)
    const earliest = m.clocks.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]))[0]
    const [h, min] = earliest ?? GROUP_TIMES[m.group.toLowerCase()] ?? [12, 0]
    return { day: m.day, group: m.group, eatenAt: new Date(y, mo - 1, d, h, min).toISOString(), items: m.items, fiberG: m.fiberG }
  })
  meals.sort((a, b) => a.eatenAt.localeCompare(b.eatenAt))
  return { meals, rows: count }
}

/** Replace the user's Cronometer meals for every day in [from, to]. */
export function storeServings(db, userId, from, to, csvText) {
  const { meals, rows } = servingsToMeals(csvText)
  const inRange = meals.filter((m) => m.day >= from && m.day <= to)
  return withTx(db, () => {
    const removed = db.prepare("DELETE FROM meals WHERE user_id = ? AND source = 'cronometer' AND day >= ? AND day <= ?").run(userId, from, to)
    for (const m of inRange) {
      const sum = (k) => m.items.reduce((acc, it) => acc + it[k], 0)
      insertMeal(db, userId, {
        eatenAt: m.eatenAt,
        day: m.day,
        name: m.group,
        description: 'From Cronometer',
        kcal: sum('kcal'),
        proteinG: sum('proteinG'),
        carbsG: sum('carbsG'),
        fatG: sum('fatG'),
        fiberG: m.fiberG || null,
        source: 'cronometer',
        items: m.items,
      })
    }
    return { meals: inRange.length, servings: rows, replaced: Number(removed.changes) }
  })
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

function exportsToday(row) {
  return row?.export_day === today() ? Number(row.export_count) || 0 : 0
}

/** Status payload for GET /api/cronometer. */
export function cronometerStatus(db, userId) {
  const row = stateRow(db, userId)
  const session = readSession(userId)
  const backoffUntil = row?.backoff_until && Date.parse(row.backoff_until) > Date.now() ? row.backoff_until : null
  let status = row?.status ?? 'never'
  if (!session) status = row ? 'needs_login' : 'never'
  return {
    available: cronometerAvailable(),
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
    exportsToday: exportsToday(row),
    exportsPerDay: dailyExports(),
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

/** Log in, keep the session (never the password), then run the first sync. */
export async function connect(db, userId, email, password) {
  if (!cronometerAvailable()) throw new CronometerError('unavailable', 'Cronometer sync is switched off on this server.', 503)
  if (running.has(userId)) throw new CronometerError('busy', 'A Cronometer sync is already running.', 409)
  const { cookies, cronometerUserId } = await login(email, password)
  writeSession(userId, { cookies, cronometerUserId, email })
  // A fresh login clears an old failure; the export budget for today stays.
  saveState(db, userId, { status: 'connected', last_error: null, backoff_until: null })
  console.log(`[cronometer] connected for ${userId}`)
  try {
    return await syncUser(db, userId, { trigger: 'connect' })
  } catch (e) {
    if (e instanceof CronometerError && e.code === 'budget') return { ok: false, error: 'budget', message: e.message }
    throw e
  }
}

export async function disconnect(db, userId, { deleteMeals = false } = {}) {
  const session = readSession(userId)
  if (session) await logout(session)
  deleteSession(userId)
  db.prepare('DELETE FROM integrations WHERE user_id = ? AND provider = ?').run(userId, PROVIDER)
  let deleted = 0
  if (deleteMeals) deleted = Number(db.prepare("DELETE FROM meals WHERE user_id = ? AND source = 'cronometer'").run(userId).changes)
  console.log(`[cronometer] disconnected for ${userId}${deleteMeals ? ` (${deleted} meals removed)` : ''}`)
  return { deletedMeals: deleted }
}

/**
 * Sync one user. Throws CronometerError for refusals (not connected, busy,
 * backing off, out of exports today); a failed fetch is recorded in the state
 * and returned, not thrown.
 */
export async function syncUser(db, userId, { days, trigger = 'manual' } = {}) {
  if (!cronometerAvailable()) throw new CronometerError('unavailable', 'Cronometer sync is switched off on this server.', 503)
  const session = readSession(userId)
  const before = stateRow(db, userId)
  if (!session || before?.status === 'needs_login') throw new CronometerError('needs_login', 'Cronometer is not connected. Connect it in Settings.', 409)
  if (running.has(userId)) throw new CronometerError('busy', 'A Cronometer sync is already running.', 409)
  if (before?.backoff_until && Date.parse(before.backoff_until) > Date.now()) {
    throw new CronometerError('rate_limited', `Cronometer is rate-limiting requests; syncing is paused until ${before.backoff_until}.`, 429)
  }
  const used = exportsToday(before)
  if (used >= dailyExports()) {
    throw new CronometerError('budget', `Cronometer allows only a few exports a day, and today's ${dailyExports()} are used. It will sync again tomorrow.`, 429)
  }

  const { from, to } = syncRange(before?.last_success_at ?? null, today(), days)
  running.add(userId)
  saveState(db, userId, { last_attempt_at: new Date().toISOString(), export_day: today(), export_count: used + 1 })
  try {
    const csv = await exportServings(session, from, to)
    writeSession(userId, session)
    const counts = storeServings(db, userId, from, to, csv)
    saveState(db, userId, { status: 'connected', last_success_at: new Date().toISOString(), last_error: null, backoff_until: null })
    console.log(`[cronometer] ${trigger} sync ok for ${userId}: ${counts.servings} servings in ${counts.meals} meals (${from}..${to})`)
    return { ok: true, from, to, meals: counts.meals, servings: counts.servings }
  } catch (e) {
    if (!(e instanceof CronometerError)) throw e
    const kind = ['needs_login', 'rate_limited'].includes(e.code) ? e.code : 'error'
    const fields = { status: kind, last_error: String(e.message).slice(0, 500) }
    if (kind === 'rate_limited') fields.backoff_until = new Date(Date.now() + envNum('CRONOMETER_BACKOFF_HOURS', 6) * 3600_000).toISOString()
    if (kind === 'needs_login') deleteSession(userId)
    saveState(db, userId, fields)
    console.error(`[cronometer] ${trigger} sync failed for ${userId}: ${kind} - ${fields.last_error}`)
    return { ok: false, error: kind, message: fields.last_error, from, to }
  } finally {
    running.delete(userId)
  }
}

/** Should the scheduler try this user now? Pure, for tests. */
export function dueForSync(row, now = new Date(), hour = 6, intervalHours = 4, perDay = 8) {
  if (now.getHours() < hour) return false
  if (!row || row.status === 'needs_login') return false
  if (row.backoff_until && Date.parse(row.backoff_until) > now.getTime()) return false
  if (exportsTodayAt(row, now) >= perDay) return false
  if (!row.last_attempt_at) return true
  return now.getTime() - Date.parse(row.last_attempt_at) >= intervalHours * 3600_000
}

function exportsTodayAt(row, now) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return row?.export_day === day ? Number(row.export_count) || 0 : 0
}

/** Scheduled sync inside the server process. Returns a stop function. */
export function scheduleCronometerSync(db) {
  if (!cronometerAvailable()) return () => {}
  const tick = async () => {
    let users = []
    try {
      users = fs.readdirSync(path.join(dataDir(), 'cronometer'))
    } catch {
      return
    }
    for (const userId of users) {
      if (running.has(userId) || !readSession(userId)) continue
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) continue
      if (!dueForSync(stateRow(db, userId), new Date(), syncHour(), syncIntervalHours(), dailyExports())) continue
      try {
        await syncUser(db, userId, { trigger: 'scheduled' })
      } catch (e) {
        console.error(`[cronometer] scheduled sync skipped for ${userId}: ${e.message}`)
      }
    }
  }
  const first = setTimeout(tick, 90_000)
  const timer = setInterval(tick, 15 * 60_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
