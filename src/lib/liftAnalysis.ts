/**
 * Lifting analytics: the numbers behind `#/lifting/analysis`. Pure and
 * framework-agnostic (SPEC §6 "Lifting — analysis").
 *
 * Methods, and why:
 * - Trend per lift: Theil–Sen slope (the median of all pairwise slopes) on
 *   each session's best estimated max, over the last 120 days. It ignores the
 *   odd terrible or brilliant day, which an ordinary regression chases. Rate =
 *   slope × 30.4 days ÷ the median level, in % per month. The 90 % range comes
 *   from 400 bootstrap resamples (seeded, so the numbers don't jitter between
 *   renders).
 * - Noise: 1.4826 × the median absolute deviation of each session from the
 *   trend, in %. A change smaller than this is ordinary day-to-day swing.
 * - Change point: one break in a piecewise linear fit, kept only if the
 *   Bayesian information criterion (BIC) improves by more than 2 and the rate
 *   changes by at least 1 %/month.
 * - Strength index: each lift's recent level (the mean of its last 2 sessions,
 *   carried for at most 8 weeks) ÷ its own starting level (the median of its
 *   first 3), combined across lifts as a geometric mean, × 100. Lifts of any
 *   size count equally.
 * - Session form: each session's best vs the lift's expected level that day,
 *   from a local linear fit that leaves the session out (tricube weights,
 *   ±56 days), clipped to ±25 %. A workout's form is the mean over its lifts.
 *   Factors are split at the median (or a stated threshold) and compared as a
 *   difference in mean form, with a bootstrap 90 % range. This is correlation
 *   only, and every factor needs at least 5 sessions on each side.
 * - Rest: the time between consecutive working sets of one exercise (from the
 *   log times, so it includes doing the set) vs the share of reps kept on the
 *   next set at the same weight.
 */
import type { Exercise, InsightsPayload, Muscle, Routine, Workout } from './types'
import { dayNum, isNum, shiftDay, weekStart } from './insights'
import { MUSCLES, isHard, sortWorkouts, type BodyweightAt, type ExerciseStats } from './lifting'

/* ------------------------------------------------------------------ */
/* small statistics                                                    */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) so bootstrap ranges are stable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return NaN
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo)
}

const meanOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Theil–Sen: median pairwise slope, intercept = median(y − b·x). */
export function theilSen(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const slopes: number[] = []
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (xs[j] !== xs[i]) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]))
  if (!slopes.length) return null
  const slope = quantile(slopes, 0.5)
  return { slope, intercept: quantile(ys.map((y, i) => y - slope * xs[i]), 0.5) }
}

function ols(xs: number[], ys: number[]): { slope: number; intercept: number; sse: number } | null {
  const n = xs.length
  if (n < 2) return null
  const mx = meanOf(xs)
  const my = meanOf(ys)
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
  if (!sxx) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  let sse = 0
  for (let i = 0; i < n; i++) sse += (ys[i] - intercept - slope * xs[i]) ** 2
  return { slope, intercept, sse }
}

/** Bootstrap 90 % range of a statistic over resampled indices. */
function bootstrap(n: number, stat: (idx: number[]) => number | null, seed: number, iters = 400): [number, number] | null {
  const r = rng(seed)
  const out: number[] = []
  for (let k = 0; k < iters; k++) {
    const idx = Array.from({ length: n }, () => Math.floor(r() * n))
    const v = stat(idx)
    if (isNum(v)) out.push(v)
  }
  return out.length >= iters / 2 ? [quantile(out, 0.05), quantile(out, 0.95)] : null
}

/** Weighted local linear fit at x0 (tricube within ±h), leaving out index `skip`. */
function localFit(xs: number[], ys: number[], x0: number, h: number, skip: number): number | null {
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, used = 0
  for (let i = 0; i < xs.length; i++) {
    if (i === skip) continue
    const d = Math.abs(xs[i] - x0) / h
    if (d >= 1) continue
    const w = (1 - d ** 3) ** 3
    sw += w; sx += w * xs[i]; sy += w * ys[i]; sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ys[i]; used++
  }
  if (used < 3 || sw <= 0) return null
  const mx = sx / sw
  const my = sy / sw
  const vx = sxx / sw - mx * mx
  if (vx < 1) return my // all on (nearly) one day: use the mean
  const slope = (sxy / sw - mx * my) / vx
  return my + slope * (x0 - mx)
}

const strHash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

/* ------------------------------------------------------------------ */
/* trend per lift                                                      */
/* ------------------------------------------------------------------ */

export type Verdict = 'gaining' | 'losing' | 'flat' | 'unclear'
export const VERDICT_LABEL: Record<Verdict, string> = { gaining: 'Gaining', losing: 'Losing', flat: 'Flat', unclear: 'Not clear yet' }

export interface LiftTrend {
  exercise: Exercise
  unit: 'kg' | 'reps'
  points: { day: string; value: number }[]
  /** Trend line over the window (one point per session day). */
  fit: { day: string; value: number }[]
  /** % per month and its 90 % range. */
  rate: number
  ci: [number, number] | null
  verdict: Verdict
  /** Typical session-to-session swing around the trend, %. */
  noise: number | null
  /** 8 weeks ahead if the trend holds. */
  projection: { day: string; value: number; lo: number; hi: number } | null
  change: { day: string; before: number; after: number } | null
  /** Latest level ÷ bodyweight. */
  relative: number | null
  windowFrom: string
  sessions: number
}

const WINDOW_DAYS = 120
const MONTH = 30.44

export function liftTrend(st: ExerciseStats, bw: BodyweightAt, today: string): LiftTrend | null {
  const pts = st.sessions.filter((s) => isNum(s.best)).map((s) => ({ day: s.day, value: s.best as number }))
  if (pts.length < 4) return null
  const lastDay = pts[pts.length - 1].day
  let win = pts.filter((p) => dayNum(p.day) > dayNum(lastDay) - WINDOW_DAYS)
  if (win.length < 4) win = pts.slice(-4)
  const x0 = dayNum(win[0].day)
  const xs = win.map((p) => dayNum(p.day) - x0)
  const ys = win.map((p) => p.value)
  if (xs[xs.length - 1] < 14) return null
  const ts = theilSen(xs, ys)
  if (!ts) return null
  const level = quantile(ys, 0.5)
  const toRate = (slope: number): number => ((slope * MONTH) / level) * 100
  const rate = toRate(ts.slope)
  const seed = strHash(st.exercise.id)
  const ci = win.length >= 5 ? bootstrap(win.length, (idx) => {
    const t = theilSen(idx.map((i) => xs[i]), idx.map((i) => ys[i]))
    return t ? toRate(t.slope) : null
  }, seed) : null
  const fitAt = (x: number): number => ts.intercept + ts.slope * x
  const resid = win.map((p, i) => ((p.value - fitAt(xs[i])) / fitAt(xs[i])) * 100)
  const mad = quantile(resid.map((r) => Math.abs(r - quantile(resid, 0.5))), 0.5)
  const noise = win.length >= 5 ? 1.4826 * mad : null

  let verdict: Verdict = 'unclear'
  if (ci && ci[0] > 0) verdict = 'gaining'
  else if (ci && ci[1] < 0) verdict = 'losing'
  else if (ci && Math.abs(rate) < 0.75 && ci[0] > -2 && ci[1] < 2) verdict = 'flat'

  // Projection from the last fitted level, compounding the rate and its range alike.
  const ahead = 56
  const fitLast = fitAt(xs[xs.length - 1])
  const months = (dayNum(today) + ahead - dayNum(lastDay)) / MONTH
  const projection = ci && dayNum(today) - dayNum(lastDay) <= 21 && win.length >= 6
    ? { day: shiftDay(today, ahead), value: fitLast * (1 + (rate / 100) * months), lo: fitLast * (1 + (ci[0] / 100) * months), hi: fitLast * (1 + (ci[1] / 100) * months) }
    : null

  const b = bw(lastDay)
  const relative = st.metric === 'e1rm' && b ? pts[pts.length - 1].value / b : null

  return {
    exercise: st.exercise, unit: st.metric === 'reps' ? 'reps' : 'kg', points: pts,
    fit: win.map((p, i) => ({ day: p.day, value: fitAt(xs[i]) })),
    rate, ci, verdict, noise, projection, change: changePoint(pts), relative, windowFrom: win[0].day, sessions: pts.length,
  }
}

/** One break in the trend, if the data clearly support it (BIC). */
export function changePoint(pts: { day: string; value: number }[]): LiftTrend['change'] {
  if (pts.length < 8) return null
  const x0 = dayNum(pts[0].day)
  const xs = pts.map((p) => dayNum(p.day) - x0)
  const ys = pts.map((p) => p.value)
  const n = pts.length
  const one = ols(xs, ys)
  if (!one) return null
  const bic = (sse: number, k: number): number => n * Math.log(Math.max(sse, 1e-9) / n) + k * Math.log(n)
  let best: { k: number; sse: number; a: NonNullable<ReturnType<typeof ols>>; b: NonNullable<ReturnType<typeof ols>> } | null = null
  for (let k = 3; k <= n - 3; k++) {
    const a = ols(xs.slice(0, k), ys.slice(0, k))
    const b = ols(xs.slice(k), ys.slice(k))
    if (!a || !b) continue
    if (!best || a.sse + b.sse < best.sse) best = { k, sse: a.sse + b.sse, a, b }
  }
  if (!best || bic(one.sse, 2) - bic(best.sse, 5) <= 2) return null
  const level = quantile(ys, 0.5)
  const before = ((best.a.slope * MONTH) / level) * 100
  const after = ((best.b.slope * MONTH) / level) * 100
  if (Math.abs(after - before) < 1) return null
  return { day: pts[best.k].day, before, after }
}

/* ------------------------------------------------------------------ */
/* strength index                                                      */
/* ------------------------------------------------------------------ */

export interface StrengthIndex {
  points: { day: string; value: number; n: number }[]
  /** Change over the last 12 weeks, or since the first week when there is less history. */
  change12w: number | null
  sinceStart: boolean
  lifts: number
}

export function strengthIndex(stats: ExerciseStats[], today: string): StrengthIndex | null {
  const lifts = stats.filter((s) => s.metric === 'e1rm' && s.sessions.filter((x) => isNum(x.best)).length >= 3)
  if (!lifts.length) return null
  const series = lifts.map((s) => {
    const pts = s.sessions.filter((x) => isNum(x.best)).map((x) => ({ day: x.day, v: x.best as number }))
    const base = quantile(pts.slice(0, 3).map((p) => p.v), 0.5)
    return { pts, base }
  })
  const first = series.map((s) => s.pts[0].day).sort()[0]
  const out: StrengthIndex['points'] = []
  for (let wk = weekStart(first); wk <= today; wk = shiftDay(wk, 7)) {
    const end = shiftDay(wk, 6)
    const logs: number[] = []
    for (const s of series) {
      const upto = s.pts.filter((p) => p.day <= end)
      if (!upto.length) continue
      const last = upto[upto.length - 1]
      if (dayNum(end) - dayNum(last.day) > 56) continue
      const recent = upto.slice(-2).map((p) => p.v)
      logs.push(Math.log(meanOf(recent) / s.base))
    }
    if (logs.length) out.push({ day: wk, value: Math.exp(meanOf(logs)) * 100, n: logs.length })
  }
  if (!out.length) return null
  const last = out[out.length - 1]
  const then = out.filter((p) => p.day <= shiftDay(last.day, -84))
  const ref = then.length ? then[then.length - 1] : out[0]
  const change12w = out.length >= 2 ? ((last.value / ref.value) - 1) * 100 : null
  return { points: out, change12w, sinceStart: !then.length, lifts: lifts.length }
}

/* ------------------------------------------------------------------ */
/* session form and what moves it                                      */
/* ------------------------------------------------------------------ */

export interface SessionForm { workoutId: string; day: string; form: number; lifts: number; hour: number | null }

/** Each workout's mean deviation from the expected level of its lifts, %. */
export function sessionForms(stats: ExerciseStats[], workouts: Workout[]): SessionForm[] {
  const byWorkout = new Map<string, number[]>()
  for (const st of stats) {
    const pts = st.sessions.filter((s) => isNum(s.best))
    if (pts.length < 5) continue
    const xs = pts.map((s) => dayNum(s.day))
    const ys = pts.map((s) => s.best as number)
    pts.forEach((s, i) => {
      const exp = localFit(xs, ys, xs[i], 56, i)
      if (!isNum(exp) || exp <= 0) return
      const r = Math.max(-25, Math.min(25, (ys[i] / exp - 1) * 100))
      const list = byWorkout.get(s.workoutId) ?? []
      list.push(r)
      byWorkout.set(s.workoutId, list)
    })
  }
  const wMap = new Map(workouts.map((w) => [w.id, w]))
  const out: SessionForm[] = []
  for (const [id, rs] of byWorkout) {
    const w = wMap.get(id)
    if (!w) continue
    const started = w.startedAt ? new Date(w.startedAt) : null
    out.push({ workoutId: id, day: w.day, form: meanOf(rs), lifts: rs.length, hour: started && !Number.isNaN(started.getTime()) ? started.getHours() + started.getMinutes() / 60 : null })
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : 1))
}

export interface FactorEffect {
  key: string
  /** "More sleep the night before". */
  label: string
  /** "≥ 7 h 20 m" vs "less". */
  highLabel: string
  lowLabel: string
  nHigh: number
  nLow: number
  /** Mean form (high) − mean form (low), percentage points. */
  diff: number
  ci: [number, number] | null
  clear: boolean
}

export interface FactorReport { effects: FactorEffect[]; waiting: { label: string; have: number }[]; sessions: number }

const MIN_GROUP = 5

interface FactorDef { key: string; label: string; value: (s: SessionForm) => number | null; split?: number; fmt: (v: number) => string; highWord?: string; lowWord?: string }

const fmtHm = (s: number): string => `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
const signed = (v: number, d = 0): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`

/** The baseline of a daily metric before a day: median of the 28 days before. */
function baselineBefore(map: Map<string, number>, day: string): number | null {
  const vals: number[] = []
  for (let i = 1; i <= 28; i++) { const v = map.get(shiftDay(day, -i)); if (isNum(v)) vals.push(v) }
  return vals.length >= 7 ? quantile(vals, 0.5) : null
}

export function factorReport(forms: SessionForm[], workouts: Workout[], data: InsightsPayload | null, weights: { day: string; weightKg: number }[]): FactorReport {
  const days = new Map((data?.days ?? []).map((d) => [d.day, d]))
  const metric = (k: 'sleepSeconds' | 'hrvNight' | 'restingHr' | 'bbWake'): Map<string, number> => {
    const m = new Map<string, number>()
    for (const d of data?.days ?? []) { const v = d[k]; if (isNum(v)) m.set(d.day, v) }
    return m
  }
  const hrv = metric('hrvNight')
  const rhr = metric('restingHr')
  const intake = new Map((data?.intake ?? []).filter((r) => r.kcal > 0).map((r) => [r.day, r]))
  const avgIntake = (day: string, k: 'kcal' | 'proteinG'): number | null => {
    const v = [1, 2, 3].map((i) => intake.get(shiftDay(day, -i))?.[k]).filter(isNum)
    return v.length >= 2 ? meanOf(v) : null
  }
  const ws = [...weights].sort((a, b) => (a.day < b.day ? -1 : 1))
  const weightSlope = (day: string): number | null => {
    const win = ws.filter((w) => w.day <= day && dayNum(day) - dayNum(w.day) <= 21)
    if (win.length < 4) return null
    const x0 = dayNum(win[0].day)
    const t = theilSen(win.map((w) => dayNum(w.day) - x0), win.map((w) => w.weightKg))
    return t ? t.slope * 7 : null
  }
  const done = sortWorkouts(workouts.filter((w) => w.sets.some(isHard)))
  const gapBefore = (s: SessionForm): number | null => {
    const prev = done.filter((w) => w.day < s.day)
    return prev.length ? dayNum(s.day) - dayNum(prev[prev.length - 1].day) : null
  }

  const defs: FactorDef[] = [
    { key: 'sleep', label: 'Sleep the night before', value: (s) => days.get(s.day)?.sleepSeconds ?? null, fmt: fmtHm },
    { key: 'hrv', label: 'Overnight HRV vs your usual', value: (s) => { const v = hrv.get(s.day); const b = baselineBefore(hrv, s.day); return isNum(v) && isNum(b) ? v - b : null }, split: 0, fmt: (v) => `${signed(v)} ms`, highWord: 'above usual', lowWord: 'below usual' },
    { key: 'rhr', label: 'Resting heart rate vs your usual', value: (s) => { const v = rhr.get(s.day); const b = baselineBefore(rhr, s.day); return isNum(v) && isNum(b) ? v - b : null }, split: 0.5, fmt: (v) => `${signed(v)} bpm`, highWord: 'raised', lowWord: 'normal or lower' },
    { key: 'bb', label: 'Body Battery at wake', value: (s) => days.get(s.day)?.bbWake ?? null, fmt: (v) => String(Math.round(v)) },
    { key: 'kcal', label: 'Calories over the 3 days before', value: (s) => avgIntake(s.day, 'kcal'), fmt: (v) => `${Math.round(v)} kcal` },
    { key: 'protein', label: 'Protein over the 3 days before', value: (s) => avgIntake(s.day, 'proteinG'), fmt: (v) => `${Math.round(v)} g` },
    { key: 'cut', label: 'Losing weight (last 3 weeks)', value: (s) => weightSlope(s.day), split: -0.2, fmt: (v) => `${v.toFixed(1)} kg/wk`, highWord: 'stable or gaining', lowWord: 'losing 0.2+ kg/wk' },
    { key: 'time', label: 'Time of day', value: (s) => s.hour, split: 12, fmt: (v) => `${Math.floor(v)}:00`, highWord: 'afternoon or evening', lowWord: 'morning' },
    { key: 'rest', label: 'Days since your last session', value: gapBefore, split: 1.5, fmt: (v) => `${v}`, highWord: '2+ days', lowWord: 'the next day' },
  ]

  const effects: FactorEffect[] = []
  const waiting: FactorReport['waiting'] = []
  for (const d of defs) {
    const rows = forms.map((s) => ({ x: d.value(s), y: s.form })).filter((r): r is { x: number; y: number } => isNum(r.x))
    if (!rows.length) continue
    // Fixed thresholds where they mean something; else the most even split
    // (a plain median can put every tied value on one side).
    let split = d.split
    if (split === undefined) {
      const vals = [...new Set(rows.map((r) => r.x))].sort((a, b) => a - b).slice(0, -1)
      let bestGap = Infinity
      for (const v of vals) {
        const gap = Math.abs(rows.filter((r) => r.x <= v).length * 2 - rows.length)
        if (gap < bestGap) { bestGap = gap; split = v }
      }
      if (split === undefined) { waiting.push({ label: d.label, have: 0 }); continue }
    }
    const hi = rows.filter((r) => r.x > split).map((r) => r.y)
    const lo = rows.filter((r) => r.x <= split).map((r) => r.y)
    if (hi.length < MIN_GROUP || lo.length < MIN_GROUP) { waiting.push({ label: d.label, have: Math.min(hi.length, lo.length) }); continue }
    const diff = meanOf(hi) - meanOf(lo)
    const r = rng(strHash(d.key))
    const boots: number[] = []
    for (let k = 0; k < 400; k++) {
      const h = Array.from({ length: hi.length }, () => hi[Math.floor(r() * hi.length)])
      const l = Array.from({ length: lo.length }, () => lo[Math.floor(r() * lo.length)])
      boots.push(meanOf(h) - meanOf(l))
    }
    const ci: [number, number] = [quantile(boots, 0.05), quantile(boots, 0.95)]
    effects.push({
      key: d.key, label: d.label,
      highLabel: d.highWord ?? `over ${d.fmt(split)}`, lowLabel: d.lowWord ?? `${d.fmt(split)} or less`,
      nHigh: hi.length, nLow: lo.length, diff, ci, clear: ci[0] > 0 || ci[1] < 0,
    })
  }
  effects.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  return { effects, waiting, sessions: forms.length }
}

/* ------------------------------------------------------------------ */
/* rest between sets                                                   */
/* ------------------------------------------------------------------ */

export interface RestBucket { label: string; lo: number; hi: number; kept: number | null; n: number }
export interface RestReport { buckets: RestBucket[]; byLift: { exercise: Exercise; medianS: number; n: number }[]; pairs: number }

const REST_BUCKETS: [string, number, number][] = [['Under 1:30', 0, 90], ['1:30–2:30', 90, 150], ['2:30–4:00', 150, 240], ['Over 4:00', 240, 901]]

export function restReport(workouts: Workout[], exMap: Map<string, Exercise>): RestReport {
  const kept: { rest: number; ratio: number }[] = []
  const perLift = new Map<string, number[]>()
  for (const w of workouts) {
    const byEx = new Map<string, typeof w.sets>()
    for (const s of w.sets) if ((s.kind === 'working' || s.kind === 'failure') && s.doneAt) byEx.set(s.exerciseId, [...(byEx.get(s.exerciseId) ?? []), s])
    for (const [exId, sets] of byEx) {
      const sorted = [...sets].sort((a, b) => (a.doneAt! < b.doneAt! ? -1 : 1))
      for (let i = 1; i < sorted.length; i++) {
        const rest = (Date.parse(sorted[i].doneAt!) - Date.parse(sorted[i - 1].doneAt!)) / 1000
        if (!(rest >= 20 && rest <= 900)) continue
        perLift.set(exId, [...(perLift.get(exId) ?? []), rest])
        if (Math.abs(sorted[i].weightKg - sorted[i - 1].weightKg) < 1e-6 && sorted[i - 1].reps > 0) kept.push({ rest, ratio: sorted[i].reps / sorted[i - 1].reps })
      }
    }
  }
  const buckets = REST_BUCKETS.map(([label, lo, hi]) => {
    const g = kept.filter((k) => k.rest >= lo && k.rest < hi).map((k) => Math.min(1.5, k.ratio))
    return { label, lo, hi, kept: g.length >= 3 ? meanOf(g) * 100 : null, n: g.length }
  })
  const byLift = [...perLift].map(([id, rs]) => ({ exercise: exMap.get(id)!, medianS: quantile(rs, 0.5), n: rs.length }))
    .filter((r) => r.exercise && r.n >= 3).sort((a, b) => b.n - a.n)
  return { buckets, byLift, pairs: kept.length }
}

/* ------------------------------------------------------------------ */
/* consistency and routines                                            */
/* ------------------------------------------------------------------ */

export interface Consistency {
  weeks: { week: string; sessions: number }[]
  perWeek8: number
  weekStreak: number
  activeWeeksPct: number
  calendar: { day: string; value: number; detail: string }[]
}

export function consistency(workouts: Workout[], today: string, weeksBack = 26): Consistency {
  const done = workouts.filter((w) => w.sets.some(isHard))
  const startWk = shiftDay(weekStart(today), -7 * (weeksBack - 1))
  const weeks: Consistency['weeks'] = []
  for (let wk = startWk; wk <= today; wk = shiftDay(wk, 7)) weeks.push({ week: wk, sessions: done.filter((w) => w.day >= wk && w.day <= shiftDay(wk, 6)).length })
  const firstDay = done.map((w) => w.day).sort()[0] ?? today
  const relevant = weeks.filter((w) => shiftDay(w.week, 6) >= firstDay)
  const last8 = relevant.slice(-8)
  let streak = 0
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (weeks[i].sessions > 0) streak++
    else if (i === weeks.length - 1) continue // this week may not have started yet
    else break
  }
  const perDay = new Map<string, { sets: number; names: string[] }>()
  for (const w of done) {
    const d = perDay.get(w.day) ?? { sets: 0, names: [] }
    d.sets += w.sets.filter(isHard).length
    d.names.push(w.name || 'Workout')
    perDay.set(w.day, d)
  }
  return {
    weeks, perWeek8: last8.length ? meanOf(last8.map((w) => w.sessions)) : 0, weekStreak: streak,
    activeWeeksPct: relevant.length ? (relevant.filter((w) => w.sessions > 0).length / relevant.length) * 100 : 0,
    calendar: [...perDay].map(([day, d]) => ({ day, value: d.sets, detail: `${d.names.join(', ')} · ${d.sets} sets` })),
  }
}

export interface RoutineUse {
  routine: Routine
  sessions: number
  /** Mean share of the routine's slots done, %. */
  completion: number
  /** Per slot: how often it was done, and how often via a stand-in. */
  slots: { exerciseId: string; done: number; swapped: number }[]
}

/** How fully each routine gets done, from workouts that carry its name. */
export function routineUse(routines: Routine[], workouts: Workout[], last = 12): RoutineUse[] {
  const out: RoutineUse[] = []
  for (const r of routines) {
    const ws = sortWorkouts(workouts.filter((w) => w.endedAt && w.name === r.name && w.sets.some(isHard))).slice(-last)
    if (!ws.length) continue
    const slots = r.items.map((it) => ({ exerciseId: it.exerciseId, done: 0, swapped: 0 }))
    let total = 0
    for (const w of ws) {
      const ids = new Set(w.sets.filter(isHard).map((s) => s.exerciseId))
      let hit = 0
      r.items.forEach((it, i) => {
        if (ids.has(it.exerciseId)) { slots[i].done++; hit++ } else if (it.alternatives.some((a) => ids.has(a))) { slots[i].done++; slots[i].swapped++; hit++ }
      })
      total += r.items.length ? hit / r.items.length : 0
    }
    out.push({ routine: r, sessions: ws.length, completion: (total / ws.length) * 100, slots })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* what you train                                                      */
/* ------------------------------------------------------------------ */

const PUSH: Muscle[] = ['chest', 'shoulders', 'triceps']
const PULL: Muscle[] = ['back', 'biceps']
const LOWER: Muscle[] = ['quads', 'hamstrings', 'glutes', 'calves']

export interface Composition {
  zones: { strength: number; hypertrophy: number; endurance: number }
  push: number
  pull: number
  upper: number
  lower: number
  rpeShare: number
  rpeMean: number | null
  failureShare: number
  sets: number
}

/** Hard sets in [from, to]: rep zones, balance, effort. */
export function composition(workouts: Workout[], exMap: Map<string, Exercise>, from: string, to: string): Composition {
  const sets = workouts.filter((w) => w.day >= from && w.day <= to).flatMap((w) => w.sets.filter(isHard))
  const muscle = (id: string): Muscle => exMap.get(id)?.muscle ?? 'other'
  const count = (ms: Muscle[]): number => sets.filter((s) => ms.includes(muscle(s.exerciseId))).length
  const rpes = sets.map((s) => s.rpe).filter(isNum)
  return {
    zones: { strength: sets.filter((s) => s.reps <= 5).length, hypertrophy: sets.filter((s) => s.reps >= 6 && s.reps <= 12).length, endurance: sets.filter((s) => s.reps > 12).length },
    push: count(PUSH), pull: count(PULL), upper: count([...PUSH, ...PULL]), lower: count(LOWER),
    rpeShare: sets.length ? (rpes.length / sets.length) * 100 : 0, rpeMean: rpes.length ? meanOf(rpes) : null,
    failureShare: sets.length ? (sets.filter((s) => s.kind === 'failure' || (isNum(s.rpe) && s.rpe >= 10)).length / sets.length) * 100 : 0,
    sets: sets.length,
  }
}

export interface HeatCell { muscle: Muscle; label: string; week: string; sets: number }

/** Hard sets per muscle per week, oldest week first; only muscles trained. */
export function muscleHeat(workouts: Workout[], exMap: Map<string, Exercise>, today: string, weeks = 12): { weeks: string[]; rows: { muscle: Muscle; label: string; cells: HeatCell[] }[] } {
  const start = shiftDay(weekStart(today), -7 * (weeks - 1))
  const wks = Array.from({ length: weeks }, (_, i) => shiftDay(start, 7 * i))
  const counts = new Map<string, number>()
  for (const w of workouts) {
    if (w.day < start) continue
    const wk = weekStart(w.day)
    for (const s of w.sets.filter(isHard)) {
      const m = exMap.get(s.exerciseId)?.muscle ?? 'other'
      counts.set(`${m}|${wk}`, (counts.get(`${m}|${wk}`) ?? 0) + 1)
    }
  }
  const rows = MUSCLES.map((m) => ({ muscle: m.key, label: m.label, cells: wks.map((wk) => ({ muscle: m.key, label: m.label, week: wk, sets: counts.get(`${m.key}|${wk}`) ?? 0 })) }))
    .filter((r) => r.cells.some((c) => c.sets > 0))
  return { weeks: wks, rows }
}

/* ------------------------------------------------------------------ */
/* records                                                             */
/* ------------------------------------------------------------------ */

export interface RecordEvent { day: string; exercise: Exercise; kinds: string[]; weightKg: number; reps: number }

export function recordEvents(stats: ExerciseStats[]): RecordEvent[] {
  const out: RecordEvent[] = []
  for (const st of stats) {
    for (const s of st.sessions) {
      for (const p of s.prs) {
        const set = s.sets.find((x) => x.id === p.setId)
        if (set) out.push({ day: s.day, exercise: st.exercise, kinds: p.kinds, weightKg: set.weightKg, reps: set.reps })
      }
    }
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1))
}

