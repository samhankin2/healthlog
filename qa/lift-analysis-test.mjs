#!/usr/bin/env node
/**
 * Unit test for the lifting analytics (src/lib/liftAnalysis.ts) on synthetic
 * training logs with known answers: a known rate of progress, a known break,
 * a planted sleep effect, a known rest effect. Bundles the TypeScript with Vite.
 *   node qa/lift-analysis-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'healthlog-ana-'))
await build({
  root: ROOT, configFile: false, logLevel: 'silent',
  build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: { lifting: path.join(ROOT, 'src/lib/lifting.ts'), analysis: path.join(ROOT, 'src/lib/liftAnalysis.ts') }, formats: ['es'] } },
})
const L = await import(pathToFileURL(path.join(out, 'lifting.js')).href)
const A = await import(pathToFileURL(path.join(out, 'analysis.js')).href)

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const TODAY = '2026-11-09'
const shift = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10) }
const noise = A.rng(42)
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += noise(); return (s - 3) / Math.sqrt(0.5) }
const ex = (id, name, muscle = 'chest') => ({ id, name, muscle, equipment: 'barbell', incrementKg: null, repMin: null, repMax: null, archived: false })
let sid = 0
/** One session: a single working set of `reps` at a weight that gives `e1rm`. */
const session = (wid, day, exId, e1, reps = 5, extra = {}) => ({ id: `s${sid++}`, exerciseId: exId, weightKg: Math.round((e1 / (1 + reps / 30)) * 4) / 4, reps, rpe: null, kind: 'working', doneAt: `${day}T18:00:00.000Z`, ...extra, _w: wid })
function workoutsFrom(sets) {
  const by = new Map()
  for (const s of sets) {
    const day = s.doneAt.slice(0, 10)
    const w = by.get(s._w) ?? { id: s._w, day, name: 'Push', notes: null, startedAt: `${day}T17:30:00.000Z`, endedAt: `${day}T19:00:00.000Z`, sets: [] }
    const { _w, ...set } = s
    w.sets.push(set)
    by.set(s._w, w)
  }
  return [...by.values()]
}
const bw = () => 80

/* ---------- small stats ---------- */
{
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  const ys = xs.map((x) => 2 * x + 1)
  ys[4] = 100 // one wild point
  const t = A.theilSen(xs, ys)
  ok('theil–sen: ignores an outlier', Math.abs(t.slope - 2) < 1e-9 && Math.abs(t.intercept - 1) < 1e-9, JSON.stringify(t))
  ok('quantile: median of 1..5', A.quantile([5, 1, 3, 2, 4], 0.5) === 3)
  const r1 = A.rng(7); const r2 = A.rng(7)
  ok('rng: seeded and repeatable', r1() === r2() && r1() === r2())
}

/* ---------- trend: known +2 %/month with noise ---------- */
const bench = ex('bench', 'Bench press')
const benchSets = []
for (let i = 0; i < 30; i++) {
  const day = shift(TODAY, -116 + i * 4)
  const e1 = 100 * (1 + (0.02 / 30.44) * (i * 4)) * (1 + 0.012 * gauss())
  benchSets.push(session(`b${i}`, day, 'bench', e1))
}
let workouts = workoutsFrom(benchSets)
let st = L.exerciseStats(bench, workouts, bw)
let t = A.liftTrend(st, bw, TODAY)
ok('trend: recovers +2 %/month', t && Math.abs(t.rate - 2) < 0.6, t && t.rate.toFixed(2))
ok('trend: range contains the truth', t?.ci && t.ci[0] < 2 && t.ci[1] > 2, JSON.stringify(t?.ci))
ok('trend: verdict gaining', t?.verdict === 'gaining', t?.verdict)
ok('trend: noise near the planted 1.2 %', t?.noise > 0.6 && t?.noise < 2.2, t?.noise?.toFixed(2))
ok('trend: projection ahead of today and above now', t?.projection && t.projection.value > t.points[t.points.length - 1].value * 0.98 && t.projection.lo < t.projection.value && t.projection.hi > t.projection.value)
ok('trend: relative strength uses bodyweight', t?.relative > 1.2 && t?.relative < 1.6, t?.relative)
ok('trend: stable between runs (seeded bootstrap)', JSON.stringify(A.liftTrend(st, bw, TODAY).ci) === JSON.stringify(t.ci))

/* ---------- flat lift ---------- */
{
  const sets = Array.from({ length: 20 }, (_, i) => session(`f${i}`, shift(TODAY, -100 + i * 5), 'row', 90 * (1 + 0.01 * gauss())))
  const s = L.exerciseStats(ex('row', 'Row', 'back'), workoutsFrom(sets), bw)
  const tf = A.liftTrend(s, bw, TODAY)
  ok('trend: flat lift is not called gaining or losing', tf && (tf.verdict === 'flat' || tf.verdict === 'unclear'), `${tf?.verdict} ${tf?.rate.toFixed(2)} ${JSON.stringify(tf?.ci)}`)
}

/* ---------- too little data ---------- */
{
  const sets = [0, 3, 6].map((d, i) => session(`n${i}`, shift(TODAY, -d), 'ohp', 60))
  ok('trend: needs 4+ sessions', A.liftTrend(L.exerciseStats(ex('ohp', 'OHP', 'shoulders'), workoutsFrom(sets), bw), bw, TODAY) === null)
}

/* ---------- change point: +4 %/month then flat ---------- */
{
  const pts = []
  for (let i = 0; i < 24; i++) {
    const d = i * 4
    const e1 = d <= 48 ? 100 * (1 + (0.04 / 30.44) * d) : 100 * (1 + (0.04 / 30.44) * 48)
    pts.push({ day: shift('2026-06-01', d), value: e1 * (1 + 0.004 * gauss()) })
  }
  const c = A.changePoint(pts)
  ok('change point: found', Boolean(c))
  ok('change point: near the real break', c && Math.abs((Date.parse(c.day) - Date.parse(shift('2026-06-01', 48))) / 864e5) <= 12, c?.day)
  ok('change point: slowed from ~+4 to ~0', c && c.before > 2.5 && Math.abs(c.after) < 1.5, c && `${c.before.toFixed(1)} → ${c.after.toFixed(1)}`)
  const straight = pts.map((p, i) => ({ day: p.day, value: 100 + i * 0.5 }))
  ok('change point: none on a straight line', A.changePoint(straight) === null)
}

/* ---------- strength index ---------- */
{
  const sets = []
  for (let i = 0; i < 10; i++) {
    const day = shift(TODAY, -90 + i * 10)
    const f = 1 + 0.1 * (i / 9)
    sets.push(session(`i${i}`, day, 'sq', 140 * f), session(`i${i}`, day, 'dl', 180 * f))
  }
  const ws = workoutsFrom(sets)
  const stats = [L.exerciseStats(ex('sq', 'Squat', 'quads'), ws, bw), L.exerciseStats(ex('dl', 'Deadlift', 'back'), ws, bw)]
  const idx = A.strengthIndex(stats, TODAY)
  const last = idx.points[idx.points.length - 1].value
  ok('strength index: starts near 100', Math.abs(idx.points[0].value - 100) < 2, idx.points[0].value.toFixed(1))
  ok('strength index: both lifts +10 % → ~108–110', last > 106 && last < 111, last.toFixed(1))
  ok('strength index: counts both lifts', idx.lifts === 2 && idx.points[idx.points.length - 1].n === 2)
}

/* ---------- session form + a planted sleep effect ---------- */
{
  // Three lifts, 40 sessions. Short-sleep days (< 6.5 h) are 4 % weaker.
  const sets = []
  const days = []
  const shortSleep = new Set()
  for (let i = 0; i < 40; i++) {
    const day = shift(TODAY, -160 + i * 4)
    const short = noise() < 0.5
    if (short) shortSleep.add(day)
    days.push({ day, sleepSeconds: short ? 5.5 * 3600 : 8 * 3600, hrvNight: null, restingHr: null, bbWake: null })
    const k = (short ? 0.96 : 1) * (1 + 0.006 * gauss())
    for (const [id, base] of [['a', 100], ['b', 140], ['c', 60]]) sets.push(session(`p${i}`, day, id, base * (1 + (0.01 / 30) * i * 4) * k))
  }
  const ws = workoutsFrom(sets)
  const stats = [['a', 'A'], ['b', 'B'], ['c', 'C']].map(([id, n]) => L.exerciseStats(ex(id, n), ws, bw))
  const forms = A.sessionForms(stats, ws)
  ok('form: one score per session', forms.length === 40, String(forms.length))
  const shortMean = forms.filter((f) => shortSleep.has(f.day)).reduce((a, f) => a + f.form, 0) / forms.filter((f) => shortSleep.has(f.day)).length
  const longMean = forms.filter((f) => !shortSleep.has(f.day)).reduce((a, f) => a + f.form, 0) / forms.filter((f) => !shortSleep.has(f.day)).length
  ok('form: short-sleep sessions score lower', longMean - shortMean > 2, `${shortMean.toFixed(2)} vs ${longMean.toFixed(2)}`)
  const rep = A.factorReport(forms, ws, { days, intake: [], sleep: [] }, [])
  const sleep = rep.effects.find((e) => e.key === 'sleep')
  ok('factors: sleep effect found and clear', sleep && sleep.clear && sleep.diff > 2 && sleep.diff < 6.5, sleep && `${sleep.diff.toFixed(2)} ${JSON.stringify(sleep.ci)}`)
  ok('factors: labels read sensibly', sleep && /over 5 h 30/.test(sleep.highLabel), sleep?.highLabel)
  const time = rep.effects.find((e) => e.key === 'time')
  ok('factors: no data for time of day (all evening) → not reported', !time)
  ok('factors: missing HRV is skipped, not invented', !rep.effects.some((e) => e.key === 'hrv'))
}

/* ---------- rest ---------- */
{
  const sets = []
  for (let i = 0; i < 6; i++) {
    const day = shift(TODAY, -i * 3)
    const t0 = Date.parse(`${day}T18:00:00Z`)
    const at = (s) => new Date(t0 + s * 1000).toISOString()
    // Short rests (60 s): 10 → 7. Long rests (200 s): 10 → 10.
    sets.push({ ...session(`r${i}`, day, 'bench', 100, 10), doneAt: at(0) }, { ...session(`r${i}`, day, 'bench', 100, 7), doneAt: at(60) })
    sets.push({ ...session(`r${i}`, day, 'row', 90, 10), doneAt: at(600) }, { ...session(`r${i}`, day, 'row', 90, 10), doneAt: at(800) })
  }
  for (const s of sets) s.weightKg = s.exerciseId === 'bench' ? 75 : 67.5
  const rr = A.restReport(workoutsFrom(sets), new Map([['bench', bench], ['row', ex('row', 'Row', 'back')]]))
  const short = rr.buckets.find((b) => b.lo === 0)
  const long = rr.buckets.find((b) => b.lo === 150)
  ok('rest: short rest keeps ~70 % of reps', short?.kept > 65 && short?.kept < 75, String(short?.kept))
  ok('rest: longer rest keeps ~100 %', long?.kept > 95, String(long?.kept))
  ok('rest: typical rest per lift', rr.byLift.find((b) => b.exercise.id === 'bench')?.medianS === 60)
}

/* ---------- routines + consistency ---------- */
{
  const routine = { id: 'r1', name: 'Upper body', position: 0, items: [{ exerciseId: 'inc', alternatives: ['bench'] }, { exerciseId: 'pu', alternatives: [] }, { exerciseId: 'lat', alternatives: [] }] }
  const mk = (i, ids) => ({ id: `u${i}`, day: shift(TODAY, -i * 7), name: 'Upper body', notes: null, startedAt: `${shift(TODAY, -i * 7)}T18:00:00Z`, endedAt: `${shift(TODAY, -i * 7)}T19:00:00Z`, sets: ids.map((id) => ({ id: `${i}${id}`, exerciseId: id, weightKg: 20, reps: 8, rpe: null, kind: 'working', doneAt: null })) })
  const ws = [mk(0, ['inc', 'pu', 'lat']), mk(1, ['bench', 'pu']), mk(2, ['inc', 'pu']), mk(3, ['inc', 'pu', 'lat'])]
  const [use] = A.routineUse([routine], ws)
  ok('routine: completion averages slots done (stand-ins count)', Math.round(use.completion) === 83, use.completion.toFixed(1))
  ok('routine: lateral raise skipped twice', use.slots[2].done === 2)
  ok('routine: swap counted', use.slots[0].swapped === 1 && use.slots[0].done === 4)
  const c = A.consistency(ws, TODAY)
  ok('consistency: 4-week streak', c.weekStreak === 4, String(c.weekStreak))
  ok('consistency: calendar has a day per session', c.calendar.length === 4)
}

/* ---------- composition ---------- */
{
  const exMap = new Map([['bp', ex('bp', 'Bench', 'chest')], ['row', ex('row', 'Row', 'back')], ['sq', ex('sq', 'Squat', 'quads')]])
  const s = (id, reps, extra = {}) => ({ id: `c${sid++}`, exerciseId: id, weightKg: 50, reps, rpe: null, kind: 'working', doneAt: null, ...extra })
  const ws = [{ id: 'c1', day: TODAY, name: null, notes: null, startedAt: null, endedAt: null, sets: [s('bp', 5), s('bp', 8, { rpe: 9 }), s('row', 10), s('sq', 15, { kind: 'failure' }), s('bp', 10, { kind: 'warmup' })] }]
  const comp = A.composition(ws, exMap, shift(TODAY, -27), TODAY)
  ok('composition: warm-ups excluded', comp.sets === 4)
  ok('composition: rep zones', comp.zones.strength === 1 && comp.zones.hypertrophy === 2 && comp.zones.endurance === 1)
  ok('composition: push/pull and upper/lower', comp.push === 2 && comp.pull === 1 && comp.upper === 3 && comp.lower === 1)
  ok('composition: effort share', comp.rpeShare === 25 && comp.failureShare === 25)
  const heat = A.muscleHeat(ws, exMap, TODAY)
  ok('heatmap: only trained muscles, 12 weeks', heat.weeks.length === 12 && heat.rows.map((r) => r.muscle).join() === 'chest,back,quads')
}

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
