#!/usr/bin/env node
/**
 * API failover and the self-retrying first load (SPEC §8) in headless Edge
 * (CDP), against a throwaway local server serving the built dist/.
 *
 *   npm run build && node qa/api-failover-browser-test.mjs
 *
 * api-config.js is replaced over CDP so APP_API_BASE lists a dead origin first
 * and the real server second, the way production lists the bare IP and the
 * sslip.io name. Covers: a sign-in whose first origin gives no answer is
 * re-sent to the second at once and the user sees the server's answer; the
 * working origin is remembered (the next load goes straight to it); the
 * failure is logged with the dead host;
 * and a first load with the API down shows the error card, retries by itself,
 * and opens the app once the API is back. EDGE_PATH overrides the browser.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 25000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const BASE = `http://127.0.0.1:${port}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-failover-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-edge-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A port nothing listens on: the "dead" origin. */
const deadPort = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)) })
})
const DEAD = `http://127.0.0.1:${deadPort}`

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(ROOT, 'dist'), RATE_LIMIT: 'off', AI_MOCK: 'agree', GARMIN: 'off', ACCESS_LOG: 'off', CRONOMETER_SYNC_HOUR: '99' }
let server
/** The server's [client] lines (uploaded diagnostics), parsed. */
const clientLines = []
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  server.stdout.setEncoding('utf8')
  let buffered = ''
  server.stdout.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop()
    for (const line of lines) {
      const m = /^\[client\] user=\S+ ip=\S+ (\{.*\})$/.exec(line)
      if (m) clientLines.push(JSON.parse(m[1]))
    }
  })
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server did not start')
}

/* ---------- CDP ---------- */
let ws
let seq = 0
const waiting = new Map()
const errors = []
/** What api-config.js says, swapped in per test step. */
let apiConfig = ''
/** Every API request the page sent, by origin. */
const requests = []
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => waiting.set(id, resolve))
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(150)
  }
  return false
}
const text = () => evaluate('document.body.innerText')
async function load(config) {
  apiConfig = config
  await send('Page.navigate', { url: `${BASE}/` })
  await sleep(300)
}

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--window-size=390,844', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

try {
  await startServer()
  const invite = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'invite', 'create', '--note', 'qa'], { env, encoding: 'utf8' }).stdout.trim()
  const reg = await (await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@example.com', password: 'cook-dinner-1', inviteCode: invite, displayName: 'Sam' }) })).json()
  ok('test user registered', !!reg.token)

  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page') } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m); waiting.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/') && m.params.request.method !== 'OPTIONS') {
      requests.push({ origin: new URL(m.params.request.url).origin, path: new URL(m.params.request.url).pathname, method: m.params.request.method })
    }
    if (m.method === 'Fetch.requestPaused' && m.params.request.url.includes('api-config.js')) {
      const body = Buffer.from(`window.APP_API_BASE = ${JSON.stringify(apiConfig)};\n`).toString('base64')
      void send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }, { name: 'Cache-Control', value: 'no-store' }], body })
    }
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api-config.js*' }] })

  /* ---------- 1. sign-in fails over to the second origin ---------- */
  await load(`${DEAD}, ${BASE}`)
  await waitFor(() => evaluate(`!!document.querySelector('form.login-form')`))
  await evaluate(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    set(document.querySelector('input[type=email]'), 'sam@example.com')
    set(document.querySelector('input[type=password]'), 'wrong-password-1')
    document.querySelector('form.login-form button[type=submit]').click()
    return true
  })()`)
  ok('the server answers through the second origin', await waitFor(async () => /Email or password is incorrect/.test(await text())), (await text()).slice(0, 200))
  // The dead origin is refused before the network (CSP connect-src), like a
  // request that never leaves the phone, so the proof is the uploaded log.
  ok('the live origin answered the sign-in', requests.some((r) => r.origin === BASE && r.path === '/api/auth/login'), JSON.stringify(requests))
  ok('the dead origin was tried first and logged with its host', await waitFor(() => clientLines.some((e) => e.type === 'fetch-fail' && e.kind === 'network' && e.path === '/auth/login' && e.base === `127.0.0.1:${deadPort}`)), JSON.stringify(clientLines))
  ok('the recovery names the origin that answered', clientLines.some((e) => e.type === 'recovered' && e.base === `127.0.0.1:${port}`), JSON.stringify(clientLines))
  ok('the working origin is remembered', (await evaluate(`localStorage.getItem('healthlog.apiBase.v1')`)) === BASE)

  /* ---------- 2. the next load goes straight to the remembered origin ---------- */
  await evaluate(`localStorage.setItem('healthlog:token', ${JSON.stringify(reg.token)}); true`)
  requests.length = 0
  await load(`${DEAD}, ${BASE}`)
  ok('a signed-in load opens the app', await waitFor(async () => !!(await evaluate(`!!document.querySelector('.health-app')`))), (await text()).slice(0, 200))
  ok('no request went to the dead origin', requests.length > 0 && !requests.some((r) => r.origin === DEAD), JSON.stringify(requests.slice(0, 6)))

  /* ---------- 3. a first load with no answer retries by itself ---------- */
  // The page is served by the same local server, so the API "outage" is made
  // over CDP: the first /api/auth/me fails as if the network were down, later
  // ones go through.
  await evaluate(`localStorage.removeItem('healthlog.apiBase.v1'); true`)
  await send('Fetch.disable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api-config.js*' }, { urlPattern: '*/api/auth/me*' }] })
  let heldMe = null
  const releaseHeld = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Fetch.requestPaused' && m.params.request.url.includes('/api/auth/me') && !heldMe) {
      heldMe = m.params.requestId
      releaseHeld.push(() => send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'ConnectionRefused' }))
    } else if (m.method === 'Fetch.requestPaused' && m.params.request.url.includes('/api/auth/me')) {
      void send('Fetch.continueRequest', { requestId: m.params.requestId })
    }
  })
  apiConfig = BASE
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor(() => heldMe !== null)
  await releaseHeld[0]()
  ok('the error card says it is retrying', await waitFor(async () => /Trying again automatically|Reconnecting/.test(await text())), (await text()).slice(0, 200))
  ok('the app opens by itself once the API answers', await waitFor(async () => !!(await evaluate(`!!document.querySelector('.health-app')`)), 10000), (await text()).slice(0, 200))

  ok('no uncaught exceptions', errors.length === 0, errors.join(' | '))
} catch (error) {
  fail++
  console.log(`FAIL  test crashed — ${error.stack ?? error}`)
} finally {
  try { ws?.close() } catch {}
  edge.kill()
  server?.kill()
  await sleep(300)
  for (const dir of [dataDir, profileDir]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
