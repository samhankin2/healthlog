#!/usr/bin/env node
/**
 * Lifting UI check in headless Edge (CDP), against a throwaway local server
 * serving the built dist/. Phone viewport (390 × 844).
 *
 *   npm run build && node qa/lifting-browser-test.mjs
 *
 * Covers: start a workout, add an exercise, log a set, last-time hint and
 * target from history, a set logged offline lands after reconnecting, the
 * exercise page, Insights showing Strength, no horizontal overflow, no
 * exceptions or console errors. EDGE_PATH overrides the browser location.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 19000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const BASE = `http://127.0.0.1:${port}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-lift-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-edge-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(ROOT, 'dist'), RATE_LIMIT: 'off', AI_MOCK: '1', GARMIN: 'off', ACCESS_LOG: 'off' }
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' })
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--window-size=390,844', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

async function json(method, route, token, body) {
  const res = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

/* ---------- CDP ---------- */
let ws
let seq = 0
const waiting = new Map()
const errors = []
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }))
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
async function until(expr, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(`return Boolean(${expr})`).catch(() => false)) return true
    await sleep(150)
  }
  return false
}
const click = (selector, text) => evaluate(`
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length)
  const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}
  if (!el) throw new Error('no element ' + ${JSON.stringify(`${selector} ${text ?? ''}`)})
  el.click(); return true`)
const bodyText = () => evaluate('return document.body.innerText')
const overflow = () => evaluate('return document.documentElement.scrollWidth - window.innerWidth')

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* booting */ } await sleep(150) }
  const invite = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'invite', 'create', '--note', 'qa'], { env, encoding: 'utf8' }).stdout.trim()
  const reg = await json('POST', '/api/auth/register', null, { email: 'lifter@example.com', password: 'lift-heavy-1', inviteCode: invite })
  const token = reg.token
  ok('setup: registered', Boolean(token))
  const lib = await json('GET', '/api/lifting', token)
  const bench = lib.exercises.find((e) => e.name === 'Bench press')
  // Two earlier sessions so the logger has a "last time" and a target.
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA') }
  for (const [n, w] of [[10, 75], [3, 80]]) {
    await json('PUT', `/api/lifting/workouts/seed-${n}-workout`, token, {
      day: day(n), name: 'Push', startedAt: new Date(Date.now() - n * 864e5).toISOString(), endedAt: new Date(Date.now() - n * 864e5 + 3600e3).toISOString(),
      sets: [1, 2, 3].map((i) => ({ id: `seed-${n}-set-${i}`, exerciseId: bench.id, weightKg: w, reps: 8 })),
    })
  }

  let target
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page') } catch { /* starting */ }
    if (!target) await sleep(200)
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result) }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
  })
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(600)
  await evaluate(`localStorage.setItem('healthlog:token', ${JSON.stringify(token)}); location.hash = '#/lifting'; location.reload(); return true`)
  ok('home: renders with the default routine', await until(`document.body.innerText.includes('Start Upper body') && document.body.innerText.includes('Empty workout')`))
  ok('home: routine lists its exercises', await evaluate(`return /Incline dumbbell press · Pull-up · Inverted row/.test(document.querySelector('.r-list')?.textContent ?? '')`))
  ok('home: lists the bench press with a next target', await until(`document.body.innerText.includes('Bench press') && document.body.innerText.includes('Next:')`))
  ok('nav: Lifting tab in the bottom bar', await evaluate(`return Boolean(document.querySelector('.bottom-nav [data-tab="lifting"]'))`))
  ok('home: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))

  await click('button', 'Empty workout')
  ok('logger: opens', await until(`location.hash.startsWith('#/lifting/log/') && document.body.innerText.includes('Add exercise')`))
  await click('button', 'Add exercise')
  await until(`document.querySelector('.ex-row')`)
  await click('.ex-row', 'Bench press')
  ok('logger: shows last time', await until(`/last time/i.test(document.body.innerText) && document.body.innerText.includes('80 × 8, 8, 8')`))
  ok('logger: suggests adding weight (8s → +2.5 kg for 6s)', await until(`document.body.innerText.includes('82.5 kg × 6, 6, 6')`))
  ok('logger: explains the plan (Why?)', await evaluate(`return [...document.querySelectorAll('details.why summary')].some((e) => /Add weight · 5–8 reps/.test(e.textContent))`))
  ok('logger: prefilled with the target', await evaluate(`return document.querySelector('.log-btn').textContent.includes('82.5 kg × 6')`))
  await click('.log-btn')
  ok('logger: set logged', await until(`document.querySelectorAll('.set-row').length === 1`))
  ok('logger: rest timer started', await until(`document.querySelector('.rest-clock')`))
  ok('logger: PR noticed', await until(`document.querySelector('.pr-badge')`))
  ok('logger: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))
  const workoutId = await evaluate(`return location.hash.split('/').pop()`)
  let synced = false
  for (let i = 0; i < 40 && !synced; i++) { synced = (await json('GET', `/api/lifting/workouts/${workoutId}`, token)).workout?.sets?.length === 1; if (!synced) await sleep(150) }
  ok('sync: set reached the server', synced)

  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await click('.log-btn')
  ok('offline: second set shown', await until(`document.querySelectorAll('.set-row').length === 2`))
  ok('offline: marked saved on phone', await until(`document.body.innerText.includes('saved on phone')`))
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await evaluate(`window.dispatchEvent(new Event('online')); return true`)
  synced = false
  for (let i = 0; i < 60 && !synced; i++) { synced = (await json('GET', `/api/lifting/workouts/${workoutId}`, token)).workout?.sets?.length === 2; if (!synced) await sleep(200) }
  ok('offline: set lands after reconnecting', synced)

  await click('button.finish')
  await until(`document.body.innerText.includes('Save workout')`)
  await click('button', 'Save workout')
  ok('finish: back on home', await until(`location.hash === '#/lifting' && document.body.innerText.includes('Start Upper body')`))
  const saved = (await json('GET', `/api/lifting/workouts/${workoutId}`, token)).workout
  ok('finish: endedAt stored', Boolean(saved?.endedAt))

  // Routine: start it, swap the incline press for the barbell bench, then discard.
  await click('button', 'Start Upper body')
  ok('routine: logger opens with its 9 exercises', await until(`document.querySelectorAll('.ex-card').length === 9 && document.querySelector('.ex-title')?.textContent === 'Incline dumbbell press'`))
  ok('routine: swap offered for the incline press', await until(`[...document.querySelectorAll('.swap')].some((b) => b.textContent.includes('Bench press'))`))
  await click('.swap', 'Bench press')
  ok('routine: swapped in place', await until(`document.querySelector('.ex-title')?.textContent === 'Bench press' && document.querySelectorAll('.ex-card').length === 9`))
  const swapText = await evaluate(`return document.querySelector('.ex-card.open')?.innerText ?? ''`)
  ok('routine: swapped lift keeps its own history and plan', /last time\s*82\.5 × 6, 6/i.test(swapText) && /try\s*82\.5 kg × /i.test(swapText), swapText.slice(0, 300).replace(/\n/g, ' / '))
  ok('routine: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))
  await click('button.finish')
  await until(`document.body.innerText.includes('Discard')`)
  await click('button', 'Discard')
  ok('routine: empty session discarded', await until(`location.hash === '#/lifting' && document.body.innerText.includes('Start Upper body')`))

  await click('button', 'Edit')
  ok('routine editor: opens', await until(`location.hash.startsWith('#/lifting/routine/') && document.body.innerText.includes('Exercises, in order')`))
  ok('routine editor: shows the stand-in', await evaluate(`return document.body.innerText.includes('or Bench press')`))
  ok('routine editor: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))
  await click('button', 'Back')

  await evaluate(`location.hash = '#/lifting/exercise/${bench.id}'; return true`)
  ok('detail: renders e1RM and sessions', await until(`document.body.innerText.includes('Best e1RM') && document.body.innerText.includes('Best weight for reps')`))
  ok('detail: shows the plan with reasoning', await until(`/Next time · /i.test(document.body.innerText) && document.querySelector('.why li')`))
  ok('detail: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))

  await evaluate(`location.hash = '#/insights'; return true`)
  ok('insights: Strength block from the lifting log', await until(`document.body.innerText.includes('Strength') && document.body.innerText.includes('Hard sets / week')`, 12000))
  ok('insights: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.hash = '#/lifting'; return true`)
  await until(`document.body.innerText.includes('Your lifts')`)
  ok('desktop: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))

  const real = errors.filter((e) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|Could not connect/i.test(e))
  ok('no exceptions or console errors', real.length === 0, real.join(' | '))
  void bodyText
} catch (err) {
  fail++
  console.log(`FAIL  run aborted — ${err?.stack || err}`)
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
  server.kill()
  await sleep(400)
  for (const d of [dataDir, profileDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows locks */ } }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
