#!/usr/bin/env node
/**
 * COROS sync test — no network, no dependencies.
 *
 * Runs a fake COROS Training Hub API (qa/fixtures/fake-coros.mjs) on a random
 * port, boots `server/index.js` against it with COROS_BASE, and walks connect /
 * sync / normalisation / token expiry / rate-limit backoff / disconnect, and
 * checks the password is never stored.
 *
 *   node qa/coros-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COROS_EMAIL, COROS_PASSWORD, startFakeCoros } from './fixtures/fake-coros.mjs'
import { localStart, normaliseActivity, syncRange } from '../server/lib/coros.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SERVER = path.join(ROOT, 'server', 'index.js')
const CLI = path.join(ROOT, 'server', 'cli.js')

let passCount = 0
let failCount = 0
function ok(name, condition, detail = '') {
  if (condition) {
    passCount++
    console.log(`PASS  ${name}`)
  } else {
    failCount++
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

function isoDay(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const num = (day) => Number(day.replaceAll('-', ''))
const TODAY = isoDay(0)
const YESTERDAY = isoDay(-1)
const LONG_AGO = isoDay(-40)
const TOO_OLD = isoDay(-120)
/** Epoch seconds of `day` at hh:mm in UTC+2 (timezone 8 quarter-hours). */
const epochAt = (day, hh, mm) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`) / 1000

const run1 = { labelId: '4711', sportType: 100, name: 'Morning Run', date: num(TODAY), startTime: epochAt(TODAY, 7, 5), startTimezone: 8, distance: 10000, totalTime: 3100, workoutTime: 3000, calorie: 641449, avgHr: 152, maxHr: 178, ascent: 85, avgSpeed: 300, trainingLoad: 112 }
const lift = { labelId: '4712', sportType: 402, name: 'Strength', date: num(YESTERDAY), startTime: epochAt(YESTERDAY, 18, 30), startTimezone: 8, totalTime: 2700, workoutTime: 2700, calorie: 250000, avgHr: 110, trainingLoad: 40 }
const old = { labelId: '4713', sportType: 200, name: 'Ride', date: num(LONG_AGO), startTime: epochAt(LONG_AGO, 9, 0), startTimezone: 8, distance: 40000, totalTime: 5400, workoutTime: 5000, calorie: 900000 }
const ancient = { labelId: '4714', sportType: 100, name: 'Ancient run', date: num(TOO_OLD), startTime: epochAt(TOO_OLD, 9, 0), startTimezone: 8, distance: 5000, totalTime: 1500, workoutTime: 1500 }

const DAYS = [
  { happenDay: num(TODAY), rhr: 48, avgSleepHrv: 71, performance: -1 },
  { happenDay: num(YESTERDAY), rhr: 50, avgSleepHrv: 0 },
  { happenDay: num(LONG_AGO), rhr: 52, avgSleepHrv: 65 },
]
const T7 = [{ happenDay: num(TODAY), vo2max: 54 }]

/* ---------- pure helpers ---------- */
eq('localStart: epoch + quarter-hour timezone -> local clock', localStart(epochAt('2026-11-14', 7, 5), 8), '2026-11-14T07:05:00')
eq('localStart: negative offsets (UTC-5)', localStart(Date.parse('2026-11-14T07:05:00-05:00') / 1000, -20), '2026-11-14T07:05:00')
const n = normaliseActivity(run1)
eq('normalise: kcal from small calories', n.kcal, 641.4)
eq('normalise: speed from distance / moving time, not the pace field', n.avgSpeedMps, 3.333)
eq('normalise: type, durations, elevation', [n.type, n.durationS, n.movingS, n.elevationGainM], ['running', 3100, 3000, 85])
eq('normalise: unknown sport is other', normaliseActivity({ ...run1, sportType: 98765 }).type, 'other')
eq('normalise: no labelId -> skipped', normaliseActivity({ ...run1, labelId: '' }), null)
eq('range: first sync backfills 90 days', syncRange(null, '2026-11-14'), { from: '2026-08-17', to: '2026-11-14' })
eq('range: later syncs re-read 7 days', syncRange('2026-11-13T10:00:00Z', '2026-11-14'), { from: '2026-11-08', to: '2026-11-14' })

/* ---------- HealthLog against the fake ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-coros-'))
const port = 22000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${port}`
let server
let serverLog = ''
let fakeCoros

async function api(method, route, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json }
}

async function makeUser(email) {
  const r = spawnSync(process.execPath, [CLI, 'user', 'create', '--email', email, '--password', 'healthlog-pw'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'healthlog-pw' } })
  return login.json.token
}

function grepTree(dir, needle) {
  const hits = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) hits.push(...grepTree(p, needle))
    else if (fs.readFileSync(p).includes(needle)) hits.push(p)
  }
  return hits
}

async function run() {
  fakeCoros = await startFakeCoros({ activities: [run1, lift, old, ancient], dayList: DAYS, t7dayList: T7 })
  const fake = fakeCoros.state

  server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      COMMIT_FILE: path.join(dataDir, 'commit.txt'),
      AI_MOCK: '1',
      OPENCODE_API_KEY: '',
      DIST_DIR: '',
      GARMIN: 'off',
      CRONOMETER: 'off',
      COROS_BASE: fakeCoros.base,
      COROS_SYNC_HOUR: '99', // keep the scheduler out of the test
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (b) => { serverLog += b })
  server.stderr.on('data', (b) => { serverLog += b })
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* not up */ }
    await sleep(100)
  }

  const a = await makeUser('a@example.com')
  const b = await makeUser('b@example.com')

  /* ---------- before connecting ---------- */
  let r = await api('GET', '/api/coros', { token: a })
  eq('status: never connected', [r.status, r.json?.coros?.status, r.json?.coros?.connected], [200, 'never', false])
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('sync before connect: 409', r.status, 409)
  r = await api('GET', '/api/coros')
  eq('status needs auth', r.status, 401)

  /* ---------- bad login ---------- */
  r = await api('POST', '/api/coros/connect', { token: a, body: { email: COROS_EMAIL, password: 'wrong' } })
  eq('wrong password: 400', r.status, 400)
  ok('wrong password: relays COROS\'s message', /password is incorrect/.test(r.json?.error ?? ''), JSON.stringify(r.json))
  r = await api('POST', '/api/coros/connect', { token: a, body: { email: COROS_EMAIL } })
  eq('missing password: 400', r.status, 400)

  /* ---------- connect ---------- */
  r = await api('POST', '/api/coros/connect', { token: a, body: { email: COROS_EMAIL, password: COROS_PASSWORD } })
  eq('connect: 200, first sync ok', [r.status, r.json?.result?.ok], [200, true])
  eq('connect: backfills 90 days', [r.json?.result?.from, r.json?.result?.to], [isoDay(-89), TODAY])
  eq('connect: 3 activities (the 120-day-old one is outside the range)', r.json?.result?.activities, 3)
  eq('connect: status connected with email', [r.json?.coros?.status, r.json?.coros?.connected, r.json?.coros?.email], ['connected', true, COROS_EMAIL])
  ok('login: sends the MD5 of the password, never the password', fake.lastLoginBody.includes(createHash('md5').update(COROS_PASSWORD).digest('hex')) && !fake.lastLoginBody.includes(COROS_PASSWORD))

  /* ---------- the password is not stored anywhere ---------- */
  eq('password: not in the data directory', grepTree(dataDir, COROS_PASSWORD), [])
  eq('password hash: not in the data directory', grepTree(dataDir, createHash('md5').update(COROS_PASSWORD).digest('hex')), [])
  eq('password: not in the server log', serverLog.includes(COROS_PASSWORD), false)
  const sessionFile = fs.readdirSync(path.join(dataDir, 'coros')).map((u) => path.join(dataDir, 'coros', u, 'session.json'))[0]
  ok('session: file exists', !!sessionFile && fs.existsSync(sessionFile))
  if (process.platform !== 'win32') eq('session: file is 0600', (fs.statSync(sessionFile).mode & 0o777).toString(8), '600')

  /* ---------- what landed ---------- */
  r = await api('GET', '/api/activities?limit=10', { token: a })
  const acts = r.json?.activities ?? []
  eq('activities: newest first, tagged coros', acts.map((x) => [x.name, x.source]), [['Morning Run', 'coros'], ['Strength', 'coros'], ['Ride', 'coros']])
  eq('activities: local start time and day', [acts[0]?.startLocal, acts[0]?.day], [`${TODAY}T07:05:00`, TODAY])
  eq('activities: run numbers', [acts[0]?.distanceM, acts[0]?.durationS, acts[0]?.kcal, acts[0]?.avgHr], [10000, 3100, 641.4, 152])
  r = await api('GET', `/api/activity/daily?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  eq('daily: resting HR per day, source coros', (r.json?.days ?? []).map((d) => [d.day, d.restingHr, d.source]), [[LONG_AGO, 52, 'coros'], [YESTERDAY, 50, 'coros'], [TODAY, 48, 'coros']])
  r = await api('GET', `/api/insights?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  eq('insights: HRV (a 0 is no reading)', (r.json?.days ?? []).map((d) => d.hrvNight), [65, null, 71])
  eq('insights: VO2max', (r.json?.metrics ?? []).map((m) => [m.day, m.vo2max]), [[TODAY, 54]])
  eq('insights: strength activity typed for the lifting merge', (r.json?.activities ?? []).find((x) => x.name === 'Strength')?.type, 'strength_training')
  r = await api('GET', '/api/activities', { token: b })
  eq('isolation: user B sees none of it', r.json?.activities?.length, 0)

  /* ---------- re-sync: 7 days, upserts, no duplicates ---------- */
  fake.activities[0] = { ...run1, name: 'Morning Run (renamed)' }
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('resync: ok, only the last 7 days', [r.json?.result?.ok, r.json?.result?.from], [true, isoDay(-6)])
  r = await api('GET', '/api/activities?limit=10', { token: a })
  eq('resync: renamed in place, no duplicates', (r.json?.activities ?? []).map((x) => x.name), ['Morning Run (renamed)', 'Strength', 'Ride'])
  r = await api('POST', '/api/coros/sync', { token: a, body: { days: 0 } })
  eq('sync: days out of range is 400', r.status, 400)
  const loginsBefore = fake.logins
  await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('sync: reuses the token, never logs in again', fake.logins, loginsBefore)

  /* ---------- rate limiting -> backoff ---------- */
  r = await api('POST', '/api/coros/connect', { token: b, body: { email: COROS_EMAIL, password: COROS_PASSWORD } })
  eq('user B connects', r.json?.result?.ok, true)
  fake.rateLimit = true
  r = await api('POST', '/api/coros/sync', { token: b, body: {} })
  eq('429: recorded as rate_limited', [r.json?.result?.ok, r.json?.result?.error], [false, 'rate_limited'])
  ok('429: backoff set', !!r.json?.coros?.backoffUntil)
  const callsBefore = fake.calls.length
  r = await api('POST', '/api/coros/sync', { token: b, body: {} })
  eq('backoff: next sync refused with 429', r.status, 429)
  eq('backoff: COROS not asked again', fake.calls.length, callsBefore)
  fake.rateLimit = false

  /* ---------- token rejected -> needs_login, then reconnect ---------- */
  fake.tokens.clear()
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('expired token: sync reports needs_login', [r.status, r.json?.result?.ok, r.json?.result?.error], [200, false, 'needs_login'])
  eq('expired token: status needs_login, not connected', [r.json?.coros?.status, r.json?.coros?.connected], ['needs_login', false])
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('expired token: further syncs refused without calling COROS', r.status, 409)
  r = await api('GET', '/api/activities', { token: a })
  eq('expired token: synced data kept', r.json?.activities?.length, 3)
  r = await api('POST', '/api/coros/connect', { token: a, body: { email: COROS_EMAIL, password: COROS_PASSWORD } })
  eq('reconnect: works', [r.status, r.json?.coros?.status], [200, 'connected'])

  /* ---------- disconnect ---------- */
  r = await api('POST', '/api/coros/disconnect', { token: a, body: { deleteData: true } })
  eq('disconnect: removed synced data', [r.status, r.json?.deleted?.activities, r.json?.deleted?.days], [200, 3, 3])
  eq('disconnect: status back to never', r.json?.coros?.status, 'never')
  r = await api('GET', `/api/insights?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  eq('disconnect: insights empty again', [r.json?.days?.length, r.json?.activities?.length], [0, 0])
  r = await api('POST', '/api/coros/disconnect', { token: b, body: {} })
  r = await api('GET', `/api/activity/daily?from=${LONG_AGO}&to=${TODAY}`, { token: b })
  ok('disconnect without deleteData keeps the data', (r.json?.days?.length ?? 0) > 0)
  ok('disconnect: session files removed', !fs.existsSync(path.join(dataDir, 'coros')) || fs.readdirSync(path.join(dataDir, 'coros')).length === 0)

  /* ---------- connect rate limit ---------- */
  let last
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/coros/connect', { token: a, body: { email: COROS_EMAIL, password: 'wrong' } })
  eq('connect: rate-limited after repeated attempts', last.status, 429)

  eq('password: still nowhere on disk after everything', grepTree(dataDir, COROS_PASSWORD), [])
}

run()
  .catch((e) => {
    failCount++
    console.error(e)
  })
  .finally(() => {
    server?.kill('SIGTERM')
    fakeCoros?.close()
    console.log(`\n${passCount} passed, ${failCount} failed`)
    if (failCount > 0) {
      console.log(serverLog.split('\n').slice(-30).join('\n'))
      process.exitCode = 1
    }
    setTimeout(() => process.exit(), 300).unref()
  })
