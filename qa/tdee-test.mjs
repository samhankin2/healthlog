#!/usr/bin/env node
/**
 * Unit test for computeAdaptiveTdee (server/lib/metrics.js). No server, no network.
 *   node qa/tdee-test.mjs
 */
import { addDays, computeAdaptiveTdee, partialDays } from '../server/lib/metrics.js'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}
const near = (name, a, e, tol) => ok(name, typeof a === 'number' && Math.abs(a - e) <= tol, `expected ~${e}, got ${a}`)

const END = '2026-03-01' // window = 2026-02-01 .. 2026-02-28
const days = (n, fn) => Array.from({ length: n }, (_, i) => fn(addDays(END, -n + i), i))

// Steady loss of 0.5 kg/wk on 2000 kcal → TDEE = 2000 + 0.5/7*7700 = 2550.
const intake = days(28, (day) => ({ day, kcal: 2000 }))
const weights = days(28, (date, i) => ({ date, weightKg: 90 - (0.5 / 7) * i }))
let t = computeAdaptiveTdee(intake, weights, END)
near('steady loss: kcal', t.kcal, 2550, 2)
near('steady loss: slope', t.weightSlopeKgPerWeek, -0.5, 0.01)
ok('steady loss: high confidence', t.confidence === 'high', t.confidence)
ok('window ends the day before', t.windowEnd === '2026-02-28' && t.windowStart === '2026-02-01', `${t.windowStart}..${t.windowEnd}`)

// Today's (partial) log and weigh-in must not count.
t = computeAdaptiveTdee([...intake, { day: END, kcal: 300 }], [...weights, { date: END, weightKg: 70 }], END)
near('today excluded', t.kcal, 2550, 2)

// Unlogged days are missing, not zero.
t = computeAdaptiveTdee(intake.filter((_, i) => i % 3 !== 0), weights, END)
near('gaps ignored, not zeroed', t.avgIntakeKcal, 2000, 0)
ok('gaps lower confidence', t.confidence !== 'high', t.confidence)

// Noise around a flat trend → TDEE ≈ intake.
const noisy = days(28, (date, i) => ({ date, weightKg: 80 + (i % 2 ? 0.6 : -0.6) }))
t = computeAdaptiveTdee(intake, noisy, END)
near('flat noisy trend ≈ intake', t.kcal, 2000, 150)

// Not enough data.
t = computeAdaptiveTdee(intake.slice(0, 10), weights, END)
ok('too few logged days → null', t.kcal === null && /food logging/.test(t.reason ?? ''), t.reason)
t = computeAdaptiveTdee(intake, weights.slice(0, 5), END)
ok('too few weigh-ins → null', t.kcal === null && /weigh-in/.test(t.reason ?? ''), t.reason)
t = computeAdaptiveTdee(intake, weights.slice(20), END)
ok('weigh-ins bunched together → null', t.kcal === null && /spread/.test(t.reason ?? ''), t.reason)
t = computeAdaptiveTdee([], [], END)
ok('empty → null with nulls', t.kcal === null && t.avgIntakeKcal === null && t.loggedDays === 0)

/* ---------- partial days ---------- */
{
  // A real-looking inconsistent log: full days ~1900–2300, and some days where
  // only breakfast (~350) or breakfast + lunch (~900) got logged.
  const full = [2100, 1950, 2250, 2050, 1900, 2300, 2000]
  const log = days(28, (day, i) => ({ day, kcal: i % 4 === 1 ? 350 : i % 7 === 3 ? 900 : full[i % 7] }))
  const flagged = partialDays(log, END)
  const expected = log.filter((d) => d.kcal < 1000).map((d) => d.day)
  ok('partial: every breakfast-only and half day flagged', expected.every((d) => flagged.has(d)), `${[...flagged].length} flagged of ${expected.length}`)
  ok('partial: no full day flagged', log.filter((d) => d.kcal >= 1900).every((d) => !flagged.has(d.day)))

  // The upper-percentile reference holds even when partial days are the majority.
  const mostlyPartial = days(28, (day, i) => ({ day, kcal: i % 3 === 0 ? 2200 : 500 }))
  const mp = partialDays(mostlyPartial, END)
  ok('partial: still detected when most days are partial', mostlyPartial.filter((d) => d.kcal === 500).every((d) => mp.has(d.day)) && mostlyPartial.filter((d) => d.kcal === 2200).every((d) => !mp.has(d.day)))

  // A naturally varying eater is left alone: 1500–2400 is within range.
  const varied = days(28, (day, i) => ({ day, kcal: [1500, 2400, 1800, 2100, 1650, 2300, 1950][i % 7] }))
  ok('partial: normal day-to-day variation is not flagged', partialDays(varied, END).size === 0, [...partialDays(varied, END)].join(','))

  // Too little history to judge, and today, are never flagged.
  ok('partial: under 7 neighbours never flags', partialDays(days(5, (day, i) => ({ day, kcal: i === 2 ? 300 : 2000 })), END).size === 0)
  ok('partial: today is in progress, never flagged', !partialDays([...log, { day: END, kcal: 200 }], END).has(END))

  // TDEE leaves flagged days out: same loss, same true intake → same estimate.
  const marked = log.map((d) => ({ ...d, partial: flagged.has(d.day) }))
  t = computeAdaptiveTdee(marked, weights, END)
  const fullAvg = log.filter((d) => !flagged.has(d.day)).reduce((a, d) => a + d.kcal, 0) / log.filter((d) => !flagged.has(d.day)).length
  near('partial: TDEE averages complete days only', t.avgIntakeKcal, fullAvg, 1)
  ok('partial: TDEE reports how many it left out', t.partialDays === flagged.size && t.loggedDays === 28 - flagged.size, `${t.loggedDays} + ${t.partialDays}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
