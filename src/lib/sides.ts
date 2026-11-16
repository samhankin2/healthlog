/**
 * One side at a time (SPEC §6 "Lifting — one side at a time"). Pure.
 *
 * For a lift marked `perSide` (lateral raises, one-arm rows …) each arm is
 * logged as its own entry. Two entries in a row at the same weight and kind are
 * one set: it counts once for volume, load and fatigue, the gap between the
 * two arms is not rest, and progression plans on the weaker arm's reps. A lone
 * entry (the other arm not logged yet, or a different weight) is a set on its own.
 */
import type { Exercise, LiftSet, Workout } from './types'
import { isNum } from './insights'

/** A workout's sets in the order they were logged: by `doneAt` when every set has one, else as stored. */
export function loggedOrder<T extends Pick<LiftSet, 'doneAt'>>(sets: T[]): T[] {
  if (!sets.length || !sets.every((s) => s.doneAt && Number.isFinite(Date.parse(s.doneAt)))) return [...sets]
  return sets.map((s, i) => ({ s, i, t: Date.parse(s.doneAt!) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.s)
}

export interface SideGroup {
  /** The entries: one, or both arms. */
  sets: LiftSet[]
  /** The pair as one set: the weaker arm's reps, the harder effort, the later time. */
  set: LiftSet
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

/** One exercise's sets (in logged order) grouped into sets: pairs for a one-side lift, else one each. */
export function sideGroups(sets: LiftSet[], perSide: boolean | undefined): SideGroup[] {
  const out: SideGroup[] = []
  for (let i = 0; i < sets.length; i++) {
    const a = sets[i]
    const b = sets[i + 1]
    if (perSide && b && a.kind !== 'warmup' && b.kind === a.kind && near(a.weightKg, b.weightKg)) {
      const rpes = [a.rpe, b.rpe].filter(isNum)
      out.push({ sets: [a, b], set: { ...a, reps: Math.min(a.reps, b.reps), rpe: rpes.length ? Math.max(...rpes) : null, doneAt: b.doneAt ?? a.doneAt } })
      i++
    } else out.push({ sets: [a], set: a })
  }
  return out
}

/** One exercise's sets with each pair merged into one set. */
export const mergeSides = (sets: LiftSet[], perSide: boolean | undefined): LiftSet[] => sideGroups(loggedOrder(sets), perSide).map((g) => g.set)

/** True when the last entry of a one-side lift is waiting for the other arm. */
export function otherSidePending(sets: LiftSet[], perSide: boolean | undefined): boolean {
  if (!perSide) return false
  const hard = loggedOrder(sets).filter((s) => s.kind !== 'warmup')
  const groups = sideGroups(hard, true)
  return groups.length > 0 && groups[groups.length - 1].sets.length === 1
}

/** How much each set of a workout counts as a set: ½ for each arm of a pair, else 1 (warm-ups too; callers filter). */
export function setShares(w: Pick<Workout, 'sets'>, exMap: Map<string, Pick<Exercise, 'perSide'>>): Map<string, number> {
  const out = new Map<string, number>()
  const byEx = new Map<string, LiftSet[]>()
  for (const s of loggedOrder(w.sets)) byEx.set(s.exerciseId, [...(byEx.get(s.exerciseId) ?? []), s])
  for (const [id, sets] of byEx) {
    for (const g of sideGroups(sets, exMap.get(id)?.perSide)) for (const s of g.sets) out.set(s.id, 1 / g.sets.length)
  }
  return out
}

/** A workout's hard sets as sets: each pair of arms merged into one. */
export function countedSets(w: Pick<Workout, 'sets'>, exMap: Map<string, Pick<Exercise, 'perSide'>>): LiftSet[] {
  const byEx = new Map<string, LiftSet[]>()
  for (const s of loggedOrder(w.sets)) if (s.kind !== 'warmup') byEx.set(s.exerciseId, [...(byEx.get(s.exerciseId) ?? []), s])
  return [...byEx].flatMap(([id, sets]) => sideGroups(sets, exMap.get(id)?.perSide).map((g) => g.set))
}

/** Hard sets in a workout, a pair counting once. */
export function hardSetCount(w: Pick<Workout, 'sets'>, exMap: Map<string, Pick<Exercise, 'perSide'>>): number {
  const share = setShares(w, exMap)
  return w.sets.reduce((a, s) => a + (s.kind !== 'warmup' ? share.get(s.id) ?? 1 : 0), 0)
}
