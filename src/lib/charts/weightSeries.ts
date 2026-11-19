import { addDays, daysApart, today } from '../format'
import { buildTrend, trendOn } from '../weightTrend'
import type { WeightEntry } from '../types'

export interface WeightChartPoint {
  date: string
  weightKg: number | null
  /** Smoothed trend weight (lib/weightTrend.ts) — not a 7-day mean, which a single weigh-in would dominate. */
  trendKg: number | null
  deltaKg: number | null
}

/** A continuous daily axis: raw entries stay sparse, the trend carries over gaps. */
export function buildWeightSeries(entries: WeightEntry[], endDate: string, windowDays: number): WeightChartPoint[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0]
  const days = windowDays === 0
    ? Math.min(3650, Math.max(30, first ? daysApart(first.date, endDate) + 1 : 30))
    : Math.max(1, windowDays)
  const start = addDays(endDate, -(days - 1))
  const byDate = new Map(sorted.map((entry) => [entry.date, entry.weightKg]))
  const trend = buildTrend(sorted, endDate)
  const series: WeightChartPoint[] = []
  let previousWeight: number | null = null
  for (const entry of sorted) if (entry.date < start) previousWeight = entry.weightKg

  for (let index = 0; index < days; index += 1) {
    const date = addDays(start, index)
    const weightKg = byDate.get(date) ?? null
    series.push({
      date,
      weightKg,
      trendKg: trendOn(trend, date),
      deltaKg: weightKg !== null && previousWeight !== null ? weightKg - previousWeight : null,
    })
    if (weightKg !== null) previousWeight = weightKg
  }
  return series
}

export function defaultChartEndDate(): string {
  return today()
}
