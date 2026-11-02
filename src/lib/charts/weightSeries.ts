import { addDays, daysApart, today } from '../format'
import type { WeightEntry } from '../types'

export interface WeightChartPoint {
  date: string
  weightKg: number | null
  avg7Kg: number | null
  deltaKg: number | null
}

/** A continuous daily axis: raw entries stay sparse, the trailing average carries over gaps. */
export function buildWeightSeries(entries: WeightEntry[], endDate: string, windowDays: number): WeightChartPoint[] {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0]
  const days = windowDays === 0
    ? Math.min(3650, Math.max(30, first ? daysApart(first.date, endDate) + 1 : 30))
    : Math.max(1, windowDays)
  const start = addDays(endDate, -(days - 1))
  const byDate = new Map(sorted.map((entry) => [entry.date, entry.weightKg]))
  const series: WeightChartPoint[] = []
  let previousWeight: number | null = null

  for (let index = 0; index < days; index += 1) {
    const date = addDays(start, index)
    let sum = 0
    let count = 0
    for (let offset = 0; offset < 7; offset += 1) {
      const value = byDate.get(addDays(date, -offset))
      if (value !== undefined) {
        sum += value
        count += 1
      }
    }
    const weightKg = byDate.get(date) ?? null
    series.push({
      date,
      weightKg,
      avg7Kg: count > 0 ? sum / count : null,
      deltaKg: weightKg !== null && previousWeight !== null ? weightKg - previousWeight : null,
    })
    if (weightKg !== null) previousWeight = weightKg
  }
  return series
}

export function defaultChartEndDate(): string {
  return today()
}
