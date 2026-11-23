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

  await runMeals({ sam, chloe, alex })
}

/* ---------- meals, import, ratings, tags, notes ---------- */
const DRAFT = {
  dishes: [
    { name: 'Dirty cabbage', options: { Style: ['Korean', 'Chinese'], Protein: ['Kangaroo', 'Beef'] }, aliases: ['Filthy cabbage'], suggestedTags: ['stir-fry', 'quick'] },
    { name: 'Thai curry', options: { Protein: ['Tofu'] }, aliases: ['Thai cuzza'], suggestedTags: ['curry', 'Thai'], tips: 'Light coconut milk' },
    { name: 'Palak', options: {}, aliases: [], suggestedTags: [] },
  ],
  weeks: [
    { source: 'qa', week: 1, entries: [
      { day: 'Mon', raw: 'Chinese dirty cabbage', dish: 'Dirty cabbage', options: { Style: 'Chinese' } },
      { day: 'Tue', raw: 'Thai cuzza', dish: 'Thai curry' },
      { day: 'Wed', raw: 'OUT', kind: 'out' },
      { day: 'Thu', raw: '-', kind: 'nothing' },
      { day: 'Fri', raw: 'Filthy cabbage', dish: 'Dirty cabbage' },
    ] },
  ],
}

function cliImport(email, draft, ...flags) {
  return spawnSync(process.execPath, [CLI, 'planner', 'import', '--email', email, ...flags, '-'], {
    env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', input: JSON.stringify(draft),
  })
}

async function runMeals({ sam, chloe, alex }) {
  // Chloe re-links Sam (Sam left for Alex above): reset to a clean pair.
  await link(sam, 'chloe@example.com')
  await link(chloe, 'sam@example.com')
  await api('DELETE', '/api/partner', { token: alex })
  const home = await household(sam)
  eq('meals setup: Sam and Chloe share a household again', (await household(chloe))?.id, home.id)
  const chloeId = home.members.find((m) => m.name === 'Chloe').id

  let r = cliImport('sam@example.com', DRAFT, '--dry-run')
  ok('import: dry run exits 0', r.status === 0, r.stdout + r.stderr)
  ok('import: dry run says so', /DRY RUN/.test(r.stdout))
  ok('import: dry run saves nothing', !(await api('GET', '/api/planner/meals', { token: sam })).json.meals.some((m) => m.name === 'Palak'))

  r = cliImport('sam@example.com', DRAFT)
  ok('import: exits 0', r.status === 0, r.stdout + r.stderr)
  // Thai curry already exists from the household tests above, so it is matched, not created.
  ok('import: 2 new meals, 1 matched', /mealsCreated: 2/.test(r.stdout) && /mealsMatched: 1/.test(r.stdout), r.stdout)
  ok('import: 4 history rows (nothing night skipped)', /historyAdded: 4/.test(r.stdout), r.stdout)
  r = cliImport('sam@example.com', DRAFT)
  ok('import: re-run adds nothing', /mealsCreated: 0/.test(r.stdout) && /historyAdded: 0/.test(r.stdout) && /historySkipped: 4/.test(r.stdout), r.stdout)

  r = await api('GET', '/api/planner/meals', { token: chloe })
  eq('meals: 200 for the partner', r.status, 200)
  const meals = r.json.meals
  const cabbage = meals.find((m) => m.name === 'Dirty cabbage')
  const curry2 = meals.find((m) => m.name === 'Thai curry')
  eq('meals: cooked count from history', cabbage?.cooked, 2)
  eq('meals: undated history has no last date', cabbage?.lastCooked, null)
  eq('meals: options on two axes', cabbage?.options.map((o) => `${o.axis}:${o.name}`).sort(), ['Protein:Beef', 'Protein:Kangaroo', 'Style:Chinese', 'Style:Korean'])
  eq('meals: suggested tags', cabbage?.suggestedTags, ['stir-fry', 'quick'])
  eq('meals: no accepted tags yet', cabbage?.tags, [])
  ok('meals: aliases exclude the name', cabbage?.aliases.includes('filthy cabbage') && !cabbage.aliases.includes('dirty cabbage'))
  eq('meals: tips imported', curry2?.tips, 'Light coconut milk')
  eq('meals: outsiders see none of it', (await api('GET', '/api/planner/meals', { token: alex })).json.meals.length, 0)

  // Tags + effort
  r = await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { tags: ['quick', ' Quick ', 'weeknight'], effort: 1 } })
  eq('tags: saved, trimmed, de-duplicated', r.json?.meal?.tags, ['quick', 'weeknight'])
  eq('effort: saved', r.json?.meal?.effort, 1)
  eq('effort: 4 rejected', (await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { effort: 4 } })).status, 400)
  eq('tags: too long rejected', (await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { tags: ['x'.repeat(31)] } })).status, 400)
  eq('meal edit: other household gets 404', (await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: alex, body: { effort: 2 } })).status, 404)
  r = cliImport('sam@example.com', DRAFT)
  eq('import: re-run keeps accepted tags', (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id).tags, ['quick', 'weeknight'])

  // Ratings: both, me, as the partner, per option
  const korean = cabbage.options.find((o) => o.name === 'Korean')
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'both', thumbs: 1, stars: 4 } })
  eq('rating: both saved', r.json?.rating, { optionId: null, ratedAs: 'both', thumbs: 1, stars: 4 })
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'me', thumbs: 1, stars: 5 } })
  eq('rating: me resolves to my id', r.json?.rating?.ratedAs, home.members.find((m) => m.me).id)
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: chloeId, thumbs: -1, stars: 3 } })
  eq('rating: Sam can rate as Chloe', r.json?.rating?.ratedAs, chloeId)
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: korean.id, ratedAs: 'both', thumbs: 1, stars: 5 } })
  eq('rating: an option on its own', r.json?.rating?.optionId, korean.id)
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'both', thumbs: 1, stars: 2 } })
  const after = (await api('GET', '/api/planner/meals', { token: chloe })).json.meals.find((m) => m.id === cabbage.id)
  eq('rating: upsert, 4 ratings in total', after.ratings.length, 4)
  eq('rating: both updated in place', after.ratings.find((x) => x.ratedAs === 'both' && !x.optionId)?.stars, 2)
  r = await api('PUT', '/api/planner/ratings', { token: chloe, body: { dishId: cabbage.id, ratedAs: 'me', thumbs: null, stars: null } })
  eq('rating: clearing deletes', r.json?.rating, null)
  eq('rating: Chloe’s gone', (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id).ratings.length, 3)
  eq('rating: outsider as ratedAs rejected', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'someone-else', thumbs: 1 } })).status, 400)
  eq('rating: stars 6 rejected', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'both', stars: 6 } })).status, 400)
  eq('rating: thumbs 0 rejected', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'both', thumbs: 0 } })).status, 400)
  eq('rating: option from another meal 404', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: curry2.id, optionId: korean.id, ratedAs: 'both', thumbs: 1 } })).status, 404)
  eq('rating: other household 404', (await api('PUT', '/api/planner/ratings', { token: alex, body: { dishId: cabbage.id, ratedAs: 'both', thumbs: 1 } })).status, 404)

  // Notes for Claude
  r = await api('POST', `/api/planner/meals/${curry2.id}/notes`, { token: chloe, body: { body: 'Green curry should be its own meal' } })
  eq('note: 201', r.status, 201)
  const noteId = r.json?.note?.id
  eq('note: empty rejected', (await api('POST', `/api/planner/meals/${curry2.id}/notes`, { token: chloe, body: { body: '  ' } })).status, 400)
  eq('note: other household 404', (await api('POST', `/api/planner/meals/${curry2.id}/notes`, { token: alex, body: { body: 'hi' } })).status, 404)
  r = spawnSync(process.execPath, [CLI, 'planner', 'notes'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
  ok('cli notes: lists the open note with its meal', r.stdout.includes(noteId) && r.stdout.includes('[Thai curry]') && r.stdout.includes('Green curry'), r.stdout + r.stderr)
  r = spawnSync(process.execPath, [CLI, 'planner', 'reply', '--id', noteId, '--resolve', '-'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', input: 'Done: added a Style option instead.' })
  ok('cli reply: exits 0', r.status === 0, r.stdout + r.stderr)
  const note = (await api('GET', '/api/planner/meals', { token: chloe })).json.meals.find((m) => m.id === curry2.id).notes[0]
  eq('note: reply shows in the app', note?.reply, 'Done: added a Style option instead.')
  eq('note: resolved', note?.resolved, true)
  r = spawnSync(process.execPath, [CLI, 'planner', 'notes'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
  ok('cli notes: resolved notes hidden by default', !r.stdout.includes(noteId), r.stdout)
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
