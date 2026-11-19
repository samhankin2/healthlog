/**
 * Weight trend analysis (pure). SPEC §10 "Weight view".
 *
 * A plain 7-day average is only as good as the weigh-ins inside it: with one
 * weigh-in in the window it *is* that weigh-in, water and all. The trend here
 * is an exponentially smoothed moving average over a daily axis instead —
 * the "trend weight" of the Hacker's Diet — so every weigh-in only nudges it
 * (by `ALPHA`), and a sparse week leans on the weeks before it:
 *
 * - days between two weigh-ins are linearly interpolated, so a gap neither
 *   freezes the trend nor lets the next weigh-in yank it;
 * - after the last weigh-in the trend is held flat — no new information;
 * - the seed is the mean of the first week's weigh-ins, not the first one.
 *
 * Rates come from a least-squares fit through the raw weigh-ins in a window
 * (robust to which days happened to be logged); period changes (week, month)
 * are trend at the period's end minus trend at the previous period's end.
 */
import { addDays, daysApart, today } from './format'

export const ALPHA = 0.1
export const KCAL_PER_KG = 7700
/** A rate needs this many weigh-ins spanning this many days to mean anything. */
export const RATE_RULES = { minWeighIns: 3, minSpanDays: 7 }

export interface WeighIn { date: string; weightKg: number }

export interface TrendDay {
  day: string
  /** The weigh-in that day, if any. */
  weightKg: number | null
  trendKg: number
  /** After the last weigh-in: held flat, not observed. */
  held: boolean
}

export interface Trend {
  days: TrendDay[]
  byDay: Map<string, TrendDay>
  first: string | null
  last: string | null
  end: string
}

function sortedUnique(entries: WeighIn[]): WeighIn[] {
  const byDate = new Map<string, number>()
  for (const e of entries) if (Number.isFinite(e.weightKg)) byDate.set(e.date, e.weightKg)
  return [...byDate].map(([date, weightKg]) => ({ date, weightKg })).sort((a, b) => a.date.localeCompare(b.date))
}

/** The smoothed daily trend from the first weigh-in to `end` (inclusive). */
export function buildTrend(entries: WeighIn[], end = today(), alpha = ALPHA): Trend {
  const sorted = sortedUnique(entries).filter((e) => e.date <= end)
  const days: TrendDay[] = []
  const byDay = new Map<string, TrendDay>()
  if (sorted.length === 0) return { days, byDay, first: null, last: null, end }

  const first = sorted[0].date
  const last = sorted[sorted.length - 1].date
  const firstWeek = sorted.filter((e) => daysApart(first, e.date) < 7)
  let trend = firstWeek.reduce((s, e) => s + e.weightKg, 0) / firstWeek.length

  let next = 0 // index of the next weigh-in at or after the current day
  const total = daysApart(first, end)
  for (let i = 0; i <= total; i++) {
    const day = addDays(first, i)
    while (next < sorted.length && sorted[next].date < day) next++
    const exact = next < sorted.length && sorted[next].date === day ? sorted[next].weightKg : null
    const held = day > last
    if (!held) {
      let input: number
      if (exact !== null) input = exact
      else {
        const a = sorted[next - 1]
        const b = sorted[next]
        const t = daysApart(a.date, day) / daysApart(a.date, b.date)
        input = a.weightKg + (b.weightKg - a.weightKg) * t
      }
      if (i > 0) trend += alpha * (input - trend)
    }
    const row = { day, weightKg: exact, trendKg: trend, held }
    days.push(row)
    byDay.set(day, row)
  }
  return { days, byDay, first, last, end }
}

/** Trend on a day; before the first weigh-in there is none. */
export function trendOn(trend: Trend, day: string): number | null {
  if (!trend.first || day < trend.first) return null
  if (day > trend.end) return trend.days[trend.days.length - 1]?.trendKg ?? null
  return trend.byDay.get(day)?.trendKg ?? null
}

export interface RateFit {
  kgPerWeek: number
  weighIns: number
  spanDays: number
  from: string
  to: string
}

/** Least-squares slope through the weigh-ins in the `days` days ending `end`. */
export function fitRate(entries: WeighIn[], end: string, days: number): RateFit | null {
  const from = addDays(end, -(days - 1))
  const pts = sortedUnique(entries).filter((e) => e.date >= from && e.date <= end)
  if (pts.length < RATE_RULES.minWeighIns) return null
  const spanDays = daysApart(pts[0].date, pts[pts.length - 1].date)
  if (spanDays < RATE_RULES.minSpanDays) return null
  const xs = pts.map((p) => daysApart(from, p.date))
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = pts.reduce((a, p) => a + p.weightKg, 0) / pts.length
  let num = 0
  let den = 0
  xs.forEach((x, i) => {
    num += (x - mx) * (pts[i].weightKg - my)
    den += (x - mx) ** 2
  })
  if (den === 0) return null
  return { kgPerWeek: (num / den) * 7, weighIns: pts.length, spanDays, from, to: end }
}

/** Trend change over the last `days` days; null when the trend does not reach back that far. */
export function trendChange(trend: Trend, end: string, days: number): number | null {
  const now = trendOn(trend, end)
  const then = trendOn(trend, addDays(end, -days))
  return now === null || then === null ? null : now - then
}

export interface Period {
  /** First day of the period (Monday, or the 1st). */
  key: string
  start: string
  end: string
  weighIns: number
  avgKg: number | null
  minKg: number | null
  maxKg: number | null
  /** Trend at the period's end (or today) minus trend at the previous period's end. */
  changeKg: number | null
  trendEndKg: number | null
  /** Still running (contains today). */
  current: boolean
  /** Starts before the first weigh-in, so the change covers only part of it. */
  partial: boolean
}

function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(y, m - 1, d).getDay() // 0 = Sunday
  return addDays(day, -((dow + 6) % 7))
}

function monthEnd(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  return addDays(next, -1)
}

function periods(entries: WeighIn[], trend: Trend, keys: string[], endOf: (key: string) => string): Period[] {
  const sorted = sortedUnique(entries)
  const out: Period[] = []
  for (const key of keys) {
    const end = endOf(key)
    const until = end < trend.end ? end : trend.end
    const inside = sorted.filter((e) => e.date >= key && e.date <= until).map((e) => e.weightKg)
    const atEnd = trendOn(trend, until)
    const partial = !!trend.first && key <= trend.first
    const before = partial ? trendOn(trend, trend.first as string) : trendOn(trend, addDays(key, -1))
    // Past the last weigh-in the trend is only held flat: no change to report.
    const unobserved = !!trend.last && key > trend.last
    out.push({
      key,
      start: key,
      end,
      weighIns: inside.length,
      avgKg: inside.length ? inside.reduce((a, b) => a + b, 0) / inside.length : null,
      minKg: inside.length ? Math.min(...inside) : null,
      maxKg: inside.length ? Math.max(...inside) : null,
      changeKg: atEnd === null || before === null || unobserved ? null : atEnd - before,
      trendEndKg: atEnd,
      current: trend.end >= key && trend.end <= end,
      partial,
    })
  }
  return out
}

/** Monday-start weeks from the first weigh-in's week to `trend.end`, oldest first. */
export function weeklyPeriods(entries: WeighIn[], trend: Trend): Period[] {
  if (!trend.first) return []
  const keys: string[] = []
  for (let k = mondayOf(trend.first); k <= trend.end; k = addDays(k, 7)) keys.push(k)
  return periods(entries, trend, keys, (k) => addDays(k, 6))
}

/** Calendar months from the first weigh-in's month to `trend.end`, oldest first. */
export function monthlyPeriods(entries: WeighIn[], trend: Trend): Period[] {
  if (!trend.first) return []
  const keys: string[] = []
  let [y, m] = trend.first.split('-').map(Number)
  for (;;) {
    const k = `${y}-${String(m).padStart(2, '0')}-01`
    if (k > trend.end) break
    keys.push(k)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return periods(entries, trend, keys, monthEnd)
}

export interface WeekdayBias {
  /** 0 = Monday … 6 = Sunday. */
  index: number
  label: string
  /** Mean of (weigh-in − trend) on this weekday, relative to the average day. */
  meanKg: number | null
  n: number
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * How far each weekday's weigh-ins sit above or below the trend, over `days`,
 * relative to the average weigh-in. While losing or gaining, the trend lags the
 * scale, so every raw residual leans one way; subtracting the overall mean
 * leaves only the weekday pattern.
 */
export function weekdayBias(trend: Trend, end: string, days: number): WeekdayBias[] {
  const from = addDays(end, -(days - 1))
  const sums = WEEKDAYS.map(() => ({ s: 0, n: 0 }))
  for (const d of trend.days) {
    if (d.weightKg === null || d.day < from || d.day > end) continue
    const [y, m, dd] = d.day.split('-').map(Number)
    const idx = (new Date(y, m - 1, dd).getDay() + 6) % 7
    sums[idx].s += d.weightKg - d.trendKg
    sums[idx].n++
  }
  const n = sums.reduce((a, v) => a + v.n, 0)
  const overall = n ? sums.reduce((a, v) => a + v.s, 0) / n : 0
  return sums.map((v, index) => ({ index, label: WEEKDAYS[index], meanKg: v.n ? v.s / v.n - overall : null, n: v.n }))
}

/**
 * Day-to-day noise: mean absolute gap between a weigh-in and the trend, after
 * removing the window's mean gap (the trend's lag behind a steady slope).
 */
export function noiseKg(trend: Trend, from: string, to: string): number | null {
  const gaps = trend.days.filter((d) => d.weightKg !== null && d.day >= from && d.day <= to).map((d) => (d.weightKg as number) - d.trendKg)
  if (gaps.length < 3) return null
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return gaps.reduce((a, g) => a + Math.abs(g - mean), 0) / gaps.length
}

export interface GoalEta {
  status: 'reached' | 'on-track' | 'wrong-way' | 'flat' | 'too-far'
  remainingKg: number
  weeks: number | null
  day: string | null
}

/** When the trend reaches `goal` at `kgPerWeek`. Beyond two years counts as "too far". */
export function goalEta(trendKg: number, goal: number, kgPerWeek: number | null, from = today()): GoalEta {
  const remainingKg = goal - trendKg
  if (Math.abs(remainingKg) < 0.1) return { status: 'reached', remainingKg, weeks: 0, day: from }
  if (kgPerWeek === null || Math.abs(kgPerWeek) < 0.05) return { status: 'flat', remainingKg, weeks: null, day: null }
  if (Math.sign(kgPerWeek) !== Math.sign(remainingKg)) return { status: 'wrong-way', remainingKg, weeks: null, day: null }
  const weeks = remainingKg / kgPerWeek
  if (weeks > 104) return { status: 'too-far', remainingKg, weeks, day: null }
  return { status: 'on-track', remainingKg, weeks, day: addDays(from, Math.round(weeks * 7)) }
}

/** Implied daily energy balance of a rate (kg/week → kcal/day). */
export function kcalPerDay(kgPerWeek: number): number {
  return (kgPerWeek * KCAL_PER_KG) / 7
}
