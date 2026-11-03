/** Tiny scale + tick helpers for the hand-drawn SVG charts. No dependency. */
import { dayNum, numDay } from '../insights'

export interface Scale {
  (v: number): number
  domain: [number, number]
  range: [number, number]
}

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0)
  const fn = ((v: number) => r0 + (v - d0) * k) as Scale
  fn.domain = domain
  fn.range = range
  return fn
}

/** ~count round ticks covering [lo, hi]; returns the expanded domain too. */
export function niceTicks(lo: number, hi: number, count = 4, minStep = 0): { ticks: number[]; domain: [number, number] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0, 1], domain: [0, 1] }
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max(minStep, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag)
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)))
  return { ticks, domain: [start, end] }
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Date-axis ticks for [from, to]: months (with the year on January), or weeks for short ranges. */
export function dayTicks(from: string, to: string, maxTicks = 6): { day: string; label: string }[] {
  const span = dayNum(to) - dayNum(from)
  if (span <= 45) {
    const step = Math.max(1, Math.ceil(span / maxTicks / 7)) * 7
    const out: { day: string; label: string }[] = []
    for (let n = dayNum(to); n >= dayNum(from); n -= step) {
      const d = numDay(n)
      out.unshift({ day: d, label: `${+d.slice(8, 10)} ${MONTH[+d.slice(5, 7) - 1]}` })
    }
    return out
  }
  const months: string[] = []
  let y = +from.slice(0, 4)
  let m = +from.slice(5, 7)
  for (;;) {
    m++
    if (m > 12) { m = 1; y++ }
    const d = `${y}-${String(m).padStart(2, '0')}-01`
    if (d > to) break
    months.push(d)
  }
  const every = Math.max(1, Math.ceil(months.length / maxTicks))
  return months.filter((_, i) => i % every === 0).map((d) => {
    const mi = +d.slice(5, 7) - 1
    return { day: d, label: mi === 0 || months.length <= 3 ? `${MONTH[mi]} ’${d.slice(2, 4)}` : MONTH[mi] }
  })
}

export const fmtDayShort = (day: string): string => `${+day.slice(8, 10)} ${MONTH[+day.slice(5, 7) - 1]}`
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const fmtDayLong = (day: string): string => {
  const wd = (new Date(dayNum(day) * 86_400_000).getUTCDay() + 6) % 7
  return `${WEEKDAY[wd]} ${+day.slice(8, 10)} ${MONTH[+day.slice(5, 7) - 1]} ${day.slice(0, 4)}`
}

/** SVG path through points, breaking at gaps (null). */
export function linePath(points: { x: number; y: number | null }[]): string {
  let d = ''
  let pen = false
  for (const p of points) {
    if (p.y === null || !Number.isFinite(p.y)) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`
    pen = true
  }
  return d
}

/** Rounded-top bar path (4px data end, square baseline). */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}
