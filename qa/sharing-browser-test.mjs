#!/usr/bin/env node
/**
 * Partner meal sharing in headless Edge (CDP), against a throwaway local server
 * serving the built dist/ with the mock AI.
 *
 *   npm run build && node qa/sharing-browser-test.mjs
 *
 * Covers: linking a partner in Settings (pending → linked), logging a meal in
 * the chat and sharing it, the partner seeing it at the top of the chat when
 * the app opens (a notification, Review opens the card), choosing a portion, correcting it before adding, dismissing
 * one from the dashboard, the sender seeing it was logged (History), no horizontal
 * overflow, no exceptions or console errors. EDGE_PATH overrides the browser
 * location; SHOT_DIR saves screenshots.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 23000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const BASE = `http://127.0.0.1:${port}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-share-ui-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-edge-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const today = new Date().toLocaleDateString('en-CA')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(ROOT, 'dist'), RATE_LIMIT: 'off', AI_MOCK: 'agree', GARMIN: 'off', ACCESS_LOG: 'off', CRONOMETER_SYNC_HOUR: '99' }
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: 'ignore' })
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--window-size=390,844', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

async function http(method, route, token, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
/** Type into a Svelte-bound input or textarea (native setter + input event). */
const type = (selector, value) => evaluate(`
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) throw new Error('no input ' + ${JSON.stringify(selector)})
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true })); return true`)
const text = (selector) => evaluate(`return document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
/** Is the button with this text, scrolled into view in the topmost sheet, really what a tap there hits? */
const tappableInTopSheet = (label) => evaluate(`
  await new Promise((r) => setTimeout(r, 500))
  const top = [...document.querySelectorAll('[role="dialog"]')].at(-1)
  const el = [...top.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)}))
  if (!el) return false
  el.scrollIntoView({ block: 'nearest' })
  await new Promise((r) => setTimeout(r, 200))
  const box = el.getBoundingClientRect()
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  return Boolean(hit && el.contains(hit))`)
const overflow = () => evaluate('return document.documentElement.scrollWidth - window.innerWidth')
const signInAs = (token, hash) =>
  evaluate(`localStorage.setItem('healthlog:token', ${JSON.stringify(token)}); location.hash = ${JSON.stringify(hash)}; location.reload(); return true`)
async function shot(name) {
  if (!process.env.SHOT_DIR) return
  const s = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(process.env.SHOT_DIR, name), Buffer.from(s.data, 'base64'))
}

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break } catch { /* booting */ } await sleep(150) }
  const invite = () => spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'invite', 'create', '--note', 'qa'], { env, encoding: 'utf8' }).stdout.trim()
  const sam = await http('POST', '/api/auth/register', undefined, { email: 'sam@example.com', password: 'cook-dinner-1', inviteCode: invite(), displayName: 'Sam' })
  const chloe = await http('POST', '/api/auth/register', undefined, { email: 'chloe@example.com', password: 'eat-dinner-1', inviteCode: invite(), displayName: 'Chloe Example' })
  ok('setup: two accounts', Boolean(sam.token && chloe.token))

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

  /* ---------- Sam links Chloe in Settings ---------- */
  await signInAs(sam.token, '#/settings')
  ok('settings: partner card with an email field', await until(`document.querySelector('#partner-email')`))
  await type('#partner-email', 'chloe@example.com')
  await click('[aria-labelledby="partner-title"] button[type="submit"]')
  ok('settings: one-sided link shows Waiting', await until(`/Waiting/.test(document.querySelector('[aria-labelledby="partner-title"]')?.innerText ?? '')`))
  await http('PUT', '/api/partner', chloe.token, { email: 'sam@example.com' })
  await click('[aria-labelledby="partner-title"] button', 'Check again')
  ok('settings: linked once Chloe adds Sam', await until(`/Sharing with Chloe/.test(document.querySelector('[aria-labelledby="partner-title"]')?.innerText ?? '')`), await text('[aria-labelledby="partner-title"]'))
  ok('phone: no horizontal overflow on Settings', (await overflow()) <= 0, String(await overflow()))
  await evaluate(`document.querySelector('[aria-labelledby="partner-title"]').scrollIntoView(); return true`)
  await shot('share-settings-phone.png')

  /* ---------- Sam logs dinner and shares it ---------- */
  await evaluate(`location.hash = '#/chat'; return true`)
  await until(`document.querySelector('.composer-input')`)
  await type('.composer-input', 'chicken curry with rice')
  await click('.composer-send')
  ok('chat: estimate arrives', await until(`[...document.querySelectorAll('.analysis-actions button')].some((b) => b.textContent.includes('Save meal'))`, 15000))
  ok('chat: no share button before saving', !(await evaluate(`return document.body.innerText.includes('Share with Chloe')`)))
  await click('.analysis-actions button', 'Save meal')
  ok('chat: share button after saving', await until(`[...document.querySelectorAll('.analysis-actions button')].some((b) => b.textContent.includes('Share with Chloe'))`))
  await click('.analysis-actions button', 'Share with Chloe')
  ok('chat: shows Shared with Chloe', await until(`document.querySelector('.analysis-actions')?.innerText.includes('Shared with Chloe')`))
  await shot('share-chat-sender-phone.png')
  const samMeals = await http('GET', `/api/meals?day=${today}`, sam.token)
  const samKcal = samMeals.meals?.[0]?.kcal
  ok('chat: Sam’s meal is shared', samMeals.meals?.[0]?.sharedStatus === 'pending', JSON.stringify(samMeals.meals?.[0]))

  /* ---------- Chloe opens the app ---------- */
  await signInAs(chloe.token, '#/chat')
  ok('chloe: notification at the top of the chat', await until(`document.querySelector('.shared-banner')?.innerText.includes('Sam shared')`, 10000), await text('.view--chat'))
  ok('phone: notification fits above the chat', (await overflow()) <= 0, String(await overflow()))
  await shot('share-banner-phone.png')
  await click('.shared-banner button', 'Review')
  ok('chloe: Review opens the shared meal', await until(`document.querySelector('[role="dialog"] .shared-card')?.innerText.includes('Sam shared a meal')`))
  ok('phone: Not for me is tappable in the review sheet', await tappableInTopSheet('Not for me'))
  ok('chloe: card shows the full kcal at Same', (await text('.shared-kcal')).includes(String(Math.round(samKcal))), await text('.shared-kcal'))
  await click('.shared-card .segmented-control button, .shared-card [role="radio"], .shared-card button', '¾')
  ok('chloe: ¾ portion scales the kcal', await until(`document.querySelector('.shared-kcal')?.innerText.includes('${Math.round(samKcal * 0.75)}')`), await text('.shared-kcal'))
  ok('phone: no horizontal overflow on Chat with a shared meal', (await overflow()) <= 0, String(await overflow()))
  await shot('share-inbox-phone.png')

  await click('.shared-card button', 'Correct')
  ok('chloe: correction sheet opens prefilled at ¾', await until(`document.querySelector('#meal-kcal')?.value === '${Math.round(samKcal * 0.75 * 10) / 10}'`), await evaluate(`return document.querySelector('#meal-kcal')?.value`))
  await shot('share-correct-phone.png')
  ok('phone: Add to my log is tappable in the correction sheet', await tappableInTopSheet('Add to my log'))
  await type('#meal-kcal', '480')
  await type('#meal-name', 'Chicken curry (less rice)')
  // The correction sheet opens on top of the review sheet: use the topmost.
  await evaluate(`const top = [...document.querySelectorAll('[role="dialog"]')].at(-1); [...top.querySelectorAll('button')].find((b) => b.textContent.includes('Add to my log')).click(); return true`)
  ok('chloe: card and notification leave', await until(`!document.querySelector('.shared-card') && !document.querySelector('.shared-banner')`))
  const chloeMeals = await http('GET', `/api/meals?day=${today}`, chloe.token)
  const added = chloeMeals.meals?.[0]
  ok('chloe: meal added with her corrections', added?.kcal === 480 && added?.name === 'Chicken curry (less rice)' && added?.source === 'shared', JSON.stringify(added))
  ok('chloe: items scaled to ¾', added?.items?.every((i) => /^¾ of /.test(i.quantity ?? '')), JSON.stringify(added?.items))
  const samAfter = await http('GET', `/api/meals?day=${today}`, sam.token)
  ok('sam: his meal is untouched', samAfter.meals?.[0]?.kcal === samKcal)

  /* ---------- dashboard: a second share, dismissed ---------- */
  const pizza = await http('POST', '/api/meals', sam.token, { day: today, name: 'Pizza night', kcal: 900, proteinG: 35, carbsG: 100, fatG: 35 })
  await http('POST', `/api/meals/${pizza.meal.id}/share`, sam.token)
  await evaluate(`location.hash = '#/dashboard'; location.reload(); return true`)
  ok('chloe: shared meal on the dashboard', await until(`document.querySelector('.view--dashboard .shared-card')?.innerText.includes('Pizza night')`, 10000))
  ok('phone: no horizontal overflow on Dashboard', (await overflow()) <= 0, String(await overflow()))
  await click('.shared-card button', 'Not for me')
  ok('chloe: dismissed card goes away', await until(`!document.querySelector('.shared-card')`))
  ok('chloe: dismissed meal not logged', (await http('GET', `/api/meals?day=${today}`, chloe.token)).meals?.length === 1)

  /* ---------- Sam sees it was logged ---------- */
  // The chat starts fresh each time the app opens, so the record is in History.
  await signInAs(sam.token, '#/history')
  ok('sam: history says Chloe logged the curry', await until(`[...document.querySelectorAll('.meal-card')].some((c) => c.innerText.includes('Chloe logged it'))`, 10000), await text('.meals-history'))
  ok('sam: history marks the dismissed pizza as shared, not logged', await until(`[...document.querySelectorAll('.meal-card')].some((c) => c.innerText.includes('Pizza night') && c.innerText.includes('Shared'))`))
  ok('phone: no horizontal overflow on History', (await overflow()) <= 0, String(await overflow()))
  await shot('share-history-phone.png')

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const soup = await http('POST', '/api/meals', sam.token, { day: today, name: 'Soup', kcal: 300, proteinG: 10, carbsG: 30, fatG: 10 })
  await http('POST', `/api/meals/${soup.meal.id}/share`, sam.token)
  await signInAs(chloe.token, '#/chat')
  ok('desktop: shared meal on the chat', await until(`document.querySelector('.shared-banner')?.innerText.includes('Soup')`, 10000))
  await click('.shared-banner button', 'Review')
  await until(`document.querySelector('[role="dialog"] .shared-card')`)
  ok('desktop: no horizontal overflow', (await overflow()) <= 0, String(await overflow()))
  await shot('share-inbox-desktop.png')
  await click('.shared-card button', 'Add to my log')
  ok('desktop: quick add logs it as shared', await until(`!document.querySelector('.shared-card')`) && (await http('GET', `/api/meals?day=${today}`, chloe.token)).meals?.some((m) => m.name === 'Soup' && m.kcal === 300))

  ok('no exceptions or console errors', errors.length === 0, errors.join(' | '))
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
