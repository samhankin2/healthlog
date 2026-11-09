/**
 * Progression engine: what to lift next time, and what to do with the next set
 * mid-session. Pure and framework-agnostic (SPEC §6 "Lifting — progression").
 *
 * The rules, and where they come from:
 *
 * - Rep ranges, not fixed reps (double progression). Every lift has a range:
 *   set on the exercise, or picked from its type (barbell compounds 5–8,
 *   other compounds 8–12, isolation 10–15, core 10–20) and moved to fit
 *   what you actually do if your reps sit well outside it. Below the top of the
 *   range you add reps; when every working set at the top weight reaches the
 *   top, you add weight. Load progression and rep progression grow muscle and
 *   strength about equally (Plotkin et al. 2022, PeerJ 10:e14142), so both
 *   count as progress.
 *
 * - The size of a weight jump comes from your own numbers, not a fixed "drop
 *   two reps". Each set's estimated max (Epley) predicts the reps you would
 *   get at the heavier weight at the same effort, so a big step on a light
 *   dumbbell is caught before it craters your reps.
 *
 * - Effort (RPE / reps in reserve) adjusts the plan when you log it:
 *   reps in reserve = 10 − RPE, and a set marked "to failure" has none. Three
 *   or more in reserve on every top set means the weight is too light and the
 *   jump can be bigger. At most 4 in reserve is ever trusted, because guesses
 *   far from failure are off by 2–5 reps, while guesses near failure are off
 *   by about 1 (Zourdos et al. 2016; Halperin et al. 2022). The default effort
 *   for working sets is RPE 8, which is 2 in reserve. Taking sets
 *   that close to failure gives most of the muscle growth, and strength gains
 *   barely change across that range (Robinson et al. 2024).
 *
 * - A single bad session is not a trend. If the last one came in at least 5 %
 *   below the best of the few before it, repeat the plan.
 *
 * - A plateau is three sessions in a row with no new best since the last reset.
 *   The first time, reset: drop about 10 % and build back past it (the
 *   classic linear-progression reset). If it stalls again after a reset,
 *   change the rep range for a block instead of grinding the same one.
 *
 * - Time off: strength holds for about 3 weeks of detraining and then
 *   slips. After 10–20 days, repeat the last session; after 3 weeks or more,
 *   restart at 80–90 % depending on how long.
 *
 * - Back-off sets keep their weight ratio to the top set and their reps.
 */
import type { Exercise, LiftSet } from './types'
import { dayNum, isNum } from './insights'
import { defaultIncrement, fmtW, roundKg, setLoad, type BodyweightAt, type SessionLine } from './lifting'

export interface RepRange { lo: number; hi: number }

export const RANGE_PRESETS: RepRange[] = [
  { lo: 1, hi: 3 }, { lo: 3, hi: 5 }, { lo: 5, hi: 8 }, { lo: 6, hi: 10 },
  { lo: 8, hi: 12 }, { lo: 10, hi: 15 }, { lo: 15, hi: 20 }, { lo: 20, hi: 30 },
]

export type PlanKind = 'load' | 'reps' | 'repeat' | 'reset' | 'range' | 'return' | 'lighter'
export const PLAN_LABEL: Record<PlanKind, string> = {
  load: 'Add weight', reps: 'Add reps', repeat: 'Repeat', reset: 'Reset', range: 'New rep range', return: 'Ease back in', lighter: 'Go lighter',
}

export interface PlanSet { weightKg: number; reps: number }

export interface Target {
  kind: PlanKind
  /** Top working weight (added load for bodyweight lifts). */
  weightKg: number
  /** Reps for the sets at the top weight. */
  reps: number[]
  /** Every working set, in order (top and back-off). */
  sets: PlanSet[]
  /** One short line for the gym. */
  note: string
  /** The reasoning, for "Why?". */
  why: string[]
  range: RepRange
  rangeAuto: boolean
  /** A different range to switch to (kind 'range'). */
  suggestRange: RepRange | null
}

/** Target effort for working sets: RPE 8. */
const TARGET_RIR = 2
const EPS = 1e-9
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6
const ISOLATION = /curl|raise|fly|flye|extension|pushdown|push-down|kickback|crunch|shrug|pullover|face pull|calf|skull|crossover|pec deck/i

export const fmtRange = (r: RepRange): string => `${r.lo}–${r.hi}`

/** The range a lift starts with before you set one. */
export function defaultRange(ex: Pick<Exercise, 'name' | 'muscle' | 'equipment'>): RepRange {
  if (ex.muscle === 'core') return { lo: 10, hi: 20 }
  if (ex.muscle === 'calves' || ex.muscle === 'biceps' || ISOLATION.test(ex.name)) return { lo: 10, hi: 15 }
  if (ex.equipment === 'barbell') return { lo: 5, hi: 8 }
  if (ex.equipment === 'bodyweight') return { lo: 6, hi: 12 }
  return { lo: 8, hi: 12 }
}

/** The preset that starts at (or just below) a habitual rep count. */
function fitRange(m: number): RepRange {
  const inside = RANGE_PRESETS.filter((r) => r.lo <= m && m <= r.hi)
  if (!inside.length) return m < 1 ? RANGE_PRESETS[0] : RANGE_PRESETS[RANGE_PRESETS.length - 1]
  return inside.reduce((a, b) => (m - b.lo < m - a.lo ? b : a))
}

export const working = (sets: LiftSet[]): LiftSet[] => {
  const w = sets.filter((s) => s.kind === 'working' || s.kind === 'failure')
  return w.length ? w : sets.filter((s) => s.kind !== 'warmup')
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/**
 * The lift's range: the one you set, else the default for its type, unless
 * your recent first sets sit well outside it (then the preset that fits them).
 * The slack (1 below, 2 above) stops the range drifting upward as reps climb.
 */
export function repRange(ex: Exercise, sessions: SessionLine[]): { range: RepRange; auto: boolean } {
  if (isNum(ex.repMin) && isNum(ex.repMax) && ex.repMin >= 1 && ex.repMax >= ex.repMin) return { range: { lo: ex.repMin, hi: ex.repMax }, auto: false }
  const def = defaultRange(ex)
  const firsts = sessions.slice(-4).map((s) => working(s.sets)[0]?.reps).filter(isNum)
  if (firsts.length >= 2) {
    const m = median(firsts)
    if (m < def.lo - 1 || m > def.hi + 2) return { range: fitRange(Math.round(m)), auto: true }
  }
  return { range: def, auto: true }
}

/** Reps in reserve from a logged effort; null when unknown. Capped at 4. */
export function rirOf(s: Pick<LiftSet, 'kind' | 'rpe'>): number | null {
  if (s.kind === 'failure') return 0
  if (!isNum(s.rpe)) return null
  return Math.min(4, Math.max(0, 10 - s.rpe))
}

function rangeSwitch(r: RepRange, ex: Exercise): RepRange {
  if (r.hi <= 8) return { lo: 8, hi: 12 }
  if (r.lo >= 10) return { lo: 6, hi: 10 }
  return ex.equipment === 'barbell' ? { lo: 5, hi: 8 } : { lo: 10, hi: 15 }
}

/**
 * Plan the next session from everything logged so far.
 * `today` is the day it will happen (for time-off handling); defaults to the
 * last session's day.
 */
export function planNext(ex: Exercise, sessions: SessionLine[], metric: 'e1rm' | 'reps', bw: BodyweightAt, today?: string): Target | null {
  const last = sessions[sessions.length - 1]
  if (!last) return null
  const work = working(last.sets)
  if (!work.length) return null

  const { range, auto } = repRange(ex, sessions)
  const { lo, hi } = range
  const inc = defaultIncrement(ex)
  const bodyweight = ex.equipment === 'bodyweight'
  const bNow = bw(today ?? last.day) ?? bw(last.day)
  const total = (added: number, b: number | null = bNow): number => setLoad({ weightKg: added }, ex, b)
  const unit = (w: number): string => (bodyweight ? (w > 0 ? `BW+${fmtW(w)} kg` : 'bodyweight') : `${fmtW(w)} kg`)

  const top = Math.max(...work.map((s) => s.weightKg))
  const topSets = work.filter((s) => near(s.weightKg, top))
  const rirs = topSets.map(rirOf)
  const repsNow = topSets.map((s) => s.reps)
  const minTop = Math.min(...repsNow)
  const firstTop = repsNow[0]
  const why: string[] = [`Rep range ${fmtRange(range)}${auto ? ' (picked from the lift type and your recent sets; change it on the lift page)' : ' (your setting)'}.`]
  const repsMetric = metric === 'reps' || !(total(top) > 0)

  /** Estimated max of a set, adjusted for known reps in reserve. */
  const estOf = (s: LiftSet): number => {
    const r = rirOf(s)
    return total(s.weightKg, bw(last.day) ?? bNow) * (1 + (s.reps + (r ?? 0)) / 30)
  }
  /** Reps a set predicts at another weight: same effort, or RPE 8 when the set was easier. */
  const repsAt = (s: LiftSet, w: number): number => {
    const t = total(w)
    if (!(t > 0)) return s.reps
    const r = rirOf(s)
    const keep = r === null ? 0 : Math.min(r, TARGET_RIR)
    return Math.floor(30 * (estOf(s) / t - 1) - keep + EPS)
  }
  /** Heaviest weight on the lift's grid (steps of `inc` from the top weight) at or below a total load. */
  const gridDown = (targetTotal: number): number => {
    const added = targetTotal - (total(top) - top)
    return Math.max(0, roundKg(top + inc * Math.floor((added - top) / inc + EPS)))
  }
  /** Weight on the grid that lets this set reach `reps`. */
  const weightFor = (s: LiftSet, reps: number): number => gridDown(estOf(s) / (1 + (reps + Math.min(rirOf(s) ?? 0, TARGET_RIR)) / 30))

  const build = (kind: PlanKind, weight: number, topReps: number[], note: string, suggestRange: RepRange | null = null): Target => {
    let ti = 0
    const ratio = total(top) > 0 ? total(weight) / total(top) : 1
    const sets = work.map((s) => {
      if (near(s.weightKg, top)) return { weightKg: weight, reps: topReps[Math.min(ti++, topReps.length - 1)] }
      const w = bodyweight ? Math.max(0, roundKg(s.weightKg + (weight - top))) : Math.max(0, roundKg(Math.round((s.weightKg * ratio) / inc) * inc))
      return { weightKg: w, reps: s.reps }
    })
    if (sets.length > topReps.length && work.some((s) => !near(s.weightKg, top))) why.push('Back-off sets keep their weight relative to the top set.')
    return { kind, weightKg: weight, reps: topReps, sets, note, why, range, rangeAuto: auto, suggestRange }
  }

  /* ---------- context ---------- */
  const daysOff = today ? dayNum(today) - dayNum(last.day) : 0
  const sessionTop = (s: SessionLine): number => Math.max(0, ...working(s.sets).map((x) => total(x.weightKg, bw(s.day))))
  const score = (s: SessionLine): number => {
    const b = bw(s.day)
    return Math.max(0, ...working(s.sets).map((x) => (repsMetric ? x.reps : total(x.weightKg, b) * (1 + Math.min(x.reps, 30) / 30))))
  }
  // The latest deliberate drop (reset or comeback) starts a new segment.
  let seg = 0
  for (let i = sessions.length - 1; i > 0 && i >= sessions.length - 12 && !repsMetric; i--) {
    if (sessionTop(sessions[i]) <= sessionTop(sessions[i - 1]) * 0.92) { seg = i; break }
  }
  const win = sessions.slice(Math.max(seg, sessions.length - 8))
  const scores = win.map(score)
  let bestIdx = 0
  scores.forEach((v, i) => { if (v > scores[bestIdx] * 1.002) bestIdx = i })
  const sinceBest = win.length - 1 - bestIdx
  const stalled = win.length >= 4 && sinceBest >= 3
  const resetBefore = seg > 0 && sessionTop(sessions[seg - 1]) <= total(top) + inc + EPS
  const prev = scores.slice(-4, -1)
  const lastScore = scores[scores.length - 1]
  const prevBest = prev.length ? Math.max(...prev) : 0
  const dip = prevBest > 0 ? (lastScore - prevBest) / prevBest : 0

  /* ---------- 1. time off ---------- */
  if (daysOff >= 21) {
    const f = daysOff >= 90 ? 0.8 : daysOff >= 42 ? 0.85 : 0.9
    const w = repsMetric ? top : Math.min(top - (top > 0 ? inc : 0), gridDown(total(top) * f))
    const reps = repsMetric ? repsNow.map((r) => Math.max(1, Math.round(r * f))) : repsNow.map((r) => Math.min(hi, Math.max(lo, r)))
    why.push(`${Math.round(daysOff / 7)} weeks since you last did this. Strength holds for about 3 weeks off, then slips, and comes back fast once you're training again.`)
    why.push(`Start at about ${Math.round(f * 100)} % and build back over 2–3 sessions.`)
    return build('return', Math.max(0, w), reps, `${Math.round(daysOff / 7)} weeks off — ease back in`)
  }
  if (daysOff >= 10) {
    why.push(`${daysOff} days since last time. Repeat it before pushing on.`)
    return build('repeat', top, repsNow, 'A while since last time — repeat it')
  }

  /* ---------- 2. below the range: the weight is too heavy ---------- */
  const grinding = rirs.some((r) => r !== null && r <= 0.5)
  if (!repsMetric && (firstTop < lo - 1 || (minTop < lo && grinding)) && top > 0) {
    const w = Math.min(top - inc, weightFor(topSets[0], lo + 1))
    const reps = topSets.map((s) => Math.min(hi, Math.max(lo, repsAt(s, w))))
    why.push(`Your sets fell below ${lo} reps${grinding ? ' at all-out effort' : ''}. That's under your range, so the weight is too heavy for now.`)
    why.push(`${unit(w)} should put you back at ${lo}+ reps, based on what you just lifted.`)
    return build('lighter', Math.max(0, w), reps, `Below ${lo} reps — drop to ${unit(Math.max(0, w))}`)
  }

  /* ---------- 3. plateau ---------- */
  if (stalled && !repsMetric) {
    if (resetBefore) {
      const next = rangeSwitch(range, ex)
      const w = weightFor(topSets[0], next.lo)
      const reps = topSets.map((s) => Math.min(next.hi, Math.max(next.lo, repsAt(s, w))))
      why.push(`No new best in ${sinceBest} sessions, and this is the second plateau around this weight after a reset.`)
      why.push(`Changing the rep range for 4–6 weeks is a new stimulus, and it usually breaks the plateau. Your best at ${fmtRange(range)} will be waiting when you switch back.`)
      return build('range', w, reps, `Stuck again — switch to ${fmtRange(next)} reps for a block`, next)
    }
    const w = Math.min(top - inc, gridDown(total(top) * 0.9))
    const reps = repsNow.map((r) => Math.min(hi, Math.max(lo, r)))
    why.push(`No new best in your last ${sinceBest} sessions.`)
    why.push('Drop about 10 % and work back up. The lighter sessions let fatigue clear, and you usually pass the old best within 3–4 weeks.')
    return build('reset', Math.max(0, w), reps, `Stalled ${sinceBest} sessions — reset to ${unit(Math.max(0, w))} and climb`)
  }

  /* ---------- 4. one bad day ---------- */
  if (dip <= -0.05 && !stalled) {
    why.push(`Last session was ${Math.round(-dip * 100)} % below your recent best. One off day is normal (sleep, food, stress), so it isn't a trend yet.`)
    why.push('Repeat it rather than chasing more.')
    return build('repeat', top, repsNow, 'Off day last time — repeat it')
  }

  /* ---------- 5. add weight ---------- */
  const easy = rirs.every((r) => r !== null && r >= 3) && minTop >= lo
  const atTop = minTop >= hi

  if (repsMetric) {
    if (atTop) {
      const w = top + inc
      why.push(`Every set reached ${hi}. Add load (a belt, vest or dumbbell) and start back at the bottom of the range.`)
      return build('load', w, repsNow.map(() => lo), `Every set hit ${hi} — add ${fmtW(inc)} kg`)
    }
  } else if (atTop || easy) {
    const maxK = easy || minTop >= hi + 2 ? 3 : 1
    let chosen: { w: number; reps: number[] } | null = null
    for (let k = 1; k <= maxK; k++) {
      const w = roundKg(top + k * inc)
      if (k > 1 && total(w) > total(top) * 1.1 + EPS) break
      const reps = topSets.map((s) => Math.max(1, Math.min(hi, repsAt(s, w))))
      if (reps[0] >= lo && Math.min(...reps) >= lo - 1) chosen = { w, reps }
      else break
    }
    const reason = atTop ? `Every set at ${unit(top)} reached the top of your range (${hi}).` : 'Every top set had 3+ reps in reserve (RPE 7 or less), so the weight is too light.'
    if (chosen) {
      const jump = roundKg(chosen.w - top)
      why.push(reason)
      why.push(`At ${unit(chosen.w)}, your sets predict ${chosen.reps.join(', ')} reps${rirs.some((r) => r !== null) ? ' at RPE 8' : ' at the same effort'}.${jump > inc ? ` That has room for a ${fmtW(jump)} kg jump.` : ''}`)
      return build('load', chosen.w, chosen.reps, `${atTop ? `Every set hit ${hi}` : 'Felt easy'} — add ${fmtW(jump)} kg`)
    }
    const w1 = roundKg(top + inc)
    const big = topSets.map((s) => Math.max(1, Math.min(hi, repsAt(s, w1))))
    if (big[0] >= Math.max(1, lo - 2) || minTop >= hi + 4) {
      why.push(reason)
      why.push(`+${fmtW(inc)} kg is a big step at this weight (${Math.round((total(w1) / total(top) - 1) * 100)} %), so expect about ${big[0]} reps and build back up. A smaller step (change it on the lift page) makes this smoother.`)
      return build('load', w1, big.map((r) => Math.max(r, 1)), `Add ${fmtW(inc)} kg — fewer reps is fine`)
    }
    const reps = repsNow.map((r, i) => (i === repsNow.indexOf(minTop) ? r + 1 : r))
    why.push(reason)
    why.push(`But +${fmtW(inc)} kg would drop you to about ${big[0]} reps (${Math.round((total(w1) / total(top) - 1) * 100)} % heavier), below your range. Keep adding reps past ${hi} until the jump fits, or use a smaller step.`)
    return build('reps', top, reps, `Big jump at this weight — one more rep first`)
  }

  /* ---------- 6. add reps ---------- */
  const reps = [...repsNow]
  const cap = Math.max(hi, ...repsNow)
  const roomy = rirs.every((r) => r !== null && r >= 2)
  const gain = roomy ? Math.max(2, Math.ceil(reps.length / 2)) : 1
  for (let g = 0; g < gain; g++) {
    const below = reps.map((r, i) => ({ r, i })).filter((x) => x.r < cap)
    if (!below.length) break
    const pick = below.reduce((a, b) => (b.r < a.r ? b : a))
    reps[pick.i]++
  }
  const added = reps.map((r, i) => r - repsNow[i])
  const bumped = added.map((d, i) => (d > 0 ? i + 1 : 0)).filter(Boolean)
  why.push(`${repsMetric ? 'Bodyweight only, so progress is reps' : `Your sets are below the top of your range (${hi}) at ${unit(top)}`}. Add reps before adding weight.`)
  why.push(roomy ? 'You had 2+ reps in reserve, so aim for a few more reps across your sets.' : grinding ? 'Your last set was all-out, so aim for one rep more on the weakest set and keep the others.' : 'One more rep on the weakest set is steady progress, about +3 % on your estimated max.')
  if (repsNow.length >= 2 && repsNow[repsNow.length - 1] < repsNow[0] * 0.75) why.push('Reps fell sharply across your sets. Resting longer (2–3 minutes) between sets usually keeps them up.')
  const note = bumped.length === 1 && reps.length > 1 ? `Same weight — one more rep on set ${bumped[0]}` : bumped.length ? `Same weight — ${reps.length > 1 ? 'more reps' : 'one more rep'}` : 'Same weight — match it'
  return build('reps', top, reps, note)
}

/* ------------------------------------------------------------------ */
/* Mid-session: the next set                                           */
/* ------------------------------------------------------------------ */

export interface NextSet { weightKg: number; reps: number; note: string | null }

/**
 * What to put in the entry pad for the next working set, given the plan and
 * the working sets already logged this session. Adjusts when a set went much
 * worse or much better than planned.
 */
export function nextSet(ex: Exercise, plan: Target | null, logged: LiftSet[], range: RepRange): NextSet | null {
  const done = working(logged.filter((s) => s.kind !== 'warmup'))
  const planned = plan ? plan.sets[Math.min(done.length, plan.sets.length - 1)] ?? null : null
  const prevSet = done[done.length - 1]
  if (!prevSet) return planned ? { ...planned, note: null } : null
  const beyondPlan = !plan || done.length >= plan.sets.length
  const base: PlanSet = planned && !beyondPlan ? { ...planned } : { weightKg: prevSet.weightKg, reps: prevSet.reps }
  if (!near(base.weightKg, prevSet.weightKg)) return { ...base, note: null }

  const inc = defaultIncrement(ex)
  const r = rirOf(prevSet)
  // Too heavy: short of the range at near-max effort.
  if (prevSet.reps < range.lo && (r === null ? prevSet.reps < range.lo - 1 : r <= 1) && prevSet.weightKg > 0) {
    const est = prevSet.weightKg * (1 + (prevSet.reps + (r ?? 0)) / 30)
    const w = Math.max(0, Math.min(prevSet.weightKg - inc, roundKg(prevSet.weightKg + inc * Math.floor((est / (1 + (range.lo + 1) / 30) - prevSet.weightKg) / inc))))
    if (ex.equipment !== 'bodyweight') return { weightKg: w, reps: range.lo, note: `Short of ${range.lo} reps — drop to ${fmtW(w)} kg for the next set` }
    return { weightKg: w, reps: range.lo, note: `Short of ${range.lo} reps — lighten the load for the next set` }
  }
  // Fell well short of the plan: aim for what you just did.
  if (planned && prevSet.reps <= base.reps - 2) return { weightKg: base.weightKg, reps: prevSet.reps, note: `Aim to match your last set (${prevSet.reps})` }
  // Much easier than planned: offer more weight for the rest.
  if (r !== null && r >= 3 && planned && prevSet.reps >= base.reps && !beyondPlan) {
    const w = roundKg(base.weightKg + inc)
    return { weightKg: w, reps: base.reps, note: `That was easy (RPE ${fmtW(10 - r)}) — try ${ex.equipment === 'bodyweight' ? `+${fmtW(w)}` : fmtW(w)} kg` }
  }
  return { ...base, note: null }
}

/* ------------------------------------------------------------------ */
/* Across lifts: time for a lighter week?                              */
/* ------------------------------------------------------------------ */

export interface DeloadAdvice { stuck: string[]; of: number }

/**
 * Several lifts stalling or slipping at once points to fatigue more than to
 * any one lift. Returns the stuck ones when at least 3 of the lifts trained in
 * the last 3 weeks (and at least 40 % of them) are stalled or slipping.
 */
export function deloadAdvice(stats: { exercise: Exercise; status: string; lastDay: string | null; sessions: unknown[] }[], today: string): DeloadAdvice | null {
  const active = stats.filter((s) => s.lastDay && dayNum(today) - dayNum(s.lastDay) <= 21 && s.sessions.length >= 4)
  const stuck = active.filter((s) => s.status === 'stalled' || s.status === 'regressing')
  if (stuck.length >= 3 && stuck.length / active.length >= 0.4) return { stuck: stuck.map((s) => s.exercise.name), of: active.length }
  return null
}

/** "82.5 kg × 6, 6, 6 · 70 kg × 10": consecutive sets at one weight grouped. */
export function fmtPlan(t: Pick<Target, 'sets'>, ex: Pick<Exercise, 'equipment'>): string {
  const groups: { w: number; reps: number[] }[] = []
  for (const s of t.sets) {
    const g = groups[groups.length - 1]
    if (g && near(g.w, s.weightKg)) g.reps.push(s.reps)
    else groups.push({ w: s.weightKg, reps: [s.reps] })
  }
  return groups.map((g) => `${ex.equipment === 'bodyweight' ? (g.w > 0 ? `BW+${fmtW(g.w)}` : 'BW') : `${fmtW(g.w)} kg`} × ${g.reps.join(', ')}`).join(' · ')
}
