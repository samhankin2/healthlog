#!/usr/bin/env node
/**
 * Unit test for the progression engine (src/lib/progression.ts) on realistic
 * training histories. Bundles the TypeScript with Vite into a temp dir first.
 *   node qa/progression-test.mjs        (SHOW=1 also prints sample plans with their reasoning)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-prog-'))
await build({
  root: ROOT, configFile: false, logLevel: 'silent',
  build: {
    outDir: out, emptyOutDir: true, minify: false,
    lib: { entry: { lifting: path.join(ROOT, 'src/lib/lifting.ts'), progression: path.join(ROOT, 'src/lib/progression.ts') }, formats: ['es'] },
  },
})
const L = await import(pathToFileURL(path.join(out, 'lifting.js')).href)
const P = await import(pathToFileURL(path.join(out, 'progression.js')).href)

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

/* ---------- fixtures ---------- */
const day0 = '2026-09-01'
const shift = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const ex = (over = {}) => ({ id: 'ex1', name: 'Bench press', muscle: 'chest', equipment: 'barbell', incrementKg: null, repMin: null, repMax: null, archived: false, ...over })
let n = 0
/** sessions: [[weight, [reps...], rpe?|'F'], ...] one per session, 3 days apart. */
function history(e, sessions, gap = 3) {
  return sessions.map((s, i) => {
    const groups = Array.isArray(s[0]) ? s : [s]
    return {
      id: `w${i}`, day: shift(day0, i * gap), name: null, notes: null, startedAt: null, endedAt: null,
      sets: groups.flatMap(([w, reps, eff]) => reps.map((r) => ({ id: `s${n++}`, exerciseId: e.id, weightKg: w, reps: r, rpe: typeof eff === 'number' ? eff : null, kind: eff === 'F' ? 'failure' : 'working', doneAt: null }))),
    }
  })
}
const noBw = () => null
function plan(e, sessions, { gap = 3, bw = noBw, todayGap } = {}) {
  const ws = history(e, sessions, gap)
  const last = ws[ws.length - 1].day
  const st = L.exerciseStats(e, ws, bw, shift(last, todayGap ?? gap))
  return st.next
}
const show = (t) => (t ? `${t.kind}: ${P.fmtPlan(t, { equipment: 'barbell' })} — ${t.note}` : 'null')

/* ---------- ranges ---------- */
ok('range: barbell compound 5–8', JSON.stringify(P.defaultRange(ex())) === '{"lo":5,"hi":8}')
ok('range: lateral raise is isolation 10–15', P.defaultRange(ex({ name: 'Lateral raise', muscle: 'shoulders', equipment: 'dumbbell' })).lo === 10)
ok('range: dumbbell press 8–12', P.defaultRange(ex({ name: 'Dumbbell bench press', equipment: 'dumbbell' })).lo === 8)
ok('range: user setting wins', plan(ex({ repMin: 3, repMax: 5 }), [[100, [5, 5, 5]]]).range.hi === 5)
{
  // Someone doing 5×5 on a dumbbell lift (default 8–12) gets a range that fits.
  const t = plan(ex({ name: 'Dumbbell row', muscle: 'back', equipment: 'dumbbell' }), [[40, [5, 5, 5]], [40, [5, 5, 5]], [40, [5, 5, 5]]])
  ok('range: adapts to habitual 5s', t.range.lo === 5, JSON.stringify(t.range))
}
{
  // Climbing reps inside the range must not drag the range upward.
  const t = plan(ex(), [[80, [6, 6, 6]], [80, [7, 7, 6]], [80, [8, 8, 7]], [80, [8, 8, 8]]])
  ok('range: no upward drift', t.range.lo === 5 && t.range.hi === 8, JSON.stringify(t.range))
}

/* ---------- add reps ---------- */
{
  const t = plan(ex(), [[80, [6, 6, 5]]])
  ok('reps: below top → same weight, +1 on the weakest set', t.kind === 'reps' && t.weightKg === 80 && t.reps.join() === '6,6,6', show(t))
}
{
  const t = plan(ex(), [[80, [6, 6, 6], 7]])
  ok('reps: RPE 7 (3 in reserve) → load, not reps', t.kind === 'load' && t.weightKg > 80, show(t))
}
{
  const t = plan(ex(), [[80, [6, 6, 6], 8]])
  ok('reps: RPE 8 (2 in reserve) → several reps', t.kind === 'reps' && t.reps.reduce((a, b) => a + b) >= 20, show(t))
}
{
  const t = plan(ex(), [[80, [6, 6, 6], 'F']])
  ok('reps: to failure → just one more rep', t.kind === 'reps' && t.reps.reduce((a, b) => a + b) === 19, show(t))
}

/* ---------- add weight ---------- */
{
  const t = plan(ex(), [[75, [8, 8, 8]], [80, [8, 8, 8]]])
  ok('load: all at top of 5–8 → +2.5 kg, reps from the estimate', t.kind === 'load' && t.weightKg === 82.5 && t.reps.join() === '6,6,6', show(t))
}
{
  const t = plan(ex(), [[80, [8, 8, 8], 6]])
  ok('load: top of range at RPE 6 → bigger jump', t.kind === 'load' && t.weightKg >= 85 && t.weightKg <= 88, show(t))
  ok('load: bigger jump stays inside the range', Math.min(...t.reps) >= 5, show(t))
}
{
  // 10 kg dumbbell lateral raise, 2 kg step = +20 %: 15 reps predict far fewer at 12.
  const lat = ex({ name: 'Lateral raise', muscle: 'shoulders', equipment: 'dumbbell' })
  const t = plan(lat, [[10, [15, 15, 15]]])
  ok('load: big relative step on a light dumbbell is flagged', t.kind === 'load' ? /big step|fewer/i.test(t.note + t.why.join(' ')) : /big jump/i.test(t.note), show(t))
}
{
  const t = plan(ex(), [[[100, [5]], [85, [8, 8]]], [[100, [8]], [85, [8, 8]]]])
  ok('load: back-off sets scale with the top set', t.sets.length === 3 && t.sets[0].weightKg === 102.5 && t.sets[1].weightKg > 85 && t.sets[1].reps === 8, JSON.stringify(t.sets))
}

/* ---------- too heavy ---------- */
{
  const t = plan(ex(), [[100, [3, 3, 2], 'F']])
  ok('lighter: below range at failure → ~90 kg for 5–6', t.kind === 'lighter' && t.weightKg === 90 && t.reps[0] === 6, show(t))
}

/* ---------- off day vs plateau ---------- */
{
  const t = plan(ex(), [[80, [6, 6, 6]], [80, [7, 7, 6]], [80, [5, 5, 4]]])
  ok('repeat: one bad session → repeat, no reset', t.kind === 'repeat' && t.weightKg === 80, show(t))
}
{
  const t = plan(ex(), [[80, [8, 8, 8]], [82.5, [6, 6, 6]], [82.5, [6, 6, 5]], [82.5, [6, 5, 5]], [82.5, [6, 6, 5]]])
  ok('reset: 3 sessions without a best → ~10 % lighter', t.kind === 'reset' && t.weightKg <= 75 && t.weightKg >= 72.5, show(t))
}
{
  // Stalled at 82.5, reset to 75, climbed back to 82.5, stalled again → change range.
  const t = plan(ex(), [
    [82.5, [6, 6, 6]], [82.5, [6, 6, 5]], [82.5, [6, 5, 5]], [82.5, [6, 6, 5]],
    [75, [8, 8, 8]], [77.5, [8, 8, 7]], [80, [7, 7, 7]], [82.5, [6, 6, 6]], [82.5, [6, 6, 5]], [82.5, [6, 6, 5]], [82.5, [6, 5, 5]],
  ])
  ok('range: second plateau after a reset → new rep range', t.kind === 'range' && t.suggestRange?.lo === 8, show(t))
  ok('range: weight lowered for the higher reps', t.weightKg < 82.5 && t.reps[0] >= 8, show(t))
}
{
  // A reset must not trigger another reset while you climb back.
  const t = plan(ex(), [[82.5, [6, 6, 6]], [82.5, [6, 6, 5]], [82.5, [6, 5, 5]], [82.5, [6, 6, 5]], [75, [6, 6, 6]], [75, [7, 7, 6]], [75, [8, 7, 7]]])
  ok('reset: climbing back after a reset is progress, not a plateau', t.kind === 'reps' || t.kind === 'load', show(t))
}

/* ---------- time off ---------- */
{
  const t = plan(ex(), [[80, [8, 8, 8]]], { todayGap: 14 })
  ok('time off: two weeks → repeat', t.kind === 'repeat' && t.weightKg === 80, show(t))
}
{
  const t = plan(ex(), [[100, [5, 5, 5]]], { todayGap: 35 })
  ok('time off: five weeks → about 90 %', t.kind === 'return' && t.weightKg === 90, show(t))
}

/* ---------- bodyweight ---------- */
{
  const pu = ex({ name: 'Pull-up', muscle: 'back', equipment: 'bodyweight' })
  const t = plan(pu, [[0, [8, 7, 6]]])
  ok('bodyweight: no weigh-ins → reps progression', t.kind === 'reps' && t.weightKg === 0 && t.reps.join() === '8,7,7', show(t))
  const t2 = plan(pu, [[0, [12, 12, 12]]])
  ok('bodyweight: top of range → add load', t2.kind === 'load' && t2.weightKg === 2.5, show(t2))
  const t3 = plan(pu, [[10, [12, 12, 12]]], { bw: () => 80 })
  ok('bodyweight + weigh-ins: jump uses total load', t3.kind === 'load' && t3.weightKg === 12.5 && t3.reps[0] >= 10, show(t3))
}

/* ---------- mid-session ---------- */
{
  const e = ex()
  const t = plan(e, [[75, [8, 8, 8]], [80, [8, 8, 8]]])
  const set = (w, r, rpe = null, kind = 'working') => ({ id: `x${n++}`, exerciseId: e.id, weightKg: w, reps: r, rpe, kind, doneAt: null })
  const range = t.range
  const first = P.nextSet(e, t, [], range)
  ok('next set: first set is the plan', first.weightKg === 82.5 && first.reps === 6 && first.note === null)
  const short = P.nextSet(e, t, [set(82.5, 3, 10)], range)
  ok('next set: short of range at RPE 10 → drop weight', short.weightKg < 82.5 && /drop/i.test(short.note), JSON.stringify(short))
  const meh = P.nextSet(e, t, [set(82.5, 4)], range)
  ok('next set: 2 short of plan → match what you did', meh.weightKg === 82.5 && meh.reps === 4, JSON.stringify(meh))
  const easy = P.nextSet(e, t, [set(82.5, 6, 6)], range)
  ok('next set: very easy → offer more weight', easy.weightKg === 85 && /easy/i.test(easy.note), JSON.stringify(easy))
  const fine = P.nextSet(e, t, [set(82.5, 6, 8)], range)
  ok('next set: on plan → keep going', fine.weightKg === 82.5 && fine.reps === 6 && fine.note === null, JSON.stringify(fine))
}

/* ---------- deload ---------- */
{
  const today = '2026-10-01'
  const mk = (name, status) => ({ exercise: ex({ name }), status, lastDay: '2026-09-28', sessions: [1, 2, 3, 4] })
  ok('deload: 3 of 5 stuck → suggest', P.deloadAdvice([mk('a', 'stalled'), mk('b', 'regressing'), mk('c', 'stalled'), mk('d', 'progressing'), mk('e', 'steady')], today)?.stuck.length === 3)
  ok('deload: 1 of 5 stuck → no', P.deloadAdvice([mk('a', 'stalled'), mk('b', 'progressing'), mk('c', 'steady'), mk('d', 'progressing'), mk('e', 'steady')], today) === null)
}

/* ---------- every plan explains itself ---------- */
{
  const t = plan(ex(), [[80, [6, 6, 5]]])
  ok('why: reasoning attached', t.why.length >= 2 && t.why[0].includes('5–8'))
}

if (process.env.SHOW) for (const [label, e, h, o] of [
  ["rpe8", ex(), [[80, [6, 6, 6], 8]]], ["rpe6", ex(), [[80, [8, 8, 8], 6]]], ["lat", ex({ name: "Lateral raise", muscle: "shoulders", equipment: "dumbbell" }), [[10, [15, 15, 15]]]],
  ["lat12", ex({ name: "Lateral raise", muscle: "shoulders", equipment: "dumbbell" }), [[12, [15, 15, 15]]]], ["fail", ex(), [[100, [3, 3, 2], "F"]]],
  ["reset", ex(), [[80, [8, 8, 8]], [82.5, [6, 6, 6]], [82.5, [6, 6, 5]], [82.5, [6, 5, 5]], [82.5, [6, 6, 5]]]], ["fatigue", ex(), [[80, [8, 6, 4]]]], ["pu", ex({ name: "Pull-up", muscle: "back", equipment: "bodyweight" }), [[10, [12, 12, 12]]], { bw: () => 80 }],
]) { const t = plan(e, h, o); console.log(label, show(t)); console.log("   ", t.why.join(' | ')) }
fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
