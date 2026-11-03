#!/usr/bin/env node
/**
 * HealthLog API test — no network, no dependencies.
 *
 * Boots `server/index.js` on a random port with a temp DATA_DIR and AI_MOCK=1,
 * then walks the whole SPEC §6 surface with fetch. Prints one PASS/FAIL line per
 * assertion and exits non-zero if anything fails.
 *
 *   node qa/api-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SERVER = path.join(ROOT, 'server', 'index.js')
const CLI = path.join(ROOT, 'server', 'cli.js')

/* ------------------------------------------------------------------ */
/* Assertions                                                          */
/* ------------------------------------------------------------------ */

let passCount = 0
let failCount = 0
const failures = []

function ok(name, condition, detail = '') {
  if (condition) {
    passCount++
    console.log(`PASS  ${name}`)
  } else {
    failCount++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(name, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function near(name, actual, expected, tolerance = 0.05) {
  const same = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
  ok(name, same, `expected ~${expected}, got ${actual}`)
}

/* ------------------------------------------------------------------ */
/* Dates (local calendar, same as the server)                          */
/* ------------------------------------------------------------------ */

function isoDay(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const TODAY = isoDay(0)
const YESTERDAY = isoDay(-1)
const TWO_DAYS_AGO = isoDay(-2)
const FIVE_DAYS_AGO = isoDay(-5)

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

const port = 18000 + Math.floor(Math.random() * 2000)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-qa-'))
const BASE = `http://127.0.0.1:${port}`

const childEnv = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  COMMIT_FILE: path.join(dataDir, 'commit.txt'),
  AI_MOCK: '1',
  OPENCODE_API_KEY: '',
  DIST_DIR: '',
  // Garmin: a fake fetcher stands in for the Python script (qa/fixtures/fake-garmin.mjs).
  GARMIN: 'on',
  GARMIN_PYTHON: process.execPath,
  GARMIN_SCRIPT: path.join(HERE, 'fixtures', 'fake-garmin.mjs'),
  GARMIN_SYNC_HOUR: '99', // never let the daily scheduler fire during the test
}

let serverLog = ''
const server = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', (b) => {
  serverLog += b.toString()
})
server.stderr.on('data', (b) => {
  serverLog += b.toString()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode})\n${serverLog}`)
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error(`server did not become healthy in ${timeoutMs} ms\n${serverLog}`)
}

function stopServer() {
  if (server.exitCode === null) {
    try {
      server.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helper                                                         */
/* ------------------------------------------------------------------ */

async function api(method, route, { token, body, headers = {}, rawBody } = {}) {
  const opts = { method, headers: { ...headers } }
  if (rawBody !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = rawBody
  } else if (body !== undefined) {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  if (token) opts.headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + route, opts)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

async function run() {
  await waitForServer()

  /* ---------- health + CORS ---------- */
  let r = await api('GET', '/api/health')
  eq('health: 200', r.status, 200)
  eq('health: ok', r.json?.ok, true)
  eq('health: service', r.json?.service, 'healthlog')
  eq('health: commit null without COMMIT_FILE', r.json?.commit, null)
  eq('health: users 0 on empty db', r.json?.users, 0)
  eq('health: meals 0 on empty db', r.json?.meals, 0)
  ok('health: users/meals are numbers', typeof r.json?.users === 'number' && typeof r.json?.meals === 'number')

  r = await api('GET', '/api/health', { headers: { origin: 'https://example.github.io' } })
  eq('cors: echoes Origin', r.headers.get('access-control-allow-origin'), 'https://example.github.io')
  ok('cors: vary Origin', (r.headers.get('vary') || '').toLowerCase().includes('origin'))
  ok(
    'cors: allow-methods',
    (r.headers.get('access-control-allow-methods') || '').includes('DELETE'),
    r.headers.get('access-control-allow-methods') || '',
  )

  r = await api('OPTIONS', '/api/weights')
  eq('cors: OPTIONS 204', r.status, 204)
  eq('cors: OPTIONS has empty body', r.text, '')

  r = await api('POST', '/api/auth/login', { rawBody: '{nope' })
  eq('bad JSON: 400', r.status, 400)
  eq('bad JSON: ok false', r.json?.ok, false)

  /* ---------- invite codes via the CLI ---------- */
  const cli = spawnSync(process.execPath, [CLI, 'invite', 'create', '--note', 'qa'], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
  })
  const inviteCode = (cli.stdout || '').trim()
  eq('cli: invite create exits 0', cli.status, 0)
  ok('cli: invite create prints a code', /^HL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(inviteCode), inviteCode)
  ok('cli: invite create prints only the code', (cli.stdout || '').trim().split(/\s+/).length === 1)

  const cliList = spawnSync(process.execPath, [CLI, 'invite', 'list'], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
  })
  ok('cli: invite list shows the code', (cliList.stdout || '').includes(inviteCode))
  ok('cli: invite list does not leak hashes', !/scrypt\$/.test(cliList.stdout || ''))

  const cliUser = spawnSync(
    process.execPath,
    [CLI, 'user', 'create', '--email', 'owner@example.com', '--password', 'own3r-pass'],
    { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' },
  )
  ok('cli: user create works without an invite', cliUser.status === 0 && /created user/i.test(cliUser.stdout || ''), cliUser.stdout + cliUser.stderr)
  ok('cli: user create never prints a password hash', !/scrypt\$/.test(cliUser.stdout || ''))

  r = await api('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'own3r-pass' } })
  eq('cli: created user can log in', r.status, 200)

  /* ---------- register / login ---------- */
  const EMAIL = 'sam@example.com'
  const PASSWORD = 'correct-horse'

  r = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: 'short', inviteCode } })
  eq('register: rejects a short password', r.status, 400)

  r = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: PASSWORD, inviteCode: 'HL-NOPE-NOPE-NOPE' } })
  eq('register: rejects a bad invite code', r.status, 400)

  r = await api('POST', '/api/auth/register', { body: { email: EMAIL, password: PASSWORD, inviteCode } })
  eq('register: 200', r.status, 200)
  eq('register: ok', r.json?.ok, true)
  ok('register: returns a token', typeof r.json?.token === 'string' && r.json.token.length > 20)
  eq('register: returns the user email', r.json?.user?.email, EMAIL)
  eq('register: user has no display name', r.json?.user?.displayName, null)
  const token = r.json?.token

  r = await api('POST', '/api/auth/register', { body: { email: EMAIL.toUpperCase(), password: PASSWORD, inviteCode } })
  eq('register: duplicate email (case-insensitive) is 409', r.status, 409)

  r = await api('POST', '/api/auth/register', {
    body: { email: 'other@example.com', password: PASSWORD, inviteCode },
  })
  ok('register: used invite code is rejected', r.status === 409 || r.status === 400, `status ${r.status}`)

  r = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong-password' } })
  eq('login: wrong password 401', r.status, 401)
  eq('login: wrong password message', r.json?.ok, false)

  r = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } })
  eq('login: 200', r.status, 200)
  ok('login: returns a fresh token', typeof r.json?.token === 'string' && r.json.token !== token)
  const authToken = r.json?.token

  r = await api('GET', '/api/auth/me')
  eq('me: 401 without a token', r.status, 401)
  eq('me: 401 body', r.json?.error, 'Not signed in')

  r = await api('GET', '/api/auth/me', { token: authToken })
  eq('me: 200 with a token', r.status, 200)
  eq('me: user email', r.json?.user?.email, EMAIL)
  ok('me: includes a profile object', r.json?.profile && typeof r.json.profile === 'object')
  eq('me: profile defaults to a 90-day chart window', r.json?.profile?.chartWindowDays, 90)

  /* ---------- profile ---------- */
  r = await api('GET', '/api/profile', { token: authToken })
  eq('profile: GET 200', r.status, 200)
  eq('profile: empty heightCm', r.json?.profile?.heightCm, null)
  eq('profile: empty kcalTarget', r.json?.profile?.kcalTarget, null)

  r = await api('PUT', '/api/profile', {
    token: authToken,
    body: {
      heightCm: 180,
      sex: 'male',
      age: 30,
      activityLevel: 'moderate',
      startWeightKg: 82,
      goalWeightKg: 75,
      chartWindowDays: 30,
    },
  })
  eq('profile: PUT 200', r.status, 200)
  eq('profile: height saved', r.json?.profile?.heightCm, 180)
  eq('profile: activity saved', r.json?.profile?.activityLevel, 'moderate')
  eq('profile: chart window saved', r.json?.profile?.chartWindowDays, 30)
  // Mifflin–St Jeor, male: 10*82 + 6.25*180 - 5*30 + 5 = 1800; *1.55 = 2790
  eq('profile: kcalTarget recomputed (Mifflin–St Jeor x activity)', r.json?.profile?.kcalTarget, 2790)

  r = await api('PUT', '/api/profile', { token: authToken, body: { kcalTarget: 2400, proteinG: 180, carbG: 240, fatG: 80 } })
  eq('profile: explicit kcalTarget wins', r.json?.profile?.kcalTarget, 2400)
  eq('profile: protein grams saved', r.json?.profile?.proteinG, 180)

  r = await api('PUT', '/api/profile', { token: authToken, body: { sex: 'robot' } })
  eq('profile: rejects an invalid sex', r.status, 400)

  r = await api('PUT', '/api/profile', { token: authToken, body: { chartWindowDays: 45 } })
  eq('profile: explicit kcalTarget survives an unrelated update', r.json?.profile?.kcalTarget, 2400)
  eq('profile: unrelated update still applies', r.json?.profile?.chartWindowDays, 45)

  r = await api('PUT', '/api/profile', { token: authToken, body: { heightCm: 181 } })
  eq('profile: changing a formula input recomputes kcalTarget', r.json?.profile?.kcalTarget, 2800)
  await api('PUT', '/api/profile', { token: authToken, body: { heightCm: 180, chartWindowDays: 30, kcalTarget: 2400 } })

  /* ---------- weights ---------- */
  r = await api('POST', '/api/weights', { token: authToken, body: { date: TODAY, weightKg: 82.4 } })
  eq('weights: POST 201', r.status, 201)
  eq('weights: POST echo date', r.json?.entry?.date, TODAY)
  near('weights: POST echo weight', r.json?.entry?.weightKg, 82.4)
  const firstEntryId = r.json?.entry?.id
  ok('weights: POST returns an id', typeof firstEntryId === 'string' && firstEntryId.length > 10)

  r = await api('POST', '/api/weights', { token: authToken, body: { date: TODAY, weightKg: 82.1, note: 'upserted' } })
  eq('weights: same date upserts (201)', r.status, 201)
  eq('weights: upsert reuses the row id', r.json?.entry?.id, firstEntryId)
  near('weights: upsert stores the new weight', r.json?.entry?.weightKg, 82.1)
  eq('weights: upsert stores the note', r.json?.entry?.note, 'upserted')

  r = await api('POST', '/api/weights', { token: authToken, body: { date: YESTERDAY, weightKg: 82.6 } })
  const yesterdayId = r.json?.entry?.id
  eq('weights: second day 201', r.status, 201)

  r = await api('POST', '/api/weights', { token: authToken, body: { date: TWO_DAYS_AGO, weightKg: 82.9 } })
  eq('weights: third day 201', r.status, 201)

  r = await api('GET', '/api/weights', { token: authToken })
  eq('weights: GET returns all 3 days', r.json?.entries?.length, 3)
  eq('weights: GET is sorted ascending', r.json?.entries?.map((e) => e.date), [TWO_DAYS_AGO, YESTERDAY, TODAY])
  ok('weights: entry shape', typeof r.json?.entries?.[0]?.weightKg === 'number' && !!r.json.entries[0].createdAt)

  r = await api('GET', `/api/weights?from=${YESTERDAY}&to=${TODAY}`, { token: authToken })
  eq('weights: from/to filter', r.json?.entries?.length, 2)

  r = await api('POST', '/api/weights', { token: authToken, body: { date: '31-10-2026', weightKg: 80 } })
  eq('weights: rejects a non-ISO date', r.status, 400)

  r = await api('PUT', `/api/weights/${yesterdayId}`, { token: authToken, body: { weightKg: 82.2 } })
  eq('weights: PUT 200', r.status, 200)
  near('weights: PUT updated the weight', r.json?.entry?.weightKg, 82.2)

  r = await api('PUT', '/api/weights/does-not-exist', { token: authToken, body: { weightKg: 80 } })
  eq('weights: PUT unknown id 404', r.status, 404)

  /* ---------- phases ---------- */
  r = await api('POST', '/api/phases', { token: authToken, body: { name: 'Cut 1', startDate: TWO_DAYS_AGO, color: '#e11d48' } })
  eq('phases: POST 201', r.status, 201)
  eq('phases: name saved', r.json?.phase?.name, 'Cut 1')
  eq('phases: colour saved', r.json?.phase?.color, '#e11d48')
  eq('phases: open-ended by default', r.json?.phase?.endDate, null)
  const phaseId = r.json?.phase?.id

  r = await api('GET', '/api/phases', { token: authToken })
  eq('phases: GET returns 1', r.json?.phases?.length, 1)

  r = await api('PUT', `/api/phases/${phaseId}`, { token: authToken, body: { name: 'Cut 1 (revised)', endDate: TODAY } })
  eq('phases: PUT 200', r.status, 200)
  eq('phases: PUT renamed', r.json?.phase?.name, 'Cut 1 (revised)')
  eq('phases: PUT closed the phase', r.json?.phase?.endDate, TODAY)

  r = await api('POST', '/api/phases', { token: authToken, body: { name: 'Bad', startDate: TODAY, endDate: YESTERDAY } })
  eq('phases: rejects endDate before startDate', r.status, 400)

  /* ---------- dashboard (weight maths) ---------- */
  r = await api('GET', '/api/dashboard?days=30', { token: authToken })
  eq('dashboard: 200', r.status, 200)
  const m = r.json?.metrics ?? {}
  near('dashboard: currentWeightKg', m.currentWeightKg, 82.1)
  near('dashboard: avg7d (mean of 3 entries)', m.avg7d, (82.9 + 82.2 + 82.1) / 3, 0.02)
  near('dashboard: totalChangeKg', m.totalChangeKg, 82.1 - 82.9, 0.02)
  near('dashboard: dailySwingKg (mean abs day-to-day)', m.dailySwingKg, (0.7 + 0.1) / 2, 0.02)
  eq('dashboard: streakDays', m.streakDays, 3)
  eq('dashboard: bestStreakDays', m.bestStreakDays, 3)
  near('dashboard: bmi from height', m.bmi, 82.1 / (1.8 * 1.8), 0.05)
  eq('dashboard: goalProgressPct', m.goalProgressPct, 0)
  eq('dashboard: startWeightKg from profile', m.startWeightKg, 82)
  eq('dashboard: goalWeightKg from profile', m.goalWeightKg, 75)
  eq('dashboard: weeklyRateKg null without a 7-day-old average', m.weeklyRateKg, null)
  eq('dashboard: intake day defaults to today', m.intake?.day, TODAY)
  eq('dashboard: intake kcalTarget from profile', m.intake?.kcalTarget, 2400)
  eq('dashboard: intake kcal 0 before meals', m.intake?.kcal, 0)
  eq('dashboard: intakeHistory length = days', m.intakeHistory?.length, 30)
  eq('dashboard: intakeHistory ends today', m.intakeHistory?.[29]?.day, TODAY)
  eq('dashboard: adaptiveTdee kcal null without enough data', m.adaptiveTdee?.kcal, null)
  ok('dashboard: adaptiveTdee explains what is missing', typeof m.adaptiveTdee?.reason === 'string' && m.adaptiveTdee.reason.length > 0)
  eq('dashboard: adaptiveTdee window ends yesterday', m.adaptiveTdee?.windowEnd, YESTERDAY)
  eq('dashboard: adaptiveTdee echoes kcalTarget, untouched', m.adaptiveTdee?.kcalTarget, m.intake?.kcalTarget)

  // bmi must be null without a height
  const savedHeight = 180
  await api('PUT', '/api/profile', { token: authToken, body: { heightCm: null } })
  r = await api('GET', '/api/dashboard?days=7', { token: authToken })
  eq('dashboard: bmi null without height', r.json?.metrics?.bmi, null)
  await api('PUT', '/api/profile', { token: authToken, body: { heightCm: savedHeight } })
  await api('PUT', '/api/profile', { token: authToken, body: { kcalTarget: 2400 } })

  /* ---------- meals + foods ---------- */
  r = await api('POST', '/api/meals', {
    token: authToken,
    body: {
      day: TODAY,
      name: 'Oatmeal',
      description: 'with blueberries',
      kcal: 350,
      proteinG: 12,
      carbsG: 55,
      fatG: 9,
      items: [{ name: 'Oats', quantity: '60 g', kcal: 220, proteinG: 8, carbsG: 38, fatG: 4 }],
    },
  })
  eq('meals: POST 201', r.status, 201)
  eq('meals: name saved', r.json?.meal?.name, 'Oatmeal')
  eq('meals: day saved', r.json?.meal?.day, TODAY)
  eq('meals: source defaults to manual', r.json?.meal?.source, 'manual')
  eq('meals: items saved', r.json?.meal?.items?.length, 1)
  eq('meals: item name', r.json?.meal?.items?.[0]?.name, 'Oats')
  const mealId = r.json?.meal?.id

  r = await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })
  eq('meals: GET by day', r.json?.meals?.length, 1)
  eq('meals: GET includes items', r.json?.meals?.[0]?.items?.length, 1)

  r = await api('PUT', `/api/meals/${mealId}`, { token: authToken, body: { kcal: 380, name: 'Oatmeal + berries' } })
  eq('meals: PUT 200', r.status, 200)
  eq('meals: PUT updated kcal', r.json?.meal?.kcal, 380)
  eq('meals: PUT keeps existing items', r.json?.meal?.items?.length, 1)

  r = await api('POST', '/api/foods', {
    token: authToken,
    body: { name: 'Greek yoghurt', serving: '170 g', kcal: 100, proteinG: 17, carbsG: 6, fatG: 0 },
  })
  eq('foods: POST 201', r.status, 201)
  eq('foods: name saved', r.json?.food?.name, 'Greek yoghurt')
  eq('foods: serving saved', r.json?.food?.serving, '170 g')
  const foodId = r.json?.food?.id

  r = await api('GET', '/api/foods', { token: authToken })
  eq('foods: GET lists the food', r.json?.foods?.length, 1)

  r = await api('GET', '/api/dashboard?days=7', { token: authToken })
  eq('dashboard: intake kcal includes the meal', r.json?.metrics?.intake?.kcal, 380)
  eq('dashboard: intake protein', r.json?.metrics?.intake?.proteinG, 12)
  eq('dashboard: intakeHistory today kcal', r.json?.metrics?.intakeHistory?.[6]?.kcal, 380)
  ok(
    'dashboard: intake macro pcts are energy shares',
    r.json?.metrics?.intake?.proteinPct + r.json?.metrics?.intake?.carbPct + r.json?.metrics?.intake?.fatPct >= 99,
  )

  /* ---------- chat: both models valid and agreeing ---------- */
  r = await api('POST', '/api/chat', { token: authToken, body: { message: '2 eggs on toast with butter', day: TODAY } })
  eq('chat: 200', r.status, 200)
  eq('chat: ok', r.json?.ok, true)
  ok('chat: assistant message returned', r.json?.message?.role === 'assistant')
  ok('chat: reply quotes the reconciled kcal', /\b420\b/.test(r.json?.message?.content || ''), r.json?.message?.content)
  ok('chat: reply quotes the macros', /protein/i.test(r.json?.message?.content || '') && /carbs/i.test(r.json?.message?.content || ''))
  ok('chat: reply includes the comparison', /Model A/.test(r.json?.message?.content || ''))
  ok('chat: reply includes the assumption notes', /Assume/i.test(r.json?.message?.content || ''))

  const agreeAnalysis = r.json?.analysis
  ok('chat: analysis returned', !!agreeAnalysis?.id)
  eq('chat: analysis modelA', agreeAnalysis?.modelA, 'claude-haiku-5-5')
  eq('chat: analysis modelB', agreeAnalysis?.modelB, 'gemini-4-argon')
  eq('chat: modelAOutput total kcal', agreeAnalysis?.modelAOutput?.total?.kcal, 400)
  eq('chat: modelBOutput total kcal', agreeAnalysis?.modelBOutput?.total?.kcal, 440)
  ok('chat: modelAOutput has confidence + notes', typeof agreeAnalysis?.modelAOutput?.confidence === 'number' && !!agreeAnalysis?.modelAOutput?.notes)
  ok('chat: modelAOutput has items', Array.isArray(agreeAnalysis?.modelAOutput?.items) && agreeAnalysis.modelAOutput.items.length > 0)
  eq('chat: reconciled kcal is the mean', agreeAnalysis?.reconciled?.total?.kcal, 420)
  eq('chat: reconciled protein is the mean', agreeAnalysis?.reconciled?.total?.protein_g, 25)
  eq('chat: agreement high under 10%', agreeAnalysis?.agreement, 'high')
  near('chat: deltaPct computed', agreeAnalysis?.deltaPct, 9.1, 0.15)
  ok('chat: reconciled items scaled to the reconciled total', Array.isArray(agreeAnalysis?.reconciled?.items) && agreeAnalysis.reconciled.items.length > 0)
  const scaledKcal = (agreeAnalysis?.reconciled?.items ?? []).reduce((a, i) => a + i.kcal, 0)
  near('chat: scaled item kcal sums to the reconciled total', scaledKcal, 420, 1.5)

  ok('chat: meal saved', !!r.json?.meal?.id)
  eq('chat: meal kcal = reconciled', r.json?.meal?.kcal, 420)
  eq('chat: meal source ai', r.json?.meal?.source, 'ai')
  eq('chat: meal linked to the analysis', r.json?.meal?.analysisId, agreeAnalysis?.id)
  eq('chat: meal day', r.json?.meal?.day, TODAY)
  ok('chat: meal has items', (r.json?.meal?.items ?? []).length > 0)

  r = await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })
  eq('chat: meal is retrievable', r.json?.meals?.filter((x) => x.source === 'ai').length, 1)

  r = await api('GET', `/api/analyses/${agreeAnalysis?.id}`, { token: authToken })
  eq('analyses: GET 200', r.status, 200)
  eq('analyses: reconciled matches', r.json?.analysis?.reconciled?.total?.kcal, 420)
  ok('analyses: comparison stored', (r.json?.analysis?.comparison || '').length > 10)
  eq('analyses: agreement recomputed from stored outputs', r.json?.analysis?.agreement, 'high')

  r = await api('GET', '/api/analyses/nope', { token: authToken })
  eq('analyses: unknown id 404', r.status, 404)

  r = await api('GET', '/api/chat/messages', { token: authToken })
  eq('chat messages: GET 200', r.status, 200)
  eq('chat messages: user + assistant stored', r.json?.messages?.length, 2)
  eq('chat messages: chronological', r.json?.messages?.map((x) => x.role), ['user', 'assistant'])
  ok('chat messages: assistant linked to the analysis', !!r.json?.messages?.[1]?.analysisId)

  r = await api('GET', '/api/chat/messages?limit=1', { token: authToken })
  eq('chat messages: limit is honoured', r.json?.messages?.length, 1)
  eq('chat messages: limit returns the newest', r.json?.messages?.[0]?.role, 'assistant')

  r = await api('GET', `/api/chat/messages?before=${encodeURIComponent('1999-01-01T00:00:00.000Z')}`, { token: authToken })
  eq('chat messages: before filters everything older out', r.json?.messages?.length, 0)

  r = await api('GET', `/api/chat/messages?before=${encodeURIComponent(new Date(Date.now() + 5000).toISOString())}`, {
    token: authToken,
  })
  eq('chat messages: before accepts ISO timestamps', r.json?.messages?.length, 2)

  r = await api('GET', '/api/chat/messages?before=not-a-date', { token: authToken })
  eq('chat messages: bad before is a 400', r.status, 400)

  r = await api('GET', '/api/dashboard?days=7', { token: authToken })
  eq('dashboard: day total updated after chat', r.json?.metrics?.intake?.kcal, 380 + 420)

  /* ---------- chat: disagreement triggers the judge ---------- */
  r = await api('POST', '/api/chat', { token: authToken, body: { message: 'big plate of pasta #disagree', day: TODAY } })
  eq('chat disagree: 200', r.status, 200)
  eq('chat disagree: reconciled uses the more confident model', r.json?.analysis?.reconciled?.total?.kcal, 300)
  eq('chat disagree: agreement low', r.json?.analysis?.agreement, 'low')
  ok('chat disagree: deltaPct over 15', (r.json?.analysis?.deltaPct || 0) > 15, String(r.json?.analysis?.deltaPct))
  ok('chat disagree: judge prose used', /MOCK JUDGE/.test(r.json?.analysis?.comparison || ''), r.json?.analysis?.comparison)
  ok('chat disagree: reply carries the judge comparison', /MOCK JUDGE/.test(r.json?.message?.content || ''))
  eq('chat disagree: meal saved with the chosen estimate', r.json?.meal?.kcal, 300)

  /* ---------- chat: one model fails ---------- */
  r = await api('POST', '/api/chat', { token: authToken, body: { message: 'soup and bread #fail-a', day: TODAY } })
  eq('chat fail-a: 200 (never a 500)', r.status, 200)
  ok('chat fail-a: model A output is an error', typeof r.json?.analysis?.modelAOutput?.error === 'string')
  eq('chat fail-a: reconciled from model B', r.json?.analysis?.reconciled?.total?.kcal, 440)
  ok('chat fail-a: comparison explains the missing model', /unavailable/i.test(r.json?.analysis?.comparison || ''))
  eq('chat fail-a: meal still saved', r.json?.meal?.kcal, 440)
  eq('chat fail-a: deltaPct 0 with one model', r.json?.analysis?.deltaPct, 0)

  /* ---------- chat: both models fail ---------- */
  const beforeBothFail = (await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })).json?.meals?.length ?? 0
  r = await api('POST', '/api/chat', { token: authToken, body: { message: 'mystery casserole #fail-both', day: TODAY } })
  eq('chat fail-both: 200 (never a 500)', r.status, 200)
  eq('chat fail-both: no meal saved', r.json?.meal, null)
  ok('chat fail-both: reply is an apology, not a crash', /Sorry/i.test(r.json?.message?.content || ''), r.json?.message?.content)
  ok('chat fail-both: analysis records the error', typeof r.json?.analysis?.error === 'string' && r.json.analysis.error.length > 0)
  eq('chat fail-both: reconciled is null', r.json?.analysis?.reconciled, null)
  const afterBothFail = (await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })).json?.meals?.length ?? 0
  eq('chat fail-both: meal count unchanged', afterBothFail, beforeBothFail)

  /* ---------- chat: save:false and idempotency ---------- */
  const beforeNoSave = (await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })).json?.meals?.length ?? 0
  r = await api('POST', '/api/chat', { token: authToken, body: { message: 'toast only', day: TODAY, save: false } })
  eq('chat save:false: no meal saved', r.json?.meal, null)
  ok('chat save:false: analysis still stored', !!r.json?.analysis?.id)
  const afterNoSave = (await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })).json?.meals?.length ?? 0
  eq('chat save:false: meal count unchanged', afterNoSave, beforeNoSave)

  // "Save meal" on a two-meal reply posts part 0 and part 1 of the same analysis.
  const partsAnalysisId = r.json?.analysis?.id
  const partBody = (part, name) => ({
    day: TODAY, name, kcal: 100 + part, proteinG: 1, carbsG: 1, fatG: 1, source: 'ai',
    eatenAt: new Date(Date.now() + part).toISOString(),
    analysisId: partsAnalysisId, analysisPart: part,
  })
  const part0 = await api('POST', '/api/meals', { token: authToken, body: partBody(0, 'Part zero') })
  const part1 = await api('POST', '/api/meals', { token: authToken, body: partBody(1, 'Part one') })
  eq('meal parts: part 0 created', part0.status, 201)
  eq('meal parts: part 1 created, not deduped onto part 0', part1.status, 201)
  ok('meal parts: two distinct meals', part0.json?.meal?.id && part0.json.meal.id !== part1.json?.meal?.id)
  const again0 = await api('POST', '/api/meals', { token: authToken, body: partBody(0, 'Part zero') })
  const again1 = await api('POST', '/api/meals', { token: authToken, body: partBody(1, 'Part one') })
  eq('meal parts: re-saving part 0 returns it', again0.json?.meal?.id, part0.json?.meal?.id)
  eq('meal parts: re-saving part 1 returns it', again1.json?.meal?.id, part1.json?.meal?.id)
  const afterParts = (await api('GET', `/api/meals?day=${TODAY}`, { token: authToken })).json?.meals?.length ?? 0
  eq('meal parts: exactly two meals added', afterParts, afterNoSave + 2)
  r = await api('POST', '/api/meals', { token: authToken, body: { ...partBody(0, 'x'), analysisPart: -1 } })
  eq('meal parts: negative part is 400', r.status, 400)

  const idemKey = `qa-${Date.now()}`
  const first = await api('POST', '/api/chat', {
    token: authToken,
    body: { message: 'idempotent toast', day: TODAY },
    headers: { 'idempotency-key': idemKey },
  })
  const second = await api('POST', '/api/chat', {
    token: authToken,
    body: { message: 'idempotent toast', day: TODAY },
    headers: { 'idempotency-key': idemKey },
  })
  eq('chat: retry with the same idempotency key reuses the reply', second.json?.analysis?.id, first.json?.analysis?.id)
  eq('chat: retry does not double-save the meal', second.json?.meal?.id, first.json?.meal?.id)

  /* ---------- old weight-tracker JSON import ---------- */
  const exportPayload = {
    version: 1,
    profile: { startWeightKg: 83, goalWeightKg: 74, heightCm: 181, unit: 'kg', chartWindowDays: 120 },
    entries: [
      { date: FIVE_DAYS_AGO, weightKg: 83.4, note: 'imported', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { date: TODAY, weightKg: 81.5, note: 'overwritten by import', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { date: 'not-a-date', weightKg: 80 },
    ],
    phases: [
      { id: '11111111-2222-3333-4444-555555555555', name: 'Bulk', startDate: FIVE_DAYS_AGO, endDate: YESTERDAY, color: '#22c55e', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'phase-bad', name: 'Broken phase', startDate: 'nope', endDate: null, color: '#000000' },
    ],
  }

  r = await api('POST', '/api/import/weight-json', { token: authToken, body: { json: exportPayload } })
  eq('import weight-json: 200', r.status, 200)
  eq('import weight-json: entries imported', r.json?.imported?.entries, 2)
  eq('import weight-json: invalid entry skipped', r.json?.skipped?.entries, 1)
  eq('import weight-json: phases imported', r.json?.imported?.phases, 1)
  eq('import weight-json: invalid phase skipped', r.json?.skipped?.phases, 1)

  r = await api('GET', '/api/weights', { token: authToken })
  const importedToday = r.json?.entries?.find((e) => e.date === TODAY)
  near('import weight-json: existing date updated, not duplicated', importedToday?.weightKg, 81.5)
  ok('import weight-json: entry count unchanged for the existing date', r.json?.entries?.filter((e) => e.date === TODAY).length === 1)
  ok('import weight-json: new date added', !!r.json?.entries?.find((e) => e.date === FIVE_DAYS_AGO))
  eq('import weight-json: note carried over', importedToday?.note, 'overwritten by import')

  r = await api('GET', '/api/phases', { token: authToken })
  eq('import weight-json: phases count', r.json?.phases?.length, 2)
  ok('import weight-json: phase id preserved', !!r.json?.phases?.find((p) => p.id === '11111111-2222-3333-4444-555555555555'))

  r = await api('GET', '/api/profile', { token: authToken })
  eq('import weight-json: profile goal mapped', r.json?.profile?.goalWeightKg, 74)
  eq('import weight-json: profile start weight mapped', r.json?.profile?.startWeightKg, 83)
  eq('import weight-json: profile chart window mapped', r.json?.profile?.chartWindowDays, 120)
  near('import weight-json: profile height mapped', r.json?.profile?.heightCm, 181)

  r = await api('POST', '/api/import/weight-json', { token: authToken, body: { json: exportPayload } })
  eq('import weight-json: re-import updates entries again', r.json?.imported?.entries, 2)
  eq('import weight-json: re-import skips the duplicate phase', r.json?.skipped?.phases, 2)

  r = await api('POST', '/api/import/weight-json', { token: authToken, body: { nope: true } })
  eq('import weight-json: rejects junk', r.status, 400)

  /* ---------- food CSV preview + commit ---------- */
  const csv = [
    'name,kcal,protein (g),carbs (g),fat (g),serving',
    '"Rice, cooked",205,4.2,45,0.4,"150 g"',
    'Chicken breast,165,31,0,3.6,100 g',
    ',120,5,20,2,no name here',
    'Mystery bar,abc,3,10,4,40 g',
  ].join('\r\n')

  r = await api('POST', '/api/import/food-csv/preview', { token: authToken, body: { csv } })
  eq('csv preview: 200', r.status, 200)
  eq('csv preview: headers sniffed', r.json?.headers, ['name', 'kcal', 'protein (g)', 'carbs (g)', 'fat (g)', 'serving'])
  eq('csv preview: name mapped', r.json?.suggestedMapping?.name, 'name')
  eq('csv preview: kcal mapped', r.json?.suggestedMapping?.kcal, 'kcal')
  eq('csv preview: "protein (g)" mapped to protein', r.json?.suggestedMapping?.protein, 'protein (g)')
  eq('csv preview: carbs mapped', r.json?.suggestedMapping?.carbs, 'carbs (g)')
  eq('csv preview: fat mapped', r.json?.suggestedMapping?.fat, 'fat (g)')
  eq('csv preview: serving mapped', r.json?.suggestedMapping?.serving, 'serving')
  eq('csv preview: valid rows parsed', r.json?.rows?.length, 2)
  eq('csv preview: quoted comma handled', r.json?.rows?.[0]?.parsed?.name, 'Rice, cooked')
  near('csv preview: numbers parsed', r.json?.rows?.[1]?.parsed?.kcal, 165)
  eq('csv preview: skipped rows reported', r.json?.skipped?.length, 2)
  ok('csv preview: skipped rows carry a reason', (r.json?.skipped ?? []).every((s) => typeof s.reason === 'string' && s.reason.length > 0))
  ok('csv preview: rows carry a physical line number', r.json?.rows?.[0]?.line === 2)

  r = await api('POST', '/api/import/food-csv/commit', {
    token: authToken,
    body: {
      csv,
      mapping: { name: 'name', kcal: 'kcal', protein: 'protein (g)', carbs: 'carbs (g)', fat: 'fat (g)', serving: 'serving' },
    },
  })
  eq('csv commit: 200', r.status, 200)
  eq('csv commit: imported count', r.json?.imported, 2)
  eq('csv commit: skipped count', r.json?.skipped, 2)
  eq('csv commit: meals returned', r.json?.meals?.length, 2)
  eq('csv commit: meal source import', r.json?.meals?.[0]?.source, 'import')
  near('csv commit: kcal from the csv', (r.json?.meals ?? []).find((x) => x.name === 'Chicken breast')?.kcal, 165)
  eq('csv commit: default day is today', r.json?.meals?.[0]?.day, TODAY)

  // The commit honours an overridden mapping even when the headers are unhelpful.
  const csv2 = ['item,amount,p,c,f', 'Toast,90,3,17,1'].join('\n')
  const preview2 = await api('POST', '/api/import/food-csv/preview', { token: authToken, body: { csv: csv2 } })
  eq('csv preview: unknown header leaves kcal unmapped', preview2.json?.suggestedMapping?.kcal, undefined)
  r = await api('POST', '/api/import/food-csv/commit', {
    token: authToken,
    body: { csv: csv2, mapping: { name: 'item', kcal: 'amount', protein: 'p', carbs: 'c', fat: 'f' } },
  })
  eq('csv commit: honours a user mapping', r.json?.imported, 1)
  near('csv commit: mapped kcal', r.json?.meals?.[0]?.kcal, 90)

  r = await api('POST', '/api/import/food-csv/commit', {
    token: authToken,
    body: { csv: ['name,kcal', 'Toast,90'].join('\n'), mapping: { name: 'nope', kcal: 'kcal' } },
  })
  eq('csv commit: rejects a mapping that names a missing column', r.status, 400)

  r = await api('POST', '/api/import/food-csv/commit', { token: authToken, body: { csv: 'a,b\n1,2' } })
  eq('csv commit: rejects a csv with no usable mapping', r.status, 400)

  /* ---------- built-in parser edge cases via a quoted-CRLF file ---------- */
  const messy = '\uFEFFname,kcal,notes\r\n"Eggs, ""scrambled""",144,"line one\nline two"\r\n'
  r = await api('POST', '/api/import/food-csv/preview', { token: authToken, body: { csv: messy } })
  eq('csv: BOM stripped from the first header', r.json?.headers?.[0], 'name')
  eq('csv: escaped quotes parsed', r.json?.rows?.[0]?.parsed?.name, 'Eggs, "scrambled"')

  /* ---------- dashboard after imports ---------- */
  r = await api('GET', '/api/dashboard?days=7', { token: authToken })
  ok('dashboard: intakeHistory kcal is non-zero after imports', r.json?.metrics?.intake?.kcal > 0)
  eq('dashboard: streak still counts today', r.json?.metrics?.streakDays >= 1, true)

  /* ---------- deletes ---------- */
  r = await api('DELETE', `/api/meals/${mealId}`, { token: authToken })
  eq('meals: DELETE 200', r.status, 200)
  eq('meals: DELETE echoes the id', r.json?.deleted, mealId)
  r = await api('DELETE', `/api/meals/${mealId}`, { token: authToken })
  eq('meals: DELETE twice 404', r.status, 404)

  r = await api('DELETE', `/api/foods/${foodId}`, { token: authToken })
  eq('foods: DELETE 200', r.status, 200)
  eq('foods: DELETE echoes the id', r.json?.deleted, foodId)

  r = await api('DELETE', `/api/phases/${phaseId}`, { token: authToken })
  eq('phases: DELETE 200', r.status, 200)

  r = await api('DELETE', `/api/weights/${firstEntryId}`, { token: authToken })
  eq('weights: DELETE 200', r.status, 200)
  r = await api('GET', '/api/weights', { token: authToken })
  ok('weights: DELETE removed the entry', !r.json?.entries?.some((e) => e.id === firstEntryId))

  /* ---------- garmin ---------- */
  {
    r = await api('GET', '/api/auth/me', { token: authToken })
    const uid = r.json?.user?.id
    ok('garmin: have the user id', typeof uid === 'string' && uid.length > 0)
    const gdir = path.join(dataDir, 'garmin', uid)
    const setMode = (m) => fs.writeFileSync(path.join(gdir, 'mode'), m)
    const calls = () => { try { return fs.readFileSync(path.join(gdir, 'calls'), 'utf8').split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean) } catch { return [] } }

    r = await api('GET', '/api/garmin', { token: authToken })
    eq('garmin: GET 200', r.status, 200)
    eq('garmin: available with the fake fetcher', r.json?.garmin?.available, true)
    eq('garmin: not connected without tokens', r.json?.garmin?.connected, false)
    eq('garmin: status needs_login without tokens', r.json?.garmin?.status, 'needs_login')
    r = await api('POST', '/api/garmin/sync', { token: authToken })
    eq('garmin: sync without tokens is 409', r.status, 409)
    eq('garmin: no fetch attempted without tokens', calls().length, 0)

    fs.mkdirSync(gdir, { recursive: true })
    fs.writeFileSync(path.join(gdir, 'garmin_tokens.json'), '{}')
    setMode('ok')
    r = await api('POST', '/api/garmin/sync', { token: authToken })
    eq('garmin: first sync 200', r.status, 200)
    eq('garmin: first sync backfills 30 days', r.json?.result?.days, 30)
    eq('garmin: first sync stores 2 activities', r.json?.result?.activities, 2)
    eq('garmin: status connected after sync', r.json?.garmin?.status, 'connected')
    ok('garmin: lastSuccessAt set', typeof r.json?.garmin?.lastSuccessAt === 'string')
    eq('garmin: fetch called with fetch + range', calls()[0], `fetch ${isoDay(-29)} ${TODAY}`)

    r = await api('POST', '/api/garmin/sync', { token: authToken })
    // Finished days are not re-fetched: right after a sync only today is open,
    // plus yesterday until a sync after noon has run.
    const openDays = new Date().getHours() >= 12 ? 1 : 2
    eq('garmin: later sync fetches only unfinished days', r.json?.result?.days, openDays)
    eq('garmin: later sync range', calls().at(-1), `fetch ${isoDay(1 - openDays)} ${TODAY}`)
    r = await api('POST', '/api/garmin/sync', { token: authToken, body: { days: 7 } })
    eq('garmin: days forces a re-fetch of the last 7', r.json?.result?.days, 7)
    r = await api('GET', '/api/activities', { token: authToken })
    eq('garmin: activities upserted, not duplicated', r.json?.activities?.length, 2)
    eq('garmin: newest activity first', r.json?.activities?.[0]?.name, 'Morning Run')
    eq('garmin: activity fields', [r.json?.activities?.[0]?.type, r.json?.activities?.[0]?.distanceM, r.json?.activities?.[0]?.startLocal], ['running', 5000, `${TODAY}T07:15:00`])
    r = await api('GET', `/api/activity/daily?from=${isoDay(-6)}&to=${TODAY}`, { token: authToken })
    eq('garmin: 7 daily rows', r.json?.days?.length, 7)
    eq('garmin: daily fields', [r.json?.days?.[0]?.steps, r.json?.days?.[0]?.totalKcal, r.json?.days?.[0]?.restingHr], [9000, 2600, 52])

    r = await api('GET', '/api/dashboard?days=7', { token: authToken })
    eq('garmin: dashboard latest steps', r.json?.metrics?.activity?.latest?.steps, 9000)
    eq('garmin: dashboard avgSteps7d', r.json?.metrics?.activity?.avgSteps7d, 9000)
    eq('garmin: dashboard recent activities', r.json?.metrics?.activity?.recent?.length, 2)
    eq('garmin: TDEE watchKcal from 28-day window', r.json?.metrics?.adaptiveTdee?.watchKcal, 2600)
    eq('garmin: TDEE watchDays', r.json?.metrics?.adaptiveTdee?.watchDays, 28)

    setMode('needs_login')
    r = await api('POST', '/api/garmin/sync', { token: authToken })
    eq('garmin: needs_login is reported, not a 500', r.status, 200)
    eq('garmin: needs_login result', [r.json?.result?.ok, r.json?.result?.error], [false, 'needs_login'])
    eq('garmin: status needs_login', r.json?.garmin?.status, 'needs_login')
    r = await api('GET', '/api/activities', { token: authToken })
    eq('garmin: data kept after a failed sync', r.json?.activities?.length, 2)

    setMode('rate_limited')
    r = await api('POST', '/api/garmin/sync', { token: authToken })
    eq('garmin: rate_limited result', r.json?.result?.error, 'rate_limited')
    ok('garmin: backoff set', typeof r.json?.garmin?.backoffUntil === 'string' && Date.parse(r.json.garmin.backoffUntil) > Date.now() + 5 * 3600_000)
    const before = calls().length
    setMode('ok')
    r = await api('POST', '/api/garmin/sync', { token: authToken })
    eq('garmin: sync refused during backoff (429)', r.status, 429)
    eq('garmin: no fetch attempted during backoff', calls().length, before)
    r = await api('POST', '/api/garmin/sync', { token: authToken, body: { days: 500 } })
    eq('garmin: days out of range is 400', r.status, 400)
  }

  /* ---------- auth scoping + logout ---------- */
  r = await api('POST', '/api/auth/register', { body: { email: 'owner@example.com', password: 'whatever1' } })
  eq('register: duplicate email without an invite is 409', r.status, 409)

  r = await api('POST', '/api/auth/register', { body: { email: 'newbie@example.com', password: 'whatever1' } })
  eq('register: missing invite code is 400', r.status, 400)

  const ownerLogin = await api('POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'own3r-pass' } })
  const ownerToken = ownerLogin.json?.token
  r = await api('GET', '/api/meals', { token: ownerToken })
  eq('scoping: another user sees no meals', r.json?.meals?.length, 0)
  r = await api('GET', `/api/analyses/${agreeAnalysis?.id}`, { token: ownerToken })
  eq('scoping: another user cannot read an analysis', r.status, 404)
  r = await api('DELETE', `/api/weights/${firstEntryId}`, { token: ownerToken })
  eq('scoping: another user cannot delete a weight entry', r.status, 404)

  r = await api('POST', '/api/auth/logout', { token: authToken })
  eq('logout: 200', r.status, 200)
  r = await api('GET', '/api/auth/me', { token: authToken })
  eq('logout: token no longer works', r.status, 401)
  r = await api('GET', '/api/weights', { token: authToken })
  eq('logout: protected route rejects the dead token', r.status, 401)

  /* ---------- 404s ---------- */
  r = await api('GET', '/api/nope', { token: ownerToken })
  eq('unknown api route: 404 json', r.status, 404)
  eq('unknown api route: ok false', r.json?.ok, false)
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

let crashed = null
try {
  await run()
} catch (err) {
  crashed = err
  failCount++
  failures.push('run aborted by an exception')
  console.error('\nTest run threw:', err?.stack || err)
} finally {
  stopServer()
  await sleep(150)
  try {
    fs.rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* windows may still hold the DB file; the temp dir is disposable */
  }
}

const total = passCount + failCount
if (crashed) {
  console.log(`\n${passCount} passed, ${failCount} failed, ${total} assertions (run aborted by an exception)`)
  process.exit(1)
}

console.log(`\n${passCount} passed, ${failCount} failed, ${total} assertions`)
if (failCount > 0) {
  console.log(`Failures:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
}
if (failCount > 0 || passCount === 0) process.exit(1)
