#!/usr/bin/env node
/**
 * Cronometer UI check in headless Edge (CDP), against a throwaway local server
 * serving the built dist/ and a fake cronometer.com (qa/fixtures/fake-cronometer.mjs).
 *
 *   npm run build && node qa/cronometer-browser-test.mjs
 *
 * Covers: the Settings card, a wrong password shows Cronometer's message, a
 * connect syncs and the meals show on Calories labelled "Cronometer", Sync now,
 * disconnect, no horizontal overflow (phone + desktop), no exceptions or console
 * errors. EDGE_PATH overrides the browser location; SHOT_DIR saves screenshots.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRONO_EMAIL, CRONO_PASSWORD, startFakeCronometer } from './fixtures/fake-cronometer.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 22000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const BASE = `http://127.0.0.1:${port}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-crono-ui-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-edge-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const today = new Date().toLocaleDateString('en-CA')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const fake = await startFakeCronometer({
  diary: [
    [today, '8:05 AM', 'Breakfast', 'Oats, rolled', '60.00 g', '228.0', '7.9', '40.6', '4.1', '6.0'],
    [today, '1:15 PM', 'Lunch', 'Chicken breast', '150.00 g', '248.0', '46.5', '0.0', '5.4', ''],
  ],
})
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(ROOT, 'dist'), RATE_LIMIT: 'off', AI_MOCK: '1', GARMIN: 'off', ACCESS_LOG: 'off', CRONOMETER_BASE: fake.base, CRONOMETER_SYNC_HOUR: '99' }
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' })
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--window-size=390,844', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

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
/** Type into a Svelte-bound input (native setter + input event). */
const type = (selector, value) => evaluate(`
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) throw new Error('no input ' + ${JSON.stringify(selector)})
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true })); return true`)
const card = () => evaluate(`return document.querySelector('[aria-labelledby="cronometer-title"]')?.innerText ?? ''`)
const overflow = () => evaluate('return document.documentElement.scrollWidth - window.innerWidth')
async function shot(name) {
  if (!process.env.SHOT_DIR) return
  const s = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(process.env.SHOT_DIR, name), Buffer.from(s.data, 'base64'))
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* booting */ } await sleep(150) }
  const invite = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'invite', 'create', '--note', 'qa'], { env, encoding: 'utf8' }).stdout.trim()
  const reg = await (await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'eater@example.com', password: 'eat-well-1', inviteCode: invite }) })).json()
  ok('setup: registered', Boolean(reg.token))

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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(600)
  await evaluate(`localStorage.setItem('healthlog:token', ${JSON.stringify(reg.token)}); location.hash = '#/settings'; location.reload(); return true`)

  ok('settings: Cronometer card with the sign-in form', await until(`document.querySelector('#cronometer-email') && document.querySelector('#cronometer-password')`))
  ok('settings: says the password is not stored', /never stored/.test(await card()))
  await evaluate(`document.querySelector('[aria-labelledby="cronometer-title"]').scrollIntoView(); return true`)
  await shot('cronometer-connect-phone.png')

  await type('#cronometer-email', CRONO_EMAIL)
  await type('#cronometer-password', 'wrong-password')
  await click('[aria-labelledby="cronometer-title"] button[type="submit"]')
  ok('wrong password: shows Cronometer\'s message', await until(`document.querySelector('[aria-labelledby="cronometer-title"] .form-error')?.textContent.includes('Invalid email or password')`))
  ok('wrong password: the password field is cleared', await evaluate(`return document.querySelector('#cronometer-password').value === ''`))

  await type('#cronometer-password', CRONO_PASSWORD)
  await click('[aria-labelledby="cronometer-title"] button[type="submit"]')
  ok('connect: card shows connected as the Cronometer email', await until(`document.querySelector('[aria-labelledby="cronometer-title"]')?.innerText.includes('as ${CRONO_EMAIL}')`, 15000), await card())
  ok('connect: form gone, Sync now + Disconnect shown', /Sync now/.test(await card()) && /Disconnect/.test(await card()) && !(await evaluate(`return Boolean(document.querySelector('#cronometer-password'))`)))
  ok('connect: export count shown', /1 of 8 syncs used today/.test(await card()), await card())
  ok('phone: no horizontal overflow on Settings', (await overflow()) <= 0, String(await overflow()))
  await shot('cronometer-connected-phone.png')

  await click('[aria-labelledby="cronometer-title"] button', 'Sync now')
  ok('sync now: count goes up', await until(`/2 of 8 syncs used today/.test(document.querySelector('[aria-labelledby="cronometer-title"]')?.innerText ?? '')`, 10000))

  await evaluate(`location.hash = '#/calories'; return true`)
  ok('calories: synced Breakfast and Lunch listed', await until(`document.body.innerText.includes('Breakfast') && document.body.innerText.includes('Lunch')`, 10000))
  ok('calories: labelled Cronometer', await until(`document.body.innerText.includes('Cronometer')`))
  ok('calories: totals include the synced kcal (476)', await until(`document.body.innerText.includes('476')`), (await evaluate('return document.body.innerText')).slice(0, 400))
  ok('phone: no horizontal overflow on Calories', (await overflow()) <= 0, String(await overflow()))
  await shot('cronometer-calories-phone.png')

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.hash = '#/settings'; return true`)
  await until(`document.querySelector('[aria-labelledby="cronometer-title"]')`)
  ok('desktop: no horizontal overflow on Settings', (await overflow()) <= 0, String(await overflow()))

  await click('[aria-labelledby="cronometer-title"] button', 'Disconnect')
  ok('disconnect: offers keep or remove', await until(`/Keep synced meals/.test(document.querySelector('[aria-labelledby="cronometer-title"]')?.innerText ?? '')`))
  await click('[aria-labelledby="cronometer-title"] button', 'Remove synced meals')
  ok('disconnect: back to the sign-in form', await until(`document.querySelector('#cronometer-password')`))
  const meals = await (await fetch(`${BASE}/api/meals?day=${today}`, { headers: { authorization: `Bearer ${reg.token}` } })).json()
  ok('disconnect: synced meals removed', meals.meals?.length === 0, JSON.stringify(meals.meals?.map((m) => m.name)))

  ok('no exceptions or console errors', errors.length === 0, errors.join(' | '))
} catch (err) {
  fail++
  console.log(`FAIL  run aborted — ${err?.stack || err}`)
} finally {
  try { ws?.close() } catch { /* ignore */ }
  edge.kill()
  server.kill()
  fake.close()
  await sleep(400)
  for (const d of [dataDir, profileDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows locks */ } }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
