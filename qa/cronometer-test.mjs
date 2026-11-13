#!/usr/bin/env node
/**
 * Cronometer sync test — no network, no dependencies.
 *
 * Runs a fake cronometer.com (login page, form login, GWT RPC, CSV export) on a
 * random port, boots `server/index.js` against it with CRONOMETER_BASE, and
 * walks connect / sync / replace / session expiry / export budget / disconnect.
 *
 *   node qa/cronometer-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { CRONO_EMAIL, CRONO_PASSWORD, startFakeCronometer } from './fixtures/fake-cronometer.mjs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const TODAY = isoDay(0)
const YESTERDAY = isoDay(-1)
const LONG_AGO = isoDay(-40)

/* ------------------------------------------------------------------ */
/* Fake Cronometer (qa/fixtures/fake-cronometer.mjs)                   */
/* ------------------------------------------------------------------ */

// [Day, Time, Group, Food Name, Amount, kcal, protein, carbs, fat, fiber]
const DIARY = [
  [TODAY, '8:05 AM', 'Breakfast', 'Oats, rolled', '60.00 g', '228.0', '7.9', '40.6', '4.1', '6.0'],
  [TODAY, '8:10 AM', 'Breakfast', 'Milk, "semi-skimmed"', '200.00 ml', '94.0', '7.0', '9.6', '3.4', ''],
  [TODAY, '1:15 PM', 'Lunch', 'Chicken breast', '150.00 g', '248.0', '46.5', '0.0', '5.4', ''],
  [YESTERDAY, '', 'Dinner', 'Salmon, baked', '1.00 fillet', '367.0', '39.0', '0.0', '22.0', ''],
  [LONG_AGO, '7:30 PM', 'Dinner', 'Pasta', '100.00 g', '371.0', '13.0', '75.0', '1.5', '3.2'],
]

let fake // the fake server's state, set in run()
let fakeCronometer

/* ------------------------------------------------------------------ */
/* HealthLog                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-crono-'))
const port = 20000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${port}`
let server
let serverLog = ''

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
  fakeCronometer = await startFakeCronometer({ diary: DIARY })
  fake = fakeCronometer.state
  const cronoBase = fakeCronometer.base

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
      CRONOMETER_BASE: cronoBase,
      CRONOMETER_SYNC_HOUR: '99', // keep the scheduler out of the test
      CRONOMETER_DAILY_EXPORTS: '4',
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
  let r = await api('GET', '/api/cronometer', { token: a })
  eq('status: 200', r.status, 200)
  eq('status: never connected', [r.json?.cronometer?.status, r.json?.cronometer?.connected], ['never', false])
  r = await api('POST', '/api/cronometer/sync', { token: a, body: {} })
  eq('sync before connect: 409', r.status, 409)
  r = await api('GET', '/api/cronometer')
  eq('status needs auth', r.status, 401)

  /* ---------- a manual meal that must survive every sync ---------- */
  r = await api('POST', '/api/meals', { token: a, body: { day: TODAY, name: 'Chat-logged banana', kcal: 105, proteinG: 1, carbsG: 27, fatG: 0 } })
  eq('manual meal saved', r.status, 201)

  /* ---------- bad login ---------- */
  r = await api('POST', '/api/cronometer/connect', { token: a, body: { email: CRONO_EMAIL, password: 'wrong' } })
  eq('wrong password: 400', r.status, 400)
  ok('wrong password: relays Cronometer\'s message', /Invalid email or password/.test(r.json?.error ?? ''), JSON.stringify(r.json))
  r = await api('POST', '/api/cronometer/connect', { token: a, body: { email: CRONO_EMAIL } })
  eq('missing password: 400', r.status, 400)

  /* ---------- connect ---------- */
  r = await api('POST', '/api/cronometer/connect', { token: a, body: { email: CRONO_EMAIL, password: CRONO_PASSWORD } })
  eq('connect: 200', r.status, 200)
  eq('connect: first sync ok', r.json?.result?.ok, true)
  eq('connect: backfills 90 days', [r.json?.result?.from, r.json?.result?.to], [isoDay(-89), TODAY])
  eq('connect: 5 servings in 4 meals', [r.json?.result?.servings, r.json?.result?.meals], [5, 4])
  eq('connect: status connected with email', [r.json?.cronometer?.status, r.json?.cronometer?.connected, r.json?.cronometer?.email], ['connected', true, CRONO_EMAIL])
  eq('connect: one export counted', r.json?.cronometer?.exportsToday, 1)
  ok('login: sent the csrf token and the cookie from the login page', fake.lastLoginBody.includes('anticsrf=csrf-123'))

  /* ---------- the password is not stored anywhere ---------- */
  eq('password: not in the data directory (DB, WAL, session file)', grepTree(dataDir, CRONO_PASSWORD), [])
  eq('password: not in the server log', serverLog.includes(CRONO_PASSWORD), false)
  const sessionFile = fs.readdirSync(path.join(dataDir, 'cronometer')).map((u) => path.join(dataDir, 'cronometer', u, 'session.json'))[0]
  ok('session: file exists', !!sessionFile && fs.existsSync(sessionFile))
  if (process.platform !== 'win32') eq('session: file is 0600', (fs.statSync(sessionFile).mode & 0o777).toString(8), '600')

  /* ---------- meals ---------- */
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: a })
  const todays = r.json?.meals ?? []
  const breakfast = todays.find((m) => m.name === 'Breakfast')
  eq('meals today: banana + breakfast + lunch', todays.map((m) => m.name).sort(), ['Breakfast', 'Chat-logged banana', 'Lunch'])
  eq('breakfast: source cronometer', breakfast?.source, 'cronometer')
  eq('breakfast: kcal is the sum of servings', breakfast?.kcal, 322)
  eq('breakfast: macros summed', [breakfast?.proteinG, breakfast?.carbsG, breakfast?.fatG], [14.9, 50.2, 7.5])
  eq('breakfast: fibre summed', breakfast?.fiberG, 6)
  eq('breakfast: servings become items, quoted names intact', breakfast?.items?.map((i) => [i.name, i.quantity]), [['Oats, rolled', '60.00 g'], ['Milk, "semi-skimmed"', '200.00 ml']])
  const eaten = new Date(breakfast?.eatenAt)
  eq('breakfast: eaten at the earliest serving time (local 08:05)', [eaten.getHours(), eaten.getMinutes()], [8, 5])
  r = await api('GET', `/api/meals?day=${YESTERDAY}`, { token: a })
  const dinner = r.json?.meals?.[0]
  const dinnerAt = new Date(dinner?.eatenAt)
  eq('no time: dinner defaults to 19:00', [dinner?.name, dinnerAt.getHours(), dinnerAt.getMinutes()], ['Dinner', 19, 0])
  r = await api('GET', `/api/meals?day=${LONG_AGO}`, { token: a })
  eq('backfill: 40 days ago imported', r.json?.meals?.length, 1)
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: b })
  eq('isolation: user B sees none of it', r.json?.meals?.length, 0)
  r = await api('GET', '/api/cronometer', { token: b })
  eq('isolation: user B is not connected', r.json?.cronometer?.connected, false)

  /* ---------- re-sync replaces, edits and deletes carry over ---------- */
  fake.diary = fake.diary.filter((row) => !(row[0] === TODAY && row[2] === 'Lunch')) // deleted in Cronometer
  fake.diary.push([TODAY, '7:45 PM', 'Dinner', 'Steak', '200.00 g', '542.0', '50.0', '0.0', '37.0', ''])
  fake.diary[0][5] = '300.0' // edited oats
  fake.diary = fake.diary.filter((row) => row[0] !== LONG_AGO) // outside the window: must stay in HealthLog
  r = await api('POST', '/api/cronometer/sync', { token: a, body: {} })
  eq('resync: 200 ok', [r.status, r.json?.result?.ok], [200, true])
  eq('resync: only the last 7 days', [r.json?.result?.from, r.json?.result?.to], [isoDay(-6), TODAY])
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: a })
  const names = (r.json?.meals ?? []).map((m) => m.name).sort()
  eq('resync: lunch gone, dinner added, banana kept', names, ['Breakfast', 'Chat-logged banana', 'Dinner'])
  eq('resync: edited serving updated', r.json?.meals?.find((m) => m.name === 'Breakfast')?.kcal, 394)
  r = await api('GET', `/api/meals?day=${LONG_AGO}`, { token: a })
  eq('resync: days outside the window untouched', r.json?.meals?.length, 1)
  r = await api('POST', '/api/cronometer/sync', { token: a, body: {} })
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: a })
  eq('resync twice: no duplicates', r.json?.meals?.length, 3)
  r = await api('POST', '/api/cronometer/sync', { token: a, body: { days: 0 } })
  eq('sync: days out of range is 400', r.status, 400)

  /* ---------- daily export budget (4 in this test) ---------- */
  eq('budget: 3 exports so far', fake.exports.length, 3)
  r = await api('POST', '/api/cronometer/sync', { token: a, body: {} })
  eq('budget: 4th export allowed', r.json?.result?.ok, true)
  r = await api('POST', '/api/cronometer/sync', { token: a, body: {} })
  eq('budget: 5th refused with 429', r.status, 429)
  eq('budget: Cronometer not asked again', fake.exports.length, 4)

  /* ---------- session expiry -> needs_login, then reconnect ---------- */
  fake.sessions.clear()
  r = await api('POST', '/api/cronometer/connect', { token: b, body: { email: CRONO_EMAIL, password: CRONO_PASSWORD } })
  eq('user B connects (own budget)', r.json?.result?.ok, true)
  fake.sessions.clear()
  r = await api('POST', '/api/cronometer/sync', { token: b, body: {} })
  eq('expired session: sync reports needs_login', [r.status, r.json?.result?.ok, r.json?.result?.error], [200, false, 'needs_login'])
  eq('expired session: status needs_login, not connected', [r.json?.cronometer?.status, r.json?.cronometer?.connected], ['needs_login', false])
  r = await api('POST', '/api/cronometer/sync', { token: b, body: {} })
  eq('expired session: further syncs refused without calling Cronometer', r.status, 409)
  r = await api('POST', '/api/cronometer/connect', { token: b, body: { email: CRONO_EMAIL, password: CRONO_PASSWORD } })
  eq('reconnect: works', [r.status, r.json?.cronometer?.status], [200, 'connected'])

  /* ---------- disconnect ---------- */
  r = await api('POST', '/api/cronometer/disconnect', { token: b, body: { deleteMeals: true } })
  eq('disconnect: 200', r.status, 200)
  ok('disconnect: removed B\'s synced meals', r.json?.deletedMeals > 0)
  eq('disconnect: status back to never', r.json?.cronometer?.status, 'never')
  ok('disconnect: logged out at Cronometer', fake.logouts >= 1)
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: a })
  eq('disconnect: A\'s meals untouched', r.json?.meals?.length, 3)
  r = await api('POST', '/api/cronometer/disconnect', { token: a, body: {} })
  r = await api('GET', `/api/meals?day=${TODAY}`, { token: a })
  eq('disconnect without deleteMeals keeps the meals', r.json?.meals?.length, 3)
  ok('disconnect: session files removed', !fs.existsSync(path.join(dataDir, 'cronometer')) || fs.readdirSync(path.join(dataDir, 'cronometer')).length === 0)

  /* ---------- connect rate limit ---------- */
  let last
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/cronometer/connect', { token: a, body: { email: CRONO_EMAIL, password: 'wrong' } })
  eq('connect: rate-limited after repeated attempts', last.status, 429)

  eq('password: still nowhere on disk after everything', grepTree(dataDir, CRONO_PASSWORD), [])
}

run()
  .catch((e) => {
    failCount++
    console.error(e)
  })
  .finally(() => {
    server?.kill('SIGTERM')
    fakeCronometer?.close()
    console.log(`\n${passCount} passed, ${failCount} failed`)
    if (failCount > 0) {
      console.log(serverLog.split('\n').slice(-30).join('\n'))
      process.exitCode = 1
    }
    setTimeout(() => process.exit(), 300).unref()
  })
