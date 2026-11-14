#!/usr/bin/env node
/**
 * COROS sync test — no network, no dependencies.
 *
 * Runs a fake COROS MCP (qa/fixtures/fake-coros.mjs: OAuth metadata, client
 * registration, PKCE, rotating refresh tokens, MCP over SSE, text tools) and
 * boots `server/index.js` against it with COROS_MCP_URL. Walks the browser
 * sign-in round trip, the first sync, parsing into every table, re-sync,
 * token refresh (scheduled and on 401), a revoked connection, a denied
 * sign-in, partial failures, rate-limit backoff and disconnect. Also unit-tests
 * the text parsers on COROS's documented examples.
 *
 *   node qa/coros-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeCoros } from './fixtures/fake-coros.mjs'
import { blocks, clockRange, duration, parseDailyHealth, parseFitness, parseHrv, parsePerDay, parseSleep, parseSportRecords, parseTimezone } from '../server/lib/corosParse.js'
import { messageFromSse, unwrapText } from '../server/lib/corosMcp.js'
import { syncRange } from '../server/lib/coros.js'

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
/* Parsers on the Tool Guide's own examples                            */
/* ------------------------------------------------------------------ */

const DOC_SPORT = `Sport Records — 2026-09-19 to 2026-10-18 (1 records)

1. Sport(9807) — 2026-10-03
   Duration: 2:12:38 | Distance: 12.03 km
   Average Pace: 11:01 /km`
const docSport = parseSportRecords(DOC_SPORT)
eq('doc sport list: one record, range heading ignored', docSport.length, 1)
eq('doc sport list: day, duration, distance, code', [docSport[0]?.startLocal, docSport[0]?.durationS, docSport[0]?.distanceM, docSport[0]?.sportType], ['2026-10-03T00:00:00', 7958, 12030, 9807])
ok('doc sport list: a stable id without a label id', docSport[0]?.externalId === parseSportRecords(DOC_SPORT)[0]?.externalId)

const DOC_SLEEP = `Sleep Overview

2026-10-15
Sleep Score: 91
Daily Sleep: 7h 57min (incl. naps)
Main Sleep (asleep): 7h 57min
Deep Sleep Ratio: 27%
Light Sleep Ratio: 41%
REM Ratio: 31%
Awake Time: 5 min
Main Sleep Window: 2026-10-15 00:28 - 2026-10-15 08:30
Naps Total: 0 min`
const docSleep = parseSleep(DOC_SLEEP)
eq('doc sleep: night row', docSleep.sleep[0], { day: '2026-10-15', startLocal: '2026-10-15T00:28:00', endLocal: '2026-10-15T08:30:00', deepS: 7727, lightS: 11734, remS: 8872, awakeS: 300, score: 91, avgHr: null })
eq('doc sleep: main sleep seconds for the day', docSleep.days, [{ day: '2026-10-15', sleepSeconds: 28620 }])

eq('durations', ['7h 57min', '2:12:38', '45:10', '5 min', '1 h 5 m', '90 s'].map(duration), [28620, 7958, 2710, 300, 3900, 90])
eq('window across midnight from clocks only', clockRange('23:40 - 07:10', '2026-10-15'), ['2026-10-14T23:40:00', '2026-10-15T07:10:00'])
eq('per-day lines', parsePerDay('Resting Heart Rate\n2026-10-13: 49 bpm\n2026-10-14: 48 bpm', /resting/), [{ day: '2026-10-13', value: 49 }, { day: '2026-10-14', value: 48 }])
eq('HRV ignores the normal range', parseHrv('2026-10-15\nNormal Range: 50-70 ms\nAverage HRV: 62 ms\nEvaluation: Normal'), [{ day: '2026-10-15', hrvNight: 62, hrvStatus: 'Normal' }])
eq('markdown table + thousands; a bare Calories is active', parseDailyHealth('| Date | Steps | Calories |\n|---|---|---|\n| 2026-10-14 | 9,812 | 1,450 kcal |')[0], { day: '2026-10-14', steps: 9812, activeKcal: 1450, totalKcal: null, bmrKcal: null, stressAvg: null, restingHr: null, intensityMinutes: null })
eq('JSON reply', parseDailyHealth(JSON.stringify({ list: [{ date: 20261014, steps: 9000, activeCalories: 520 }] }))[0], { day: '2026-10-14', steps: 9000, activeKcal: 520, totalKcal: null, bmrKcal: null, stressAvg: null, restingHr: null, intensityMinutes: null })
eq('nothing recognisable -> nothing', [blocks('No data for this period.').filter((b) => b.day).length, parseSleep('No sleep recorded.').sleep.length], [0, 0])
eq('SSE: picks the reply with the right id', messageFromSse('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"x":1}}\n\n', 3)?.result, { x: 1 })
eq('range: first sync backfills 90 days, later 7', [syncRange(null, '2026-11-14').from, syncRange('2026-11-13T10:00:00Z', '2026-11-14').from], ['2026-08-17', '2026-11-08'])

/* ---- the layout the real COROS MCP sent on 2026-11-14 (values changed) ---- */
eq('wire: a JSON-encoded text block is decoded once', [unwrapText('"Sleep Overview\\n\\n2026-11-14"'), unwrapText('plain "quoted" text'), unwrapText('"not json')], ['Sleep Overview\n\n2026-11-14', 'plain "quoted" text', '"not json'])
const REAL_SPORT = `Sport Records — 2026-11-08 to 2026-11-14 (2 records)
========================

1. Outdoor Run — 2026-11-14
   Location: City Run
   Start Coordinates: -37.800000, 145.000000
   Time Window: startTimestamp=1794647390 | endTimestamp=1794649389
   Duration: 33:14 | Distance: 5.00 km
   Average Pace: 6:39 /km | Avg HR: 160 bpm | Calories: 374 kcal
   LabelId: 481748088193581463 | SportType: 100

2. Outdoor Run — 2026-11-11
   Time Window: startTimestamp=1794339991 | endTimestamp=1794341957
   Duration: 32:34 | Distance: 5.00 km
   LabelId: 481675607669768594 | SportType: 100`
const realSport = parseSportRecords(REAL_SPORT, { tzOffsetMin: 660 })
eq('real sport list: both records', realSport.length, 2)
eq('real sport list: epoch start on the watch clock, numbers, ids', [realSport[0]?.startLocal, realSport[0]?.durationS, realSport[0]?.distanceM, realSport[0]?.avgHr, realSport[0]?.kcal, realSport[0]?.labelId, realSport[0]?.type, realSport[0]?.name],
  ['2026-11-14T20:09:50', 1994, 5000, 160, 374, '481748088193581463', 'running', 'Outdoor Run'])
eq('real sport list: without a timezone the start is the date at 00:00', parseSportRecords(REAL_SPORT)[1]?.startLocal, '2026-11-11T00:00:00')
eq('real sport list: an offset that moves the date is not trusted', parseSportRecords(REAL_SPORT, { tzOffsetMin: -600 })[0]?.startLocal, '2026-11-14T00:00:00')
eq('timezone from the HRV time series (quarter hours)', [parseTimezone('2026-11-08:\n  timestamp=1794056690, timezone=44, hrv=105 ms\n  timestamp=1794057590, timezone=44, hrv=71 ms'), parseTimezone('none here')], [660, null])
eq('real HRV: verdict after the dash, range and baseline ignored', parseHrv('2026-11-14:\n  HRV Avg: 65 ms — Normal\n  Normal Range: 52 - 84 ms\n  Baseline: 68 ms\n2026-11-10:\n  HRV Avg: 88 ms — Above normal'),
  [{ day: '2026-11-14', hrvNight: 65, hrvStatus: 'Normal' }, { day: '2026-11-10', hrvNight: 88, hrvStatus: 'Above normal' }])
eq('real daily: dashed date heading, steps, active calories, exercise, stress', parseDailyHealth('Daily Health Data — Last 7 days | Resting HR: 51 bpm | HRV Baseline: 42 ms\n\n--- 20261108 ---\nSteps: 15,443 | Calories: 995 kcal | Exercise: 54 min\nStress: Avg 28\nSleep Summary:\n  Total: 8h 6min | Deep: 2h 12min | Light: 4h 19min | REM: 1h 25min | Awake: 10 min\n  Sleep HR: Avg 50 bpm | Min 44 bpm | Max 91 bpm'),
  [{ day: '2026-11-08', steps: 15443, activeKcal: 995, totalKcal: null, bmrKcal: null, stressAvg: 28, restingHr: null, intensityMinutes: 54 }])
eq('real fitness: VO2max, race predictions, threshold pace', parseFitness('Fitness Assessment Overview\n========================\n\nVO2max: 41\nRunning Level: 75\nThreshold Pace: 5:23 /km\n5 km Prediction: 25:55\n10 km Prediction: 54:21\nHalf Marathon Prediction: 2:03:07\nMarathon Prediction: 4:22:39'),
  { vo2max: 41, race5kS: 1555, race10kS: 3261, raceHalfS: 7387, raceMarathonS: 15759, ltPaceSPerKm: 323 })

/* ------------------------------------------------------------------ */
/* HealthLog against the fake                                          */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-coros-'))
const port = 22000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${port}`
const RETURN_TO = `${BASE}/#/settings`
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
  return { status: res.status, json, text }
}

async function makeUser(email) {
  const r = spawnSync(process.execPath, [CLI, 'user', 'create', '--email', email, '--password', 'healthlog-pw'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stdout + r.stderr)
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'healthlog-pw' } })
  return login.json.token
}

/** What a browser does: open the authorize URL, follow COROS's redirect to our callback, land on returnTo. */
async function browserSignIn(token) {
  const start = await api('POST', '/api/coros/connect', { token, body: { returnTo: RETURN_TO } })
  if (start.status !== 200) return { start }
  const atCoros = await fetch(start.json.authorizeUrl, { redirect: 'manual' })
  const callback = atCoros.headers.get('location')
  const back = await fetch(callback, { redirect: 'manual' })
  return { start, authorizeUrl: start.json.authorizeUrl, callback, back: { status: back.status, location: back.headers.get('location') } }
}

async function waitFor(token, predicate, ms = 15000) {
  const until = Date.now() + ms
  let last
  while (Date.now() < until) {
    last = (await api('GET', '/api/coros', { token })).json?.coros
    if (last && predicate(last)) return last
    await sleep(100)
  }
  return last
}

function sessionFileFor(token) {
  const dirs = fs.existsSync(path.join(dataDir, 'coros')) ? fs.readdirSync(path.join(dataDir, 'coros')) : []
  return dirs.map((u) => path.join(dataDir, 'coros', u, 'session.json')).filter((f) => fs.existsSync(f))
}

async function run() {
  const ACTS = [
    { labelId: '4711', sportType: 100, name: 'Morning Run', day: TODAY, start: '07:05', duration: '50:00', distance: '10.00 km' },
    { labelId: '4712', sportType: 402, name: 'Strength', day: YESTERDAY, start: '18:30', duration: '45:00', distance: '0.00 km' },
    { labelId: '4713', sportType: 200, name: 'Long Ride', day: LONG_AGO, start: '09:00', duration: '1:30:00', distance: '40.00 km' },
  ]
  const DETAILS = {
    4711: { workoutTime: '48:20', kcal: 641, avgHr: 152, maxHr: 178, ascent: 85 },
    4712: { workoutTime: '45:00', kcal: 250, avgHr: 110, maxHr: 140, ascent: 0 },
    4713: { workoutTime: '1:24:00', kcal: 900, avgHr: 130, maxHr: 165, ascent: 410 },
  }
  fakeCoros = await startFakeCoros({
    activities: ACTS,
    details: DETAILS,
    sleep: [
      { day: TODAY, score: 88, main: '7h 30min', deep: 20, light: 50, rem: 25, awake: '12 min', window: `${YESTERDAY} 23:30 - ${TODAY} 07:12` },
      { day: LONG_AGO, score: 70, main: '6h 0min', deep: 15, light: 60, rem: 20, awake: '20 min', window: `${isoDay(-41)} 00:30 - ${LONG_AGO} 06:50` },
    ],
    hrv: [{ day: TODAY, ms: 62, eval: 'Normal' }, { day: LONG_AGO, ms: 55, eval: 'Low' }],
    daily: [{ day: TODAY, steps: 11234, kcal: 820, exercise: 50, stress: 28 }, { day: YESTERDAY, steps: 8000, kcal: 610, exercise: 45, stress: 35 }],
    rhr: [{ day: TODAY, bpm: 48 }, { day: YESTERDAY, bpm: 50 }],
    stress: [{ day: TODAY, avg: 28 }, { day: YESTERDAY, avg: 35 }],
    vo2max: 54,
  })
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
      COROS_MCP_URL: fakeCoros.mcpUrl,
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
  r = await api('POST', '/api/coros/connect', { body: { returnTo: RETURN_TO } })
  eq('connect needs auth', r.status, 401)
  r = await api('POST', '/api/coros/connect', { token: a, body: { returnTo: 'https://evil.example/#/settings' } })
  eq('connect: returnTo must be a HealthLog page', r.status, 400)
  r = await api('GET', '/api/coros/oauth/callback?code=x&state=forged')
  eq('callback: unknown state is refused', [r.status, /expired|not valid/.test(r.text)], [400, true])

  /* ---------- sign in through COROS ---------- */
  const signIn = await browserSignIn(a)
  eq('connect: 200 with an authorize URL at COROS', [signIn.start.status, signIn.authorizeUrl?.startsWith(`${fakeCoros.base}/oauth2/authorize?`)], [200, true])
  const q = new URL(signIn.authorizeUrl).searchParams
  eq('authorize URL: PKCE S256, resource, offline_access', [q.get('code_challenge_method'), !!q.get('code_challenge'), q.get('resource'), q.get('scope')?.includes('offline_access')], ['S256', true, fakeCoros.mcpUrl, true])
  eq('authorize URL: callback is this API', q.get('redirect_uri'), `${BASE}/api/coros/oauth/callback`)
  eq('callback: browser sent back to Settings', [signIn.back.status, signIn.back.location], [302, RETURN_TO])
  eq('client registered once', fake.registrations, 1)

  let st = await waitFor(a, (s) => !!s.lastSuccessAt)
  eq('first sync: connected and synced in the background', [st?.connected, st?.status, !!st?.lastSuccessAt], [true, 'connected', true])
  ok('first sync: daily tool asked for 90 days, fell back to 7 without a warning', fake.toolCalls.some((c) => c.name === 'queryDailyHealthData' && c.args.days === 90) && fake.toolCalls.some((c) => c.name === 'queryDailyHealthData' && c.args.days === 7) && !st?.lastError, st?.lastError)
  ok('first sync: HRV fetched in chunks of at most 7 days', fake.toolCalls.filter((c) => c.name === 'querySleepHrv').length >= 13)
  eq('first sync: one detail call per activity', fake.toolCalls.filter((c) => c.name === 'getActivityDetail').length, 3)

  /* ---------- tokens stay on the box, out of logs ---------- */
  const [sessionFile] = sessionFileFor(a)
  ok('session: file exists', !!sessionFile)
  if (sessionFile && process.platform !== 'win32') eq('session: file is 0600', (fs.statSync(sessionFile).mode & 0o777).toString(8), '600')
  const session = sessionFile ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : {}
  ok('session: holds access + refresh token', /^at-/.test(session.accessToken ?? '') && /^rt-/.test(session.refreshToken ?? ''))
  eq('tokens and code not in the server log', [serverLog.includes(session.accessToken), serverLog.includes(session.refreshToken), serverLog.includes(new URL(signIn.callback).searchParams.get('code'))], [false, false, false])
  eq('tokens not in the database', ['healthlog.db', 'healthlog.db-wal'].map((f) => path.join(dataDir, f)).filter((f) => fs.existsSync(f) && fs.readFileSync(f).includes(session.accessToken)), [])

  /* ---------- what landed ---------- */
  r = await api('GET', '/api/activities?limit=10', { token: a })
  const acts = r.json?.activities ?? []
  eq('activities: newest first, tagged coros', acts.map((x) => [x.name, x.source]), [['Morning Run', 'coros'], ['Strength', 'coros'], ['Long Ride', 'coros']])
  eq('activities: start, list numbers, detail numbers', [acts[0]?.startLocal, acts[0]?.durationS, acts[0]?.movingS, acts[0]?.distanceM, acts[0]?.kcal, acts[0]?.avgHr, acts[0]?.maxHr, acts[0]?.elevationGainM], [`${TODAY}T07:05:00`, 3000, 2900, 10000, 641, 152, 178, 85])
  r = await api('GET', `/api/activity/daily?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  const daysRows = r.json?.days ?? []
  const todayRow = daysRows.find((d) => d.day === TODAY)
  eq('daily: today steps, active calories, resting HR, sleep, source', [todayRow?.steps, todayRow?.activeKcal, todayRow?.totalKcal, todayRow?.restingHr, todayRow?.sleepSeconds, todayRow?.source], [11234, 820, null, 48, 27000, 'coros'])
  eq('daily: an old day has sleep only (daily metrics reach back a week)', [daysRows.find((d) => d.day === LONG_AGO)?.sleepSeconds, daysRows.find((d) => d.day === LONG_AGO)?.steps], [21600, null])
  r = await api('GET', `/api/insights?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  const ins = r.json ?? {}
  const insToday = ins.days?.find((d) => d.day === TODAY)
  eq('insights: HRV + status, stress', [insToday?.hrvNight, insToday?.hrvStatus, insToday?.stressAvg], [62, 'Normal', 28])
  const night = ins.sleep?.find((s) => s.day === TODAY)
  eq('insights: sleep night with stages and window', [night?.startLocal, night?.endLocal, night?.deepS, night?.lightS, night?.remS, night?.awakeS, night?.score], [`${YESTERDAY}T23:30:00`, `${TODAY}T07:12:00`, 5400, 13500, 6750, 720, 88])
  eq('insights: VO2max and race predictions today', (ins.metrics ?? []).map((m) => [m.day, m.vo2max, m.race5kS, m.race10kS, m.raceHalfS, m.raceMarathonS]), [[TODAY, 54, 1290, 2690, 5940, 12495]])
  eq('insights: threshold pace from COROS', ins.meta?.thresholds?.ltPaceSPerKm, 280)
  eq('insights: sources say COROS, not Garmin', ins.sources, { garmin: false, coros: true })
  const corosDirs = fs.readdirSync(path.join(dataDir, 'coros'))
  const lastSync = corosDirs.map((u) => path.join(dataDir, 'coros', u, 'last-sync.txt')).find((f) => fs.existsSync(f))
  const lastText = lastSync ? fs.readFileSync(lastSync, 'utf8') : ''
  ok('raw replies of the sync saved, decoded', /===== querySportRecords/.test(lastText) && lastText.includes('\n1. Morning Run'))
  ok('server log: each tool reply logged, nothing flagged as unparsed', /\[coros\] \S+ querySportRecords \{/.test(serverLog) && !/parsed to 0 rows/.test(serverLog), serverLog.match(/.*parsed to 0 rows.*/)?.[0])
  eq('insights: strength typed for the lifting merge', ins.activities?.find((x) => x.name === 'Strength')?.type, 'strength_training')
  r = await api('GET', '/api/activities', { token: b })
  eq('isolation: user B sees none of it', r.json?.activities?.length, 0)

  /* ---------- re-sync ---------- */
  fake.toolCalls.length = 0
  fake.activities[0] = { ...fake.activities[0], name: 'Morning Run (renamed)' }
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('resync: ok over the last 7 days', [r.json?.result?.ok, r.json?.result?.from], [true, isoDay(-6)])
  eq('resync: no detail calls for known activities', fake.toolCalls.filter((c) => c.name === 'getActivityDetail').length, 0)
  r = await api('GET', '/api/activities?limit=10', { token: a })
  eq('resync: renamed in place, details kept, no duplicates', (r.json?.activities ?? []).map((x) => [x.name, x.kcal]), [['Morning Run (renamed)', 641], ['Strength', 250], ['Long Ride', 900]])
  r = await api('POST', '/api/coros/sync', { token: a, body: { days: 0 } })
  eq('sync: days out of range is 400', r.status, 400)

  /* ---------- one tool failing does not sink the sync ---------- */
  fake.failTool = 'queryStressLevel'
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('partial: sync ok, failure reported', [r.json?.result?.ok, r.json?.result?.warnings?.length], [true, 1])
  ok('partial: status says what was skipped', /queryStressLevel/.test(r.json?.coros?.lastError ?? ''), r.json?.coros?.lastError)
  fake.failTool = null

  /* ---------- token refresh ---------- */
  const s1 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  fs.writeFileSync(sessionFile, JSON.stringify({ ...s1, expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { mode: 0o600 })
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  const s2 = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  eq('refresh: due token refreshed before syncing', [r.json?.result?.ok, fake.refreshes, s2.refreshToken !== s1.refreshToken, Date.parse(s2.expiresAt) > Date.now() + 86400_000], [true, 1, true, true])
  ok('refresh: the spent refresh token no longer works at COROS', !fake.refresh.has(s1.refreshToken))
  fake.access.clear() // COROS forgot the access token
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('refresh: a 401 refreshes once and retries', [r.json?.result?.ok, fake.refreshes], [true, 2])

  /* ---------- connection revoked at COROS -> needs_login ---------- */
  fake.access.clear()
  fake.refresh.clear()
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('revoked: sync reports needs_login', [r.status, r.json?.result?.ok, r.json?.result?.error], [200, false, 'needs_login'])
  eq('revoked: status needs_login, session file gone', [r.json?.coros?.status, r.json?.coros?.connected, sessionFileFor(a).length], ['needs_login', false, 0])
  r = await api('POST', '/api/coros/sync', { token: a, body: {} })
  eq('revoked: further syncs refused without calling COROS', r.status, 409)
  r = await api('GET', '/api/activities', { token: a })
  eq('revoked: synced data kept', r.json?.activities?.length, 3)

  /* ---------- denied sign-in, then a good one ---------- */
  fake.denyNext = true
  const denied = await browserSignIn(a)
  eq('denied: browser still sent back to Settings', [denied.back.status, denied.back.location], [302, RETURN_TO])
  st = (await api('GET', '/api/coros', { token: a })).json?.coros
  ok('denied: not connected, reason recorded', !st?.connected && /not completed/.test(st?.lastError ?? ''), JSON.stringify(st))
  const again = await browserSignIn(a)
  eq('reconnect: works', again.back.location, RETURN_TO)
  st = await waitFor(a, (s) => s.connected && !!s.lastSuccessAt)
  eq('reconnect: synced again', [st?.status, st?.connected], ['connected', true])
  eq('reconnect: client reused, not registered again', fake.registrations, 1)

  /* ---------- rate limiting -> backoff ---------- */
  await browserSignIn(b)
  await waitFor(b, (s) => !!s.lastSuccessAt)
  fake.rateLimit = true
  r = await api('POST', '/api/coros/sync', { token: b, body: {} })
  eq('429: recorded as rate_limited with a backoff', [r.json?.result?.error, !!r.json?.coros?.backoffUntil], ['rate_limited', true])
  const calls = fake.toolCalls.length
  r = await api('POST', '/api/coros/sync', { token: b, body: {} })
  eq('backoff: next sync refused with 429, COROS not asked', [r.status, fake.toolCalls.length], [429, calls])
  fake.rateLimit = false

  /* ---------- disconnect ---------- */
  const revokedBefore = fake.revoked
  r = await api('POST', '/api/coros/disconnect', { token: a, body: { deleteData: true } })
  eq('disconnect: removed synced data', [r.status, r.json?.deleted?.activities, r.json?.deleted?.sleep > 0, r.json?.deleted?.days > 0], [200, 3, true, true])
  eq('disconnect: token revoked at COROS, status never', [fake.revoked, r.json?.coros?.status], [revokedBefore + 1, 'never'])
  r = await api('GET', `/api/insights?from=${LONG_AGO}&to=${TODAY}`, { token: a })
  eq('disconnect: insights empty again', [r.json?.days?.length, r.json?.sleep?.length, r.json?.activities?.length], [0, 0, 0])
  r = await api('POST', '/api/coros/disconnect', { token: b, body: {} })
  r = await api('GET', '/api/activities', { token: b })
  ok('disconnect without deleteData keeps the data', (r.json?.activities?.length ?? 0) > 0)
  eq('disconnect: session files removed', sessionFileFor(a).length + sessionFileFor(b).length, 0)
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
