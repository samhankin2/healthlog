/**
 * Lifting analysis — pure, framework-agnostic (SPEC §6 "Lifting").
 *
 * Definitions:
 * - Hard set: any set that is not a warm-up (working, drop, failure).
 * - e1RM (estimated one-rep max): Epley, weight × (1 + reps / 30); a single is
 *   its own weight; sets over 12 reps are too far from a max to estimate one.
 * - Load of a set: the weight lifted. Bodyweight lifts add the nearest weigh-in
 *   (on or before the day, else the first after) to the added load.
 * - Progression: the best e1RM in the last 4 weeks of training for a lift vs the
 *   4 weeks before. +1 % or more is progressing, -3 % or worse is regressing.
 *   A lift with no new best in its last 3 sessions is stalled.
 * - Lift load (for Insights): 5 per hard set at RPE 8 (or no RPE), scaled by
 *   effort — (RPE - 5) / 3, clamped 0.4–1.7 — plus 1 per warm-up. A 20-set
 *   session lands near 100, the load Garmin gives a moderate 50-minute run;
 *   the watch's own strength load (heart rate only) is usually far lower.
 */
import type { Equipment, Exercise, InsightActivity, InsightsPayload, LiftSet, LiftingPayload, Muscle, SetKind, Workout } from './types'
import { dayNum, isNum, shiftDay, weekStart } from './insights'

export const MUSCLES: { key: Muscle; label: string }[] = [
  { key: 'chest', label: 'Chest' },
  { key: 'back', label: 'Back' },
  { key: 'shoulders', label: 'Shoulders' },
  { key: 'biceps', label: 'Biceps' },
  { key: 'triceps', label: 'Triceps' },
  { key: 'quads', label: 'Quads' },
  { key: 'hamstrings', label: 'Hamstrings' },
  { key: 'glutes', label: 'Glutes' },
  { key: 'calves', label: 'Calves' },
  { key: 'core', label: 'Core' },
  { key: 'other', label: 'Other' },
]
export const MUSCLE_LABEL = Object.fromEntries(MUSCLES.map((m) => [m.key, m.label])) as Record<Muscle, string>

export const EQUIPMENT: { key: Equipment; label: string }[] = [
  { key: 'barbell', label: 'Barbell' },
  { key: 'dumbbell', label: 'Dumbbell' },
  { key: 'machine', label: 'Machine' },
  { key: 'cable', label: 'Cable' },
  { key: 'bodyweight', label: 'Bodyweight' },
  { key: 'kettlebell', label: 'Kettlebell' },
  { key: 'other', label: 'Other' },
]
export const EQUIPMENT_LABEL = Object.fromEntries(EQUIPMENT.map((e) => [e.key, e.label])) as Record<Equipment, string>

export const KIND_LABEL: Record<SetKind, string> = { working: 'Working', warmup: 'Warm-up', drop: 'Drop set', failure: 'To failure' }
export const KIND_SHORT: Record<SetKind, string> = { working: '', warmup: 'W', drop: 'D', failure: 'F' }

/** Weekly hard sets per muscle that most hypertrophy research lands on. */
export const VOLUME_BAND = { lo: 10, hi: 20 }

export const isHard = (s: LiftSet): boolean => s.kind !== 'warmup'

export function e1rm(weightKg: number, reps: number): number | null {
  if (!(weightKg > 0) || reps < 1 || reps > 12) return null
  return reps === 1 ? weightKg : weightKg * (1 + reps / 30)
}

const STEP: Record<Equipment, number> = { barbell: 2.5, dumbbell: 2, machine: 2.5, cable: 2.5, bodyweight: 2.5, kettlebell: 4, other: 2.5 }
export const defaultIncrement = (ex: Pick<Exercise, 'equipment' | 'incrementKg'>): number => ex.incrementKg ?? STEP[ex.equipment]

/** Round to the nearest 0.25 kg so stepping never shows 82.49999. */
export const roundKg = (v: number): number => Math.round(v * 4) / 4
export const fmtW = (v: number): string => String(Math.round(v * 100) / 100)
export function fmtTonnage(kg: number): string {
  if (kg >= 10_000) return `${(kg / 1000).toFixed(1)} t`
  if (kg >= 1000) return `${(kg / 1000).toFixed(2)} t`
  return `${Math.round(kg)} kg`
}

/* ------------------------------------------------------------------ */
/* Bodyweight                                                          */
/* ------------------------------------------------------------------ */

export type BodyweightAt = (day: string) => number | null

/** Nearest weigh-in on or before the day, else the first one after it. */
export function bodyweightLookup(weights: { day: string; weightKg: number }[]): BodyweightAt {
  const sorted = [...weights].filter((w) => isNum(w.weightKg)).sort((a, b) => (a.day < b.day ? -1 : 1))
  return (day) => {
    if (!sorted.length) return null
    let lo = 0
    let hi = sorted.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].day <= day) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    return (found >= 0 ? sorted[found] : sorted[0]).weightKg
  }
}

/** The weight actually moved: bodyweight lifts include the lifter. */
export function setLoad(set: Pick<LiftSet, 'weightKg'>, ex: Pick<Exercise, 'equipment'>, bw: number | null): number {
  return ex.equipment === 'bodyweight' ? (bw ?? 0) + set.weightKg : set.weightKg
}

/* ------------------------------------------------------------------ */
/* Per-exercise history                                                */
/* ------------------------------------------------------------------ */

export type PrKind = 'e1rm' | 'weight' | 'reps'
export const PR_LABEL: Record<PrKind, string> = { e1rm: 'Best e1RM', weight: 'Heaviest', reps: 'Rep PR' }

export interface SessionLine {
  workoutId: string
  day: string
  sets: LiftSet[]
  hard: LiftSet[]
  /** Best e1RM of the session (by total load), or best reps when there is no load. */
  best: number | null
  heaviest: number
  volume: number
  reps: number
  /** Set ids that set a record when they were lifted, with the kind. */
  prs: { setId: string; kinds: PrKind[] }[]
}

export type LiftStatus = 'new' | 'progressing' | 'steady' | 'stalled' | 'regressing'
export const STATUS_LABEL: Record<LiftStatus, string> = { new: 'New', progressing: 'Progressing', steady: 'Steady', stalled: 'Stalled', regressing: 'Slipping' }

export interface Target {
  weightKg: number
  reps: number[]
  note: string
}

export interface ExerciseStats {
  exercise: Exercise
  sessions: SessionLine[]
  /** 'reps' for bodyweight lifts with no added load and no weigh-ins. */
  metric: 'e1rm' | 'reps'
  best: { value: number; day: string; weightKg: number; reps: number } | null
  heaviest: { weightKg: number; reps: number; day: string } | null
  bestVolume: { value: number; day: string } | null
  repMaxes: { reps: number; weightKg: number; day: string }[]
  status: LiftStatus
  /** Best in the last 4 training weeks vs the 4 before, in percent. */
  change: number | null
  sessionsSinceBest: number
  next: Target | null
  lastDay: string | null
}

const REP_MAX_COLUMNS = [1, 3, 5, 8, 10, 12]

interface Running { bestE1rm: number; heaviest: number; repsAt: { load: number; reps: number }[]; seen: boolean }

function prKinds(load: number, reps: number, run: Running, metric: 'e1rm' | 'reps'): PrKind[] {
  if (!run.seen) return []
  const out: PrKind[] = []
  if (metric === 'reps') {
    if (reps > run.bestE1rm) out.push('reps')
    return out
  }
  const est = e1rm(load, reps)
  if (isNum(est) && est > run.bestE1rm + 1e-9) out.push('e1rm')
  if (load > run.heaviest + 1e-9) out.push('weight')
  else if (!out.length && run.repsAt.every((r) => r.load < load - 1e-9 || r.reps < reps)) out.push('reps')
  return out
}

function absorb(load: number, reps: number, run: Running, metric: 'e1rm' | 'reps'): void {
  run.seen = true
  if (metric === 'reps') { run.bestE1rm = Math.max(run.bestE1rm, reps); return }
  const est = e1rm(load, reps)
  if (isNum(est)) run.bestE1rm = Math.max(run.bestE1rm, est)
  run.heaviest = Math.max(run.heaviest, load)
  run.repsAt.push({ load, reps })
}

/** Workouts in chronological order (day, then start). */
export function sortWorkouts(workouts: Workout[]): Workout[] {
  return [...workouts].sort((a, b) => (a.day === b.day ? (a.startedAt ?? '').localeCompare(b.startedAt ?? '') : a.day < b.day ? -1 : 1))
}

export function exerciseStats(ex: Exercise, workouts: Workout[], bw: BodyweightAt): ExerciseStats {
  const ordered = sortWorkouts(workouts)
  const raw = ordered.map((w) => ({ w, sets: w.sets.filter((s) => s.exerciseId === ex.id) })).filter((x) => x.sets.length)
  const anyLoad = raw.some((x) => x.sets.some((s) => setLoad(s, ex, bw(x.w.day)) > 0))
  const metric: 'e1rm' | 'reps' = anyLoad ? 'e1rm' : 'reps'
  const run: Running = { bestE1rm: 0, heaviest: 0, repsAt: [], seen: false }

  const sessions: SessionLine[] = raw.map(({ w, sets }) => {
    const b = bw(w.day)
    const hard = sets.filter(isHard)
    const prs: SessionLine['prs'] = []
    let best: number | null = null
    let heaviest = 0
    let volume = 0
    let reps = 0
    const before: Running = { ...run, repsAt: [...run.repsAt] }
    for (const s of hard) {
      const load = setLoad(s, ex, b)
      const kinds = prKinds(load, s.reps, before, metric)
      if (kinds.length) prs.push({ setId: s.id, kinds })
      absorb(load, s.reps, before, metric)
      const v = metric === 'reps' ? s.reps : e1rm(load, s.reps)
      if (isNum(v)) best = Math.max(best ?? 0, v)
      heaviest = Math.max(heaviest, load)
      volume += load * s.reps
      reps += s.reps
    }
    Object.assign(run, before)
    return { workoutId: w.id, day: w.day, sets, hard, best, heaviest, volume, reps, prs }
  })

  // Records
  let best: ExerciseStats['best'] = null
  let heaviest: ExerciseStats['heaviest'] = null
  let bestVolume: ExerciseStats['bestVolume'] = null
  const repMax = new Map<number, { weightKg: number; day: string }>()
  for (const s of sessions) {
    const b = bw(s.day)
    for (const set of s.hard) {
      const load = setLoad(set, ex, b)
      const v = metric === 'reps' ? set.reps : e1rm(load, set.reps)
      if (isNum(v) && (!best || v > best.value)) best = { value: v, day: s.day, weightKg: load, reps: set.reps }
      if (load > 0 && (!heaviest || load > heaviest.weightKg || (load === heaviest.weightKg && set.reps > heaviest.reps))) heaviest = { weightKg: load, reps: set.reps, day: s.day }
      for (const col of REP_MAX_COLUMNS) {
        if (set.reps >= col && load > 0 && load > (repMax.get(col)?.weightKg ?? 0)) repMax.set(col, { weightKg: load, day: s.day })
      }
    }
    if (s.volume > 0 && (!bestVolume || s.volume > bestVolume.value)) bestVolume = { value: s.volume, day: s.day }
  }
  const repMaxes = REP_MAX_COLUMNS.filter((c) => repMax.has(c)).map((c) => ({ reps: c, ...repMax.get(c)! }))

  // Progression
  const scored = sessions.filter((s) => isNum(s.best))
  let bestIdx = -1
  scored.forEach((s, i) => { if (bestIdx < 0 || (s.best as number) > (scored[bestIdx].best as number) + 1e-9) bestIdx = i })
  const sessionsSinceBest = bestIdx < 0 ? 0 : scored.length - 1 - bestIdx
  const lastDay = sessions.length ? sessions[sessions.length - 1].day : null
  let change: number | null = null
  if (lastDay && scored.length >= 2) {
    const end = dayNum(lastDay)
    const recent = scored.filter((s) => dayNum(s.day) > end - 28)
    let prior = scored.filter((s) => dayNum(s.day) <= end - 28 && dayNum(s.day) > end - 56)
    if (!prior.length) prior = scored.filter((s) => dayNum(s.day) <= end - 28)
    const rMax = Math.max(...recent.map((s) => s.best as number))
    const pMax = prior.length ? Math.max(...prior.map((s) => s.best as number)) : NaN
    if (recent.length && pMax > 0) change = ((rMax - pMax) / pMax) * 100
  }
  let status: LiftStatus = 'new'
  if (scored.length >= 2) {
    if (isNum(change) && change <= -3) status = 'regressing'
    else if (sessionsSinceBest === 0 || (isNum(change) && change >= 1)) status = 'progressing'
    else if (sessionsSinceBest >= 3) status = 'stalled'
    else status = 'steady'
  }

  const last = sessions[sessions.length - 1]
  return {
    exercise: ex, sessions, metric, best, heaviest, bestVolume, repMaxes, status, change, sessionsSinceBest,
    next: last ? suggestNext(ex, last.sets, metric) : null, lastDay,
  }
}

export function allExerciseStats(exercises: Exercise[], workouts: Workout[], bw: BodyweightAt): Map<string, ExerciseStats> {
  return new Map(exercises.map((ex) => [ex.id, exerciseStats(ex, workouts, bw)]))
}

/**
 * Double progression from the last session's working sets at their top weight:
 * every set matched the first → add one increment (same reps for sets of 6 or
 * fewer, two fewer above that); otherwise keep the weight and add a rep to the
 * weakest set.
 */
export function suggestNext(ex: Exercise, sets: LiftSet[], metric: 'e1rm' | 'reps'): Target | null {
  const working = sets.filter((s) => s.kind === 'working' || s.kind === 'failure')
  if (!working.length) return null
  const top = Math.max(...working.map((s) => s.weightKg))
  const atTop = working.filter((s) => Math.abs(s.weightKg - top) < 1e-9).map((s) => s.reps)
  const first = atTop[0]
  const minIdx = atTop.indexOf(Math.min(...atTop))
  const sameWeight = (): Target => ({
    weightKg: top,
    reps: atTop.map((r, i) => (i === minIdx ? r + 1 : r)),
    note: atTop.length > 1 ? 'Same weight — add a rep to your weakest set' : 'Same weight — one more rep',
  })
  if (metric === 'reps') return sameWeight()
  if (first >= 5 && atTop.every((r) => r >= first)) {
    const reps = first <= 6 ? first : Math.max(5, first - 2)
    return { weightKg: roundKg(top + defaultIncrement(ex)), reps: atTop.map(() => reps), note: `Every set hit ${first} — add ${fmtW(defaultIncrement(ex))} kg` }
  }
  return sameWeight()
}

/** Live PR check for a set about to be logged, against everything before it. */
export function livePrs(ex: Exercise, set: Pick<LiftSet, 'weightKg' | 'reps' | 'kind'>, history: Workout[], current: Workout, bw: BodyweightAt): PrKind[] {
  if (set.kind === 'warmup') return []
  const before = history.filter((w) => w.id !== current.id && (w.day < current.day || (w.day === current.day && (w.startedAt ?? '') < (current.startedAt ?? ''))))
  const stats = exerciseStats(ex, [...before, { ...current, sets: current.sets.filter((s) => s.exerciseId === ex.id) }], bw)
  const metric = stats.metric === 'reps' && setLoad(set, ex, bw(current.day)) > 0 ? 'e1rm' : stats.metric
  const run: Running = { bestE1rm: 0, heaviest: 0, repsAt: [], seen: false }
  for (const s of stats.sessions) {
    const b = bw(s.day)
    for (const h of s.hard) absorb(setLoad(h, ex, b), h.reps, run, metric)
  }
  return prKinds(setLoad(set, ex, bw(current.day)), set.reps, run, metric)
}

/** "80 × 8, 8, 7 · 85 × 5": consecutive sets at one weight grouped. */
export function fmtSets(sets: LiftSet[], ex?: Pick<Exercise, 'equipment'>): string {
  const groups: { w: number; reps: number[] }[] = []
  for (const s of sets) {
    const g = groups[groups.length - 1]
    if (g && g.w === s.weightKg) g.reps.push(s.reps)
    else groups.push({ w: s.weightKg, reps: [s.reps] })
  }
  return groups.map((g) => `${ex?.equipment === 'bodyweight' ? (g.w > 0 ? `BW+${fmtW(g.w)}` : 'BW') : fmtW(g.w)} × ${g.reps.join(', ')}`).join(' · ')
}

/* ------------------------------------------------------------------ */
/* Workouts                                                            */
/* ------------------------------------------------------------------ */

const STALE_GAP_S = 4 * 3600

/** Logged duration, else first-to-last set plus a closing rest, else an estimate from the sets. */
export function workoutDurationS(w: Workout, now = Date.now()): number {
  const start = w.startedAt ? Date.parse(w.startedAt) : NaN
  const end = w.endedAt ? Date.parse(w.endedAt) : NaN
  if (isNum(start) && isNum(end) && end > start && (end - start) / 1000 < STALE_GAP_S * 2) return (end - start) / 1000
  if (isNum(start) && !w.endedAt && now > start && (now - start) / 1000 < STALE_GAP_S) return (now - start) / 1000
  const done = w.sets.map((s) => (s.doneAt ? Date.parse(s.doneAt) : NaN)).filter(isNum)
  if (done.length >= 2) return (Math.max(...done) - Math.min(...done)) / 1000 + 120
  return w.sets.filter(isHard).length * 150 + w.sets.filter((s) => !isHard(s)).length * 60
}

export function liftLoad(w: Workout): number {
  let load = 0
  for (const s of w.sets) {
    if (!isHard(s)) { load += 1; continue }
    const effort = isNum(s.rpe) ? Math.min(1.7, Math.max(0.4, (s.rpe - 5) / 3)) : 1
    load += 5 * effort
  }
  return Math.round(load)
}

export interface WorkoutSummary {
  durationS: number
  hardSets: number
  volume: number
  reps: number
  exercises: string[]
  load: number
}

export function workoutSummary(w: Workout, exMap: Map<string, Exercise>, bw: BodyweightAt): WorkoutSummary {
  const b = bw(w.day)
  let volume = 0
  let reps = 0
  const exercises: string[] = []
  for (const s of w.sets) {
    if (!exercises.includes(s.exerciseId)) exercises.push(s.exerciseId)
    if (!isHard(s)) continue
    const ex = exMap.get(s.exerciseId)
    volume += (ex ? setLoad(s, ex, b) : s.weightKg) * s.reps
    reps += s.reps
  }
  return { durationS: workoutDurationS(w), hardSets: w.sets.filter(isHard).length, volume, reps, exercises, load: liftLoad(w) }
}

/** Exercise ids in the order they first appear in a workout. */
export const exerciseOrder = (w: Workout): string[] => [...new Set(w.sets.map((s) => s.exerciseId))]

/* ------------------------------------------------------------------ */
/* Volume by muscle                                                    */
/* ------------------------------------------------------------------ */

export interface MuscleWeek { week: string; sets: Record<Muscle, number>; total: number; volume: number; sessions: number }

const emptyMuscles = (): Record<Muscle, number> => Object.fromEntries(MUSCLES.map((m) => [m.key, 0])) as Record<Muscle, number>

/** Monday-start weeks from `from` to `to`, every week present (zeros included). */
export function muscleWeeks(workouts: Workout[], exMap: Map<string, Exercise>, from: string, to: string, bw: BodyweightAt): MuscleWeek[] {
  const out = new Map<string, MuscleWeek>()
  for (let w = weekStart(from); w <= to; w = shiftDay(w, 7)) out.set(w, { week: w, sets: emptyMuscles(), total: 0, volume: 0, sessions: 0 })
  for (const w of workouts) {
    if (w.day < from || w.day > to) continue
    const row = out.get(weekStart(w.day))
    if (!row) continue
    row.sessions += 1
    const b = bw(w.day)
    for (const s of w.sets) {
      if (!isHard(s)) continue
      const ex = exMap.get(s.exerciseId)
      const m = ex?.muscle ?? 'other'
      row.sets[m] += 1
      row.total += 1
      row.volume += (ex ? setLoad(s, ex, b) : s.weightKg) * s.reps
    }
  }
  return [...out.values()]
}

/** Average weekly hard sets per muscle over the last `weeks` full-or-current weeks. */
export function muscleAverages(weeks: MuscleWeek[], count = 4): { muscle: Muscle; label: string; sets: number }[] {
  const recent = weeks.slice(-count)
  const n = Math.max(1, recent.length)
  return MUSCLES.map((m) => ({ muscle: m.key, label: m.label, sets: recent.reduce((a, w) => a + w.sets[m.key], 0) / n }))
    .filter((m) => m.sets > 0 || m.muscle !== 'other')
}

/* ------------------------------------------------------------------ */
/* Insights                                                            */
/* ------------------------------------------------------------------ */

function localStamp(isoString: string | null, day: string): string {
  const t = isoString ? Date.parse(isoString) : NaN
  if (!isNum(t)) return `${day}T12:00:00`
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return date === day ? `${date}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${day}T12:00:00`
}

const clockOf = (stamp: string): number => +stamp.slice(11, 13) * 60 + +stamp.slice(14, 16)

/**
 * Fold logged workouts into the Garmin activities Insights analyses. A logged
 * session on a day with a watch-recorded strength activity enriches that
 * activity (sets, reps, and the higher of the two loads); one without becomes a
 * strength activity of its own. Nothing is written back.
 */
export function mergeLifting(payload: InsightsPayload, lifting: LiftingPayload | null): InsightsPayload {
  if (!lifting?.workouts.length) return payload
  const activities = payload.activities.map((a) => ({ ...a }))
  const taken = new Set<string>()
  for (const w of lifting.workouts) {
    const hard = w.sets.filter(isHard)
    if (!hard.length) continue
    const load = liftLoad(w)
    const stamp = localStamp(w.startedAt, w.day)
    const watch = activities
      .filter((a) => a.day === w.day && !taken.has(a.id) && (a.type ?? '').includes('strength'))
      .sort((a, b) => Math.abs(clockOf(a.startLocal) - clockOf(stamp)) - Math.abs(clockOf(b.startLocal) - clockOf(stamp)))[0]
    if (watch) {
      taken.add(watch.id)
      watch.trainingLoad = Math.max(watch.trainingLoad ?? 0, load)
      watch.sets = hard.length
      watch.reps = hard.reduce((a, s) => a + s.reps, 0)
      watch.name = w.name || watch.name
      continue
    }
    const synth: InsightActivity = {
      id: `lift:${w.id}`, startLocal: stamp, day: w.day, name: w.name || 'Strength session', type: 'strength_training',
      durationS: workoutDurationS(w), movingS: null, distanceM: null, kcal: null, avgHr: null, maxHr: null, elevationGainM: null,
      avgSpeedMps: null, trainingEffect: null, anaerobicTe: null, trainingLoad: load, teLabel: null, vo2max: null, steps: null,
      cadence: null, location: null, hrZonesS: null, sets: hard.length, reps: hard.reduce((a, s) => a + s.reps, 0),
    }
    activities.push(synth)
  }
  activities.sort((a, b) => a.startLocal.localeCompare(b.startLocal))
  const first = lifting.workouts.reduce<string | null>((m, w) => (!m || w.day < m ? w.day : m), null)
  const coverage = { ...payload.coverage, first: payload.coverage.first && first && first > payload.coverage.first ? payload.coverage.first : (first ?? payload.coverage.first) }
  return { ...payload, activities, coverage }
}

/** The Garmin strength activity recorded alongside a logged workout, if any. */
export function watchFor(w: Workout, activities: InsightActivity[]): InsightActivity | null {
  const stamp = localStamp(w.startedAt, w.day)
  return activities
    .filter((a) => a.day === w.day && (a.type ?? '').includes('strength'))
    .sort((a, b) => Math.abs(clockOf(a.startLocal) - clockOf(stamp)) - Math.abs(clockOf(b.startLocal) - clockOf(stamp)))[0] ?? null
}

/** Strength summary for an Insights range. */
export interface StrengthInsight {
  sessions: number
  hardSets: number
  setsPerWeek: number
  volume: number
  prs: number
  lifts: { exercise: Exercise; now: number | null; change: number | null; spark: { day: string; value: number | null }[]; status: LiftStatus; metric: 'e1rm' | 'reps' }[]
  muscles: { muscle: Muscle; label: string; sets: number }[]
}

export function strengthInsight(lifting: LiftingPayload, from: string, to: string, bw: BodyweightAt): StrengthInsight | null {
  const inRange = lifting.workouts.filter((w) => w.day >= from && w.day <= to && w.sets.some(isHard))
  if (!inRange.length) return null
  const exMap = new Map(lifting.exercises.map((e) => [e.id, e]))
  const stats = allExerciseStats(lifting.exercises, lifting.workouts, bw)
  let hardSets = 0
  let volume = 0
  for (const w of inRange) {
    const s = workoutSummary(w, exMap, bw)
    hardSets += s.hardSets
    volume += s.volume
  }
  const weeks = muscleWeeks(lifting.workouts, exMap, from, to, bw)
  let prs = 0
  const lifts: StrengthInsight['lifts'] = []
  for (const st of stats.values()) {
    const sess = st.sessions.filter((s) => s.day >= from && s.day <= to)
    prs += sess.reduce((a, s) => a + s.prs.filter((p) => p.kinds.includes(st.metric === 'reps' ? 'reps' : 'e1rm')).length, 0)
    if (sess.length < 2) continue
    const firstBest = sess.find((s) => isNum(s.best))?.best ?? null
    const lastBest = [...sess].reverse().find((s) => isNum(s.best))?.best ?? null
    lifts.push({
      exercise: st.exercise, now: lastBest, metric: st.metric, status: st.status,
      change: isNum(firstBest) && isNum(lastBest) && firstBest > 0 ? ((lastBest - firstBest) / firstBest) * 100 : null,
      spark: sess.map((s) => ({ day: s.day, value: s.best })),
    })
  }
  lifts.sort((a, b) => stats.get(b.exercise.id)!.sessions.length - stats.get(a.exercise.id)!.sessions.length)
  const span = Math.max(1, (dayNum(to) - dayNum(from) + 1) / 7)
  return {
    sessions: inRange.length, hardSets, setsPerWeek: hardSets / span, volume, prs,
    lifts: lifts.slice(0, 6), muscles: muscleAverages(weeks, Math.min(weeks.length, 4)),
  }
}
