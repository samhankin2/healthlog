/**
 * Pace vs heart rate lab — pure analysis for the zoomable deep dive on the
 * Advanced insights page. SPEC §8 "Advanced insights".
 *
 * Model: across runs, speed rises roughly linearly with average heart rate
 * (speed = a + b·hr). The slope b lets any run be re-expressed at a reference
 * heart rate, so an easy 140-bpm jog and a 170-bpm tempo compare on one scale.
 * Blocks are stretches of running separated by 21+ days off; breaks are gaps
 * of 14+ days. Pace is seconds per km throughout (lower = faster).
 */
import type { InsightActivity } from './types'
import { dayNum, isNum, mean, median } from './insights.ts'

export interface Run {
  id: string
  day: string
  name: string | null
  treadmill: boolean
  hr: number
  speed: number // m/s
  paceS: number
  distanceM: number
  durationS: number
  cadence: number | null
  maxHr: number | null
}

export interface Fit { a: number; b: number; n: number; r: number | null }

export interface Filters { minKm: number; treadmill: boolean }

export function runsFrom(acts: InsightActivity[], f: Filters): Run[] {
  return acts
    .filter((a) => (a.type ?? '').includes('running'))
    .filter((a) => f.treadmill || !(a.type ?? '').includes('treadmill'))
    .filter((a) => isNum(a.avgHr) && a.avgHr >= 110 && a.avgHr <= 210)
    .filter((a) => isNum(a.distanceM) && a.distanceM >= Math.max(1000, f.minKm * 1000))
    .map((a) => {
      const t = (a.movingS ?? a.durationS) as number
      return { a, t }
    })
    .filter(({ a, t }) => isNum(t) && t > 0 && (a.distanceM as number) / t > 1.5 && (a.distanceM as number) / t < 7)
    .map(({ a, t }) => ({
      id: a.id,
      day: a.day,
      name: a.name,
      treadmill: (a.type ?? '').includes('treadmill'),
      hr: a.avgHr as number,
      speed: (a.distanceM as number) / t,
      paceS: t / ((a.distanceM as number) / 1000),
      distanceM: a.distanceM as number,
      durationS: t,
      cadence: a.cadence,
      maxHr: a.maxHr,
    }))
    .sort((x, y) => (x.day < y.day ? -1 : 1))
}

/** Least-squares speed = a + b·hr. */
export function fit(runs: Run[]): Fit | null {
  if (runs.length < 3) return null
  const mx = mean(runs.map((r) => r.hr)) as number
  const my = mean(runs.map((r) => r.speed)) as number
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const r of runs) {
    sxy += (r.hr - mx) * (r.speed - my)
    sxx += (r.hr - mx) ** 2
    syy += (r.speed - my) ** 2
  }
  const b = sxx ? sxy / sxx : 0
  return { a: my - b * mx, b, n: runs.length, r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null }
}

/**
 * A fit that is safe to extrapolate: a period with too few runs, or a slope
 * that is flat/negative (noise), borrows the global slope and keeps only its
 * own level.
 */
export function stableFit(runs: Run[], global: Fit): Fit | null {
  if (!runs.length) return null
  const own = runs.length >= 6 ? fit(runs) : null
  const hrSpread = Math.max(...runs.map((r) => r.hr)) - Math.min(...runs.map((r) => r.hr))
  if (own && own.b > 0.004 && hrSpread >= 12) return own
  const mx = mean(runs.map((r) => r.hr)) as number
  const my = mean(runs.map((r) => r.speed)) as number
  return { a: my - global.b * mx, b: global.b, n: runs.length, r: null }
}

export const speedAt = (f: Fit, hr: number): number => f.a + f.b * hr
export const paceAt = (f: Fit, hr: number): number | null => {
  const v = speedAt(f, hr)
  return v > 0.8 ? 1000 / v : null
}

/** One run re-expressed at `ref` bpm, using the global slope. */
export const adjustedPace = (r: Run, ref: number, slope: number): number => 1000 / Math.max(0.8, r.speed + slope * (ref - r.hr))

/* ------------------------------------------------------------------ */
/* blocks and breaks                                                   */
/* ------------------------------------------------------------------ */

export interface Block { index: number; from: string; to: string; runs: Run[]; fit: Fit | null }
export interface Break {
  from: string // last run before
  to: string // first run after
  days: number
  before: number | null // adjusted pace, last runs before
  after: number | null // adjusted pace, first runs after
  lossPct: number | null // positive = slower after
  backAfterDays: number | null // days from return until the rolling pace was back within 1%; null = not (yet) back
  /** True when the comeback block is the one you are in now. */
  ongoing?: boolean
  backRuns: number | null
}

export function blocks(runs: Run[], global: Fit, gapDays = 21): Block[] {
  const out: Block[] = []
  let cur: Run[] = []
  const flush = (): void => {
    if (cur.length) out.push({ index: out.length + 1, from: cur[0].day, to: cur[cur.length - 1].day, runs: cur, fit: stableFit(cur, global) })
    cur = []
  }
  for (const r of runs) {
    if (cur.length && dayNum(r.day) - dayNum(cur[cur.length - 1].day) >= gapDays) flush()
    cur.push(r)
  }
  flush()
  return out
}

export function breaks(runs: Run[], ref: number, slope: number, minDays = 14): Break[] {
  // Segments of running split at 14+ day gaps; segments under 3 runs (a lone
  // test run mid lay-off) count as part of the break, not as a comeback.
  const segs: Run[][] = []
  let cur: Run[] = []
  for (const r of runs) {
    if (cur.length && dayNum(r.day) - dayNum(cur[cur.length - 1].day) >= minDays) { segs.push(cur); cur = [] }
    cur.push(r)
  }
  if (cur.length) segs.push(cur)
  const real = segs.filter((s) => s.length >= 3)
  const adj = (xs: Run[]): number[] => xs.map((r) => adjustedPace(r, ref, slope))
  const out: Break[] = []
  for (let k = 1; k < real.length; k++) {
    const prev = real[k - 1]
    const next = real[k]
    // Form before the break: every run in the 45 days up to it (robust to one fast burst).
    const lastDay = prev[prev.length - 1].day
    const pre = runs.filter((r) => r.day <= lastDay && dayNum(lastDay) - dayNum(r.day) <= 45)
    const before = median(adj(pre.length >= 3 ? pre : prev.slice(-6)))
    const nextAdj = adj(next)
    const after = median(nextAdj.slice(0, 4))
    let backAfterDays: number | null = null
    let backRuns: number | null = null
    if (isNum(before) && isNum(after)) {
      if (after <= before * 1.01) {
        backAfterDays = 0
        backRuns = 1
      } else {
        for (let j = 3; j < next.length; j++) {
          if ((median(nextAdj.slice(j - 3, j + 1)) as number) <= before * 1.01) {
            backAfterDays = dayNum(next[j].day) - dayNum(next[0].day)
            backRuns = j + 1
            break
          }
        }
      }
    }
    const from = prev[prev.length - 1].day
    out.push({
      from, to: next[0].day, days: dayNum(next[0].day) - dayNum(from), before, after,
      lossPct: isNum(before) && isNum(after) ? ((after - before) / before) * 100 : null,
      backAfterDays, backRuns, ongoing: k === real.length - 1,
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* window analysis (the zoomed range)                                  */
/* ------------------------------------------------------------------ */

export interface Lab {
  runs: Run[] // filtered, all time
  global: Fit | null
  inWindow: Run[]
  earlier: Run[]
  recent: Run[]
  earlierFit: Fit | null
  recentFit: Fit | null
  table: { hr: number; earlier: number | null; recent: number | null; changePct: number | null }[]
  /** seg: the stretch of running between breaks; inBreak: a lone run during a lay-off (no trend). */
  trend: { day: string; adj: number; roll: number | null; rollN: number; run: Run; seg: number; inBreak: boolean }[]
  nowPace: number | null
  bestPace: { value: number; day: string } | null
  startPace: number | null
  efficiency: { day: string; value: number }[] // metres per heartbeat
  effNow: number | null
  effStart: number | null
  blocks: Block[]
  breaks: Break[]
  slopeSecPerBpm: number | null
}

export const TABLE_HRS = [130, 135, 140, 145, 150, 155, 160, 165, 170, 175]

export function buildLab(acts: InsightActivity[], f: Filters, ref: number, from: string, to: string): Lab {
  const runs = runsFrom(acts, f)
  const global = fit(runs)
  const slope = global && global.b > 0 ? global.b : 0.03
  const inWindow = runs.filter((r) => r.day >= from && r.day <= to)
  const half = Math.floor(inWindow.length / 2)
  const earlier = inWindow.slice(0, half)
  const recent = inWindow.slice(half)
  const g = global ?? { a: 0, b: slope, n: 0, r: null }
  const earlierFit = stableFit(earlier, g)
  const recentFit = stableFit(recent, g)
  const lo = Math.min(...inWindow.map((r) => r.hr), 999)
  const hi = Math.max(...inWindow.map((r) => r.hr), 0)
  const table = TABLE_HRS.filter((hr) => hr >= lo - 8 && hr <= hi + 8).map((hr) => {
    const e = earlierFit ? paceAt(earlierFit, hr) : null
    const r = recentFit ? paceAt(recentFit, hr) : null
    return { hr, earlier: e, recent: r, changePct: isNum(e) && isNum(r) ? ((e - r) / e) * 100 : null }
  })
  // Breaks split the trend: the rolling median never mixes runs from either
  // side of a break, and lone runs inside a break get no trend value.
  const allBreaks = breaks(runs, ref, slope)
  const trend = inWindow.map((r) => {
    const adj = adjustedPace(r, ref, slope)
    const inBreak = allBreaks.some((b) => r.day > b.from && r.day < b.to)
    const seg = allBreaks.filter((b) => b.to <= r.day).length
    return { day: r.day, adj, roll: null as number | null, rollN: 0, run: r, seg, inBreak }
  })
  for (const t of trend) {
    if (t.inBreak) continue
    const win = trend.filter((x) => !x.inBreak && x.seg === t.seg && x.day <= t.day && dayNum(t.day) - dayNum(x.day) < 28).map((x) => x.adj)
    t.rollN = win.length
    t.roll = win.length >= 3 ? (median(win) as number) : null
  }
  const rolls = trend.filter((t) => isNum(t.roll))
  const best = rolls.filter((t) => t.rollN >= 4).reduce<{ value: number; day: string } | null>((b, t) => (!b || (t.roll as number) < b.value ? { value: t.roll as number, day: t.day } : b), null)
  const efficiency = inWindow.map((r) => ({ day: r.day, value: (r.speed * 60) / r.hr }))
  const third = Math.max(1, Math.floor(efficiency.length / 3))
  const typicalSpeed = median(inWindow.map((r) => r.speed))
  return {
    runs, global, inWindow, earlier, recent, earlierFit, recentFit, table, trend,
    nowPace: rolls.length ? (rolls[rolls.length - 1].roll as number) : null,
    bestPace: best,
    startPace: rolls.length ? (rolls[0].roll as number) : null,
    efficiency,
    effNow: efficiency.length ? mean(efficiency.slice(-third).map((e) => e.value)) : null,
    effStart: efficiency.length ? mean(efficiency.slice(0, third).map((e) => e.value)) : null,
    blocks: blocks(runs, g),
    breaks: allBreaks.filter((b) => b.to >= from && b.from <= to),
    // d(pace)/d(hr) at your typical speed: how many s/km one extra bpm buys.
    slopeSecPerBpm: isNum(typicalSpeed) ? (1000 / (typicalSpeed * typicalSpeed)) * slope : null,
  }
}
