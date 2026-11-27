#!/usr/bin/env node
/**
 * Client diagnostics (SPEC §6 "Client diagnostics") in headless Edge (CDP),
 * against a throwaway local server serving the built dist/.
 *
 *   npm run build && node qa/client-log-browser-test.mjs
 *
 * Covers: the app start is queued and uploaded after the first answer; with
 * the API down, a sign-in attempt is queued as a `network` fetch-fail; once the
 * API is back, the next answer uploads the failure and a `recovered` event with
 * the outage length, and the queue empties. Also the server side: unknown event
 * types and fields are dropped, ids in paths become `:id`, bad bodies are 400.
 * EDGE_PATH overrides the browser location.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const port = 24000 + Math.floor(Math.random() * 900)
const cdpPort = port + 1000
const BASE = `http://127.0.0.1:${port}`
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-clientlog-'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-edge-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DIST_DIR: path.join(ROOT, 'dist'), RATE_LIMIT: 'off', AI_MOCK: 'agree', GARMIN: 'off', ACCESS_LOG: 'off', CRONOMETER_SYNC_HOUR: '99' }

/** The server's [client] lines, parsed. */
const clientLines = []
let server
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  server.stdout.setEncoding('utf8')
  let buffered = ''
  server.stdout.on('data', (chunk) => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop()
    for (const line of lines) {
      const m = /^\[client\] user=(\S+) ip=(\S+) (\{.*\})$/.exec(line)
      if (m) clientLines.push({ user: m[1], ...JSON.parse(m[3]) })
    }
  })
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return } catch {}
    await sleep(150)
  }
  throw new Error('server did not start')
}
async function stopServer() {
  const exited = new Promise((r) => server.once('exit', r))
  server.kill()
  await exited
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function waitFor(label, fn, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(150)
  }
  return false
}
const queued = () => evaluate(`JSON.parse(localStorage.getItem('healthlog.clientlog.v1') || '[]')`)
const signIn = () => evaluate(`(() => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  set(document.querySelector('input[type=email]'), 'nobody@example.test')
  set(document.querySelector('input[type=password]'), 'wrong-password-123')
  document.querySelector('form.login-form button[type=submit]').click()
  return true
})()`)
const pageText = () => evaluate('document.body.innerText')

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, '--window-size=390,844', '--no-first-run', 'about:blank'], { stdio: 'ignore' })

try {
  await startServer()

  /* ---------- server side ---------- */
  const post = (body) => fetch(`${BASE}/api/client-log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  ok('bad body is 400', (await post({ events: 'nope' })).status === 400)
  const mixed = await (await post({ events: [
    { type: 'fetch-fail', at: '2026-01-01T00:00:00Z', path: '/meals/3f1c2a9e-1111-2222-3333-444455556666?x=1', kind: 'network', password: 'leak', email: 'a@b.c' },
    { type: 'not-a-type' },
    'junk',
  ] })).json()
  ok('only known event types are accepted', mixed.accepted === 1, JSON.stringify(mixed))
  await waitFor('server line', () => clientLines.length >= 1)
  const cleaned = clientLines.at(-1)
  ok('ids in paths become :id, query dropped', cleaned?.path === '/meals/:id', JSON.stringify(cleaned))
  ok('unknown fields are dropped', cleaned && !('password' in cleaned) && !('email' in cleaned), JSON.stringify(cleaned))
  ok('anonymous upload is tagged anon', cleaned?.user === 'anon')
  clientLines.length = 0

  /* ---------- browser ---------- */
  let target
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250)
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((t) => t.type === 'page') } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && waiting.has(m.id)) { waiting.get(m.id).resolve(m.result ?? m); waiting.delete(m.id); return }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `${BASE}/` })
  await waitFor('login form', () => evaluate(`!!document.querySelector('form.login-form')`))

  const boot = await queued()
  ok('app start is queued', boot.some((e) => e.type === 'boot' && typeof e.build === 'string'), JSON.stringify(boot))

  // A 401 is an answer: the queue (the boot) goes up and empties.
  await signIn()
  ok('boot uploaded after the first answer', await waitFor('boot line', () => clientLines.some((e) => e.type === 'boot')))
  ok('queue empties after upload', await waitFor('empty', async () => (await queued()).length === 0))

  // API down: the attempt is queued, nothing reaches the server.
  await stopServer()
  await signIn()
  const offline = await waitFor('fail queued', async () => (await queued()).some((e) => e.type === 'fetch-fail'))
  const failQueue = await queued()
  const failure = failQueue.find((e) => e.type === 'fetch-fail')
  ok('a sign-in with the API down is queued as a network failure', offline && failure?.kind === 'network' && failure?.path === '/auth/login' && failure?.method === 'POST', JSON.stringify(failQueue))
  ok('the user still sees the connection message', /Could not connect to HealthLog/.test(await pageText()))
  await sleep(1200)

  // API back: the next answer uploads the failure and the outage length.
  clientLines.length = 0
  await startServer()
  await signIn()
  const recovered = await waitFor('recovered line', () => clientLines.some((e) => e.type === 'recovered'))
  const rec = clientLines.find((e) => e.type === 'recovered')
  ok('recovery is reported with the outage length', recovered && rec.failures === 1 && rec.outageMs >= 1000, JSON.stringify(rec))
  ok('the queued failure reaches the server', clientLines.some((e) => e.type === 'fetch-fail' && e.kind === 'network' && e.path === '/auth/login'), JSON.stringify(clientLines))
  ok('queue empties after recovery', await waitFor('empty', async () => (await queued()).length === 0))
  ok('the upload itself is never logged as a request failure', !clientLines.some((e) => e.path === '/client-log'))
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
