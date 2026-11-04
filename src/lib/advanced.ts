/**
 * Advanced insights — the deeper analyses behind `#/advanced`. Pure and
 * framework-agnostic, built on the same `GET /api/insights` payload as the
 * Insights tab. Anything that needs warm-up history (training load, baselines)
 * is computed over the whole history and then sliced to [from, to].
 * SPEC §8 "Advanced insights".
 */
import type { InsightActivity, InsightDay, InsightsPayload, SleepNight } from './types'
import {
  bedMinutes, clockMinutes, dayNum, eachDay, fmtHM, fmtRace, isNum, mean, median, shiftDay, sd,
  slopePerDay, sportGroup, SPORTS, weekday, type Point, type SportGroup,
} from './insights.ts'

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sum = (xs: (number | null | undefined)[]): number => xs.filter(isNum).reduce((a, b) => a + b, 0)
const sleepTotal = (n: SleepNight | undefined): number | null =>
  n && (isNum(n.deepS) || isNum(n.lightS) || isNum(n.remS)) ? (n.deepS ?? 0) + (n.lightS ?? 0) + (n.remS ?? 0) : null
const inRange = <T extends { day: string }>(rows: T[], from: string, to: string): T[] => rows.filter((r) => r.day >= from && r.day <= to)

export function pearson(pairs: [number, number][]): number | null {
  if (pairs.length < 10) return null
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length
  const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length
  let num = 0
  let dx = 0
  let dy = 0
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my)
    dx += (x - mx) ** 2
    dy += (y - my) ** 2
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null
}

/** Training load of one activity: Garmin's own load, else a duration × effect estimate. */
export function activityLoad(a: InsightActivity): number {
  if (isNum(a.trainingLoad) && a.trainingLoad > 0) return a.trainingLoad
  const min = (a.durationS ?? 0) / 60
  return min * (isNum(a.trainingEffect) && a.trainingEffect > 0 ? a.trainingEffect / 2 : 0.6)
}

const monthKey = (day: string): string => day.slice(0, 7)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fmtMonth = (key: string): string => `${MONTHS[+key.slice(5, 7) - 1]} ’${key.slice(2, 4)}`

/* ------------------------------------------------------------------ */
/* 1 + 2. Training load: acute:chronic and fitness / fatigue / form    */
/* ------------------------------------------------------------------ */

export interface LoadModel {
  daily: Point[]
  acwr: Point[]
  ctl: Point[]
  atl: Point[]
  tsb: Point[]
  now: { acwr: number | null; ctl: number | null; atl: number | null; tsb: number | null }
  acwrZone: 'low' | 'optimal' | 'high' | 'danger' | null
  formLabel: string | null
  spikes: number
}

function loadModel(acts: InsightActivity[], from: string, to: string): LoadModel {
  const byDay = new Map<string, number>()
  for (const a of acts) byDay.set(a.day, (byDay.get(a.day) ?? 0) + activityLoad(a))
  const first = acts.length ? acts.map((a) => a.day).sort()[0] : from
  const start = first < from ? first : from
  const days = eachDay(start, to)
  const kCtl = 1 - Math.exp(-1 / 42)
  const kAtl = 1 - Math.exp(-1 / 7)
  let ctl = 0
  let atl = 0
  const out = { daily: [] as Point[], acwr: [] as Point[], ctl: [] as Point[], atl: [] as Point[], tsb: [] as Point[] }
  const loads: number[] = []
  days.forEach((day, i) => {
    const load = byDay.get(day) ?? 0
    loads.push(load)
    ctl += (load - ctl) * kCtl
    atl += (load - atl) * kAtl
    if (day < from) return
    const acute = loads.slice(Math.max(0, i - 6), i + 1).reduce((a, b) => a + b, 0)
    const chronic = loads.slice(Math.max(0, i - 27), i + 1).reduce((a, b) => a + b, 0) / 4
    const warm = i >= 27
    out.daily.push({ day, value: load })
    out.acwr.push({ day, value: warm && chronic > 20 ? acute / chronic : null })
    out.ctl.push({ day, value: i >= 14 ? ctl : null })
    out.atl.push({ day, value: i >= 14 ? atl : null })
    out.tsb.push({ day, value: i >= 14 ? ctl - atl : null })
  })
  const last = <T extends Point>(xs: T[]): number | null => [...xs].reverse().find((p) => isNum(p.value))?.value ?? null
  const acwr = last(out.acwr)
  const tsb = last(out.tsb)
  return {
    ...out,
    now: { acwr, ctl: last(out.ctl), atl: last(out.atl), tsb },
    acwrZone: acwr === null ? null : acwr < 0.8 ? 'low' : acwr <= 1.3 ? 'optimal' : acwr <= 1.5 ? 'high' : 'danger',
    formLabel: tsb === null ? null : tsb > 10 ? 'Fresh — good day to race or test' : tsb > -10 ? 'Balanced' : tsb > -30 ? 'Building — productive fatigue' : 'Heavy fatigue — prioritise recovery',
    spikes: out.acwr.filter((p) => isNum(p.value) && p.value > 1.5).length,
  }
}

/* ------------------------------------------------------------------ */
/* 3 + 13. Efficiency: pace at a fixed heart rate                      */
/* ------------------------------------------------------------------ */

export interface EfficiencyRun { day: string; name: string | null; paceS: number; hr: number; adjPaceS: number; distanceM: number }
export interface Efficiency {
  /** Speed metric per sport: run = s/km, swim = s/100 m, ride = km/h. */
  unit: 'pace-km' | 'pace-100m' | 'speed'
  refHr: number
  runs: EfficiencyRun[]
  trend: Point[]
  firstAvg: number | null
  lastAvg: number | null
  /** Positive = got better (faster at the same HR), in percent. */
  changePct: number | null
  hrPerSpeed: number | null
}

/**
 * Normalise each session's speed to one reference heart rate with a
 * regression across all sessions of the sport, so a hot easy run and a cool
 * hard run compare fairly. Lower pace / higher speed at refHr = fitter.
 */
function efficiency(acts: InsightActivity[], group: SportGroup, from: string, to: string): Efficiency | null {
  const unit: Efficiency['unit'] = group === 'swim' ? 'pace-100m' : group === 'ride' ? 'speed' : 'pace-km'
  const minDist = group === 'swim' ? 300 : group === 'ride' ? 5000 : 1500
  const all = acts.filter((a) => sportGroup(a.type) === group && isNum(a.avgHr) && a.avgHr > 80 && isNum(a.distanceM) && a.distanceM >= minDist && isNum(a.movingS ?? a.durationS))
  if (all.length < 6) return null
  const speed = (a: InsightActivity): number => (a.distanceM as number) / ((a.movingS ?? a.durationS) as number) // m/s
  const pairs = all.map((a) => [a.avgHr as number, speed(a)] as [number, number])
  const mx = mean(pairs.map((p) => p[0])) as number
  const my = mean(pairs.map((p) => p[1])) as number
  let num = 0
  let den = 0
  for (const [x, y] of pairs) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  const slope = den ? Math.max(0, num / den) : 0 // m/s per bpm; never negative (noise)
  const refHr = Math.round((median(pairs.map((p) => p[0])) as number) / 5) * 5
  const toMetric = (mps: number): number => (unit === 'speed' ? mps * 3.6 : unit === 'pace-100m' ? 100 / mps : 1000 / mps)
  const runs = all.filter((a) => a.day >= from && a.day <= to).map((a) => {
    const adj = speed(a) + slope * (refHr - (a.avgHr as number))
    return { day: a.day, name: a.name, paceS: toMetric(speed(a)), hr: a.avgHr as number, adjPaceS: toMetric(Math.max(0.3, adj)), distanceM: a.distanceM as number }
  })
  if (runs.length < 4) return null
  // 30-day trailing mean of the adjusted metric at each session.
  const trend = runs.map((r) => ({ day: r.day, value: mean(runs.filter((x) => x.day <= r.day && dayNum(r.day) - dayNum(x.day) < 30).map((x) => x.adjPaceS)) }))
  const third = Math.max(2, Math.floor(runs.length / 3))
  const firstAvg = mean(runs.slice(0, third).map((r) => r.adjPaceS))
  const lastAvg = mean(runs.slice(-third).map((r) => r.adjPaceS))
  const better = (a: number, b: number): number => (unit === 'speed' ? (b - a) / a : (a - b) / a) * 100
  return {
    unit, refHr, runs, trend, firstAvg, lastAvg,
    changePct: isNum(firstAvg) && isNum(lastAvg) ? better(firstAvg, lastAvg) : null,
    hrPerSpeed: slope ? 1 / slope : null,
  }
}

export function fmtEff(v: number | null, unit: Efficiency['unit']): string {
  if (!isNum(v)) return '—'
  if (unit === 'speed') return `${v.toFixed(1)} km/h`
  return `${fmtRace(v)} /${unit === 'pace-100m' ? '100 m' : 'km'}`
}

/* ------------------------------------------------------------------ */
/* 4. Race predictions                                                 */
/* ------------------------------------------------------------------ */

export type RaceKey = 'race5kS' | 'race10kS' | 'raceHalfS' | 'raceMarathonS'
export interface RaceProgress {
  key: RaceKey
  series: Point[]
  first: number | null
  now: number | null
  best: number | null
  windows: { from: string; to: string; change: number; runKmPerWeek: number; hoursPerWeek: number }[]
  avgRunKmPerWeek: number | null
}

function raceProgress(data: InsightsPayload, key: RaceKey, from: string, to: string): RaceProgress {
  const series = inRange(data.metrics, from, to).filter((m) => isNum(m[key])).map((m) => ({ day: m.day, value: m[key] as number }))
  const acts = inRange(data.activities, from, to)
  const perWeek = (a: string, b: string): { km: number; h: number } => {
    const list = acts.filter((x) => x.day >= a && x.day <= b)
    const weeks = Math.max(1, (dayNum(b) - dayNum(a) + 1) / 7)
    return { km: sum(list.filter((x) => sportGroup(x.type) === 'run').map((x) => x.distanceM)) / 1000 / weeks, h: sum(list.map((x) => x.durationS)) / 3600 / weeks }
  }
  // Non-overlapping 28-day windows; keep the two biggest moves each way.
  const windows: RaceProgress['windows'] = []
  for (let i = 0; i < series.length; i++) {
    const end = series.find((p) => dayNum(p.day) - dayNum(series[i].day) >= 28)
    if (!end) break
    const change = (end.value as number) - (series[i].value as number)
    const w = perWeek(series[i].day, end.day)
    windows.push({ from: series[i].day, to: end.day, change, runKmPerWeek: w.km, hoursPerWeek: w.h })
  }
  const picked: RaceProgress['windows'] = []
  for (const w of [...windows].sort((a, b) => a.change - b.change)) {
    if (picked.length >= 2) break
    if (w.change < -5 && !picked.some((p) => !(w.to < p.from || w.from > p.to))) picked.push(w)
  }
  const worst = [...windows].sort((a, b) => b.change - a.change).find((w) => w.change > 5 && !picked.some((p) => !(w.to < p.from || w.from > p.to)))
  if (worst) picked.push(worst)
  const all = perWeek(from, to)
  return {
    key, series,
    first: series[0]?.value ?? null,
    now: series[series.length - 1]?.value ?? null,
    best: series.length ? Math.min(...series.map((p) => p.value as number)) : null,
    windows: picked,
    avgRunKmPerWeek: all.km,
  }
}

/* ------------------------------------------------------------------ */
/* 5 + 6 + 7. Sleep: debt, consistency, predictors                     */
/* ------------------------------------------------------------------ */

export interface SleepAnalysis {
  needS: number | null
  needBasis: number
  debt14: Point[]
  debtNow: number | null
  weekDebt: number | null
  consistency: Point[]
  consistencyNow: number | null
  bedSd: number | null
  wakeSd: number | null
  steadyScore: number | null
  erraticScore: number | null
  predictors: { label: string; r: number; n: number; detail: string }[]
}

function sleepAnalysis(data: InsightsPayload, from: string, to: string): SleepAnalysis {
  const nights = data.sleep
  const dayMap = new Map(data.days.map((d) => [d.day, d]))
  const sleepMap = new Map(nights.map((n) => [n.day, n]))
  // Need: what you sleep on nights you wake fully charged.
  const charged = nights.filter((n) => (dayMap.get(n.day)?.bbWake ?? 0) >= 90).map(sleepTotal).filter(isNum)
  const fallback = nights.filter((n) => (n.score ?? 0) >= 85).map(sleepTotal).filter(isNum)
  const basis = charged.length >= 10 ? charged : fallback
  const needRaw = median(basis)
  const needS = isNum(needRaw) ? Math.min(9.5 * 3600, Math.max(6.5 * 3600, needRaw)) : null

  const rangeNights = eachDay(from, to)
  const debt14: Point[] = []
  const consistency: Point[] = []
  for (const day of rangeNights) {
    if (isNum(needS)) {
      const last14 = eachDay(shiftDay(day, -13), day).map((d) => sleepTotal(sleepMap.get(d))).filter(isNum)
      debt14.push({ day, value: last14.length >= 7 ? ((needS * last14.length - last14.reduce((a, b) => a + b, 0)) / last14.length) * 14 : null })
    }
    const win = eachDay(shiftDay(day, -13), day).map((d) => sleepMap.get(d)).filter((n): n is SleepNight => !!n)
    const beds = win.map((n) => bedMinutes(n.startLocal)).filter(isNum)
    const wakes = win.map((n) => clockMinutes(n.endLocal)).filter(isNum)
    const s1 = sd(beds)
    const s2 = sd(wakes)
    consistency.push({ day, value: beds.length >= 7 && isNum(s1) && isNum(s2) ? Math.max(0, Math.min(100, 100 - ((s1 + s2) / 2 - 15) * 1.1)) : null })
  }
  const lastVal = (xs: Point[]): number | null => [...xs].reverse().find((p) => isNum(p.value))?.value ?? null
  const inR = inRange(nights, from, to)
  const lastWeek = eachDay(shiftDay(to, -6), to).map((d) => sleepTotal(sleepMap.get(d))).filter(isNum)

  // Steady vs erratic nights: distance of bedtime from that fortnight's median.
  const steady: number[] = []
  const erratic: number[] = []
  for (const n of inR) {
    const b = bedMinutes(n.startLocal)
    if (!isNum(b) || !isNum(n.score)) continue
    const med = median(eachDay(shiftDay(n.day, -14), shiftDay(n.day, -1)).map((d) => bedMinutes(sleepMap.get(d)?.startLocal ?? null)))
    if (!isNum(med)) continue
    if (Math.abs(b - med) <= 30) steady.push(n.score)
    else if (Math.abs(b - med) >= 60) erratic.push(n.score)
  }

  // Predictors of the night's score (values from the day before the morning).
  const intake = new Map(data.intake.map((i) => [i.day, i.kcal]))
  const load = new Map<string, number>()
  const late = new Set<string>()
  for (const a of data.activities) {
    load.set(a.day, (load.get(a.day) ?? 0) + activityLoad(a))
    if ((clockMinutes(a.startLocal) ?? 0) >= 18 * 60) late.add(a.day)
  }
  const factors: { label: string; x: (n: SleepNight, prev: InsightDay | undefined, pd: string) => number | null; detail: string }[] = [
    { label: 'Bedtime', x: (n) => bedMinutes(n.startLocal), detail: 'later bedtime' },
    { label: 'Training load that day', x: (_n, _p, pd) => load.get(pd) ?? 0, detail: 'more training' },
    { label: 'Evening session', x: (_n, _p, pd) => (late.has(pd) ? 1 : 0), detail: 'training after 6 pm' },
    { label: 'Steps that day', x: (_n, p) => p?.steps ?? null, detail: 'more steps' },
    { label: 'Stress that day', x: (_n, p) => p?.stressAvg ?? null, detail: 'higher stress' },
    { label: 'High-stress time', x: (_n, p) => (isNum(p?.stressHighS) ? (p!.stressHighS as number) / 60 : null), detail: 'more high-stress minutes' },
    { label: 'Calories eaten', x: (_n, _p, pd) => intake.get(pd) ?? null, detail: 'eating more' },
    { label: 'Body Battery drained', x: (_n, p) => p?.bbDrained ?? null, detail: 'a more draining day' },
  ]
  const predictors = factors.map((f) => {
    const pairs: [number, number][] = []
    for (const n of inR) {
      if (!isNum(n.score)) continue
      const pd = shiftDay(n.day, -1)
      const x = f.x(n, dayMap.get(pd), pd)
      if (isNum(x)) pairs.push([x, n.score])
    }
    const r = pearson(pairs)
    return { label: f.label, r: r ?? 0, n: pairs.length, detail: f.detail, ok: r !== null }
  }).filter((p) => p.ok).map(({ ok: _ok, ...p }) => p).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))

  return {
    needS, needBasis: basis.length,
    debt14, debtNow: lastVal(debt14),
    weekDebt: isNum(needS) && lastWeek.length >= 4 ? (needS - (lastWeek.reduce((a, b) => a + b, 0) / lastWeek.length)) * 7 : null,
    consistency, consistencyNow: lastVal(consistency),
    bedSd: sd(inR.map((n) => bedMinutes(n.startLocal))), wakeSd: sd(inR.map((n) => clockMinutes(n.endLocal))),
    steadyScore: steady.length >= 5 ? mean(steady) : null, erraticScore: erratic.length >= 5 ? mean(erratic) : null,
    predictors,
  }
}

/* ------------------------------------------------------------------ */
/* 8. Recovery after hard sessions                                     */
/* ------------------------------------------------------------------ */

export interface RecoveryBySport { key: SportGroup; label: string; sessions: number; rhrBump: number | null; bbDip: number | null; daysToNormal: number | null }
export interface RecoveryAnalysis { curve: { day: number; rhr: number | null; bb: number | null }[]; bySport: RecoveryBySport[]; threshold: number; sessions: number }

function recoveryAnalysis(data: InsightsPayload, from: string, to: string): RecoveryAnalysis {
  const dayMap = new Map(data.days.map((d) => [d.day, d]))
  const loads = data.activities.map(activityLoad).filter((v) => v > 0).sort((a, b) => a - b)
  const threshold = loads.length ? loads[Math.floor(loads.length * 0.75)] : Infinity
  const hard = inRange(data.activities, from, to).filter((a) => activityLoad(a) >= threshold)
  const base = (day: string, k: 'restingHr' | 'bbWake'): number | null => mean(eachDay(shiftDay(day, -7), shiftDay(day, -1)).map((d) => dayMap.get(d)?.[k] ?? null))
  const rows = hard.map((a) => {
    const rb = base(a.day, 'restingHr')
    const bb = base(a.day, 'bbWake')
    const after = [1, 2, 3, 4].map((k) => {
      const d = dayMap.get(shiftDay(a.day, k))
      return { rhr: isNum(rb) && isNum(d?.restingHr) ? (d!.restingHr as number) - rb : null, bb: isNum(bb) && isNum(d?.bbWake) ? (d!.bbWake as number) - bb : null }
    })
    const normal = after.findIndex((x) => isNum(x.rhr) && (x.rhr as number) <= 0.5)
    return { group: sportGroup(a.type), after, days: normal < 0 ? (after.some((x) => isNum(x.rhr)) ? 4 : null) : normal + 1 }
  })
  const curve = [1, 2, 3, 4].map((k) => ({ day: k, rhr: mean(rows.map((r) => r.after[k - 1].rhr)), bb: mean(rows.map((r) => r.after[k - 1].bb)) }))
  const bySport = SPORTS.map(({ key, label }) => {
    const list = rows.filter((r) => r.group === key)
    return { key, label, sessions: list.length, rhrBump: mean(list.map((r) => r.after[0].rhr)), bbDip: mean(list.map((r) => r.after[0].bb)), daysToNormal: mean(list.map((r) => r.days)) }
  }).filter((s) => s.sessions >= 2)
  return { curve, bySport, threshold, sessions: rows.length }
}

/* ------------------------------------------------------------------ */
/* 9. Weekday rhythm                                                   */
/* ------------------------------------------------------------------ */

export interface RhythmRow { label: string; values: (number | null)[]; format: (v: number) => string; higherIsBetter: boolean | null }

function weekdayRhythm(data: InsightsPayload, from: string, to: string): RhythmRow[] {
  const days = inRange(data.days, from, to)
  const nights = inRange(data.sleep, from, to)
  const acts = inRange(data.activities, from, to)
  const intake = inRange(data.intake, from, to)
  const byWd = <T extends { day: string }>(rows: T[], pick: (r: T) => number | null): (number | null)[] =>
    [0, 1, 2, 3, 4, 5, 6].map((wd) => mean(rows.filter((r) => weekday(r.day) === wd).map(pick)))
  const trainMin = new Map<string, number>()
  for (const a of acts) trainMin.set(a.day, (trainMin.get(a.day) ?? 0) + (a.durationS ?? 0) / 60)
  const allDays = eachDay(from, to).map((day) => ({ day, m: trainMin.get(day) ?? 0 }))
  const rows: RhythmRow[] = [
    { label: 'Stress', values: byWd(days, (d) => d.stressAvg), format: (v) => `${Math.round(v)}`, higherIsBetter: false },
    { label: 'Steps', values: byWd(days, (d) => d.steps), format: (v) => `${(v / 1000).toFixed(1)}k`, higherIsBetter: true },
    { label: 'Training', values: byWd(allDays, (d) => d.m), format: (v) => `${Math.round(v)}m`, higherIsBetter: null },
    { label: 'Sleep (that night)', values: [0, 1, 2, 3, 4, 5, 6].map((wd) => mean(nights.filter((n) => (weekday(n.day) + 6) % 7 === wd).map(sleepTotal))), format: (v) => `${(v / 3600).toFixed(1)}h`, higherIsBetter: true },
    { label: 'Sleep score', values: [0, 1, 2, 3, 4, 5, 6].map((wd) => mean(nights.filter((n) => (weekday(n.day) + 6) % 7 === wd).map((n) => n.score))), format: (v) => `${Math.round(v)}`, higherIsBetter: true },
    { label: 'Body Battery at wake', values: byWd(days, (d) => d.bbWake), format: (v) => `${Math.round(v)}`, higherIsBetter: true },
    { label: 'Calories eaten', values: byWd(intake, (i) => (i.kcal > 300 ? i.kcal : null)), format: (v) => `${Math.round(v).toLocaleString()}`, higherIsBetter: null },
  ]
  return rows.filter((r) => r.values.filter(isNum).length >= 5)
}

/* ------------------------------------------------------------------ */
/* 10. Monthly trends                                                  */
/* ------------------------------------------------------------------ */

export interface MonthRow { month: string; rhr: number | null; sleepS: number | null; score: number | null; trainH: number; stress: number | null; steps: number | null; vo2: number | null }

function monthly(data: InsightsPayload, from: string, to: string): MonthRow[] {
  const months = [...new Set(eachDay(from, to).map(monthKey))]
  return months.map((m) => {
    const days = data.days.filter((d) => monthKey(d.day) === m)
    const nights = data.sleep.filter((n) => monthKey(n.day) === m)
    const vo2 = data.metrics.filter((x) => monthKey(x.day) === m && isNum(x.vo2max))
    return {
      month: m,
      rhr: mean(days.map((d) => d.restingHr)),
      sleepS: mean(nights.map(sleepTotal)),
      score: mean(nights.map((n) => n.score)),
      trainH: sum(data.activities.filter((a) => monthKey(a.day) === m).map((a) => a.durationS)) / 3600,
      stress: mean(days.map((d) => d.stressAvg)),
      steps: mean(days.map((d) => d.steps)),
      vo2: vo2.length ? (vo2[vo2.length - 1].vo2max as number) : null,
    }
  }).filter((r) => isNum(r.rhr) || isNum(r.sleepS) || r.trainH > 0)
}

/* ------------------------------------------------------------------ */
/* 11 + 12. Energy vs the scale, protein                               */
/* ------------------------------------------------------------------ */

export interface ScaleCheck {
  predicted: Point[]
  actual: Point[]
  loggedDays: number
  watchBurn: number | null
  impliedBurn: number | null
  watchErrorKcal: number | null
  predictedKg: number | null
  actualKg: number | null
  reason: string | null
}

function scaleCheck(data: InsightsPayload, from: string, to: string): ScaleCheck {
  const intake = new Map(data.intake.map((i) => [i.day, i.kcal]))
  const dayMap = new Map(data.days.map((d) => [d.day, d]))
  const weights = inRange(data.weights, from, to)
  const logged = eachDay(from, to).filter((d) => d < to && (intake.get(d) ?? 0) > 300 && isNum(dayMap.get(d)?.totalKcal))
  const empty: ScaleCheck = { predicted: [], actual: [], loggedDays: logged.length, watchBurn: null, impliedBurn: null, watchErrorKcal: null, predictedKg: null, actualKg: null, reason: null }
  if (logged.length < 14) return { ...empty, reason: `Needs 14 days with meals logged in this range (${logged.length} so far).` }
  if (weights.length < 6) return { ...empty, reason: `Needs at least 6 weigh-ins in this range (${weights.length} so far).` }
  const start = logged[0]
  const w0 = mean(weights.filter((w) => dayNum(w.day) - dayNum(start) <= 7 && dayNum(w.day) >= dayNum(start) - 7).map((w) => w.weightKg)) ?? weights[0].weightKg
  const avgIntake = mean(logged.map((d) => intake.get(d))) as number
  const watchBurn = mean(logged.map((d) => dayMap.get(d)?.totalKcal)) as number
  let cum = 0
  const predicted: Point[] = []
  for (const d of eachDay(start, to)) {
    const i = intake.get(d)
    const b = dayMap.get(d)?.totalKcal
    // Days without a log assume the average balance (no data is not zero food).
    cum += isNum(i) && i > 300 && isNum(b) ? i - b : avgIntake - watchBurn
    predicted.push({ day: d, value: cum / 7700 })
  }
  const actual = weights.filter((w) => w.day >= start).map((w) => ({ day: w.day, value: w.weightKg - w0 }))
  const slope = slopePerDay(actual)
  const impliedBurn = isNum(slope) ? avgIntake - slope * 7700 : null
  return {
    predicted, actual, loggedDays: logged.length, watchBurn, impliedBurn,
    watchErrorKcal: isNum(impliedBurn) ? watchBurn - impliedBurn : null,
    predictedKg: predicted[predicted.length - 1]?.value ?? null,
    actualKg: isNum(slope) ? slope * (dayNum(to) - dayNum(start)) : null,
    reason: null,
  }
}

export interface ProteinAnalysis { trainDay: number | null; restDay: number | null; perKg: number | null; weightKg: number | null; days: number; highRhr: number | null; lowRhr: number | null; reason: string | null }

function protein(data: InsightsPayload, from: string, to: string): ProteinAnalysis {
  const rows = inRange(data.intake, from, to).filter((i) => i.kcal > 300 && i.day < to)
  const trained = new Set(data.activities.map((a) => a.day))
  const w = [...data.weights].reverse().find((x) => x.day <= to)?.weightKg ?? null
  if (rows.length < 7) return { trainDay: null, restDay: null, perKg: null, weightKg: w, days: rows.length, highRhr: null, lowRhr: null, reason: `Needs 7 days of logged meals in this range (${rows.length} so far).` }
  const avg = mean(rows.map((r) => r.proteinG))
  const dayMap = new Map(data.days.map((d) => [d.day, d]))
  const med = median(rows.map((r) => r.proteinG)) ?? 0
  const nextRhr = (pred: (g: number) => boolean): number | null => {
    const v = rows.filter((r) => pred(r.proteinG)).map((r) => dayMap.get(shiftDay(r.day, 1))?.restingHr ?? null).filter(isNum)
    return v.length >= 4 ? mean(v) : null
  }
  return {
    trainDay: mean(rows.filter((r) => trained.has(r.day)).map((r) => r.proteinG)),
    restDay: mean(rows.filter((r) => !trained.has(r.day)).map((r) => r.proteinG)),
    perKg: isNum(avg) && isNum(w) ? avg / w : null,
    weightKg: w, days: rows.length,
    highRhr: nextRhr((g) => g >= med), lowRhr: nextRhr((g) => g < med),
    reason: null,
  }
}

/* ------------------------------------------------------------------ */
/* 13. Sport deep dive                                                 */
/* ------------------------------------------------------------------ */

export interface SportDive {
  key: SportGroup
  label: string
  sessions: number
  hours: number
  distanceM: number
  avgHr: number | null
  avgTe: number | null
  avgAnTe: number | null
  kcalPerHour: number | null
  avgDurationS: number | null
  months: { key: string; hours: number; sessions: number; distanceKm: number }[]
  hrTrend: Point[]
  efficiency: Efficiency | null
  zones: number[]
  hours24: number[]
  weekdays: number[]
  longest: InsightActivity | null
  fastest: (InsightActivity & { paceS: number }) | null
  hardest: InsightActivity | null
  recent: InsightActivity[]
  headline: string | null
}

function sportDive(data: InsightsPayload, key: SportGroup, from: string, to: string): SportDive | null {
  const label = SPORTS.find((s) => s.key === key)?.label ?? key
  const list = inRange(data.activities, from, to).filter((a) => sportGroup(a.type) === key)
  if (!list.length) return null
  const hours = sum(list.map((a) => a.durationS)) / 3600
  const months = [...new Set(eachDay(from, to).map(monthKey))].map((m) => {
    const ms = list.filter((a) => monthKey(a.day) === m)
    return { key: m, hours: sum(ms.map((a) => a.durationS)) / 3600, sessions: ms.length, distanceKm: sum(ms.map((a) => a.distanceM)) / 1000 }
  })
  const zones = [0, 0, 0, 0, 0, 0]
  for (const a of list) a.hrZonesS?.forEach((z, i) => { if (i < 6) zones[i] += z })
  const hours24 = Array.from({ length: 24 }, () => 0)
  const weekdays = Array.from({ length: 7 }, () => 0)
  for (const a of list) {
    hours24[+a.startLocal.slice(11, 13)]++
    weekdays[weekday(a.day)]++
  }
  const withHr = list.filter((a) => isNum(a.avgHr))
  const hrTrend = withHr.map((a) => ({ day: a.day, value: mean(withHr.filter((x) => x.day <= a.day && dayNum(a.day) - dayNum(x.day) < 30).map((x) => x.avgHr)) }))
  const eff = key === 'run' || key === 'ride' || key === 'swim' ? efficiency(data.activities, key, from, to) : null
  const paced = list.filter((a) => isNum(a.distanceM) && a.distanceM > (key === 'swim' ? 300 : 2000) && isNum(a.movingS ?? a.durationS))
    .map((a) => ({ ...a, paceS: ((a.movingS ?? a.durationS) as number) / ((a.distanceM as number) / (key === 'swim' ? 100 : 1000)) }))
  const fastest = key === 'run' || key === 'swim' ? paced.reduce<(InsightActivity & { paceS: number }) | null>((b, a) => (!b || a.paceS < b.paceS ? a : b), null) : null
  let headline: string | null = null
  if (eff && isNum(eff.changePct) && Math.abs(eff.changePct) >= 1.5) {
    headline = `${eff.changePct > 0 ? 'Faster' : 'Slower'} at the same heart rate: ${Math.abs(eff.changePct).toFixed(0)}% ${eff.changePct > 0 ? 'quicker' : 'slower'} at ${eff.refHr} bpm than at the start of this range.`
  } else {
    const firstHalf = list.filter((a) => dayNum(a.day) < (dayNum(from) + dayNum(to)) / 2).length
    const secondHalf = list.length - firstHalf
    if (list.length >= 6 && firstHalf && Math.abs(secondHalf - firstHalf) / firstHalf >= 0.3) headline = `${secondHalf > firstHalf ? 'More' : 'Fewer'} sessions lately: ${secondHalf} in the second half of this range vs ${firstHalf} in the first.`
  }
  return {
    key, label,
    sessions: list.length, hours,
    distanceM: sum(list.map((a) => a.distanceM)),
    avgHr: mean(list.map((a) => a.avgHr)),
    avgTe: mean(list.map((a) => a.trainingEffect)),
    avgAnTe: mean(list.map((a) => a.anaerobicTe)),
    kcalPerHour: hours > 0 ? sum(list.map((a) => a.kcal)) / hours : null,
    avgDurationS: mean(list.map((a) => a.durationS)),
    months, hrTrend, efficiency: eff, zones, hours24, weekdays,
    longest: list.reduce<InsightActivity | null>((b, a) => (!b || (a.durationS ?? 0) > (b.durationS ?? 0) ? a : b), null),
    fastest,
    hardest: list.reduce<InsightActivity | null>((b, a) => (!b || activityLoad(a) > activityLoad(b) ? a : b), null),
    recent: [...list].reverse().slice(0, 5),
    headline,
  }
}

/* ------------------------------------------------------------------ */
/* 14. Stress fingerprint                                              */
/* ------------------------------------------------------------------ */

export interface StressFingerprint {
  perDay: { rest: number; low: number; medium: number; high: number }
  topDays: { day: string; stress: number; highMin: number }[]
  before: { label: string; top: number; normal: number; format: (v: number) => string; worse: boolean | null }[]
  avgMax: number | null
  restRatio: number | null
}

function stressFingerprint(data: InsightsPayload, from: string, to: string): StressFingerprint | null {
  const days = inRange(data.days, from, to).filter((d) => isNum(d.stressAvg))
  if (days.length < 14) return null
  const dayMap = new Map(data.days.map((d) => [d.day, d]))
  const sleepMap = new Map(data.sleep.map((n) => [n.day, n]))
  const load = new Map<string, number>()
  for (const a of data.activities) load.set(a.day, (load.get(a.day) ?? 0) + activityLoad(a))
  const sorted = [...days].sort((a, b) => (b.stressAvg as number) - (a.stressAvg as number))
  const cut = Math.max(3, Math.floor(days.length * 0.1))
  const top = sorted.slice(0, cut)
  const normal = sorted.slice(cut)
  const factor = (label: string, pick: (d: InsightDay) => number | null, format: (v: number) => string, worseIfLower: boolean | null) => {
    const t = mean(top.map(pick))
    const n = mean(normal.map(pick))
    return isNum(t) && isNum(n) ? { label, top: t, normal: n, format, worse: worseIfLower === null ? null : worseIfLower ? t < n : t > n } : null
  }
  const before = [
    factor('Sleep the night before', (d) => sleepTotal(sleepMap.get(d.day)), fmtHM, true),
    factor('Sleep score', (d) => sleepMap.get(d.day)?.score ?? null, (v) => `${Math.round(v)}`, true),
    factor('Body Battery at wake', (d) => d.bbWake, (v) => `${Math.round(v)}`, true),
    factor('Training load the day before', (d) => load.get(shiftDay(d.day, -1)) ?? 0, (v) => `${Math.round(v)}`, null),
    factor('Steps that day', (d) => d.steps, (v) => Math.round(v).toLocaleString(), null),
    factor('Resting HR that morning', (d) => dayMap.get(d.day)?.restingHr ?? null, (v) => `${v.toFixed(1)} bpm`, false),
  ].filter((x): x is NonNullable<typeof x> => x !== null)
  const n = days.length
  const perDay = { rest: sum(days.map((d) => d.stressRestS)) / n, low: sum(days.map((d) => d.stressLowS)) / n, medium: sum(days.map((d) => d.stressMediumS)) / n, high: sum(days.map((d) => d.stressHighS)) / n }
  const stressed = perDay.low + perDay.medium + perDay.high
  return {
    perDay,
    topDays: top.slice(0, 5).map((d) => ({ day: d.day, stress: d.stressAvg as number, highMin: (d.stressHighS ?? 0) / 60 })),
    before,
    avgMax: mean(days.map((d) => d.stressMax)),
    restRatio: stressed > 0 ? perDay.rest / stressed : null,
  }
}

/* ------------------------------------------------------------------ */
/* 15. Baselines and outlier days                                      */
/* ------------------------------------------------------------------ */

export interface Baseline { label: string; p10: number; p50: number; p90: number; latest: number | null; format: (v: number) => string }
export interface Outlier { day: string; text: string; metric: string; good: boolean; span: number }

function baselinesAndOutliers(data: InsightsPayload, from: string, to: string): { baselines: Baseline[]; outliers: Outlier[] } {
  const sleepMap = new Map(data.sleep.map((n) => [n.day, n]))
  const metrics: { label: string; noun: string; hi: string; lo: string; pick: (day: string) => number | null; higherIsBetter: boolean; format: (v: number) => string }[] = [
    { label: 'Resting HR', noun: 'resting heart rate', hi: 'Highest', lo: 'Lowest', pick: (d) => data.days.find((x) => x.day === d)?.restingHr ?? null, higherIsBetter: false, format: (v) => `${Math.round(v)} bpm` },
    { label: 'Sleep score', noun: 'sleep score', hi: 'Best', lo: 'Worst', pick: (d) => sleepMap.get(d)?.score ?? null, higherIsBetter: true, format: (v) => `${Math.round(v)}` },
    { label: 'Sleep', noun: 'night', hi: 'Longest', lo: 'Shortest', pick: (d) => sleepTotal(sleepMap.get(d)), higherIsBetter: true, format: fmtHM },
    { label: 'Deep sleep', noun: 'deep sleep', hi: 'Most', lo: 'Least', pick: (d) => sleepMap.get(d)?.deepS ?? null, higherIsBetter: true, format: fmtHM },
    { label: 'Stress', noun: 'stress day', hi: 'Most stressful', lo: 'Calmest', pick: (d) => data.days.find((x) => x.day === d)?.stressAvg ?? null, higherIsBetter: false, format: (v) => `${Math.round(v)}` },
    { label: 'Body Battery at wake', noun: 'wake-up Body Battery', hi: 'Best', lo: 'Lowest', pick: (d) => data.days.find((x) => x.day === d)?.bbWake ?? null, higherIsBetter: true, format: (v) => `${Math.round(v)}` },
    { label: 'Steps', noun: 'step count', hi: 'Highest', lo: 'Lowest', pick: (d) => data.days.find((x) => x.day === d)?.steps ?? null, higherIsBetter: true, format: (v) => Math.round(v).toLocaleString() },
    { label: 'Overnight HRV', noun: 'HRV', hi: 'Highest', lo: 'Lowest', pick: (d) => data.days.find((x) => x.day === d)?.hrvNight ?? null, higherIsBetter: true, format: (v) => `${Math.round(v)} ms` },
  ]
  const allDays = [...new Set([...data.days.map((d) => d.day), ...data.sleep.map((n) => n.day)])].sort()
  const baselines: Baseline[] = []
  const outliers: Outlier[] = []
  for (const m of metrics) {
    const series = allDays.map((day) => ({ day, v: m.pick(day) })).filter((p): p is { day: string; v: number } => isNum(p.v))
    if (series.length < 20) continue
    const window = series.filter((p) => dayNum(to) - dayNum(p.day) < 90).map((p) => p.v).sort((a, b) => a - b)
    if (window.length >= 10) {
      const q = (p: number): number => window[Math.min(window.length - 1, Math.floor(p * window.length))]
      baselines.push({ label: m.label, p10: q(0.1), p50: q(0.5), p90: q(0.9), latest: series[series.length - 1]?.v ?? null, format: m.format })
    }
    // "Best/worst in N days": how far back until a more extreme value.
    for (let i = 0; i < series.length; i++) {
      const p = series[i]
      if (p.day < from || p.day > to) continue
      for (const dir of ['high', 'low'] as const) {
        let j = i - 1
        while (j >= 0 && (dir === 'high' ? series[j].v < p.v : series[j].v > p.v)) j--
        const span = j < 0 ? dayNum(p.day) - dayNum(series[0].day) : dayNum(p.day) - dayNum(series[j].day)
        if (span < 60 || i < 20) continue
        const good = (dir === 'high') === m.higherIsBetter
        const word = dir === 'high' ? m.hi : m.lo
        const whenText = j < 0 ? 'on record' : span >= 330 ? `in ${Math.round(span / 30.4)} months` : `in ${span} days`
        outliers.push({ day: p.day, metric: m.label, good, span, text: `${word} ${m.noun === 'stress day' ? 'day' : m.noun} ${whenText}: ${m.format(p.v)}` })
      }
    }
  }
  outliers.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.span - a.span))
  return { baselines, outliers: outliers.slice(0, 14) }
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export interface Advanced {
  from: string
  to: string
  load: LoadModel
  efficiency: Efficiency | null
  races: Record<RaceKey, RaceProgress>
  sleep: SleepAnalysis
  recovery: RecoveryAnalysis
  rhythm: RhythmRow[]
  months: MonthRow[]
  scale: ScaleCheck
  protein: ProteinAnalysis
  sports: SportDive[]
  stress: StressFingerprint | null
  baselines: Baseline[]
  outliers: Outlier[]
}

export function buildAdvanced(data: InsightsPayload, from: string, to: string): Advanced {
  const races = Object.fromEntries((['race5kS', 'race10kS', 'raceHalfS', 'raceMarathonS'] as const).map((k) => [k, raceProgress(data, k, from, to)])) as Record<RaceKey, RaceProgress>
  const sports = SPORTS.map((s) => sportDive(data, s.key, from, to)).filter((s): s is SportDive => s !== null).sort((a, b) => b.hours - a.hours)
  return {
    from, to,
    load: loadModel(data.activities, from, to),
    efficiency: efficiency(data.activities, 'run', from, to),
    races,
    sleep: sleepAnalysis(data, from, to),
    recovery: recoveryAnalysis(data, from, to),
    rhythm: weekdayRhythm(data, from, to),
    months: monthly(data, from, to),
    scale: scaleCheck(data, from, to),
    protein: protein(data, from, to),
    sports,
    stress: stressFingerprint(data, from, to),
    ...baselinesAndOutliers(data, from, to),
  }
}


