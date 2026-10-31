const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number)
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 }
}

function localDate(day: string): Date {
  const { y, m, d } = parts(day)
  return new Date(y, m - 1, d)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Current local-calendar day, not a UTC date. */
export function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function fmtShort(day: string): string {
  const { m, d } = parts(day)
  return `${d} ${MONTHS_SHORT[m - 1]}`
}

export function fmtMedium(day: string): string {
  const { y, m, d } = parts(day)
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`
}

export function fmtLong(day: string): string {
  const { y, m, d } = parts(day)
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`
}

export function fmtWithDay(day: string): string {
  const { m, d } = parts(day)
  return `${DAYS_SHORT[localDate(day).getDay()]} ${d} ${MONTHS_SHORT[m - 1]}`
}

export function fmtRange(start: string, end: string | null): string {
  if (!end) return `${fmtMedium(start)} – ongoing`
  return parts(start).y === parts(end).y
    ? `${fmtShort(start)} – ${fmtShort(end)}`
    : `${fmtMedium(start)} – ${fmtMedium(end)}`
}

/** Days between two local-calendar day strings (b - a). */
export function daysApart(a: string, b: string): number {
  return Math.round((localDate(b).getTime() - localDate(a).getTime()) / 86_400_000)
}

export function addDays(day: string, amount: number): string {
  const date = localDate(day)
  date.setDate(date.getDate() + amount)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function fmtRelative(day: string, todayDay = today()): string {
  const diff = daysApart(todayDay, day)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === -2) return '2 days ago'
  if (diff === 1) return 'Tomorrow'
  return fmtWithDay(day)
}

export function toDateInputValue(day: string): string {
  const { y, m, d } = parts(day)
  return `${y}-${pad(m)}-${pad(d)}`
}

export function fromDateInputValue(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export function fmtNumber(value: number, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
}

export function fmtKg(value: number, signed = false): string {
  const prefix = signed && value > 0 ? '+' : ''
  return `${prefix}${fmtNumber(value, 1)} kg`
}

export function fmtKcal(value: number): string {
  return `${fmtNumber(value, 0)} kcal`
}

export function fmtMacro(value: number): string {
  return `${fmtNumber(value, 1)} g`
}

/** Relative clock time for an epoch-ms timestamp or an ISO timestamp. */
export function fmtRelativeTime(timestamp: number | string, now = Date.now()): string {
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp)
  if (!Number.isFinite(time)) return ''
  const elapsed = now - time
  const future = elapsed < 0
  const seconds = Math.round(Math.abs(elapsed) / 1000)
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [604_800, 'week'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [size, unit] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size)
      return formatter.format(future ? value : -value, unit)
    }
  }
  return future ? 'in a few seconds' : 'just now'
}

export function fmtTime(timestamp: number | string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}
