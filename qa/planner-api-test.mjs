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
  eq('rating: both saved', r.json?.rating, { optionId: null, ratedAs: 'both', thumbs: 1, stars: 4, want: false })
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
  const beef = cabbage.options.find((o) => o.name === 'Beef')
  const chinese = cabbage.options.find((o) => o.name === 'Chinese')
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${korean.id}+${beef.id}`, ratedAs: 'both', thumbs: 1, stars: 5 } })
  eq('rating: a combination, key sorted', r.json?.rating?.optionId, [korean.id, beef.id].sort().join('+'))
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${beef.id}+${korean.id}`, ratedAs: 'both', thumbs: -1, stars: 2 } })
  const combos = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id).ratings.filter((x) => x.optionId?.includes('+'))
  eq('rating: same combination either order is one rating', combos.length, 1)
  eq('rating: combination updated', combos[0]?.stars, 2)
  eq('rating: two options from one axis rejected', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${korean.id}+${chinese.id}`, ratedAs: 'both', thumbs: 1 } })).status, 400)
  await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${korean.id}+${beef.id}`, ratedAs: 'both', thumbs: null, stars: null } })
  // Want to make: no score, counts as an answer; a score clears it
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${chinese.id}+${beef.id}`, ratedAs: 'both', want: true } })
  eq('want: saved with no score', r.json?.rating, { optionId: [chinese.id, beef.id].sort().join('+'), ratedAs: 'both', thumbs: null, stars: null, want: true })
  eq('want: with stars rejected', (await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, ratedAs: 'both', want: true, stars: 4 } })).status, 400)
  let listed = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id)
  eq('want: listed', listed.ratings.find((x) => x.optionId === [chinese.id, beef.id].sort().join('+'))?.want, true)
  eq('want: ordinary ratings say false', listed.ratings.find((x) => x.ratedAs === 'both' && !x.optionId)?.want, false)
  r = await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${chinese.id}+${beef.id}`, ratedAs: 'both', thumbs: 1, stars: 4 } })
  eq('want: a score replaces it', r.json?.rating?.want, false)
  await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: cabbage.id, optionId: `${chinese.id}+${beef.id}`, ratedAs: 'both', thumbs: null, stars: null } })

  // Hidden variations: never had it, off the list for the household
  r = await api('PUT', `/api/planner/meals/${cabbage.id}/hidden`, { token: sam, body: { optionId: `${beef.id}+${chinese.id}` } })
  eq('hidden: saved, key sorted', r.json?.hidden, [[chinese.id, beef.id].sort().join('+')])
  listed = (await api('GET', '/api/planner/meals', { token: chloe })).json.meals.find((m) => m.id === cabbage.id)
  eq('hidden: the partner sees it hidden too', listed.hidden, [[chinese.id, beef.id].sort().join('+')])
  eq('hidden: again is a no-op', (await api('PUT', `/api/planner/meals/${cabbage.id}/hidden`, { token: sam, body: { optionId: `${chinese.id}+${beef.id}`, hidden: true } })).json?.hidden.length, 1)
  eq('hidden: bad option 404', (await api('PUT', `/api/planner/meals/${cabbage.id}/hidden`, { token: sam, body: { optionId: 'nope' } })).status, 404)
  eq('hidden: other household 404', (await api('PUT', `/api/planner/meals/${cabbage.id}/hidden`, { token: alex, body: { optionId: chinese.id } })).status, 404)
  r = await api('PUT', `/api/planner/meals/${cabbage.id}/hidden`, { token: sam, body: { optionId: `${chinese.id}+${beef.id}`, hidden: false } })
  eq('hidden: put back', r.json?.hidden, [])

  // Removing a meal: off the list, back again with its ratings
  r = await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { archived: true } })
  eq('remove meal: 200, no meal in the reply', [r.status, r.json?.meal], [200, null])
  ok('remove meal: gone from the list', !(await api('GET', '/api/planner/meals', { token: sam })).json.meals.some((m) => m.id === cabbage.id))
  r = await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { archived: false } })
  eq('remove meal: undo brings it back with its ratings', r.json?.meal?.ratings.length, 3)

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

  // Split: each option becomes its own meal in a section
  r = cliImport('sam@example.com', {
    dishes: [{ name: 'Pulled pork', options: { Style: ['Sandwiches', 'Soup'] }, aliases: ['Pulled pork sandwich'], suggestedTags: ['batch-cook'] }],
    weeks: [{ source: 'qa-pp', week: 1, entries: [
      { day: 'Sat', raw: 'Pulled pork', dish: 'Pulled pork' },
      { day: 'Sun', raw: 'Pulled pork sandwich', dish: 'Pulled pork', options: { Style: 'Sandwiches' } },
      { day: 'Mon', raw: 'Pulled pork sandwich', dish: 'Pulled pork', options: { Style: 'Sandwiches' } },
    ] }],
  })
  ok('split setup: imported', r.status === 0, r.stdout + r.stderr)
  let pp = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.name === 'Pulled pork')
  await api('PUT', '/api/planner/ratings', { token: sam, body: { dishId: pp.id, optionId: pp.options.find((o) => o.name === 'Sandwiches').id, ratedAs: 'both', thumbs: 1, stars: 5 } })
  const split = (...extra) => spawnSync(process.execPath, [CLI, 'planner', 'split', '--email', 'sam@example.com', '--meal', 'Pulled pork', '--rest', 'Pulled pork (slow roast)', ...extra], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
  r = split('--dry-run')
  ok('split: dry run changes nothing', r.status === 0 && (await api('GET', '/api/planner/meals', { token: sam })).json.meals.some((m) => m.name === 'Pulled pork'), r.stdout + r.stderr)
  r = split()
  ok('split: exits 0', r.status === 0, r.stdout + r.stderr)
  const all = (await api('GET', '/api/planner/meals', { token: sam })).json.meals
  const fam = all.filter((m) => m.family === 'Pulled pork').map((m) => m.name).sort()
  eq('split: a section of three meals', fam, ['Pulled pork (slow roast)', 'Pulled pork sandwiches', 'Pulled pork soup'])
  const sand = all.find((m) => m.name === 'Pulled pork sandwiches')
  eq('split: history moved with the option', sand?.cooked, 2)
  eq('split: rating became the new meal’s own', sand?.ratings.map((x) => [x.optionId, x.stars]), [[null, 5]])
  ok('split: matching alias moved', sand?.aliases.includes('pulled pork sandwich'))
  eq('split: the rest keeps history without an option', all.find((m) => m.name === 'Pulled pork (slow roast)')?.cooked, 1)
  eq('split: the rest has no options left', all.find((m) => m.name === 'Pulled pork (slow roast)')?.options.length, 0)
  eq('split: tags copied', sand?.suggestedTags, ['batch-cook'])
  ok('split: again fails cleanly (no options)', split().status !== 0)

  await runWeek({ sam, chloe, alex })
}

/* ---------- the week: slots, copy, parse, new meals, aliases ---------- */
async function runWeek({ sam, chloe, alex }) {
  const MON = '2026-11-30'
  const day = (n) => new Date(Date.parse(`${MON}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
  const meals = (await api('GET', '/api/planner/meals', { token: sam })).json.meals
  const cabbage = meals.find((m) => m.name === 'Dirty cabbage')
  const korean = cabbage.options.find((o) => o.name === 'Korean')
  const beef = cabbage.options.find((o) => o.name === 'Beef')
  const chinese = cabbage.options.find((o) => o.name === 'Chinese')

  // Week start setting
  let r = await api('GET', '/api/planner/household', { token: sam })
  eq('week start: Monday by default', r.json?.household?.weekStartDay, 0)
  r = await api('PUT', '/api/planner/household', { token: chloe, body: { weekStartDay: 5 } })
  eq('week start: changed to Saturday', r.json?.household?.weekStartDay, 5)
  eq('week start: shared with the partner', (await api('GET', '/api/planner/household', { token: sam })).json?.household?.weekStartDay, 5)
  eq('week start: 7 rejected', (await api('PUT', '/api/planner/household', { token: sam, body: { weekStartDay: 7 } })).status, 400)
  await api('PUT', '/api/planner/household', { token: sam, body: { weekStartDay: 0 } })

  // Slots
  r = await api('PUT', `/api/planner/slots/${MON}`, { token: sam, body: { dishId: cabbage.id, optionIds: [korean.id, beef.id], raw: 'korean cabbage' } })
  eq('slot: set a meal with options', r.status, 200)
  eq('slot: options saved', r.json?.entry?.optionIds, [korean.id, beef.id].sort())
  eq('slot: status planned', r.json?.entry?.status, 'planned')
  r = await api('PUT', `/api/planner/slots/${day(1)}`, { token: chloe, body: { kind: 'out', note: 'Dinner with friends' } })
  eq('slot: out night by the partner', r.json?.entry?.kind, 'out')
  r = await api('PUT', `/api/planner/slots/${MON}`, { token: chloe, body: { dishId: cabbage.id, optionIds: [chinese.id] } })
  eq('slot: replacing keeps one entry per night', (await api('GET', `/api/planner/week?start=${MON}`, { token: sam })).json.week.entries.length, 2)
  eq('slot: replaced options', r.json?.entry?.optionIds, [chinese.id])
  eq('slot: two options on one axis rejected', (await api('PUT', `/api/planner/slots/${MON}`, { token: sam, body: { dishId: cabbage.id, optionIds: [korean.id, chinese.id] } })).status, 400)
  eq('slot: bad date rejected', (await api('PUT', '/api/planner/slots/2026-02-30', { token: sam, body: { kind: 'out' } })).status, 400)
  eq('slot: meal night needs a meal', (await api('PUT', `/api/planner/slots/${day(2)}`, { token: sam, body: { kind: 'dish' } })).status, 400)
  eq('slot: bad kind rejected', (await api('PUT', `/api/planner/slots/${day(2)}`, { token: sam, body: { kind: 'brunch' } })).status, 400)
  eq('slot: another household’s meal 404', (await api('PUT', `/api/planner/slots/${day(2)}`, { token: alex, body: { dishId: cabbage.id } })).status, 404)
  r = await api('GET', `/api/planner/week?start=${MON}`, { token: alex })
  eq('week: outsiders see an empty week', r.json?.week?.entries?.length, 0)
  r = await api('GET', `/api/planner/week?start=${MON}`, { token: sam })
  eq('week: range is start..start+6', [r.json?.week?.start, r.json?.week?.end], [MON, day(6)])
  ok('week: imported history (no date) never shows', r.json.week.entries.every((e) => e.date))
  eq('week: missing start rejected', (await api('GET', '/api/planner/week', { token: sam })).status, 400)
  r = await api('DELETE', `/api/planner/slots/${day(1)}`, { token: sam })
  eq('slot: cleared', (await api('GET', `/api/planner/week?start=${MON}`, { token: sam })).json.week.entries.length, 1)

  // Copy last week into this week's empty nights
  await api('PUT', `/api/planner/slots/${day(9)}`, { token: sam, body: { kind: 'leftovers' } }) // next Wed already planned
  r = await api('POST', '/api/planner/week/copy', { token: sam, body: { from: MON, to: day(7) } })
  eq('copy: one night copied', r.json?.copied, 1)
  const next = r.json?.week?.entries ?? []
  ok('copy: lands on the same weekday with options', next.some((e) => e.date === day(7) && e.dishId === cabbage.id && e.optionIds[0] === chinese.id))
  eq('copy: never overwrites a planned night', next.find((e) => e.date === day(9))?.kind, 'leftovers')
  r = await api('POST', '/api/planner/week/copy', { token: sam, body: { from: MON, to: day(7) } })
  eq('copy: again copies nothing', r.json?.copied, 0)

  // New meals and aliases
  r = await api('POST', '/api/planner/meals', { token: sam, body: { name: 'Katsu curry bowls' } })
  eq('new meal: 201', r.status, 201)
  const katsu = r.json?.meal
  r = await api('POST', '/api/planner/meals', { token: chloe, body: { name: 'katsu curry   bowls' } })
  ok('new meal: same name returns the existing meal', r.status === 200 && r.json?.created === false && r.json?.meal?.id === katsu.id)
  eq('new meal: empty name rejected', (await api('POST', '/api/planner/meals', { token: sam, body: { name: ' ' } })).status, 400)
  r = await api('POST', `/api/planner/meals/${cabbage.id}/aliases`, { token: sam, body: { alias: 'Filthy Cabbage!' } })
  eq('alias: normalised (case, trailing punctuation)', r.json?.alias, 'filthy cabbage')
  await api('POST', `/api/planner/meals/${katsu.id}/aliases`, { token: sam, body: { alias: 'that lentil thing' } })
  r = await api('POST', `/api/planner/meals/${cabbage.id}/aliases`, { token: sam, body: { alias: 'that lentil thing' } })
  const after = (await api('GET', '/api/planner/meals', { token: sam })).json.meals
  ok('alias: the latest correction wins', after.find((m) => m.id === cabbage.id).aliases.includes('that lentil thing') && !after.find((m) => m.id === katsu.id).aliases.includes('that lentil thing'))
  eq('alias: other household 404', (await api('POST', `/api/planner/meals/${cabbage.id}/aliases`, { token: alex, body: { alias: 'x' } })).status, 404)

  // Parse a typed week (AI mocked: code matching only)
  r = await api('POST', '/api/planner/parse-week', { token: sam, body: { start: MON, text: 'mon thai cuzza, tue out\nwed: korean dirty cabbage beef\nthat lentil thing\nfri -\nsomething brand new' } })
  eq('parse: 200', r.status, 200)
  const items = r.json?.items ?? []
  const at = (d) => items.find((it) => it.date === d)
  eq('parse: Monday matched by alias', [at(MON)?.dishId, at(MON)?.confidence], [meals.find((m) => m.name === 'Thai curry').id, 1])
  eq('parse: Tuesday out', at(day(1))?.kind, 'out')
  ok('parse: Wednesday with both options', at(day(2))?.dishId === cabbage.id && at(day(2))?.optionIds.length === 2 && at(day(2))?.optionIds.includes(korean.id) && at(day(2))?.optionIds.includes(beef.id))
  eq('parse: a corrected alias is used next time', at(day(3))?.dishId, cabbage.id)
  ok('parse: "-" leaves Friday empty', !items.some((it) => it.date === day(4) && it.raw === '-'))
  const fresh = items.find((it) => it.raw === 'something brand new')
  ok('parse: unknown text proposes a new meal', fresh && fresh.dishId === null && fresh.newName === 'Something brand new', JSON.stringify(fresh))
  eq('parse: nothing saved yet', (await api('GET', `/api/planner/week?start=${MON}`, { token: sam })).json.week.entries.length, 1)
  eq('parse: empty text rejected', (await api('POST', '/api/planner/parse-week', { token: sam, body: { start: MON, text: '  ' } })).status, 400)

  await runReview({ sam, chloe, alex })
}

/* ---------- the review: cooked / skipped / swapped, opinions, freezer ---------- */
async function runReview({ sam, chloe, alex }) {
  const TODAY = '2027-01-12'
  const d = (n) => new Date(Date.parse('2027-01-04T00:00:00Z') + n * 86400000).toISOString().slice(0, 10) // Mon 4 Jan +n
  const meals = (await api('GET', '/api/planner/meals', { token: sam })).json.meals
  const cabbage = meals.find((m) => m.name === 'Dirty cabbage')
  const curry = meals.find((m) => m.name === 'Thai curry')
  const palak = meals.find((m) => m.name === 'Palak')
  const korean = cabbage.options.find((o) => o.name === 'Korean')
  const beef = cabbage.options.find((o) => o.name === 'Beef')
  const home = await household(sam)
  const samId = home.members.find((m) => m.me).id

  const night = async (date, body) => (await api('PUT', `/api/planner/slots/${date}`, { token: sam, body })).json.entry
  const e1 = await night(d(0), { dishId: cabbage.id, optionIds: [korean.id, beef.id] })
  const e2 = await night(d(1), { dishId: curry.id })
  await night(d(2), { kind: 'out' })
  const e4 = await night(d(3), { dishId: palak.id })
  await night(d(9), { dishId: palak.id }) // after today: not up for review

  let r = await api('GET', `/api/planner/review?today=${TODAY}`, { token: chloe })
  eq('queue: past meal nights only, oldest first', r.json?.entries?.map((e) => e.date), [d(0), d(1), d(3)])
  eq('queue: needs today', (await api('GET', '/api/planner/review', { token: sam })).status, 400)
  eq('queue: outsiders see nothing', (await api('GET', `/api/planner/review?today=${TODAY}`, { token: alex })).json?.entries?.length, 0)

  // Cooked + an opinion: becomes the standing rating for that exact combination
  r = await api('PUT', `/api/planner/entries/${e1.id}`, { token: sam, body: { status: 'cooked', cookNote: 'more gochujang', leftovers: true, tweakRetry: true } })
  eq('cooked: status and facts saved', [r.json?.entry?.status, r.json?.entry?.cookNote, r.json?.entry?.leftovers, r.json?.entry?.tweakRetry, Boolean(r.json?.entry?.reviewedAt)], ['cooked', 'more gochujang', true, true, true])
  r = await api('PUT', `/api/planner/entries/${e1.id}/review`, { token: sam, body: { ratedAs: 'both', thumbs: 1, stars: 5 } })
  eq('opinion: saved on the cook', r.json?.entry?.reviews, [{ ratedAs: 'both', thumbs: 1, stars: 5 }])
  let m = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((x) => x.id === cabbage.id)
  const combo = [korean.id, beef.id].sort().join('+')
  const standing = m.ratings.find((x) => x.optionId === combo && x.ratedAs === 'both')
  eq('opinion: standing rating of the combination, marked review', [standing?.stars, standing?.source], [5, 'review'])
  eq('cooked: counts, with a real last date', [m.cooked >= 1, m.lastCooked], [true, d(0)])
  r = await api('PUT', `/api/planner/entries/${e1.id}/review`, { token: chloe, body: { ratedAs: 'me', thumbs: -1, stars: 2 } })
  eq('opinion: per person alongside Both', r.json?.entry?.reviews.length, 2)

  // A cook that doesn't pin a variation down leaves standing ratings alone
  await api('PUT', `/api/planner/entries/${e2.id}`, { token: sam, body: { status: 'cooked' } })
  const curryBefore = JSON.stringify((await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((x) => x.id === curry.id).ratings)
  await api('PUT', `/api/planner/entries/${e2.id}/review`, { token: sam, body: { ratedAs: 'both', thumbs: 1, stars: 4 } })
  eq('opinion: no variation chosen, standing ratings untouched', JSON.stringify((await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((x) => x.id === curry.id).ratings), curryBefore)

  // Swapped: we made Palak instead of the Thai curry
  r = await api('PUT', `/api/planner/entries/${e2.id}`, { token: sam, body: { swapToDishId: palak.id } })
  eq('swap: night becomes what we made, cooked', [r.json?.entry?.dishId, r.json?.entry?.status, r.json?.entry?.note], [palak.id, 'cooked', 'Planned: Thai curry'])
  eq('swap: old opinions cleared', r.json?.entry?.reviews, [])

  // Froze some → freezer stock, adjustable from the review
  r = await api('PUT', `/api/planner/entries/${e4.id}`, { token: sam, body: { status: 'cooked', frozenPortions: 3 } })
  let freezer = (await api('GET', '/api/planner/freezer', { token: chloe })).json.items
  const item = freezer.find((f) => f.fromEntryId === e4.id)
  eq('freezer: portions from the review', [item?.dishId, item?.portions, item?.frozenOn], [palak.id, 3, d(3)])
  await api('PUT', `/api/planner/entries/${e4.id}`, { token: sam, body: { frozenPortions: 2 } })
  eq('freezer: changing the review adjusts stock', (await api('GET', '/api/planner/freezer', { token: sam })).json.items.find((f) => f.id === item.id)?.portions, 2)
  eq('freezer: 21 portions rejected', (await api('PUT', `/api/planner/entries/${e4.id}`, { token: sam, body: { frozenPortions: 21 } })).status, 400)
  r = await api('PUT', `/api/planner/entries/${e4.id}/review`, { token: sam, body: { ratedAs: 'me', thumbs: 1, stars: 4 } })
  m = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((x) => x.id === palak.id)
  ok('opinion: a meal without options rates the meal itself', m.ratings.some((x) => x.optionId === null && x.ratedAs === samId && x.stars === 4 && x.source === 'review'))

  // A freezer night: eating it takes a portion; anything else gives it back
  const fz = await night(d(5), { kind: 'freezer', freezerItemId: item.id })
  eq('freezer night: eats the frozen meal', [fz?.kind, fz?.dishId, fz?.freezerItemId], ['freezer', palak.id, item.id])
  eq('freezer night: unknown item 404', (await api('PUT', `/api/planner/slots/${d(6)}`, { token: sam, body: { kind: 'freezer', freezerItemId: 'nope' } })).status, 404)
  ok('queue: freezer night up for review', (await api('GET', `/api/planner/review?today=${TODAY}`, { token: sam })).json.entries.some((e) => e.id === fz.id))
  const portions = async () => (await api('GET', '/api/planner/freezer', { token: sam })).json.items.find((f) => f.id === item.id)?.portions ?? 0
  await api('PUT', `/api/planner/entries/${fz.id}`, { token: sam, body: { status: 'cooked' } })
  eq('freezer night: eaten takes one portion', await portions(), 1)
  await api('PUT', `/api/planner/entries/${fz.id}`, { token: sam, body: { status: 'cooked' } })
  eq('freezer night: marking again takes nothing more', await portions(), 1)
  await api('PUT', `/api/planner/entries/${fz.id}`, { token: sam, body: { status: 'skipped' } })
  eq('freezer night: skipped gives it back', await portions(), 2)
  await api('PUT', `/api/planner/entries/${fz.id}`, { token: sam, body: { status: 'cooked' } })
  await night(d(5), { kind: 'out' })
  eq('freezer night: replacing the night gives it back', await portions(), 2)

  // Skipped, validation, scoping
  await api('PUT', `/api/planner/entries/${e1.id}`, { token: sam, body: { status: 'planned' } })
  ok('undo: back in the queue', (await api('GET', `/api/planner/review?today=${TODAY}`, { token: sam })).json.entries.some((e) => e.id === e1.id))
  await api('PUT', `/api/planner/entries/${e1.id}`, { token: sam, body: { status: 'skipped' } })
  eq('queue: all reviewed', (await api('GET', `/api/planner/review?today=${TODAY}`, { token: sam })).json.entries.length, 0)
  eq('status: bogus rejected', (await api('PUT', `/api/planner/entries/${e1.id}`, { token: sam, body: { status: 'eaten' } })).status, 400)
  const out = (await api('GET', `/api/planner/week?start=${d(0)}`, { token: sam })).json.week.entries.find((e) => e.date === d(2))
  eq('review: an out night has nothing to rate', (await api('PUT', `/api/planner/entries/${out.id}/review`, { token: sam, body: { ratedAs: 'both', thumbs: 1 } })).status, 400)
  eq('review: other household 404', (await api('PUT', `/api/planner/entries/${e1.id}`, { token: alex, body: { status: 'cooked' } })).status, 404)
  eq('review: other household opinion 404', (await api('PUT', `/api/planner/entries/${e1.id}/review`, { token: alex, body: { ratedAs: 'me', thumbs: 1 } })).status, 404)

  // Manual freezer stock
  r = await api('POST', '/api/planner/freezer', { token: chloe, body: { dishId: cabbage.id, optionIds: [korean.id], portions: 2, frozenOn: d(4) } })
  eq('freezer: added by hand', [r.status, r.json?.item?.portions], [201, 2])
  const manual = r.json?.item
  await api('PUT', `/api/planner/freezer/${manual.id}`, { token: sam, body: { portions: 0 } })
  ok('freezer: emptied drops off the list', !(await api('GET', '/api/planner/freezer', { token: sam })).json.items.some((f) => f.id === manual.id))
  eq('freezer: 0 portions rejected when adding', (await api('POST', '/api/planner/freezer', { token: sam, body: { dishId: cabbage.id, portions: 0 } })).status, 400)
  eq('freezer: other household 404', (await api('PUT', `/api/planner/freezer/${item.id}`, { token: alex, body: { portions: 5 } })).status, 404)
  eq('freezer: outsiders see none', (await api('GET', '/api/planner/freezer', { token: alex })).json.items.length, 0)

  await runExtras({ sam, chloe, alex, TODAY, d, palak, cabbage, curry })
}

/* ---------- one-line review, tips, photos, regulars, snooze, history ---------- */
async function runExtras({ sam, chloe, alex, TODAY, d, palak, cabbage, curry }) {
  // Fresh nights to review
  const set = async (date, dishId) => (await api('PUT', `/api/planner/slots/${date}`, { token: sam, body: { dishId } })).json.entry
  const a = await set(d(6), curry.id)
  const b = await set(d(7), palak.id) // d(7) = 11 Jan, before TODAY
  let r = await api('POST', '/api/planner/parse-review', { token: sam, body: { today: TODAY, text: 'all good except the palak, too much faff' } })
  eq('one line: 200, read by code (AI mocked)', [r.status, r.json?.by], [200, 'code'])
  const items = r.json?.items ?? []
  eq('one line: the rest are good', [items.find((x) => x.entryId === a.id)?.status, items.find((x) => x.entryId === a.id)?.stars], ['cooked', 4])
  eq('one line: the named meal gets the comment', [items.find((x) => x.entryId === b.id)?.stars, items.find((x) => x.entryId === b.id)?.note], [2, 'too much faff'])
  eq('one line: saves nothing by itself', (await api('GET', `/api/planner/review?today=${TODAY}`, { token: sam })).json.entries.length, 2)
  eq('one line: empty rejected', (await api('POST', '/api/planner/parse-review', { token: sam, body: { today: TODAY, text: ' ' } })).status, 400)
  await api('PUT', `/api/planner/entries/${a.id}`, { token: sam, body: { status: 'skipped' } })
  await api('PUT', `/api/planner/entries/${b.id}`, { token: sam, body: { status: 'skipped' } })
  eq('one line: nothing to review is a 409', (await api('POST', '/api/planner/parse-review', { token: sam, body: { today: TODAY, text: 'great' } })).status, 409)

  // A cook note written twice is offered as a tip
  const n1 = await set(d(-7), palak.id)
  const n2 = await set(d(-6), palak.id)
  await api('PUT', `/api/planner/entries/${n1.id}`, { token: sam, body: { status: 'cooked', cookNote: 'More garlic' } })
  await api('PUT', `/api/planner/entries/${n2.id}`, { token: chloe, body: { status: 'cooked', cookNote: 'more garlic ' } })
  let meal = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === palak.id)
  eq('tip: repeated note offered', meal.tipSuggestions, [{ note: 'more garlic', count: 2 }])
  await api('PUT', `/api/planner/meals/${palak.id}`, { token: sam, body: { tips: 'More garlic' } })
  meal = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === palak.id)
  eq('tip: gone once the tips say it', meal.tipSuggestions, [])

  // Photos: JPEG only, first becomes the cover, served to the household only
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])
  const upload = (token, dishId, body, type = 'image/jpeg', entryId = '') =>
    fetch(`${BASE}/api/planner/photos?dishId=${dishId}${entryId ? `&entryId=${entryId}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body })
  let res = await upload(sam, palak.id, jpeg, 'image/jpeg', n1.id)
  const p1 = (await res.json()).photo
  eq('photo: uploaded', res.status, 201)
  res = await upload(chloe, palak.id, jpeg)
  const p2 = (await res.json()).photo
  meal = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === palak.id)
  eq('photo: newest first, first one is the cover', [meal.photos.map((p) => p.id), meal.coverPhotoId], [[p2.id, p1.id], p1.id])
  eq('photo: linked to the cook', meal.photos.find((p) => p.id === p1.id)?.entryId, n1.id)
  eq('photo: not a JPEG rejected', (await upload(sam, palak.id, Buffer.from('hello'))).status, 400)
  eq('photo: wrong type rejected', (await upload(sam, palak.id, jpeg, 'image/png')).status, 415)
  eq('photo: too big rejected', (await upload(sam, palak.id, Buffer.concat([jpeg, Buffer.alloc(3 * 1024 * 1024)]))).status, 413)
  eq('photo: other household’s meal 404', (await upload(alex, palak.id, jpeg)).status, 404)
  res = await fetch(`${BASE}/api/planner/photos/${p1.id}`, { headers: { authorization: `Bearer ${chloe}` } })
  ok('photo: served to the household as a JPEG', res.status === 200 && res.headers.get('content-type') === 'image/jpeg' && Buffer.from(await res.arrayBuffer()).equals(jpeg))
  eq('photo: not to others', (await fetch(`${BASE}/api/planner/photos/${p1.id}`, { headers: { authorization: `Bearer ${alex}` } })).status, 404)
  eq('cover: set to another photo', (await api('PUT', `/api/planner/meals/${palak.id}`, { token: sam, body: { coverPhotoId: p2.id } })).json?.meal?.coverPhotoId, p2.id)
  eq('cover: a photo of another meal rejected', (await api('PUT', `/api/planner/meals/${cabbage.id}`, { token: sam, body: { coverPhotoId: p2.id } })).status, 400)
  await api('DELETE', `/api/planner/photos/${p2.id}`, { token: sam })
  meal = (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === palak.id)
  eq('photo: deleting the cover falls back to the next', [meal.photos.length, meal.coverPhotoId], [1, p1.id])
  eq('photo: deleted file is gone', (await fetch(`${BASE}/api/planner/photos/${p2.id}`, { headers: { authorization: `Bearer ${sam}` } })).status, 404)

  // Regulars and snoozes
  r = await api('PUT', `/api/planner/meals/${curry.id}`, { token: sam, body: { regularEveryDays: 14 } })
  eq('regular: every 14 days', r.json?.meal?.regularEveryDays, 14)
  eq('regular: 2 days rejected', (await api('PUT', `/api/planner/meals/${curry.id}`, { token: sam, body: { regularEveryDays: 2 } })).status, 400)
  r = await api('PUT', `/api/planner/meals/${cabbage.id}/snooze`, { token: chloe, body: { today: TODAY } })
  eq('snooze: three weeks by default', r.json?.until, '2027-02-02')
  eq('snooze: shows on the meal for both', (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id).snoozedUntil, '2027-02-02')
  await api('PUT', `/api/planner/meals/${cabbage.id}/snooze`, { token: sam, body: { today: TODAY, days: 0 } })
  eq('snooze: cleared', (await api('GET', '/api/planner/meals', { token: sam })).json.meals.find((m) => m.id === cabbage.id).snoozedUntil, null)
  eq('snooze: other household 404', (await api('PUT', `/api/planner/meals/${cabbage.id}/snooze`, { token: alex, body: { today: TODAY } })).status, 404)

  // History for suggestions
  r = await api('GET', '/api/planner/history', { token: sam })
  ok('history: dated cooks only', r.json?.entries?.length > 0 && r.json.entries.every((e) => e.date && e.dishId))
  ok('history: counts imported weeks', r.json?.importedWeeks >= 1, String(r.json?.importedWeeks))
  eq('history: outsiders get none', (await api('GET', '/api/planner/history', { token: alex })).json?.entries?.length, 0)

  await runShopping({ sam, chloe, alex, palak, cabbage, curry })
}

/* ---------- shopping list (M5) ---------- */
async function runShopping({ sam, chloe, alex, palak, cabbage, curry }) {
  const WEEK = '2027-02-01' // a Monday with nothing planned yet
  const day = (n) => new Date(Date.parse(`${WEEK}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
  await api('PUT', `/api/planner/slots/${day(0)}`, { token: sam, body: { dishId: palak.id } })
  await api('PUT', `/api/planner/slots/${day(1)}`, { token: sam, body: { kind: 'out' } })
  await api('PUT', `/api/planner/slots/${day(3)}`, { token: sam, body: { dishId: curry.id } })

  let r = await api('GET', `/api/planner/shopping?week=${WEEK}`, { token: chloe })
  eq('shop: empty list to start', r.json?.items, [])
  eq('shop: only meal nights to shop for', r.json?.nights?.map((n) => n.date), [day(0), day(3)])
  eq('shop: needs a week', (await api('GET', '/api/planner/shopping', { token: sam })).status, 400)

  const add = (token, body) => api('POST', '/api/planner/shopping/items', { token, body: { week: WEEK, ...body } })
  r = await add(sam, { name: 'Onions', qty: '2', dishId: palak.id })
  eq('shop: added for a meal, section guessed', [r.status, r.json?.item?.section, r.json?.item?.dishIds], [201, 'cold', [palak.id]])
  r = await add(chloe, { name: ' onions ', qty: '1', dishId: curry.id })
  eq('shop: same item from another meal is one line', [r.json?.item?.qty, r.json?.item?.dishIds], ['2 + 1', [palak.id, curry.id]])
  eq('shop: tinned tomatoes are ambient', (await add(sam, { name: 'Tinned tomatoes', dishId: curry.id })).json?.item?.section, 'ambient')
  eq('shop: unknown word falls back to ambient (AI mocked)', (await add(sam, { name: 'Zorblax' })).json?.item?.section, 'ambient')
  r = await add(sam, { name: 'Coriander', dishId: curry.id, section: 'market' })
  eq('shop: market set by us', r.json?.item?.section, 'market')
  eq('shop: empty name rejected', (await add(sam, { name: ' ' })).status, 400)
  eq('shop: bad section rejected', (await add(sam, { name: 'Milk', section: 'fridge' })).status, 400)
  eq('shop: another household’s meal 404', (await add(alex, { name: 'Milk', dishId: palak.id })).status, 404)

  r = await api('GET', `/api/planner/shopping?week=${WEEK}`, { token: sam })
  const items = r.json.items
  eq('shop: shop order Market, Cold, Ambient', items.map((i) => i.section), ['market', 'cold', 'ambient', 'ambient'])
  eq('shop: the usual remembered per meal', r.json.usual[curry.id].map((u) => u.name).sort(), ['Coriander', 'Tinned tomatoes', 'onions'])

  // Ticking, sections remembered, removing
  const onions = items.find((i) => i.name === 'Onions')
  r = await api('PUT', `/api/planner/shopping/items/${onions.id}`, { token: chloe, body: { checked: true } })
  eq('shop: ticked', r.json?.item?.checked, true)
  const zorb = items.find((i) => i.name === 'Zorblax')
  await api('PUT', `/api/planner/shopping/items/${zorb.id}`, { token: sam, body: { section: 'market' } })
  await api('DELETE', `/api/planner/shopping/items/${zorb.id}`, { token: sam })
  eq('shop: a section we set is remembered next time', (await add(sam, { name: 'zorblax' })).json?.item?.section, 'market')
  r = await api('DELETE', `/api/planner/shopping/items/${onions.id}?dishId=${palak.id}`, { token: sam })
  eq('shop: removing one meal’s claim keeps the line', r.json?.item?.dishIds, [curry.id])
  r = await add(sam, { name: 'Onions', dishId: palak.id })
  eq('shop: adding again unticks it', r.json?.item?.checked, false)
  await api('PUT', `/api/planner/shopping/items/${onions.id}`, { token: sam, body: { checked: true } })
  r = await api('DELETE', `/api/planner/shopping/checked?week=${WEEK}`, { token: chloe })
  eq('shop: clear ticked', r.json?.cleared, 1)
  eq('shop: item from another household 404', (await api('PUT', `/api/planner/shopping/items/${zorb.id}`, { token: alex, body: { checked: true } })).status, 404)
  eq('shop: outsiders see an empty list', (await api('GET', `/api/planner/shopping?week=${WEEK}`, { token: alex })).json?.items, [])

  // Sections loaded from the Notes (admin)
  const s = spawnSync(process.execPath, [CLI, 'planner', 'sections', '--email', 'sam@example.com'], {
    env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', input: JSON.stringify([{ name: 'Leeks', section: 'market' }, { name: 'x', section: 'nowhere' }]),
  })
  ok('sections: loaded', s.status === 0 && /remembered 1/.test(s.stdout), s.stdout + s.stderr)
  eq('sections: used for the next list', (await add(sam, { name: 'leeks' })).json?.item?.section, 'market')
  void cabbage
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
