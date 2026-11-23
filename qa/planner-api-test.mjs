#!/usr/bin/env node
/**
 * Meal planner API test — SPEC §6 "Meal planner". No network, no dependencies.
 *
 * Boots `server/index.js` on a random port with a temp DATA_DIR and AI_MOCK=1,
 * creates users with the CLI, and walks household resolution: solo, pending
 * link, join, merge (history kept), re-linking to someone new, and scoping.
 *
 *   node qa/planner-api-test.mjs
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
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const port = 20000 + Math.floor(Math.random() * 2000)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-planner-qa-'))
const BASE = `http://127.0.0.1:${port}`
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AI_MOCK: '1', OPENCODE_API_KEY: '', DIST_DIR: '', BACKUPS: 'off' }

let serverLog = ''
const server = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', (b) => (serverLog += b))
server.stderr.on('data', (b) => (serverLog += b))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForServer() {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early\n${serverLog}`)
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return
    } catch {
      /* not up yet */
    }
    await sleep(100)
  }
  throw new Error(`server did not start\n${serverLog}`)
}

function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
}

async function api(method, route, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  return { status: res.status, json }
}

async function makeUser(email, name) {
  const r = cli('user', 'create', '--email', email, '--password', 'planner-pass-1')
  if (r.status !== 0) throw new Error(`user create failed: ${r.stdout}${r.stderr}`)
  if (name) cli('sql', `UPDATE users SET display_name = '${name}' WHERE email = '${email}'`, '--write')
  const login = await api('POST', '/api/auth/login', { body: { email, password: 'planner-pass-1' } })
  if (login.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(login.json)}`)
  return login.json.token
}

const household = async (token) => (await api('GET', '/api/planner/household', { token })).json?.household
const link = (token, email) => api('PUT', '/api/partner', { token, body: { email } })

function addDish(householdId, name) {
  const id = `dish-${name.toLowerCase().replace(/\W+/g, '-')}`
  const r = cli('sql', `INSERT INTO dishes (id, household_id, name) VALUES ('${id}', '${householdId}', '${name}')`, '--write')
  if (r.status !== 0) throw new Error(`dish insert failed: ${r.stdout}${r.stderr}`)
  return id
}
function dishHousehold(id) {
  const r = cli('sql', `SELECT household_id FROM dishes WHERE id = '${id}'`)
  return r.stdout
}

async function run() {
  await waitForServer()

  let r = await api('GET', '/api/planner/household')
  eq('household: needs a login', r.status, 401)

  const sam = await makeUser('sam@example.com', 'Sam')
  const chloe = await makeUser('chloe@example.com', 'Chloe')
  const alex = await makeUser('alex@example.com', 'Alex')

  // Solo
  const samSolo = await household(sam)
  ok('solo: a household is created', Boolean(samSolo?.id))
  eq('solo: one member, me', samSolo?.members.map((m) => [m.name, m.me]), [['Sam', true]])
  eq('solo: no partner', samSolo?.partner, null)
  eq('solo: stable on repeat', (await household(sam))?.id, samSolo?.id)

  // Pending link changes nothing
  await link(sam, 'chloe@example.com')
  const samPending = await household(sam)
  eq('pending: same household', samPending?.id, samSolo?.id)
  eq('pending: partner pending', samPending?.partner?.status, 'pending')
  eq('pending: still one member', samPending?.members.length, 1)

  // Chloe used the planner alone first and has history
  const chloeSolo = await household(chloe)
  ok('chloe solo: her own household', chloeSolo?.id && chloeSolo.id !== samSolo?.id)
  const curry = addDish(chloeSolo.id, 'Thai curry')

  // Chloe links back: the households merge, keeping her dish
  await link(chloe, 'sam@example.com')
  const merged = await household(sam)
  eq('merge: Sam joins the household that has dishes', merged?.id, chloeSolo.id)
  eq('merge: both members', merged?.members.map((m) => m.name).sort(), ['Chloe', 'Sam'])
  eq('merge: partner linked', merged?.partner?.status, 'linked')
  eq('merge: Chloe sees the same household', (await household(chloe))?.id, chloeSolo.id)
  ok('merge: the dish survived', dishHousehold(curry).includes(chloeSolo.id), dishHousehold(curry))
  r = cli('sql', `SELECT COUNT(*) AS n FROM households WHERE id = '${samSolo.id}'`)
  ok('merge: the empty household is gone', /\b0\b/.test(r.stdout), r.stdout)

  // Unlinking alone never splits the household
  await api('DELETE', '/api/partner', { token: chloe })
  eq('unlink: Sam keeps the household', (await household(sam))?.id, chloeSolo.id)
  eq('unlink: Chloe keeps the household', (await household(chloe))?.id, chloeSolo.id)

  // Sam links someone new: Sam leaves, Chloe keeps the history
  await link(sam, 'alex@example.com')
  await link(alex, 'sam@example.com')
  const samAlex = await household(sam)
  ok('relink: Sam is in a new household', samAlex?.id && samAlex.id !== chloeSolo.id)
  eq('relink: with Alex', samAlex?.members.map((m) => m.name).sort(), ['Alex', 'Sam'])
  const chloeAfter = await household(chloe)
  eq('relink: Chloe keeps her household', chloeAfter?.id, chloeSolo.id)
  eq('relink: Chloe is alone in it', chloeAfter?.members.map((m) => m.name), ['Chloe'])
  ok('relink: the dish stayed with Chloe', dishHousehold(curry).includes(chloeSolo.id))
}

try {
  await run()
} catch (err) {
  failCount++
  console.log(`FAIL  run crashed — ${err.stack || err}`)
} finally {
  server.kill()
  await sleep(200)
  fs.rmSync(dataDir, { recursive: true, force: true })
}
console.log(`\n${passCount} passed, ${failCount} failed`)
process.exit(failCount ? 1 : 0)
