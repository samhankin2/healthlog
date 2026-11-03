/**
 * Garmin insights — the analysis behind the Insights tab. Framework-agnostic
 * and pure: `buildInsights(payload, from, to)` turns the rows from
 * `GET /api/insights` into everything the view draws. SPEC §8 "Insights view".
 *
 * Conventions:
 *   - A "night" belongs to the morning it ends on (sleep_nights.day).
 *   - A day's training affects the NEXT night (day + 1) and the next morning's
 *     resting HR / Body Battery.
 *   - Baselines are the 30 days before the day in question (the day excluded).
 *   - Findings only appear with >= MIN_GROUP observations per side and an
 *     effect above both a practical threshold and |Cohen's d| >= 0.3.
 */
import type { FitnessMetric, InsightActivity, InsightDay, InsightsPayload, PersonalRecord, SleepNight } from './types'

export type RangeKey = '30d' | '90d' | '6m' | '1y' | 'all'
export const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: '30d', label: '30D', days: 30 },
  { key: '90d', label: '90D', days: 90 },
  { key: '6m', label: '6M', days: 182 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: 'All', days: null },
]

/* ------------------------------------------------------------------ */
/* Small maths                                                         */
/* ------------------------------------------------------------------ */

export const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
export function mean(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter(isNum)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
export function sd(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter(isNum)
  if (v.length < 2) return null
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}
export function median(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter(isNum).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}
const sum = (xs: (number | null | undefined)[]): number => xs.filter(isNum).reduce((a, b) => a + b, 0)

/** Least-squares slope of value per day. */
export function slopePerDay(points: { day: string; value: number | null }[]): number | null {
  const pts = points.filter((p) => isNum(p.value)).map((p) => [dayNum(p.day), p.value as number] as const)
  if (pts.length < 5) return null
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length
  let num = 0
  let den = 0
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  return den ? num / den : null
}

/* ------------------------------------------------------------------ */
/* Dates (YYYY-MM-DD strings, local calendar)                          */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000
export const dayNum = (day: string): number => Math.round(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS)
export const numDay = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10)
export const shiftDay = (day: string, by: number): string => numDay(dayNum(day) + by)
/** 0 = Monday … 6 = Sunday. */
export const weekday = (day: string): number => (new Date(dayNum(day) * DAY_MS).getUTCDay() + 6) % 7
export const weekStart = (day: string): string => shiftDay(day, -weekday(day))
export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let n = dayNum(from), end = dayNum(to); n <= end; n++) out.push(numDay(n))
  return out
}

/** Minutes after midnight of a local timestamp; times before noon count as the next day (+1440) so bedtimes average sensibly. */
export function bedMinutes(ts: string | null): number | null {
  if (!ts || ts.length < 16) return null
  const m = +ts.slice(11, 13) * 60 + +ts.slice(14, 16)
  return m < 12 * 60 ? m + 1440 : m
}
export const clockMinutes = (ts: string | null): number | null => (ts && ts.length >= 16 ? +ts.slice(11, 13) * 60 + +ts.slice(14, 16) : null)

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function fmtHM(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return '—'
  const total = Math.round(seconds / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
/** 1350 (minutes, may exceed 1440) -> "22:30". */
export function fmtClockMin(minutes: number | null | undefined): string {
  if (!isNum(minutes)) return '—'
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
/** Race time: 1227 -> "20:27", 14055 -> "3:54:15". */
export function fmtRace(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}
export function fmtPaceSec(secPerKm: number | null | undefined): string {
  if (!isNum(secPerKm)) return '—'
  return `${fmtRace(secPerKm)}/km`
}
export function fmtSigned(v: number, digits = 0, unit = ''): string {
  const r = Number(v.toFixed(digits))
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(digits)}${unit}`
}
export function fmtKm(m: number | null | undefined): string {
  if (!isNum(m)) return '—'
  return m >= 100_000 ? `${Math.round(m / 1000).toLocaleString()} km` : `${(m / 1000).toFixed(1)} km`
}

/* ------------------------------------------------------------------ */
/* Sports                                                              */
/* ------------------------------------------------------------------ */

export type SportGroup = 'run' | 'ride' | 'swim' | 'strength' | 'other'
export const SPORTS: { key: SportGroup; label: string }[] = [
  { key: 'run', label: 'Run' },
  { key: 'ride', label: 'Ride' },
  { key: 'swim', label: 'Swim' },
  { key: 'strength', label: 'Strength' },
  { key: 'other', label: 'Other' },
]
export function sportGroup(type: string | null): SportGroup {
  const t = type ?? ''
  if (t.includes('running')) return 'run'
  if (t.includes('cycling') || t.includes('biking') || t.includes('ride')) return 'ride'
  if (t.includes('swim')) return 'swim'
  if (t.includes('strength')) return 'strength'
  return 'other'
}
const OTHER_LABELS: Record<string, string> = {
  tennis_v2: 'tennis', tennis: 'tennis', indoor_cardio: 'cardio', pilates: 'pilates', hiking: 'hiking', walking: 'walking',
  yoga: 'yoga', breathwork: 'breathwork', hiit: 'HIIT', transition_v2: 'transitions', multi_sport: 'multisport', padel: 'padel',
}
const otherLabel = (t: string | null): string => OTHER_LABELS[t ?? ''] ?? (t ?? 'other').replace(/_v\d+$/, '').replace(/_/g, ' ')

/* ------------------------------------------------------------------ */
/* Result shapes                                                       */
/* ------------------------------------------------------------------ */

export interface Point { day: string; value: number | null }

export interface Vital {
  key: 'rhr' | 'hrv' | 'sleep' | 'bb' | 'stress'
  label: string
  unit: string
  value: number | null
  baseline: number | null
  /** value - baseline */
  delta: number | null
  /** True when a higher value is better. */
  higherIsBetter: boolean
  spark: Point[]
  format: (v: number) => string
}

export interface RecoveryPart { label: string; score: number; weight: number; detail: string }
export interface Recovery { score: number; label: string; tone: 'great' | 'good' | 'fair' | 'low'; parts: RecoveryPart[] }

export interface Finding {
  id: string
  category: 'sleep' | 'training' | 'recovery' | 'stress' | 'trend'
  title: string
  body: string
  /** Comparison bars (absent for trend findings). */
  a?: { label: string; value: number; n: number }
  b?: { label: string; value: number; n: number }
  unit: string
  format: (v: number) => string
  /** Effect size used for ranking. */
  strength: number
  confidence: 'strong' | 'moderate' | 'suggestive'
  /** Whether the highlighted side (a) is the better outcome. */
  positive: boolean
}

export interface WeekSports { week: string; hours: Record<SportGroup, number>; total: number; sessions: number }

export interface Insights {
  from: string
  to: string
  hasData: boolean
  heroDay: string | null
  recovery: Recovery | null
  vitals: Vital[]
  heart: { rhr: Point[]; rhr7: Point[]; band: { day: string; lo: number; hi: number }[]; avg: number | null; slopePerMonth: number | null; min: number | null }
  stress: {
    series: Point[]
    series7: Point[]
    avg: number | null
    breakdown: { rest: number; low: number; medium: number; high: number }
    battery: { day: string; low: number; high: number; wake: number | null }[]
    avgWake: number | null
    avgCharge: number | null
  }
  sleep: {
    nights: SleepNight[]
    avgDuration: number | null
    avgScore: number | null
    avgBed: number | null
    avgWake: number | null
    bedSd: number | null
    stages: { deep: number; light: number; rem: number; awake: number }
    weekdayBed: number | null
    weekendBed: number | null
    weekdayDuration: number | null
    weekendDuration: number | null
    best: SleepNight | null
    worst: SleepNight | null
    score7: Point[]
    byWeekday: { weekday: number; duration: number | null; score: number | null }[]
  }
  fitness: {
    vo2: Point[]
    vo2Now: number | null
    vo2Change: number | null
    vo2Peak: number | null
    races: { key: 'race5kS' | 'race10kS' | 'raceHalfS' | 'raceMarathonS'; label: string; now: number | null; change: number | null; best: number | null; series: Point[] }[]
    status: { day: string; status: string }[]
    statusNow: string | null
    fitnessAge: number | null
    fitnessAgeChange: number | null
    load: { week: string; load: number | null; min: number | null; max: number | null }[]
  }
  training: {
    activities: InsightActivity[]
    totals: { key: SportGroup; label: string; sessions: number; durationS: number; distanceM: number; kcal: number }[]
    otherBreakdown: string
    sessions: number
    durationS: number
    distanceM: number
    kcal: number
    weeks: WeekSports[]
    calendar: { day: string; minutes: number; load: number }[]
    zones: number[]
    activeDays: number
    longest: InsightActivity | null
    farthest: InsightActivity | null
    avgWeeklyHours: number | null
    steps: { avg: number | null; goalDays: number; days: number; series: Point[] }
  }
  energy: {
    weeks: { week: string; intake: number | null; burn: number | null }[]
    loggedDays: number
    avgIntake: number | null
    avgBurn: number | null
    balance: number | null
    weightChange: number | null
    impliedKg: number | null
  } | null
  findings: Finding[]
  records: PersonalRecord[]
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

const inRange = <T extends { day: string }>(rows: T[], from: string, to: string): T[] => rows.filter((r) => r.day >= from && r.day <= to)

/** Trailing calendar-day mean (needs at least `minCount` values in the window). */
export function rolling(points: Point[], window = 7, minCount = 3): Point[] {
  const byDay = new Map(points.map((p) => [p.day, p.value]))
  return points.map((p) => {
    const vals: number[] = []
    for (let i = 0; i < window; i++) {
      const v = byDay.get(shiftDay(p.day, -i))
      if (isNum(v)) vals.push(v)
    }
    return { day: p.day, value: vals.length >= minCount ? vals.reduce((a, b) => a + b, 0) / vals.length : null }
  })
}

function baselineOf(map: Map<string, number | null>, day: string, days = 30): number | null {
  const vals: number[] = []
  for (let i = 1; i <= days; i++) {
    const v = map.get(shiftDay(day, -i))
    if (isNum(v)) vals.push(v)
  }
  return vals.length >= 7 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

const sleepTotal = (n: SleepNight): number | null => (isNum(n.deepS) || isNum(n.lightS) || isNum(n.remS) ? (n.deepS ?? 0) + (n.lightS ?? 0) + (n.remS ?? 0) : null)
const clamp = (v: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, v))

function recoveryFor(day: string, dayMap: Map<string, InsightDay>, sleepMap: Map<string, SleepNight>, rhrMap: Map<string, number | null>, hrvMap: Map<string, number | null>): Recovery | null {
  const parts: RecoveryPart[] = []
  const night = sleepMap.get(day)
  const d = dayMap.get(day)
  if (night && isNum(night.score)) parts.push({ label: 'Sleep', score: night.score, weight: 0.35, detail: `Sleep score ${night.score}` })
  if (d && isNum(d.bbWake)) parts.push({ label: 'Body Battery', score: d.bbWake, weight: 0.35, detail: `Woke at ${d.bbWake}` })
  const rhr = rhrMap.get(day)
  const rhrBase = baselineOf(rhrMap, day)
  if (isNum(rhr) && isNum(rhrBase)) {
    const diff = rhr - rhrBase
    parts.push({ label: 'Resting HR', score: clamp(60 - diff * 12), weight: 0.3, detail: `${rhr} bpm, ${fmtSigned(diff, 1)} vs your 30-day norm` })
  }
  const hrv = hrvMap.get(day)
  const hrvBase = baselineOf(hrvMap, day)
  if (isNum(hrv) && isNum(hrvBase) && hrvBase > 0) {
    const pct = (hrv - hrvBase) / hrvBase
    parts.push({ label: 'HRV', score: clamp(60 + pct * 250), weight: 0.25, detail: `${Math.round(hrv)} ms, ${fmtSigned(pct * 100, 0, '%')} vs norm` })
  }
  if (parts.length < 2) return null
  const w = parts.reduce((a, p) => a + p.weight, 0)
  const score = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0) / w)
  const [label, tone] = score >= 80 ? ['Primed', 'great'] as const : score >= 65 ? ['Ready', 'good'] as const : score >= 45 ? ['Go steady', 'fair'] as const : ['Recover', 'low'] as const
  return { score, label, tone, parts }
}

function confidenceOf(d: number): Finding['confidence'] {
  const a = Math.abs(d)
  return a >= 0.8 ? 'strong' : a >= 0.5 ? 'moderate' : 'suggestive'
}

const MIN_GROUP = 8

interface Compare {
  a: number[]
  b: number[]
  minDiff: number
}
/** Cohen's d with pooled SD; null when either side is too small or the effect too weak. */
function effect({ a, b, minDiff }: Compare): { ma: number; mb: number; d: number } | null {
  if (a.length < MIN_GROUP || b.length < MIN_GROUP) return null
  const ma = mean(a) as number
  const mb = mean(b) as number
  const sa = sd(a) ?? 0
  const sb = sd(b) ?? 0
  const pooled = Math.sqrt(((a.length - 1) * sa ** 2 + (b.length - 1) * sb ** 2) / (a.length + b.length - 2))
  if (!pooled) return null
  const d = (ma - mb) / pooled
  if (Math.abs(ma - mb) < minDiff || Math.abs(d) < 0.3) return null
  return { ma, mb, d }
}

function buildFindings(ctx: {
  nights: SleepNight[]
  sleepMap: Map<string, SleepNight>
  dayMap: Map<string, InsightDay>
  days: InsightDay[]
  acts: InsightActivity[]
  metrics: FitnessMetric[]
  from: string
  to: string
}): Finding[] {
  const { nights, sleepMap, dayMap, days, acts } = ctx
  const out: Finding[] = []
  const min = (v: number): string => `${Math.round(v)} min`
  const score = (v: number): string => `${Math.round(v)}`
  const bpm = (v: number): string => `${v.toFixed(1)} bpm`

  // Daily training summary
  const loadByDay = new Map<string, number>()
  const lateByDay = new Map<string, boolean>()
  const earlyByDay = new Map<string, boolean>()
  for (const a of acts) {
    loadByDay.set(a.day, (loadByDay.get(a.day) ?? 0) + (a.trainingLoad ?? (a.trainingEffect ?? 0) * 20))
    const startMin = clockMinutes(a.startLocal) ?? 0
    if (startMin >= 18 * 60) lateByDay.set(a.day, true)
    else earlyByDay.set(a.day, true)
  }
  const loads = [...loadByDay.values()].filter((v) => v > 0)
  const hardCut = Math.max(60, median(loads) ?? 60)

  // 1. Bedtime vs sleep score
  const withBed = nights.filter((n) => isNum(n.score) && isNum(bedMinutes(n.startLocal)))
  const bedMed = median(withBed.map((n) => bedMinutes(n.startLocal)))
  if (isNum(bedMed)) {
    const early = withBed.filter((n) => (bedMinutes(n.startLocal) as number) <= bedMed - 15).map((n) => n.score as number)
    const late = withBed.filter((n) => (bedMinutes(n.startLocal) as number) >= bedMed + 15).map((n) => n.score as number)
    const e = effect({ a: early, b: late, minDiff: 2 })
    if (e) {
      out.push({
        id: 'bedtime-score', category: 'sleep',
        title: e.d > 0 ? 'Earlier nights score higher' : 'You sleep better on later nights',
        body: `Going to bed before ${fmtClockMin(bedMed - 15)} averages a sleep score of ${score(e.ma)}, against ${score(e.mb)} after ${fmtClockMin(bedMed + 15)}.`,
        a: { label: `Before ${fmtClockMin(bedMed - 15)}`, value: e.ma, n: early.length },
        b: { label: `After ${fmtClockMin(bedMed + 15)}`, value: e.mb, n: late.length },
        unit: 'score', format: score, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d > 0,
      })
    }
  }

  // 2. Hard training day -> that night's deep sleep
  const trainingNight = (pick: (n: SleepNight) => number | null, hard: boolean): number[] =>
    days.map((d) => {
      const load = loadByDay.get(d.day) ?? 0
      if (hard ? load < hardCut : load > 0) return null
      const n = sleepMap.get(shiftDay(d.day, 1))
      return n ? pick(n) : null
    }).filter(isNum)
  {
    const hard = trainingNight((n) => (isNum(n.deepS) ? n.deepS / 60 : null), true)
    const rest = trainingNight((n) => (isNum(n.deepS) ? n.deepS / 60 : null), false)
    const e = effect({ a: hard, b: rest, minDiff: 5 })
    if (e) {
      out.push({
        id: 'training-deep', category: 'training',
        title: e.d > 0 ? 'Hard days buy you deep sleep' : 'Hard days cost you deep sleep',
        body: `After a day with a training load of ${Math.round(hardCut)}+ you get ${min(e.ma)} of deep sleep, against ${min(e.mb)} after a rest day.`,
        a: { label: 'After hard days', value: e.ma, n: hard.length },
        b: { label: 'After rest days', value: e.mb, n: rest.length },
        unit: 'min', format: min, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d > 0,
      })
    }
  }

  // 3. Hard training day -> next-morning resting HR
  {
    const morning = (hard: boolean): number[] => days.map((d) => {
      const load = loadByDay.get(d.day) ?? 0
      if (hard ? load < hardCut : load > 0) return null
      return dayMap.get(shiftDay(d.day, 1))?.restingHr ?? null
    }).filter(isNum)
    const hard = morning(true)
    const rest = morning(false)
    const e = effect({ a: hard, b: rest, minDiff: 0.7 })
    if (e) {
      out.push({
        id: 'training-rhr', category: 'recovery',
        title: e.d > 0 ? 'Big sessions show up in your morning heart rate' : 'Your heart rate settles after training',
        body: `Resting HR the morning after a hard day averages ${bpm(e.ma)}, against ${bpm(e.mb)} after a rest day — ${fmtSigned(e.ma - e.mb, 1)} bpm.`,
        a: { label: 'After hard days', value: e.ma, n: hard.length },
        b: { label: 'After rest days', value: e.mb, n: rest.length },
        unit: 'bpm', format: bpm, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d < 0,
      })
    }
  }

  // 4. Evening workouts -> sleep score
  {
    const scoreAfter = (pred: (day: string) => boolean): number[] =>
      days.filter((d) => pred(d.day)).map((d) => sleepMap.get(shiftDay(d.day, 1))?.score ?? null).filter(isNum)
    const late = scoreAfter((day) => lateByDay.get(day) === true)
    const early = scoreAfter((day) => earlyByDay.get(day) === true && !lateByDay.get(day))
    const e = effect({ a: early, b: late, minDiff: 2 })
    if (e) {
      out.push({
        id: 'late-training', category: 'training',
        title: e.d > 0 ? 'Evening sessions cost you sleep' : 'Evening sessions don’t hurt your sleep',
        body: `Training before 6 pm is followed by a sleep score of ${score(e.ma)}; after 6 pm, ${score(e.mb)}.`,
        a: { label: 'Trained before 6 pm', value: e.ma, n: early.length },
        b: { label: 'Trained after 6 pm', value: e.mb, n: late.length },
        unit: 'score', format: score, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d > 0,
      })
    }
  }

  // 5. Sleep length -> same-day stress
  {
    const durMed = median(nights.map(sleepTotal))
    if (isNum(durMed)) {
      const stressOn = (pred: (s: number) => boolean): number[] =>
        nights.filter((n) => isNum(sleepTotal(n)) && pred(sleepTotal(n) as number)).map((n) => dayMap.get(n.day)?.stressAvg ?? null).filter(isNum)
      const long = stressOn((s) => s >= durMed + 1800)
      const short = stressOn((s) => s <= durMed - 1800)
      const e = effect({ a: long, b: short, minDiff: 2 })
      if (e) {
        out.push({
          id: 'sleep-stress', category: 'stress',
          title: e.d < 0 ? 'Long nights take the edge off the day' : 'Short nights don’t raise your stress',
          body: `After ${fmtHM(durMed + 1800)}+ of sleep your day’s stress averages ${score(e.ma)}; after under ${fmtHM(durMed - 1800)}, ${score(e.mb)}.`,
          a: { label: `${fmtHM(durMed + 1800)}+ sleep`, value: e.ma, n: long.length },
          b: { label: `Under ${fmtHM(durMed - 1800)}`, value: e.mb, n: short.length },
          unit: 'stress', format: score, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d < 0,
        })
      }
    }
  }

  // 6. Stressful day -> next morning Body Battery
  {
    const stressMed = median(days.map((d) => d.stressAvg))
    if (isNum(stressMed)) {
      const wakeAfter = (pred: (s: number) => boolean): number[] =>
        days.filter((d) => isNum(d.stressAvg) && pred(d.stressAvg)).map((d) => dayMap.get(shiftDay(d.day, 1))?.bbWake ?? null).filter(isNum)
      const calm = wakeAfter((s) => s <= stressMed - 3)
      const tense = wakeAfter((s) => s >= stressMed + 3)
      const e = effect({ a: calm, b: tense, minDiff: 3 })
      if (e) {
        out.push({
          id: 'stress-battery', category: 'stress',
          title: e.d > 0 ? 'Calm days recharge you overnight' : 'Stress doesn’t dent your overnight recharge',
          body: `After a calm day (stress ≤ ${Math.round(stressMed - 3)}) you wake with a Body Battery of ${score(e.ma)}; after a tense one (≥ ${Math.round(stressMed + 3)}), ${score(e.mb)}.`,
          a: { label: 'After calm days', value: e.ma, n: calm.length },
          b: { label: 'After tense days', value: e.mb, n: tense.length },
          unit: 'Body Battery', format: score, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d > 0,
        })
      }
    }
  }

  // 7. Active days -> sleep score
  {
    const stepsMed = median(days.map((d) => d.steps))
    if (isNum(stepsMed)) {
      const after = (pred: (s: number) => boolean): number[] =>
        days.filter((d) => isNum(d.steps) && pred(d.steps)).map((d) => sleepMap.get(shiftDay(d.day, 1))?.score ?? null).filter(isNum)
      const hi = Math.round(stepsMed * 1.3 / 500) * 500
      const lo = Math.round(stepsMed * 0.7 / 500) * 500
      const active = after((s) => s >= hi)
      const still = after((s) => s <= lo)
      const e = effect({ a: active, b: still, minDiff: 2 })
      if (e) {
        out.push({
          id: 'steps-sleep', category: 'sleep',
          title: e.d > 0 ? 'Moving more means sleeping better' : 'Big step days don’t improve your sleep',
          body: `Nights after ${hi.toLocaleString()}+ steps score ${score(e.ma)}; after under ${lo.toLocaleString()} steps, ${score(e.mb)}.`,
          a: { label: `${hi.toLocaleString()}+ steps`, value: e.ma, n: active.length },
          b: { label: `Under ${lo.toLocaleString()}`, value: e.mb, n: still.length },
          unit: 'score', format: score, strength: Math.abs(e.d), confidence: confidenceOf(e.d), positive: e.d > 0,
        })
      }
    }
  }

  // 8. Weekend shift ("social jet lag"): Sat/Sun mornings vs Mon-Fri
  {
    const wk = nights.filter((n) => weekday(n.day) < 5).map((n) => bedMinutes(n.startLocal)).filter(isNum)
    const we = nights.filter((n) => weekday(n.day) >= 5).map((n) => bedMinutes(n.startLocal)).filter(isNum)
    if (wk.length >= MIN_GROUP && we.length >= 4) {
      const diff = (mean(we) as number) - (mean(wk) as number)
      if (Math.abs(diff) >= 25) {
        out.push({
          id: 'weekend-shift', category: 'sleep',
          title: diff > 0 ? `Weekends push bedtime ${Math.round(diff)} min later` : `You go to bed earlier at weekends`,
          body: `Weeknight bedtime averages ${fmtClockMin(mean(wk))}; Friday and Saturday nights, ${fmtClockMin(mean(we))}. Shifts over an hour act like mild jet lag on Monday.`,
          a: { label: 'Weeknights', value: mean(wk) as number, n: wk.length },
          b: { label: 'Fri & Sat', value: mean(we) as number, n: we.length },
          unit: 'clock', format: fmtClockMin, strength: Math.min(1.5, Math.abs(diff) / 60), confidence: Math.abs(diff) >= 60 ? 'strong' : 'moderate', positive: diff < 0,
        })
      }
    }
  }

  // 9. Trends over the range
  const vo2 = ctx.metrics.filter((m) => isNum(m.vo2max))
  if (vo2.length >= 2) {
    const change = (vo2[vo2.length - 1].vo2max as number) - (vo2[0].vo2max as number)
    if (Math.abs(change) >= 1) {
      out.push({
        id: 'vo2-trend', category: 'trend',
        title: change > 0 ? `VO₂ max up ${change.toFixed(0)} points` : `VO₂ max down ${Math.abs(change).toFixed(0)} points`,
        body: `From ${vo2[0].vo2max} to ${vo2[vo2.length - 1].vo2max} over this period. Each point is roughly 2–3 % on a 5K time.`,
        unit: '', format: (v) => v.toFixed(0), strength: Math.min(2, Math.abs(change) / 2), confidence: Math.abs(change) >= 2 ? 'strong' : 'moderate', positive: change > 0,
      })
    }
  }
  const rhrSlope = slopePerDay(days.map((d) => ({ day: d.day, value: d.restingHr })))
  if (isNum(rhrSlope) && days.length >= 45) {
    const perMonth = rhrSlope * 30
    if (Math.abs(perMonth) >= 0.4) {
      out.push({
        id: 'rhr-trend', category: 'trend',
        title: perMonth < 0 ? 'Your resting heart rate is falling' : 'Your resting heart rate is creeping up',
        body: `${fmtSigned(perMonth, 1)} bpm a month across this period. ${perMonth < 0 ? 'A falling RHR usually tracks rising aerobic fitness.' : 'Worth watching alongside sleep, stress and training load.'}`,
        unit: 'bpm', format: bpm, strength: Math.min(2, Math.abs(perMonth)), confidence: Math.abs(perMonth) >= 1 ? 'strong' : 'moderate', positive: perMonth < 0,
      })
    }
  }

  return out.sort((x, y) => y.strength - x.strength)
}

export function buildInsights(data: InsightsPayload, from: string, to: string): Insights {
  const allDays = data.days
  const allNights = data.sleep
  const days = inRange(allDays, from, to)
  const nights = inRange(allNights, from, to)
  const metrics = inRange(data.metrics, from, to)
  const acts = inRange(data.activities, from, to)
  const dayMap = new Map(allDays.map((d) => [d.day, d]))
  const sleepMap = new Map(allNights.map((n) => [n.day, n]))
  const rhrMap = new Map(allDays.map((d) => [d.day, d.restingHr]))
  const hrvMap = new Map(allDays.map((d) => [d.day, d.hrvNight]))

  // Hero day: the newest day with a night or a morning Body Battery.
  const heroDay = [...new Set([...allNights.map((n) => n.day), ...allDays.filter((d) => isNum(d.bbWake)).map((d) => d.day)])].filter((d) => d <= to).sort().pop() ?? null
  const recovery = heroDay ? recoveryFor(heroDay, dayMap, sleepMap, rhrMap, hrvMap) : null

  const spark = (pick: (day: string) => number | null): Point[] => (heroDay ? eachDay(shiftDay(heroDay, -29), heroDay).map((day) => ({ day, value: pick(day) })) : [])
  const vital = (key: Vital['key'], label: string, unit: string, higherIsBetter: boolean, pick: (day: string) => number | null, format: (v: number) => string): Vital => {
    // Today's partial day may not have a value yet: fall back to the day before.
    const value = heroDay ? pick(heroDay) ?? pick(shiftDay(heroDay, -1)) : null
    const map = new Map(allDays.map((d) => [d.day, pick(d.day)]))
    for (const n of allNights) if (!map.has(n.day)) map.set(n.day, pick(n.day))
    const baseline = heroDay ? baselineOf(map, heroDay) : null
    return { key, label, unit, value, baseline, delta: isNum(value) && isNum(baseline) ? value - baseline : null, higherIsBetter, spark: spark(pick), format }
  }
  const vitals: Vital[] = [
    vital('sleep', 'Sleep score', '', true, (d) => sleepMap.get(d)?.score ?? null, (v) => `${Math.round(v)}`),
    vital('bb', 'Body Battery at wake', '', true, (d) => dayMap.get(d)?.bbWake ?? null, (v) => `${Math.round(v)}`),
    vital('rhr', 'Resting HR', 'bpm', false, (d) => dayMap.get(d)?.restingHr ?? null, (v) => `${Math.round(v)}`),
    vital('hrv', 'Overnight HRV', 'ms', true, (d) => dayMap.get(d)?.hrvNight ?? null, (v) => `${Math.round(v)}`),
    vital('stress', 'Stress', '', false, (d) => dayMap.get(d)?.stressAvg ?? null, (v) => `${Math.round(v)}`),
  ].filter((v) => v.spark.some((p) => isNum(p.value)))

  // Heart
  const rangeDays = eachDay(from, to)
  const rhr = rangeDays.map((day) => ({ day, value: dayMap.get(day)?.restingHr ?? null }))
  const rhr7 = rolling(rhr)
  const band = rangeDays.map((day) => {
    const vals: number[] = []
    for (let i = 1; i <= 30; i++) {
      const v = rhrMap.get(shiftDay(day, -i))
      if (isNum(v)) vals.push(v)
    }
    if (vals.length < 10) return null
    const m = vals.reduce((a, b) => a + b, 0) / vals.length
    const s = sd(vals) ?? 0
    return { day, lo: m - s, hi: m + s }
  }).filter((b): b is { day: string; lo: number; hi: number } => b !== null)
  const rhrSlope = slopePerDay(rhr)

  // Stress & battery
  const stressSeries = rangeDays.map((day) => ({ day, value: dayMap.get(day)?.stressAvg ?? null }))
  const battery = days.filter((d) => isNum(d.bbLow) && isNum(d.bbHigh)).map((d) => ({ day: d.day, low: d.bbLow as number, high: d.bbHigh as number, wake: d.bbWake }))

  // Sleep
  const durations = nights.map(sleepTotal)
  const beds = nights.map((n) => bedMinutes(n.startLocal))
  const wakes = nights.map((n) => clockMinutes(n.endLocal))
  const stageSum = { deep: sum(nights.map((n) => n.deepS)), light: sum(nights.map((n) => n.lightS)), rem: sum(nights.map((n) => n.remS)), awake: sum(nights.map((n) => n.awakeS)) }
  const stageTotal = stageSum.deep + stageSum.light + stageSum.rem + stageSum.awake || 1
  const scored = nights.filter((n) => isNum(n.score))
  const isWeekendNight = (n: SleepNight): boolean => weekday(n.day) >= 5 // Fri & Sat nights end on Sat & Sun
  const weekdayNights = nights.filter((n) => !isWeekendNight(n))
  const weekendNights = nights.filter(isWeekendNight)

  // Fitness
  const vo2 = metrics.filter((m) => isNum(m.vo2max)).map((m) => ({ day: m.day, value: m.vo2max }))
  const lastWith = (key: keyof FitnessMetric): FitnessMetric | undefined => [...metrics].reverse().find((m) => m[key] !== null && m[key] !== undefined)
  const firstWith = (key: keyof FitnessMetric): FitnessMetric | undefined => metrics.find((m) => m[key] !== null && m[key] !== undefined)
  const RACE_LABELS = [['race5kS', '5K'], ['race10kS', '10K'], ['raceHalfS', 'Half marathon'], ['raceMarathonS', 'Marathon']] as const
  const races = RACE_LABELS.map(([key, label]) => {
    const series = metrics.filter((m) => isNum(m[key])).map((m) => ({ day: m.day, value: m[key] as number }))
    const now = series.length ? series[series.length - 1].value : null
    const first = series.length ? series[0].value : null
    return { key, label, now, change: isNum(now) && isNum(first) ? now - first : null, best: series.length ? Math.min(...series.map((p) => p.value)) : null, series }
  })
  const status: { day: string; status: string }[] = metrics.filter((m) => m.trainingStatus).map((m) => ({ day: m.day, status: m.trainingStatus as string }))
  const fa = lastWith('fitnessAge')
  const fa0 = firstWith('fitnessAge')
  const loadWeeks = new Map<string, FitnessMetric>()
  for (const m of metrics) if (isNum(m.weeklyLoad)) loadWeeks.set(weekStart(m.day), m) // last reading of each week

  // Training
  const totals = SPORTS.map(({ key, label }) => {
    const list = acts.filter((a) => sportGroup(a.type) === key)
    return { key, label, sessions: list.length, durationS: sum(list.map((a) => a.durationS)), distanceM: sum(list.map((a) => a.distanceM)), kcal: sum(list.map((a) => a.kcal)) }
  })
  const otherTypes = new Map<string, number>()
  for (const a of acts) if (sportGroup(a.type) === 'other') otherTypes.set(otherLabel(a.type), (otherTypes.get(otherLabel(a.type)) ?? 0) + 1)
  const otherBreakdown = [...otherTypes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => t).join(', ')
  const weeksMap = new Map<string, WeekSports>()
  for (let w = weekStart(from); w <= to; w = shiftDay(w, 7)) {
    weeksMap.set(w, { week: w, hours: { run: 0, ride: 0, swim: 0, strength: 0, other: 0 }, total: 0, sessions: 0 })
  }
  for (const a of acts) {
    const wk = weeksMap.get(weekStart(a.day))
    if (!wk || !isNum(a.durationS)) continue
    const h = a.durationS / 3600
    wk.hours[sportGroup(a.type)] += h
    wk.total += h
    wk.sessions++
  }
  const calMap = new Map<string, { minutes: number; load: number }>()
  for (const a of acts) {
    const c = calMap.get(a.day) ?? { minutes: 0, load: 0 }
    c.minutes += (a.durationS ?? 0) / 60
    c.load += a.trainingLoad ?? 0
    calMap.set(a.day, c)
  }
  const zones = [0, 0, 0, 0, 0, 0]
  for (const a of acts) a.hrZonesS?.forEach((z, i) => { if (i < 6) zones[i] += z })
  const weeks = [...weeksMap.values()]
  const fullWeeks = weeks.filter((w) => w.week >= from && shiftDay(w.week, 6) <= to)

  // Steps
  const stepDays = days.filter((d) => isNum(d.steps))
  const goalDays = stepDays.filter((d) => isNum(d.stepGoal) && (d.steps as number) >= (d.stepGoal as number)).length

  // Energy (needs meals logged in HealthLog)
  const intakeMap = new Map(data.intake.map((i) => [i.day, i.kcal]))
  const loggedDays = days.filter((d) => isNum(intakeMap.get(d.day)) && (intakeMap.get(d.day) as number) > 300 && isNum(d.totalKcal) && d.day < to)
  let energy: Insights['energy'] = null
  if (loggedDays.length >= 7) {
    const ew = new Map<string, { i: number[]; b: number[] }>()
    for (const d of loggedDays) {
      const w = weekStart(d.day)
      const e = ew.get(w) ?? { i: [], b: [] }
      e.i.push(intakeMap.get(d.day) as number)
      e.b.push(d.totalKcal as number)
      ew.set(w, e)
    }
    const avgIntake = mean(loggedDays.map((d) => intakeMap.get(d.day)))
    const avgBurn = mean(loggedDays.map((d) => d.totalKcal))
    const w = inRange(data.weights, from, to)
    const weightSlope = slopePerDay(w.map((x) => ({ day: x.day, value: x.weightKg })))
    const spanDays = dayNum(to) - dayNum(from) + 1
    energy = {
      weeks: [...ew.entries()].sort().map(([week, e]) => ({ week, intake: mean(e.i), burn: mean(e.b) })),
      loggedDays: loggedDays.length,
      avgIntake,
      avgBurn,
      balance: isNum(avgIntake) && isNum(avgBurn) ? avgIntake - avgBurn : null,
      weightChange: isNum(weightSlope) && w.length >= 4 ? weightSlope * spanDays : null,
      impliedKg: isNum(avgIntake) && isNum(avgBurn) ? ((avgIntake - avgBurn) * loggedDays.length) / 7700 : null,
    }
  }

  const longest = acts.reduce<InsightActivity | null>((best, a) => (isNum(a.durationS) && (!best || (a.durationS as number) > (best.durationS ?? 0)) ? a : best), null)
  const farthest = acts.filter((a) => sportGroup(a.type) === 'run').reduce<InsightActivity | null>((best, a) => (isNum(a.distanceM) && (!best || (a.distanceM as number) > (best.distanceM ?? 0)) ? a : best), null)

  return {
    from,
    to,
    hasData: allDays.length + allNights.length + data.activities.length > 0,
    heroDay,
    recovery,
    vitals,
    heart: { rhr, rhr7, band, avg: mean(rhr.map((p) => p.value)), slopePerMonth: isNum(rhrSlope) ? rhrSlope * 30 : null, min: rhr.some((p) => isNum(p.value)) ? Math.min(...rhr.map((p) => p.value).filter(isNum)) : null },
    stress: {
      series: stressSeries,
      series7: rolling(stressSeries),
      avg: mean(days.map((d) => d.stressAvg)),
      breakdown: { rest: sum(days.map((d) => d.stressRestS)), low: sum(days.map((d) => d.stressLowS)), medium: sum(days.map((d) => d.stressMediumS)), high: sum(days.map((d) => d.stressHighS)) },
      battery,
      avgWake: mean(days.map((d) => d.bbWake)),
      avgCharge: mean(days.map((d) => d.bbCharged)),
    },
    sleep: {
      nights,
      avgDuration: mean(durations),
      avgScore: mean(nights.map((n) => n.score)),
      avgBed: mean(beds),
      avgWake: mean(wakes),
      bedSd: sd(beds),
      stages: { deep: stageSum.deep / stageTotal, light: stageSum.light / stageTotal, rem: stageSum.rem / stageTotal, awake: stageSum.awake / stageTotal },
      weekdayBed: mean(weekdayNights.map((n) => bedMinutes(n.startLocal))),
      weekendBed: mean(weekendNights.map((n) => bedMinutes(n.startLocal))),
      weekdayDuration: mean(weekdayNights.map(sleepTotal)),
      weekendDuration: mean(weekendNights.map(sleepTotal)),
      best: scored.reduce<SleepNight | null>((b, n) => (!b || (n.score as number) > (b.score as number) ? n : b), null),
      worst: scored.reduce<SleepNight | null>((b, n) => (!b || (n.score as number) < (b.score as number) ? n : b), null),
      score7: rolling(rangeDays.map((day) => ({ day, value: sleepMap.get(day)?.score ?? null }))),
      byWeekday: [0, 1, 2, 3, 4, 5, 6].map((wd) => {
        // Label by the night's start: the night ending on day d started on weekday(d) - 1.
        const list = nights.filter((n) => (weekday(n.day) + 6) % 7 === wd)
        return { weekday: wd, duration: mean(list.map(sleepTotal)), score: mean(list.map((n) => n.score)) }
      }),
    },
    fitness: {
      vo2,
      vo2Now: vo2.length ? (vo2[vo2.length - 1].value as number) : null,
      vo2Change: vo2.length >= 2 ? (vo2[vo2.length - 1].value as number) - (vo2[0].value as number) : null,
      vo2Peak: vo2.length ? Math.max(...vo2.map((p) => p.value as number)) : null,
      races,
      status,
      statusNow: status.length ? status[status.length - 1].status : null,
      fitnessAge: fa?.fitnessAge ?? null,
      fitnessAgeChange: fa && fa0 && isNum(fa.fitnessAge) && isNum(fa0.fitnessAge) ? fa.fitnessAge - fa0.fitnessAge : null,
      load: [...loadWeeks.entries()].map(([week, m]) => ({ week, load: m.weeklyLoad, min: m.loadMin, max: m.loadMax })),
    },
    training: {
      activities: acts,
      totals,
      otherBreakdown,
      sessions: acts.length,
      durationS: sum(acts.map((a) => a.durationS)),
      distanceM: sum(acts.map((a) => a.distanceM)),
      kcal: sum(acts.map((a) => a.kcal)),
      weeks,
      calendar: [...calMap.entries()].map(([day, c]) => ({ day, ...c })),
      zones,
      activeDays: calMap.size,
      longest,
      farthest,
      avgWeeklyHours: fullWeeks.length ? mean(fullWeeks.map((w) => w.total)) : null,
      steps: { avg: mean(stepDays.map((d) => d.steps)), goalDays, days: stepDays.length, series: rangeDays.map((day) => ({ day, value: dayMap.get(day)?.steps ?? null })) },
    },
    energy,
    findings: buildFindings({ nights, sleepMap, dayMap, days, acts, metrics, from, to }),
    records: data.records,
  }
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export const STATUS_LABELS: Record<string, string> = {
  PRODUCTIVE: 'Productive', MAINTAINING: 'Maintaining', RECOVERY: 'Recovery', PEAKING: 'Peaking',
  OVERREACHING: 'Overreaching', UNPRODUCTIVE: 'Unproductive', DETRAINING: 'Detraining', STRAINED: 'Strained', NO_STATUS: 'No status',
}
export const statusLabel = (s: string | null): string => (s ? STATUS_LABELS[s] ?? s.toLowerCase().replace(/_/g, ' ') : '—')

/** Human value for a Garmin personal record (the export mixes units by type). */
export function fmtRecord(r: PersonalRecord): { label: string; value: string; group: 'run' | 'ride' | 'swim' | 'steps' | 'other' } {
  const t = r.type
  const lower = t.toLowerCase()
  const group = lower.includes('swim') ? 'swim' : lower.includes('cycle') || lower.includes('power') || lower.includes('elevation') ? 'ride' : lower.includes('run') || lower.includes('marathon') || lower.includes('mile') ? 'run' : lower.includes('step') || lower.includes('streak') ? 'steps' : 'other'
  let value: string
  if (/^best /i.test(t) || lower.includes('half marathon')) value = fmtRace(r.value)
  else if (lower.startsWith('farthest') || lower.startsWith('longest pool') || lower.startsWith('longest swim')) value = r.value >= 5000 ? fmtKm(r.value) : `${Math.round(r.value).toLocaleString()} m`
  else if (lower.includes('elevation')) value = `${Math.round(r.value).toLocaleString()} m`
  else if (lower.includes('power')) value = `${Math.round(r.value)} W`
  else if (lower.includes('streak')) value = `${Math.round(r.value)} days`
  else value = Math.round(r.value).toLocaleString()
  return { label: t.replace(/^Best /, '').replace(/^Most /, ''), value, group }
}
