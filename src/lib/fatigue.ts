/**
 * Pre-fatigue: how much overlapping work came before a lift in a session, and
 * what it costs. Pure and framework-agnostic (SPEC §6 "Lifting — fatigue").
 *
 * Bench press after overhead press, or overhead press after bench press: the
 * second lift shares the triceps and front delts with the first and comes in
 * lower. Exercise-order studies find this consistently (fewer reps on a lift
 * done later in a session, most of all when the earlier lifts share its
 * muscles; Simão et al. 2012, Sports Med 42:251). The progression engine uses
 * this so a lower number after a related lift is not read as a bad day or a
 * stall, and a fresh session after a tired one is not read as "too easy".
 *
 * The score (F), for one lift in one workout, sums the hard sets of other
 * exercises logged before its first hard set, each weighted by:
 * - Overlap, 0–1: how much of this lift's muscles the earlier exercise also
 *   works. Each exercise works its primary muscle (1) plus secondaries picked
 *   from its name (a press works the triceps, a row the biceps, a squat the
 *   glutes …). Overlap = Σ this[m] × earlier[m] ÷ Σ this[m].
 * - Effort: 1 at RPE 8 (or none logged), +15 % per rep closer to failure,
 *   −15 % per rep further, kept within 0.7–1.3.
 * - Time: fatigue fades partly with rest, so a set counts 0.5 + 0.5 × e^(−min/20)
 *   by the time the lift starts (0.75 when the times are missing).
 *
 * The order is the order sets were logged in (`doneAt`), not the order they
 * are shown or stored in. Both arms of a one-side lift count as one set (sides.ts). F = 1 is about one hard set of the same lift right
 * before. The cost is FATIGUE_PER_UNIT of estimated max per unit of F, capped
 * at FATIGUE_CAP: four hard sets of bench press then overhead press is about
 * F 1.9, so about 5 %, roughly 1–2 reps on a set of 8.
 */
import type { Exercise, LiftSet, Muscle, Workout } from './types'
import { isNum } from './insights'
import { loggedOrder, setShares } from './sides'

/** Share of estimated max lost per unit of pre-fatigue. */
export const FATIGUE_PER_UNIT = 0.025
/** No order costs more than this. */
export const FATIGUE_CAP = 0.15
/** Below this a lift counts as done fresh. */
export const FRESH_BELOW = 0.3
/** At or above this a lift counts as done after related work. */
export const TIRED_FROM = 1

type Involvement = Partial<Record<Muscle, number>>

/** The muscles an exercise works: its primary at 1, secondaries from its name. */
export function involvement(ex: Pick<Exercise, 'name' | 'muscle'>): Involvement {
  const n = ex.name.toLowerCase()
  const m = ex.muscle
  const out: Involvement = { [m]: 1 }
  const add = (k: Muscle, v: number): void => { if (k !== m) out[k] = Math.max(out[k] ?? 0, v) }
  const legPress = /leg press/.test(n)
  if (/deadlift|\brdl\b|good morning|rack pull/.test(n)) { add('hamstrings', 0.6); add('glutes', 0.6); add('back', 0.5); add('quads', 0.2) }
  if (/squat|lunge|leg press|step-up|step up/.test(n)) { add('quads', 0.7); add('glutes', 0.5); add('hamstrings', 0.2) }
  if (/hip thrust|glute bridge/.test(n)) { add('hamstrings', 0.4); add('quads', 0.2) }
  if (/\bdips?\b/.test(n)) { add('chest', 0.5); add('triceps', 0.5); add('shoulders', 0.4) }
  if (/chin-?up|chin up|pull-?up|pull up|pulldown|\brows?\b|inverted row/.test(n)) { add('back', 0.7); add('biceps', 0.5); add('shoulders', 0.2) }
  if (!legPress && /press|push-?up|push up|bench/.test(n) && !/leg|calf/.test(n)) {
    if (m === 'shoulders' || /overhead|military|shoulder|arnold|push press/.test(n)) { add('shoulders', 0.7); add('triceps', 0.5); add('chest', 0.2) }
    else { add('chest', 0.7); add('triceps', 0.5); add('shoulders', 0.5) }
  }
  if (/\bfly\b|flye|crossover|pec deck/.test(n) && !/rear|reverse/.test(n)) add('shoulders', 0.3)
  if (/face pull|rear delt|reverse fly/.test(n)) add('back', 0.3)
  if (/skull|triceps extension|overhead extension/.test(n)) add('shoulders', 0.1)
  return out
}

/** How much doing `earlier` first tires the muscles `later` uses, 0–1. */
export function overlap(earlier: Pick<Exercise, 'name' | 'muscle'>, later: Pick<Exercise, 'name' | 'muscle'>): number {
  const a = involvement(earlier)
  const b = involvement(later)
  let num = 0
  let den = 0
  for (const [k, v] of Object.entries(b) as [Muscle, number][]) { den += v; num += v * (a[k] ?? 0) }
  return den > 0 ? num / den : 0
}

const rirOf = (s: Pick<LiftSet, 'kind' | 'rpe'>): number => (s.kind === 'failure' ? 0 : isNum(s.rpe) ? Math.min(4, Math.max(0, 10 - s.rpe)) : 2)
const effortOf = (s: Pick<LiftSet, 'kind' | 'rpe'>): number => Math.min(1.3, Math.max(0.7, 1 + (2 - rirOf(s)) * 0.15))
const decayOf = (minutes: number | null): number => (minutes === null || !(minutes >= 0) ? 0.75 : 0.5 + 0.5 * Math.exp(-minutes / 20))


export interface FatigueSource { exerciseId: string; name: string; sets: number; share: number }
export interface Fatigue {
  /** The score; 0 = fresh. */
  score: number
  /** The exercises that contributed, biggest first. */
  after: FatigueSource[]
}

export const NO_FATIGUE: Fatigue = { score: 0, after: [] }

/**
 * Pre-fatigue for one exercise in one workout, at its first hard set. When the
 * exercise has no hard set yet, everything logged so far counts, timed to
 * `now` (ms) when given, else to the last set.
 */
export function fatigueBefore(w: Pick<Workout, 'sets'>, exerciseId: string, exMap: Map<string, Exercise>, now?: number): Fatigue {
  const target = exMap.get(exerciseId)
  if (!target) return NO_FATIGUE
  const sets = loggedOrder(w.sets)
  // Both arms of a one-side lift are one set.
  const share = setShares(w, exMap)
  const isHard = (s: LiftSet): boolean => s.kind !== 'warmup'
  const firstIdx = sets.findIndex((s) => s.exerciseId === exerciseId && isHard(s))
  const before = firstIdx >= 0 ? sets.slice(0, firstIdx) : sets
  const refSet = firstIdx >= 0 ? sets[firstIdx] : null
  const lastDone = [...sets].reverse().find((s) => s.doneAt)?.doneAt
  const ref = refSet?.doneAt ? Date.parse(refSet.doneAt) : isNum(now) ? now : lastDone ? Date.parse(lastDone) : NaN
  const per = new Map<string, { score: number; sets: number }>()
  const ov = new Map<string, number>()
  for (const s of before) {
    if (s.exerciseId === exerciseId || !isHard(s)) continue
    const ex = exMap.get(s.exerciseId)
    if (!ex) continue
    if (!ov.has(ex.id)) ov.set(ex.id, overlap(ex, target))
    const o = ov.get(ex.id)!
    if (o <= 0) continue
    const t = s.doneAt ? Date.parse(s.doneAt) : NaN
    const minutes = Number.isFinite(ref) && Number.isFinite(t) ? Math.max(0, (ref - t) / 60000) : null
    const n = share.get(s.id) ?? 1
    const v = o * effortOf(s) * decayOf(minutes) * n
    const cur = per.get(ex.id) ?? { score: 0, sets: 0 }
    per.set(ex.id, { score: cur.score + v, sets: cur.sets + n })
  }
  const score = [...per.values()].reduce((a, b) => a + b.score, 0)
  const after = [...per].map(([id, v]) => ({ exerciseId: id, name: exMap.get(id)!.name, sets: v.sets, share: score > 0 ? v.score / score : 0 }))
    .filter((a) => a.share >= 0.1).sort((a, b) => b.share - a.share)
  return { score: Math.round(score * 100) / 100, after }
}

/** Share of estimated max lost to a pre-fatigue score. */
export const fatiguePenalty = (score: number): number => Math.min(FATIGUE_CAP, FATIGUE_PER_UNIT * Math.max(0, score))

/** Scale a set's reps by a strength ratio at the same weight and effort (Epley). */
export function scaleReps(reps: number, ratio: number): number {
  if (Math.abs(ratio - 1) < 1e-9) return reps
  return Math.max(1, Math.round(30 * ((1 + reps / 30) * ratio - 1)))
}

/**
 * A session's best as if the lift had been done fresh: an estimated max
 * divided by (1 − penalty); a rep count converted through Epley.
 */
export function freshEquivalent(value: number, metric: 'e1rm' | 'reps', score: number): number {
  const p = fatiguePenalty(score)
  if (!p) return value
  return metric === 'reps' ? 30 * ((1 + value / 30) / (1 - p) - 1) : value / (1 - p)
}

/** "Bench press" · "Bench press and Overhead press" · "Bench press, Dips and 1 more". */
export function fmtAfter(after: FatigueSource[]): string {
  const names = after.map((a) => a.name)
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}
