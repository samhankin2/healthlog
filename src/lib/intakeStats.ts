/**
 * Calorie-history maths for the Calories view. Pure functions over the
 * `intakeHistory` series the dashboard endpoint returns (one row per calendar
 * day, zero-filled), so nothing here touches the network or the DOM.
 *
 * Conventions:
 * - A day is "logged" when it has any calories. Zero-filled gaps are not
 *   counted as 0-kcal days — that would drag every average down.
 * - A logged day the server flags `partial` (far below the person's usual
 *   day, SPEC §6) is left out of every average and target count too: half a
 *   day's food is not a low-intake day. Streaks still count it as logged.
 * - Today is still in progress, so the summary statistics take only the
 *   completed days. The chart still shows today.
 */
import { addDays } from './format'
import type { DayString, IntakeHistoryDay } from './types'

/** Rough energy content of a kilogram of body mass, for the balance estimate. */
export const KCAL_PER_KG = 7700
/** A logged day within ±10 % of the target counts as on target. */
export const ON_TARGET_TOLERANCE = 0.1

export interface IntakeSummary {
  /** Completed days in the window, logged or not. */
  windowDays: number
  /** Complete logged days: what the averages use. */
  loggedDays: number
  /** Logged days left out as likely partial. */
  partialDays: number
  avgKcal: number | null
  avgProteinG: number | null
  avgCarbsG: number | null
  avgFatG: number | null
  /** avgKcal − target. Null without a target or without logged days. */
  avgVsTarget: number | null
  onTargetDays: number
  overDays: number
  underDays: number
  /** Σ(kcal − target) over logged days. Negative is a deficit. */
  netBalanceKcal: number | null
  highest: IntakeHistoryDay | null
  lowest: IntakeHistoryDay | null
  avgWeekday: number | null
  avgWeekend: number | null
  /** Consecutive logged days ending today (or yesterday, if today is still empty). */
  currentStreak: number
  longestStreak: number
}

export interface WeekRollup {
  /** Monday of the week. */
  weekStart: DayString
  loggedDays: number
  partialDays: number
  avgKcal: number | null
  avgProteinG: number | null
  totalKcal: number
  avgVsTarget: number | null
}

const isLogged = (day: IntakeHistoryDay): boolean => day.kcal > 0
/** Logged and not flagged partial: the days averages are taken over. */
export const isComplete = (day: IntakeHistoryDay): boolean => day.kcal > 0 && !day.partial

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function weekday(day: DayString): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getDay()
}

/** Monday (local calendar) of the week containing `day`. */
export function weekStartOf(day: DayString): DayString {
  const offset = (weekday(day) + 6) % 7
  return addDays(day, -offset)
}

/** Drop the zero-filled days before the first logged one (for "All time"). */
export function trimLeadingEmpty(days: IntakeHistoryDay[]): IntakeHistoryDay[] {
  const first = days.findIndex(isLogged)
  return first === -1 ? [] : days.slice(first)
}

/** The completed days of a series: everything before `todayDay`. */
export function completedDays(days: IntakeHistoryDay[], todayDay: DayString): IntakeHistoryDay[] {
  return days.filter((day) => day.day < todayDay)
}

/** The per-day series the history charts can plot. */
export type IntakeMetric = 'kcal' | 'proteinG' | 'carbsG' | 'fatG'

/**
 * Trailing average of `metric` over the complete logged days in the last `window`
 * calendar days, per point. Null where the window holds no logged day.
 * "Logged" is decided by calories, so a day with meals but 0 g fat still
 * counts as a 0 g fat day.
 */
export function rollingAverage(days: IntakeHistoryDay[], window = 7, metric: IntakeMetric = 'kcal'): (number | null)[] {
  return days.map((_, index) => {
    const slice = days.slice(Math.max(0, index - window + 1), index + 1).filter(isComplete)
    const avg = mean(slice.map((day) => day[metric]))
    return avg === null ? null : Math.round(avg * 10) / 10
  })
}

function streaks(days: IntakeHistoryDay[], todayDay: DayString): { current: number; longest: number } {
  let longest = 0
  let run = 0
  for (const day of days) {
    run = isLogged(day) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  // Walk back from today; an empty today does not break the streak yet.
  let current = 0
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]!
    if (isLogged(day)) current++
    else if (day.day === todayDay && current === 0) continue
    else break
  }
  return { current, longest }
}

/**
 * Summary statistics. `days` is the full series (today included); averages
 * use the completed days only, streaks use everything.
 */
export function summarize(days: IntakeHistoryDay[], target: number | null, todayDay: DayString): IntakeSummary {
  const done = completedDays(days, todayDay)
  const logged = done.filter(isComplete)
  const partialCount = done.filter((day) => isLogged(day) && day.partial).length
  const avgKcal = mean(logged.map((day) => day.kcal))
  const hasTarget = target !== null && target > 0

  let onTargetDays = 0
  let overDays = 0
  let underDays = 0
  if (hasTarget) {
    for (const day of logged) {
      const delta = (day.kcal - target) / target
      if (Math.abs(delta) <= ON_TARGET_TOLERANCE) onTargetDays++
      else if (delta > 0) overDays++
      else underDays++
    }
  }

  const sorted = [...logged].sort((a, b) => a.kcal - b.kcal)
  const weekend = logged.filter((day) => [0, 6].includes(weekday(day.day)))
  const weekdays = logged.filter((day) => ![0, 6].includes(weekday(day.day)))
  const { current, longest } = streaks(days, todayDay)

  return {
    windowDays: done.length,
    loggedDays: logged.length,
    partialDays: partialCount,
    avgKcal,
    avgProteinG: mean(logged.map((day) => day.proteinG)),
    avgCarbsG: mean(logged.map((day) => day.carbsG)),
    avgFatG: mean(logged.map((day) => day.fatG)),
    avgVsTarget: hasTarget && avgKcal !== null ? avgKcal - target : null,
    onTargetDays,
    overDays,
    underDays,
    netBalanceKcal: hasTarget && logged.length > 0 ? logged.reduce((sum, day) => sum + day.kcal - target, 0) : null,
    highest: sorted.at(-1) ?? null,
    lowest: sorted[0] ?? null,
    avgWeekday: mean(weekdays.map((day) => day.kcal)),
    avgWeekend: mean(weekend.map((day) => day.kcal)),
    currentStreak: current,
    longestStreak: longest,
  }
}

/** Monday-start weekly rollups, newest first. Today counts toward its week. */
export function weeklyRollups(days: IntakeHistoryDay[], target: number | null): WeekRollup[] {
  const byWeek = new Map<DayString, IntakeHistoryDay[]>()
  for (const day of days) {
    const key = weekStartOf(day.day)
    byWeek.set(key, [...(byWeek.get(key) ?? []), day])
  }
  const hasTarget = target !== null && target > 0
  return Array.from(byWeek, ([weekStart, members]) => {
    const logged = members.filter(isComplete)
    const avgKcal = mean(logged.map((day) => day.kcal))
    return {
      weekStart,
      loggedDays: logged.length,
      partialDays: members.filter((day) => isLogged(day) && day.partial).length,
      avgKcal,
      avgProteinG: mean(logged.map((day) => day.proteinG)),
      totalKcal: logged.reduce((sum, day) => sum + day.kcal, 0),
      avgVsTarget: hasTarget && avgKcal !== null ? avgKcal - target : null,
    }
  })
    .filter((week) => week.loggedDays > 0 || week.partialDays > 0)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
}
