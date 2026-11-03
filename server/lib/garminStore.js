/**
 * Garmin rows -> database. The one place watch data is written, shared by the
 * live sync (server/lib/garmin.js) and the data-export import
 * (POST /api/garmin/import). SPEC §6 "Garmin insights".
 *
 * Every upsert keeps a stored value when the incoming one is null
 * (`COALESCE(excluded.col, col)`), so an import never blanks fields the live
 * sync filled and vice versa.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../db.js'

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const LOCAL_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/

/** A finite number inside [min, max], else null. */
function num(v, min = -Infinity, max = Infinity) {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null
}
const int = (v, min, max) => {
  const x = num(v, min, max)
  return x === null ? null : Math.round(x)
}
const str = (v, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const localTs = (v) => (typeof v === 'string' && LOCAL_TS.test(v) ? v.replace(' ', 'T').slice(0, 19).padEnd(19, ':00').slice(0, 19) : null)

const DAY_S = 86_400

/* ------------------------------------------------------------------ */
/* Field maps: payload key -> [column, coerce]                         */
/* ------------------------------------------------------------------ */

const ACTIVITY_DAY = {
  steps: ['steps', (v) => int(v, 0, 300_000)],
  activeKcal: ['active_kcal', (v) => num(v, 0, 20_000)],
  totalKcal: ['total_kcal', (v) => num(v, 0, 30_000)],
  bmrKcal: ['bmr_kcal', (v) => num(v, 0, 10_000)],
  restingHr: ['resting_hr', (v) => int(v, 20, 150)],
  sleepSeconds: ['sleep_seconds', (v) => int(v, 0, DAY_S)],
  intensityMinutes: ['intensity_minutes', (v) => int(v, 0, 3000)],
}

const WELLNESS = {
  distanceM: ['distance_m', (v) => num(v, 0, 500_000)],
  floorsM: ['floors_m', (v) => num(v, 0, 20_000)],
  moderateMin: ['moderate_min', (v) => int(v, 0, 1440)],
  vigorousMin: ['vigorous_min', (v) => int(v, 0, 1440)],
  stepGoal: ['step_goal', (v) => int(v, 0, 200_000)],
  minHr: ['min_hr', (v) => int(v, 20, 250)],
  maxHr: ['max_hr', (v) => int(v, 20, 250)],
  stressAvg: ['stress_avg', (v) => int(v, 0, 100)],
  stressMax: ['stress_max', (v) => int(v, 0, 100)],
  stressRestS: ['stress_rest_s', (v) => int(v, 0, DAY_S)],
  stressLowS: ['stress_low_s', (v) => int(v, 0, DAY_S)],
  stressMediumS: ['stress_medium_s', (v) => int(v, 0, DAY_S)],
  stressHighS: ['stress_high_s', (v) => int(v, 0, DAY_S)],
  bbHigh: ['bb_high', (v) => int(v, 0, 100)],
  bbLow: ['bb_low', (v) => int(v, 0, 100)],
  bbCharged: ['bb_charged', (v) => int(v, 0, 200)],
  bbDrained: ['bb_drained', (v) => int(v, 0, 200)],
  bbWake: ['bb_wake', (v) => int(v, 0, 100)],
  spo2Avg: ['spo2_avg', (v) => num(v, 50, 100)],
  spo2Low: ['spo2_low', (v) => num(v, 50, 100)],
  respAvg: ['resp_avg', (v) => num(v, 3, 60)],
  hrvNight: ['hrv_night', (v) => num(v, 1, 400)],
  hrvStatus: ['hrv_status', (v) => str(v, 32)],
}

const SLEEP = {
  startLocal: ['start_local', localTs],
  endLocal: ['end_local', localTs],
  deepS: ['deep_s', (v) => int(v, 0, DAY_S)],
  lightS: ['light_s', (v) => int(v, 0, DAY_S)],
  remS: ['rem_s', (v) => int(v, 0, DAY_S)],
  awakeS: ['awake_s', (v) => int(v, 0, DAY_S)],
  score: ['score', (v) => int(v, 0, 100)],
  qualityScore: ['quality_score', (v) => int(v, 0, 100)],
  durationScore: ['duration_score', (v) => int(v, 0, 100)],
  recoveryScore: ['recovery_score', (v) => int(v, 0, 100)],
  avgStress: ['avg_stress', (v) => num(v, 0, 100)],
  avgResp: ['avg_resp', (v) => num(v, 3, 60)],
  avgSpo2: ['avg_spo2', (v) => num(v, 50, 100)],
  avgHr: ['avg_hr', (v) => num(v, 20, 200)],
  awakeCount: ['awake_count', (v) => int(v, 0, 500)],
  restlessCount: ['restless_count', (v) => int(v, 0, 5000)],
  feedback: ['feedback', (v) => str(v, 64)],
}

const METRICS = {
  vo2max: ['vo2max', (v) => num(v, 10, 100)],
  race5kS: ['race_5k_s', (v) => num(v, 300, 36_000)],
  race10kS: ['race_10k_s', (v) => num(v, 600, 72_000)],
  raceHalfS: ['race_half_s', (v) => num(v, 1800, 150_000)],
  raceMarathonS: ['race_marathon_s', (v) => num(v, 3600, 300_000)],
  trainingStatus: ['training_status', (v) => str(v, 32)],
  weeklyLoad: ['weekly_load', (v) => num(v, 0, 20_000)],
  loadMin: ['load_min', (v) => num(v, 0, 20_000)],
  loadMax: ['load_max', (v) => num(v, 0, 20_000)],
  fitnessAge: ['fitness_age', (v) => num(v, 5, 120)],
  heatPct: ['heat_pct', (v) => num(v, 0, 100)],
}

const ACTIVITY = {
  name: ['name', (v) => str(v, 200)],
  type: ['type', (v) => str(v, 64)],
  durationS: ['duration_s', (v) => num(v, 0, 7 * DAY_S)],
  movingS: ['moving_s', (v) => num(v, 0, 7 * DAY_S)],
  distanceM: ['distance_m', (v) => num(v, 0, 2_000_000)],
  kcal: ['kcal', (v) => num(v, 0, 50_000)],
  avgHr: ['avg_hr', (v) => num(v, 20, 250)],
  maxHr: ['max_hr', (v) => num(v, 20, 250)],
  elevationGainM: ['elevation_gain_m', (v) => num(v, 0, 30_000)],
  avgSpeedMps: ['avg_speed_mps', (v) => num(v, 0, 100)],
  trainingEffect: ['training_effect', (v) => num(v, 0, 5)],
  anaerobicTe: ['anaerobic_te', (v) => num(v, 0, 5)],
  trainingLoad: ['training_load', (v) => num(v, 0, 5000)],
  teLabel: ['te_label', (v) => str(v, 40)],
  vo2max: ['vo2max', (v) => num(v, 10, 100)],
  steps: ['steps', (v) => int(v, 0, 500_000)],
  cadence: ['cadence', (v) => num(v, 0, 400)],
  location: ['location', (v) => str(v, 120)],
  hrZonesS: ['hr_zones', zones],
  sets: ['sets', (v) => int(v, 0, 1000)],
  reps: ['reps', (v) => int(v, 0, 100_000)],
}

function zones(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > 8) return null
  const out = v.map((x) => num(x, 0, 7 * DAY_S) ?? 0).map((x) => Math.round(x))
  return out.some((x) => x > 0) ? JSON.stringify(out) : null
}

/* ------------------------------------------------------------------ */
/* Generic keyed upsert                                                */
/* ------------------------------------------------------------------ */

function coerce(row, map) {
  const out = {}
  let any = false
  for (const [key, [col, fn]] of Object.entries(map)) {
    const v = fn(row[key])
    out[col] = v
    if (v !== null) any = true
  }
  return any ? out : null
}

function upsertSql(table, keyCols, cols, extra = []) {
  const all = [...keyCols, ...cols, ...extra]
  const updates = [...cols.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`), ...extra.map((c) => `${c} = excluded.${c}`)]
  return `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})
    ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
}

function upsertDays(db, userId, table, rows, map, now, extraCols = {}) {
  const cols = Object.values(map).map(([c]) => c)
  const extra = Object.keys(extraCols)
  const stmt = db.prepare(upsertSql(table, ['user_id', 'day'], cols, [...extra, 'synced_at']))
  let count = 0
  for (const r of rows) {
    if (!isDay(r?.day)) continue
    const v = coerce(r, map)
    if (!v) continue // nothing recorded that day (watch off): skip rather than store a blank row
    stmt.run(userId, r.day, ...cols.map((c) => v[c]), ...Object.values(extraCols), now)
    count++
  }
  return count
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

/** Activity rows from either source; returns the number stored. */
function upsertActivities(db, userId, rows, now) {
  const cols = Object.values(ACTIVITY).map(([c]) => c)
  const stmt = db.prepare(`
    INSERT INTO activities (id, user_id, source, external_id, start_local, day, ${cols.join(', ')}, synced_at)
    VALUES (?, ?, 'garmin', ?, ?, ?, ${cols.map(() => '?').join(', ')}, ?)
    ON CONFLICT (user_id, source, external_id) DO UPDATE SET
      start_local = excluded.start_local, day = excluded.day,
      ${cols.map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(', ')},
      synced_at = excluded.synced_at`)
  let count = 0
  for (const a of rows) {
    const externalId = a && (typeof a.externalId === 'string' || typeof a.externalId === 'number') ? String(a.externalId).slice(0, 64) : null
    const start = localTs(a?.startLocal)
    if (!externalId || !start) continue
    const v = coerce(a, ACTIVITY) ?? Object.fromEntries(cols.map((c) => [c, null]))
    stmt.run(randomUUID(), userId, externalId, start, start.slice(0, 10), ...cols.map((c) => v[c]), now)
    count++
  }
  return count
}

function upsertRecords(db, userId, rows, now) {
  const stmt = db.prepare(`
    INSERT INTO personal_records (user_id, type, value, achieved_at, external_id, synced_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, type) DO UPDATE SET value = excluded.value, achieved_at = excluded.achieved_at,
      external_id = excluded.external_id, synced_at = excluded.synced_at`)
  let count = 0
  for (const r of rows) {
    const type = str(r?.type, 80)
    const value = num(r?.value, 0, 1e9)
    if (!type || value === null) continue
    const achieved = typeof r.achievedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.achievedAt) ? r.achievedAt.slice(0, 19) : null
    stmt.run(userId, type, value, achieved, r.externalId ? String(r.externalId).slice(0, 64) : null, now)
    count++
  }
  return count
}

const META_KEYS = new Set(['hrZones', 'thresholds'])

function upsertMeta(db, userId, meta, now) {
  if (!meta || typeof meta !== 'object') return
  const stmt = db.prepare(`INSERT INTO garmin_meta (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEYS.has(key) || !value || typeof value !== 'object') continue
    // Numbers only: these are thresholds and zone floors.
    const clean = Object.fromEntries(Object.entries(value).map(([k, v]) => [String(k).slice(0, 40), num(v, 0, 1e5)]).filter(([, v]) => v !== null).slice(0, 20))
    if (Object.keys(clean).length) stmt.run(userId, key, JSON.stringify(clean), now)
  }
}

/**
 * Store a normalised Garmin payload:
 *   { days?, sleep?, metrics?, activities?, records?, meta? }
 * `days` rows carry both the daily_activity fields and the daily_wellness
 * fields. Returns counts per kind.
 */
export function storeGarmin(db, userId, payload) {
  const list = (k) => (Array.isArray(payload?.[k]) ? payload[k] : [])
  const now = new Date().toISOString()
  return withTx(db, () => {
    const days = list('days')
    const counts = {
      days: upsertDays(db, userId, 'daily_activity', days, ACTIVITY_DAY, now, { source: 'garmin' }),
      wellness: upsertDays(db, userId, 'daily_wellness', days, WELLNESS, now),
      sleep: upsertDays(db, userId, 'sleep_nights', list('sleep'), SLEEP, now),
      metrics: upsertDays(db, userId, 'fitness_metrics', list('metrics'), METRICS, now),
      activities: upsertActivities(db, userId, list('activities'), now),
      records: upsertRecords(db, userId, list('records'), now),
    }
    upsertMeta(db, userId, payload?.meta, now)
    return counts
  })
}

/* ------------------------------------------------------------------ */
/* Reads for GET /api/insights                                         */
/* ------------------------------------------------------------------ */

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

function rowsToPayload(rows, map, extra = {}) {
  return rows.map((r) => {
    const out = { day: r.day }
    for (const [key, [col]] of Object.entries(map)) out[key] = r[col] ?? null
    for (const [key, col] of Object.entries(extra)) out[key] = r[col] ?? null
    return out
  })
}

/** Everything the Insights tab needs for [from, to], in one round trip. */
export function insightsPayload(db, userId, from, to) {
  const q = (sql) => db.prepare(sql).all(userId, from, to)
  const days = q(`SELECT a.*, w.* , a.day AS day FROM daily_activity a LEFT JOIN daily_wellness w ON w.user_id = a.user_id AND w.day = a.day
                  WHERE a.user_id = ? AND a.day >= ? AND a.day <= ? ORDER BY a.day`)
  const daily = rowsToPayload(days, { ...ACTIVITY_DAY, ...WELLNESS })
  const sleep = rowsToPayload(q('SELECT * FROM sleep_nights WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY day'), SLEEP)
  const metrics = rowsToPayload(q('SELECT * FROM fitness_metrics WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY day'), METRICS)
  const activities = q('SELECT * FROM activities WHERE user_id = ? AND day >= ? AND day <= ? ORDER BY start_local').map((r) => {
    const out = { id: r.id, startLocal: r.start_local, day: r.day }
    for (const [key, [col]] of Object.entries(ACTIVITY)) out[key] = r[col] ?? null
    if (out.hrZonesS) {
      try { out.hrZonesS = JSON.parse(out.hrZonesS) } catch { out.hrZonesS = null }
    }
    return out
  })
  const intake = q(`SELECT day, SUM(kcal) AS kcal, SUM(protein_g) AS protein FROM meals WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day`)
    .map((r) => ({ day: r.day, kcal: r.kcal, proteinG: r.protein }))
  const weights = db.prepare('SELECT date AS day, weight_kg FROM weight_entries WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date').all(userId, from, to)
    .map((r) => ({ day: r.day, weightKg: r.weight_kg }))
  const records = db.prepare('SELECT * FROM personal_records WHERE user_id = ? ORDER BY type').all(userId)
    .map((r) => ({ type: r.type, value: r.value, achievedAt: r.achieved_at, externalId: r.external_id }))
  const meta = {}
  for (const r of db.prepare('SELECT key, value, updated_at FROM garmin_meta WHERE user_id = ?').all(userId)) {
    try { meta[camel(r.key)] = JSON.parse(r.value) } catch { /* skip a broken row */ }
  }
  const span = db.prepare(`SELECT MIN(day) AS first, MAX(day) AS last FROM (
      SELECT day FROM daily_activity WHERE user_id = ? UNION ALL SELECT day FROM sleep_nights WHERE user_id = ?)`).get(userId, userId)
  return { from, to, coverage: { first: span?.first ?? null, last: span?.last ?? null }, days: daily, sleep, metrics, activities, intake, weights, records, meta }
}

/** Write one garmin_meta entry (server-built values only). */
export function setMeta(db, userId, key, value) {
  db.prepare(`INSERT INTO garmin_meta (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(userId, key, JSON.stringify(value), new Date().toISOString())
}
