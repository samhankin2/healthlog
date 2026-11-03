/**
 * Garmin sync — SPEC §6 "Garmin". Node spawns sync/garmin_sync.py (a pure
 * fetcher that prints JSON) and owns every database write.
 *
 * Login hygiene (Garmin rate-limits SSO logins per IP and keeps 429ing for
 * days once tripped):
 *   - Node never has the Garmin password. The fetcher runs without credentials
 *     and can only resume saved tokens; a full login happens only through the
 *     interactive `node server/cli.js garmin login`.
 *   - Scheduled attempts at most every GARMIN_SYNC_INTERVAL_HOURS (default 3,
 *     minimum 1), successful or not, and only from GARMIN_SYNC_HOUR until
 *     midnight - nothing overnight.
 *   - Each sync fetches only the days that are not final yet (see syncRange):
 *     normally today, plus yesterday until a sync after noon has run. Finished
 *     days stay in the database and are never re-fetched.
 *   - `needs_login` stops scheduled attempts until the token file changes.
 *   - `rate_limited` blocks every sync (manual too) for GARMIN_BACKOFF_HOURS.
 *
 * Env: GARMIN=off, GARMIN_PYTHON (default /opt/healthlog-garmin/venv/bin/python),
 * GARMIN_SCRIPT (default sync/garmin_sync.py), GARMIN_SYNC_HOUR (local hour
 * syncing starts each day, default 6), GARMIN_SYNC_INTERVAL_HOURS (default 3),
 * GARMIN_BACKOFF_HOURS (default 6).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, withTx } from '../db.js'
import { addDays, today } from './metrics.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROVIDER = 'garmin'
const TOKEN_FILE = 'garmin_tokens.json'
const FETCH_TIMEOUT_MS = 180_000
const MAX_DAYS = 120
/** First sync, or a gap longer than this, backfills this many days. */
const BACKFILL_DAYS = 30

const isOff = (v) => ['0', 'off', 'false', 'no'].includes(String(v || '').trim().toLowerCase())
const envNum = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== '' && process.env[name] !== undefined ? Number(process.env[name]) : fallback)

export function pythonBin() {
  return process.env.GARMIN_PYTHON || '/opt/healthlog-garmin/venv/bin/python'
}

export function scriptPath() {
  return process.env.GARMIN_SCRIPT || path.join(ROOT, 'sync', 'garmin_sync.py')
}

/** True when the Python environment exists and the feature is not switched off. */
export function garminAvailable() {
  return !isOff(process.env.GARMIN) && fs.existsSync(pythonBin()) && fs.existsSync(scriptPath())
}

export function tokensDir(userId) {
  return path.join(dataDir(), 'garmin', userId)
}

function tokenMtime(userId) {
  try {
    return fs.statSync(path.join(tokensDir(userId), TOKEN_FILE)).mtime
  } catch {
    return null
  }
}

export function hasTokens(userId) {
  return tokenMtime(userId) !== null
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

/** Called by the CLI after a successful interactive login. */
export function markLoggedIn(db, userId) {
  saveState(db, userId, { status: 'connected', last_error: null, backoff_until: null })
}

/** Status payload for GET /api/garmin and the dashboard. */
export function garminStatus(db, userId) {
  const row = stateRow(db, userId)
  const connected = hasTokens(userId)
  const backoffUntil = row?.backoff_until && Date.parse(row.backoff_until) > Date.now() ? row.backoff_until : null
  let status = row?.status ?? 'never'
  if (!connected) status = 'needs_login'
  return {
    available: garminAvailable(),
    connected,
    status, // 'never' | 'connected' | 'needs_login' | 'rate_limited' | 'error'
    syncing: running.has(userId),
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastSuccessAt: row?.last_success_at ?? null,
    lastError: row?.last_error ?? null,
    backoffUntil,
    syncHour: envNum('GARMIN_SYNC_HOUR', 6),
    syncIntervalHours: syncIntervalHours(),
  }
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

/** Run the fetcher; resolves with its JSON (never rejects). */
function runFetch(userId, from, to) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [scriptPath(), 'fetch', '--tokens', tokensDir(userId), '--from', from, '--to', to], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GARMINTOKENS: '' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => { out += b })
    child.stderr.on('data', (b) => { err += b })
    const timer = setTimeout(() => child.kill('SIGKILL'), FETCH_TIMEOUT_MS)
    const finish = (result) => {
      clearTimeout(timer)
      // Strategy fallbacks are expected WARNING lines - journal them as info.
      for (const line of err.split('\n').map((l) => l.trim()).filter(Boolean).slice(-20)) {
        console.log(`[garmin] ${line.slice(0, 300)}`)
      }
      resolve(result)
    }
    child.on('error', (e) => finish({ ok: false, error: 'error', message: `could not start the Garmin fetcher: ${e.message}` }))
    child.on('close', (code, signal) => {
      const last = out.trim().split('\n').pop() || ''
      try {
        const parsed = JSON.parse(last)
        if (parsed && typeof parsed === 'object') return finish(parsed)
      } catch {
        /* fall through */
      }
      finish({ ok: false, error: 'error', message: signal ? `fetcher killed (${signal})` : `fetcher exited ${code} without a result` })
    })
  })
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

function store(db, userId, result) {
  const days = Array.isArray(result.days) ? result.days.filter((d) => isDay(d?.day)) : []
  const acts = Array.isArray(result.activities) ? result.activities.filter((a) => a?.externalId && typeof a.startLocal === 'string') : []
  const now = new Date().toISOString()
  withTx(db, () => {
    const upDay = db.prepare(`
      INSERT INTO daily_activity (user_id, day, steps, active_kcal, total_kcal, bmr_kcal, resting_hr, sleep_seconds, intensity_minutes, source, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'garmin', ?)
      ON CONFLICT (user_id, day) DO UPDATE SET
        steps = excluded.steps, active_kcal = excluded.active_kcal, total_kcal = excluded.total_kcal,
        bmr_kcal = excluded.bmr_kcal, resting_hr = excluded.resting_hr, sleep_seconds = excluded.sleep_seconds,
        intensity_minutes = excluded.intensity_minutes, source = excluded.source, synced_at = excluded.synced_at`)
    for (const d of days) {
      // A day Garmin has nothing for (watch off) is skipped rather than stored as zeros.
      if ([d.steps, d.activeKcal, d.totalKcal, d.restingHr, d.sleepSeconds].every((v) => n(v) === null)) continue
      upDay.run(userId, d.day, n(d.steps), n(d.activeKcal), n(d.totalKcal), n(d.bmrKcal), n(d.restingHr), n(d.sleepSeconds), n(d.intensityMinutes), now)
    }
    const upAct = db.prepare(`
      INSERT INTO activities (id, user_id, source, external_id, name, type, start_local, day, duration_s, moving_s, distance_m, kcal, avg_hr, max_hr, elevation_gain_m, avg_speed_mps, training_effect, synced_at)
      VALUES (?, ?, 'garmin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, source, external_id) DO UPDATE SET
        name = excluded.name, type = excluded.type, start_local = excluded.start_local, day = excluded.day,
        duration_s = excluded.duration_s, moving_s = excluded.moving_s, distance_m = excluded.distance_m, kcal = excluded.kcal,
        avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, elevation_gain_m = excluded.elevation_gain_m,
        avg_speed_mps = excluded.avg_speed_mps, training_effect = excluded.training_effect, synced_at = excluded.synced_at`)
    for (const a of acts) {
      const start = a.startLocal.replace(' ', 'T').slice(0, 19)
      upAct.run(randomUUID(), userId, String(a.externalId).slice(0, 64), a.name ? String(a.name).slice(0, 200) : null,
        a.type ? String(a.type).slice(0, 64) : null, start, start.slice(0, 10), n(a.durationS), n(a.movingS), n(a.distanceM),
        n(a.kcal), n(a.avgHr), n(a.maxHr), n(a.elevationGainM), n(a.avgSpeedMps), n(a.trainingEffect), now)
    }
  })
  return { days: days.length, activities: acts.length }
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

const running = new Set()

export class GarminSyncError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

function syncIntervalHours() {
  return Math.max(1, envNum('GARMIN_SYNC_INTERVAL_HOURS', 3))
}

/** Epoch ms of 12:00 local time on the day after `day`: from then on, `day` is final. */
function finalAt(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d + 1, 12).getTime()
}

/**
 * Days to fetch. A day is final once a successful sync has run after noon of
 * the next day (the watch has long since uploaded it). Every sync starts at the
 * earliest day that was not final at the last success, so finished days are
 * fetched once and then left alone. Pure, for tests.
 */
export function syncRange(lastSuccessAt, todayDay, days) {
  if (days) {
    const span = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(days)) || 1))
    return { from: addDays(todayDay, -(span - 1)), to: todayDay }
  }
  const oldest = addDays(todayDay, -(BACKFILL_DAYS - 1))
  const last = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN
  if (!Number.isFinite(last)) return { from: oldest, to: todayDay }
  let from = todayDay
  while (from > oldest && finalAt(addDays(from, -1)) > last) from = addDays(from, -1)
  return { from, to: todayDay }
}

/**
 * Sync one user. Without `days` it fetches only the days not yet final
 * (30 on the very first sync); `days` forces the last N days. Throws
 * GarminSyncError for refusals (unavailable, busy, backing off); a failed
 * fetch is recorded in the state and returned, not thrown.
 */
export async function syncUser(db, userId, { days, trigger = 'manual' } = {}) {
  if (!garminAvailable()) throw new GarminSyncError('unavailable', 'Garmin sync is not installed on this server.', 503)
  if (!hasTokens(userId)) throw new GarminSyncError('needs_login', 'Garmin is not connected. Run the login command on the server first.', 409)
  if (running.has(userId)) throw new GarminSyncError('busy', 'A Garmin sync is already running.', 409)
  const before = stateRow(db, userId)
  if (before?.backoff_until && Date.parse(before.backoff_until) > Date.now()) {
    throw new GarminSyncError('rate_limited', `Garmin is rate-limiting requests; syncing is paused until ${before.backoff_until}.`, 429)
  }

  const { from, to } = syncRange(before?.last_success_at ?? null, today(), days)

  running.add(userId)
  saveState(db, userId, { last_attempt_at: new Date().toISOString() })
  try {
    const result = await runFetch(userId, from, to)
    if (result.ok) {
      const counts = store(db, userId, result)
      saveState(db, userId, { status: 'connected', last_success_at: new Date().toISOString(), last_error: null, backoff_until: null })
      console.log(`[garmin] ${trigger} sync ok for ${userId}: ${counts.days} days, ${counts.activities} activities (${from}..${to})`)
      return { ok: true, from, to, ...counts }
    }
    const kind = ['needs_login', 'rate_limited'].includes(result.error) ? result.error : 'error'
    const fields = { status: kind, last_error: String(result.message || kind).slice(0, 500) }
    if (kind === 'rate_limited') {
      fields.backoff_until = new Date(Date.now() + envNum('GARMIN_BACKOFF_HOURS', 6) * 3600_000).toISOString()
    }
    saveState(db, userId, fields)
    console.error(`[garmin] ${trigger} sync failed for ${userId}: ${kind} - ${fields.last_error}`)
    return { ok: false, error: kind, message: fields.last_error, from, to }
  } finally {
    running.delete(userId)
  }
}

/** Should the scheduler try this user now? Pure, for tests. */
export function dueForSync(row, tokenChangedAt, now = new Date(), syncHour = 6, intervalHours = 3) {
  if (now.getHours() < syncHour) return false
  if (row?.backoff_until && Date.parse(row.backoff_until) > now.getTime()) return false
  const lastAttempt = row?.last_attempt_at ?? null
  if (!lastAttempt) return true
  // needs_login: wait for a fresh login (the token file changes), never retry blindly.
  if (row.status === 'needs_login') return tokenChangedAt !== null && tokenChangedAt.getTime() > Date.parse(lastAttempt)
  return now.getTime() - Date.parse(lastAttempt) >= Math.max(1, intervalHours) * 3600_000
}

/** Scheduled sync inside the server process. Returns a stop function. */
export function scheduleGarminSync(db) {
  if (isOff(process.env.GARMIN)) return () => {}
  const tick = async () => {
    if (!garminAvailable()) return
    let users = []
    try {
      users = fs.readdirSync(path.join(dataDir(), 'garmin'))
    } catch {
      return
    }
    for (const userId of users) {
      const mtime = tokenMtime(userId)
      if (!mtime || running.has(userId)) continue
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) continue
      if (!dueForSync(stateRow(db, userId), mtime, new Date(), envNum('GARMIN_SYNC_HOUR', 6), syncIntervalHours())) continue
      try {
        await syncUser(db, userId, { trigger: 'scheduled' })
      } catch (e) {
        console.error(`[garmin] scheduled sync skipped for ${userId}: ${e.message}`)
      }
    }
  }
  const first = setTimeout(tick, 60_000)
  const timer = setInterval(tick, 15 * 60_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function activityPayload(row) {
  return {
    id: row.id,
    source: row.source,
    name: row.name,
    type: row.type,
    startLocal: row.start_local,
    day: row.day,
    durationS: row.duration_s,
    movingS: row.moving_s,
    distanceM: row.distance_m,
    kcal: row.kcal,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    elevationGainM: row.elevation_gain_m,
    avgSpeedMps: row.avg_speed_mps,
    trainingEffect: row.training_effect,
  }
}

export function dailyActivityPayload(row) {
  return {
    day: row.day,
    steps: row.steps,
    activeKcal: row.active_kcal,
    totalKcal: row.total_kcal,
    bmrKcal: row.bmr_kcal,
    restingHr: row.resting_hr,
    sleepSeconds: row.sleep_seconds,
    intensityMinutes: row.intensity_minutes,
    source: row.source,
    syncedAt: row.synced_at,
  }
}
