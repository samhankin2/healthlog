#!/usr/bin/env node
/**
 * Model benchmark test — no network. Boots the API with AI_MOCK=1, logs meals
 * through /api/chat, and checks that the background panel is recorded and
 * scored (SPEC §7 "Model benchmark"): accepted, chat-corrected and edited
 * meals, the per-model summary, the pairwise matrix, and the off switch.
 *
 *   node qa/model-bench-test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function boot(extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 2000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-bench-'))
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, AI_MOCK: '1', OPENCODE_API_KEY: '', DIST_DIR: '', GARMIN: 'off', ...extraEnv }
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (b) => (log += b))
  child.stderr.on('data', (b) => (log += b))
  const base = `http://127.0.0.1:${port}`
  const api = async (method, route, { token, body } = {}) => {
    const headers = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json }
  }
  const ready = (async () => {
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(`server exited\n${log}`)
      try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* not up */ }
      await sleep(100)
    }
    throw new Error(`server not healthy\n${log}`)
  })()
  const register = async () => {
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'invite', 'create', '--note', 'bench'], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' })
    const r = await api('POST', '/api/auth/register', { body: { email: `bench${port}@example.com`, password: 'correct horse battery', inviteCode: cli.stdout.trim() } })
    return r.json?.token
  }
  const stop = async () => {
    child.kill('SIGTERM')
    await sleep(200)
    try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* windows */ }
  }
  return { api, ready, register, stop, dataDir }
}

async function waitForRuns(api, token, analysisId, want) {
  for (let i = 0; i < 50; i++) {
    const r = await api('GET', '/api/model-bench', { token })
    const log = r.json?.logs?.find((l) => l.id === analysisId)
    if (log && log.runs.length >= want) return r.json
    await sleep(100)
  }
  return (await api('GET', '/api/model-bench', { token })).json
}

const saveMeal = (api, token, analysis, kcal) =>
  api('POST', '/api/meals', { token, body: { name: 'meal', kcal, proteinG: analysis.reconciled.total.protein_g, carbsG: 0, fatG: 0, source: 'ai', analysisId: analysis.id } })

async function run() {
  const s = boot()
  try {
    await s.ready
    const token = await s.register()
    ok('register', typeof token === 'string')

    let r = await s.api('GET', '/api/model-bench')
    ok('auth required', r.status === 401)

    r = await s.api('GET', '/api/model-bench', { token })
    ok('empty: 200', r.status === 200 && r.json?.ok === true)
    ok('empty: config lists 5 bench models', r.json?.config?.bench?.length === 5, JSON.stringify(r.json?.config))
    ok('empty: no logs', r.json?.totals?.logs === 0)

    // 1. Logged and accepted as-is.
    r = await s.api('POST', '/api/chat', { token, body: { message: 'two eggs on toast', save: false } })
    const first = r.json.analysis
    ok('chat still replies with the A/B analysis', r.status === 200 && first?.modelA && first?.modelB)
    let bench = await waitForRuns(s.api, token, first.id, 7)
    let log = bench.logs.find((l) => l.id === first.id)
    ok('7 runs recorded (A, B + 5 bench)', log?.runs.length === 7, `${log?.runs.length}`)
    ok('roles: one a, one b, five bench', log && log.runs.filter((x) => x.role === 'a').length === 1 && log.runs.filter((x) => x.role === 'b').length === 1 && log.runs.filter((x) => x.role === 'bench').length === 5)
    ok('primary latency recorded', log?.runs.find((x) => x.role === 'a')?.latencyMs != null)
    ok('consensus computed', log?.consensusKcal > 0)
    ok('every run has a deviation', log?.runs.every((x) => typeof x.devPct === 'number'))
    ok('unsaved before Save meal', log?.outcome === 'unsaved')
    await saveMeal(s.api, token, first, first.reconciled.total.kcal)
    bench = (await s.api('GET', '/api/model-bench', { token })).json
    ok('saved unchanged -> accepted', bench.logs.find((l) => l.id === first.id)?.outcome === 'accepted')

    // 2. Corrected in chat, then saved: the saved total is the reference.
    r = await s.api('POST', '/api/chat', { token, body: { message: 'big bowl of pasta', save: false } })
    const second = r.json.analysis
    await waitForRuns(s.api, token, second.id, 7)
    r = await s.api('POST', '/api/chat', { token, body: { message: 'it was 200g dry pasta', save: false, reviseAnalysisId: second.id } })
    const revised = r.json.analysis
    await saveMeal(s.api, token, revised, 900)
    await sleep(300)
    bench = (await s.api('GET', '/api/model-bench', { token })).json
    log = bench.logs.find((l) => l.id === second.id)
    ok('correction is not its own log', !bench.logs.some((l) => l.id === revised.id))
    ok('correction got no bench runs', !bench.logs.some((l) => l.runs.length > 7))
    ok('chat correction -> corrected', log?.outcome === 'corrected' && log.reference?.source === 'chat correction', JSON.stringify(log?.reference))
    ok('reference = saved total', log?.reference?.kcal === 900)
    ok('runs scored against the reference', log?.runs.every((x) => typeof x.refDevPct === 'number'))

    // 3. Saved with an edited number.
    r = await s.api('POST', '/api/chat', { token, body: { message: 'chicken salad', save: false } })
    const third = r.json.analysis
    await waitForRuns(s.api, token, third.id, 7)
    await saveMeal(s.api, token, third, Math.round(third.reconciled.total.kcal * 1.4))
    bench = (await s.api('GET', '/api/model-bench', { token })).json
    log = bench.logs.find((l) => l.id === third.id)
    ok('edited meal -> corrected', log?.outcome === 'corrected' && log.reference?.source === 'edited meal')
    ok('logged value is ~29% under the edit', Math.abs(log?.loggedRefDevPct - -28.6) < 1, `${log?.loggedRefDevPct}`)

    // Summary.
    ok('totals', bench.totals.logs === 3 && bench.totals.corrected === 2 && bench.totals.accepted === 1, JSON.stringify(bench.totals))
    ok('totals: typical spread and A-B gap', typeof bench.totals.medianSpreadPct === 'number' && typeof bench.totals.medianAbPct === 'number', JSON.stringify(bench.totals))
    ok('totals: kcal spread and A-B gap', typeof bench.totals.medianSpreadKcal === 'number' && typeof bench.totals.medianAbKcal === 'number')
    const anyLog = bench.logs.find((l) => l.consensusKcal)
    ok('runs carry kcal gaps', anyLog.runs.every((x) => typeof x.devKcal === 'number' && typeof x.looDevKcal === 'number'))
    ok('kcal gap = kcal - median', anyLog.runs.every((x) => Math.abs(x.devKcal - (x.kcal - anyLog.consensusKcal)) < 0.2))
    ok('log carries spreadKcal', typeof anyLog.spreadKcal === 'number')
    ok('a split needs a kcal gap too', bench.logs.every((l) => !l.differed || l.spreadKcal >= bench.config.differKcal))
    const aStats = bench.models.find((m) => m.role === 'a').consensus
    ok('model stats in kcal', typeof aStats.medianAbsKcal === 'number' && typeof aStats.totalKcal === 'number' && typeof aStats.biasKcal === 'number')
    ok('pair cells carry kcal', typeof bench.pairs.cells[0][1].kcal === 'number')
    const names = bench.models.map((m) => m.model)
    ok('summary has 7 models + logged', bench.models.length === 8 && names.includes('Logged value'), names.join(','))
    ok('summary order: logged, a, b first', bench.models[0].role === 'logged' && bench.models[1].role === 'a' && bench.models[2].role === 'b')
    const a = bench.models.find((m) => m.role === 'a')
    ok('consensus stats for A over 3 logs', a.consensus.n === 3 && typeof a.consensus.medianAbsPct === 'number')
    ok('corrected stats for A over 2 logs', a.corrected.n === 2)
    ok('tiers labelled', bench.models.find((m) => m.model === 'glm-5.3-flash')?.tier === 'small' && bench.models.find((m) => m.model === 'qwen3.8-max')?.tier === 'large')
    ok('pair matrix is 7x7 and symmetric', bench.pairs.cells.length === 7 && bench.pairs.cells[1][3].pct === bench.pairs.cells[3][1].pct)
    ok('days filter', (await s.api('GET', '/api/model-bench?days=0', { token })).status === 200)

    // A failed bench model is recorded as a failure, not dropped.
    r = await s.api('POST', '/api/chat', { token, body: { message: 'mystery #fail-both', save: false } })
    bench = await waitForRuns(s.api, token, r.json.analysis.id, 5)
    log = bench.logs.find((l) => l.id === r.json.analysis.id)
    ok('failed runs kept with an error', log?.runs.filter((x) => x.error).length >= 1, JSON.stringify(log?.runs.map((x) => x.error)))
  } finally {
    await s.stop()
  }

  // Off switch: no bench rows, chat unaffected.
  const off = boot({ AI_BENCH_MODELS: 'off' })
  try {
    await off.ready
    const token = await off.register()
    const r = await off.api('POST', '/api/chat', { token, body: { message: 'toast', save: false } })
    ok('off: chat works', r.status === 200)
    await sleep(300)
    const bench = (await off.api('GET', '/api/model-bench', { token })).json
    ok('off: config disabled', bench.config.enabled === false)
    ok('off: only A and B recorded', bench.logs[0]?.runs.length === 2)

    // Backfill: earlier meals get the panel afterwards, from the CLI.
    await off.api('POST', '/api/chat', { token, body: { message: 'porridge with berries', save: false } })
    const first = await off.api('POST', '/api/chat', { token, body: { message: 'rice bowl', save: false } })
    await off.api('POST', '/api/chat', { token, body: { message: 'actually 300g rice', save: false, reviseAnalysisId: first.json.analysis.id } })
    const cli = (...argv) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'bench', ...argv], { env: { ...process.env, DATA_DIR: off.dataDir, AI_BENCH_MODELS: '', AI_MOCK: '1', OPENCODE_API_KEY: '' }, encoding: 'utf8' })
    let c = cli('backfill')
    ok('backfill: refuses to record mock answers without --mock', c.status !== 0 && /mock/i.test(c.stderr + c.stdout))
    c = cli('backfill', '--dry-run', '--mock')
    ok('backfill: dry run plans 3 meals / 15 calls (corrections skipped)', c.status === 0 && /3 meals, 15 model calls/.test(c.stdout), c.stdout)
    let after = (await off.api('GET', '/api/model-bench', { token })).json
    ok('backfill: dry run writes nothing', after.logs.every((l) => l.runs.length === 2))
    c = cli('backfill', '--mock', '--limit', '1', '--delay', '0')
    ok('backfill: --limit 1 does one meal', c.status === 0 && c.stdout.includes('1/1 meals, 5 answers'), c.stdout + c.stderr)
    c = cli('backfill', '--mock', '--delay', '0')
    ok('backfill: carries on with the rest', c.status === 0 && c.stdout.includes('2/2 meals, 10 answers'), c.stdout + c.stderr)
    after = (await off.api('GET', '/api/model-bench', { token })).json
    ok('backfill: every original meal now has 7 runs', after.logs.length === 3 && after.logs.every((l) => l.runs.length === 7), JSON.stringify(after.logs.map((l) => l.runs.length)))
    ok('backfill: consensus computed', after.logs.every((l) => l.consensusKcal > 0))
    c = cli('backfill', '--mock', '--dry-run')
    ok('backfill: nothing left to do', /0 meals, 0 model calls/.test(c.stdout), c.stdout)
    c = cli('status')
    ok('status: lists panel models', c.status === 0 && c.stdout.includes('kimi-k3') && /0 meals are missing/.test(c.stdout), c.stdout + c.stderr)
  } finally {
    await off.stop()
  }
}

try {
  await run()
} catch (err) {
  fail++
  console.error(err)
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
