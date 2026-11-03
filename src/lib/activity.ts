/** Formatting for Garmin activities and daily watch data. Framework-agnostic. */
import type { Activity, GarminStatus } from './types'

const TYPE_LABELS: Record<string, string> = {
  running: 'Run',
  treadmill_running: 'Treadmill run',
  trail_running: 'Trail run',
  indoor_running: 'Indoor run',
  track_running: 'Track run',
  cycling: 'Ride',
  road_biking: 'Road ride',
  mountain_biking: 'MTB ride',
  indoor_cycling: 'Indoor ride',
  virtual_ride: 'Virtual ride',
  walking: 'Walk',
  hiking: 'Hike',
  lap_swimming: 'Pool swim',
  open_water_swimming: 'Open-water swim',
  strength_training: 'Strength',
  yoga: 'Yoga',
  pilates: 'Pilates',
  hiit: 'HIIT',
  cardio: 'Cardio',
  elliptical: 'Elliptical',
  indoor_rowing: 'Rowing',
  rowing: 'Rowing',
}

export function activityTypeLabel(type: string | null): string {
  if (!type) return 'Activity'
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

/** Pace (min/km) suits foot sports; speed (km/h) suits the rest. */
export function isPaceSport(type: string | null): boolean {
  return !!type && /running|walking|hiking/.test(type)
}

export function isSwim(type: string | null): boolean {
  return !!type && type.includes('swim')
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function fmtDistance(meters: number | null, type: string | null = null): string | null {
  if (meters === null || meters <= 0) return null
  if (isSwim(type)) return `${Math.round(meters).toLocaleString()} m`
  return `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 2)} km`
}

export function fmtPaceOrSpeed(a: Pick<Activity, 'type' | 'distanceM' | 'movingS' | 'durationS' | 'avgSpeedMps'>): string | null {
  const time = a.movingS ?? a.durationS
  if (isSwim(a.type)) {
    if (!a.distanceM || !time) return null
    const per100 = time / (a.distanceM / 100)
    return `${fmtDuration(per100)} /100m`
  }
  const speed = a.avgSpeedMps ?? (a.distanceM && time ? a.distanceM / time : null)
  if (!speed || speed <= 0) return null
  if (isPaceSport(a.type)) return `${fmtDuration(1000 / speed)} /km`
  return `${(speed * 3.6).toFixed(1)} km/h`
}

/** "Mon 3 Nov · 07:15" from a local "YYYY-MM-DDTHH:MM:SS". */
export function fmtActivityStart(startLocal: string): string {
  const [datePart, timePart = ''] = startLocal.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  const day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return timePart ? `${day} · ${timePart.slice(0, 5)}` : day
}

export function fmtSleep(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** "3 h ago", "just now", "2 days ago". */
export function fmtAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const diff = Math.max(0, now - Date.parse(iso))
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 36) return `${h} h ago`
  const days = Math.round(h / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** One-line status for the sync control. */
export function garminStatusLine(g: GarminStatus): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!g.available) return { text: 'Garmin sync is not installed on the server yet.', tone: 'neutral' }
  if (!g.connected) return { text: 'Not connected. Run the one-time login on the server.', tone: 'warning' }
  if (g.backoffUntil) return { text: `Garmin is rate-limiting requests, so syncing is paused until ${fmtClock(g.backoffUntil)}.`, tone: 'warning' }
  if (g.status === 'needs_login') return { text: 'Garmin stopped accepting the saved login. Run the login command on the server again.', tone: 'danger' }
  if (g.status === 'error') return { text: `Last sync failed ${fmtAgo(g.lastAttemptAt)}. Your synced data is still here.`, tone: 'danger' }
  if (g.lastSuccessAt) return { text: `Synced ${fmtAgo(g.lastSuccessAt)}. Syncs automatically once a day.`, tone: 'success' }
  return { text: 'Connected. The first sync hasn’t run yet.', tone: 'neutral' }
}
