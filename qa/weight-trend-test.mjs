#!/usr/bin/env node
/**
 * Unit test for the weight trend maths (src/lib/weightTrend.ts) on synthetic
 * weigh-ins with known answers. Bundles the TypeScript with Vite first.
 *   node qa/weight-trend-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-weight-'))
await build({
  root: ROOT, configFile: false, logLevel: 'silent',
  build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { w: path.join(ROOT, 'src/lib/weightTrend.ts') }, formats: ['es'] } },
})
const W = await import(pathToFileURL(path.join(out, 'w.js')).href)

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (a, b, tol = 0.01) => a !== null && Math.abs(a - b) <= tol
const day = (n) => { const d = new Date(Date.UTC(2026, 0, 1 + n)); return d.toISOString().slice(0, 10) }

// 1. Steady loss of 0.5 kg/week, weighed every day, with ±0.6 kg water noise.
{
  const noise = [0.6, -0.4, 0.2, -0.6, 0.5, -0.1, -0.2]
  const entries = Array.from({ length: 120 }, (_, i) => ({ date: day(i), weightKg: 90 - (0.5 / 7) * i + noise[i % 7] }))
  const end = day(119)
  const t = W.buildTrend(entries, end)
  const fit = W.fitRate(entries, end, 28)
  ok('daily: 28-day fit recovers -0.5 kg/wk', near(fit.kgPerWeek, -0.5, 0.05), `got ${fit?.kgPerWeek}`)
  const c7 = W.trendChange(t, end, 7)
  ok('daily: 7-day trend change ≈ -0.5', near(c7, -0.5, 0.1), `got ${c7}`)
  // An EMA lags a linear trend by (1-α)/α days of slope.
  const lag = ((1 - W.ALPHA) / W.ALPHA) * (0.5 / 7)
  ok('daily: trend sits at true weight + EMA lag', near(W.trendOn(t, end), 90 - (0.5 / 7) * 119 + lag, 0.25), `got ${W.trendOn(t, end)}`)
  const noise60 = W.noiseKg(t, day(60), end)
  // The trend's lag behind the slope is removed, leaving the water swing (mean |noise| ≈ 0.37).
  ok('daily: noise ≈ mean |water swing|, lag removed', near(noise60, 0.37, 0.08), `got ${noise60}`)
  const months = W.monthlyPeriods(entries, t)
  ok('daily: four calendar months', months.length === 4 && months[0].key === '2026-01-01' && months[0].partial, JSON.stringify(months.map((m) => m.key)))
  const feb = months[1]
  ok('daily: February change ≈ -2 kg (28 days × 0.5/7)', near(feb.changeKg, -2, 0.25), `got ${feb.changeKg}`)
  const weeks = W.weeklyPeriods(entries, t)
  ok('daily: weeks start on Monday', weeks.every((w) => new Date(w.key + 'T00:00:00').getDay() === 1))
  // The trend warms up from its seed: early weeks understate, never overstate.
  ok('daily: warm-up weeks understate, never overshoot', weeks.slice(1, 4).every((w) => w.changeKg < 0 && w.changeKg > -0.55))
  const full = weeks.slice(4, -1)
  ok('daily: every week after warm-up ≈ -0.5', full.every((w) => near(w.changeKg, -0.5, 0.15)), JSON.stringify(full.map((w) => w.changeKg?.toFixed(2))))
  const bias = W.weekdayBias(t, end, 120)
  ok('weekday bias: seven days, each with samples', bias.length === 7 && bias.every((b) => b.n >= 15))
  // The noise pattern repeats weekly, so the weekday bias recovers it despite the lag.
  const mean = noise.reduce((x, y) => x + y, 0) / 7
  const wd = (i) => (new Date(day(i) + 'T00:00:00').getDay() + 6) % 7
  const okBias = noise.every((v, i) => near(bias[wd(i)].meanKg, v - mean, 0.08))
  ok('weekday bias: recovers the weekly pattern, centred on zero', okBias, JSON.stringify(bias.map((b) => b.meanKg?.toFixed(2))))
}

// 2. The complaint: one weigh-in in the last week. A 7-day mean would *be* that
//    weigh-in; the trend should barely move.
{
  const entries = []
  for (let i = 0; i < 60; i++) entries.push({ date: day(i), weightKg: 80 })
  entries.push({ date: day(66), weightKg: 82 }) // one salty morning after a gap
  const t = W.buildTrend(entries, day(66))
  const v = W.trendOn(t, day(66))
  ok('single heavy weigh-in moves the trend < 1 kg', v > 80 && v < 81, `got ${v}`)
  ok('interpolated gap days are not weigh-ins', t.byDay.get(day(63)).weightKg === null)
  // After the last weigh-in the trend is held, not extrapolated.
  const t2 = W.buildTrend(entries, day(80))
  ok('trend is held flat after the last weigh-in', near(W.trendOn(t2, day(80)), v, 1e-9) && t2.byDay.get(day(80)).held)
  const weeks = W.weeklyPeriods(entries, t2)
  ok('weeks after the last weigh-in report no change', weeks[weeks.length - 1].changeKg === null)
}

// 3. Sparse weigh-ins: twice a week, gaining 0.25 kg/week.
{
  const entries = []
  for (let i = 0; i < 70; i += 3.5) entries.push({ date: day(Math.round(i)), weightKg: 70 + (0.25 / 7) * Math.round(i) })
  const end = day(69)
  const fit = W.fitRate(entries, end, 28)
  ok('sparse: fit recovers +0.25 kg/wk', near(fit.kgPerWeek, 0.25, 0.02), `got ${fit?.kgPerWeek}`)
  const t = W.buildTrend(entries, end)
  ok('sparse: 30-day trend change ≈ +1.07', near(W.trendChange(t, end, 30), (0.25 / 7) * 30, 0.2), `got ${W.trendChange(t, end, 30)}`)
}

// 4. Rate rules and goal ETA.
{
  ok('fit needs 3 weigh-ins', W.fitRate([{ date: day(0), weightKg: 80 }, { date: day(10), weightKg: 79 }], day(10), 28) === null)
  ok('fit needs a week of span', W.fitRate([0, 1, 2].map((i) => ({ date: day(i), weightKg: 80 - i })), day(2), 28) === null)
  const eta = W.goalEta(80, 75, -0.5, '2026-01-01')
  ok('goal: 5 kg at 0.5/wk is 10 weeks', eta.status === 'on-track' && near(eta.weeks, 10) && eta.day === '2026-03-12', JSON.stringify(eta))
  ok('goal: wrong way', W.goalEta(80, 75, 0.3).status === 'wrong-way')
  ok('goal: flat', W.goalEta(80, 75, 0.01).status === 'flat')
  ok('goal: reached', W.goalEta(75.05, 75, -0.5).status === 'reached')
  ok('kcal: -0.5 kg/wk ≈ -550 kcal/day', near(W.kcalPerDay(-0.5), -550, 1))
}

// 5. Empty and single-entry inputs do not throw.
{
  const t = W.buildTrend([], day(10))
  ok('empty: no trend', t.days.length === 0 && W.trendOn(t, day(10)) === null && W.weeklyPeriods([], t).length === 0)
  const one = [{ date: day(5), weightKg: 77 }]
  const t1 = W.buildTrend(one, day(10))
  ok('single: trend is that weigh-in', W.trendOn(t1, day(10)) === 77 && W.trendOn(t1, day(4)) === null)
}

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
