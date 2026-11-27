/**
 * Client diagnostics — what went wrong on this device, kept until the API can
 * hear about it (SPEC §6 "Client diagnostics").
 *
 * When the app cannot reach the API, the server never sees the attempt, so the
 * only record of an outage is the one the device keeps. This module queues
 * small events in localStorage (failed requests, the outage length once a
 * request succeeds again, app starts, uncaught errors); `api.ts` uploads the
 * queue after the next successful request. Framework-agnostic, no fetch here.
 */

export type ClientEventType = 'fetch-fail' | 'recovered' | 'boot' | 'error'

export interface ClientEvent {
  type: ClientEventType
  at: string
  path?: string
  method?: string
  /** fetch-fail: 'network' (no answer at all), 'timeout', or 'http' (5xx). */
  kind?: string
  status?: number
  ms?: number
  error?: string
  online?: boolean
  visible?: boolean
  standalone?: boolean
  net?: string
  sinceLoadMs?: number
  firstFailAt?: string
  failures?: number
  outageMs?: number
  source?: string
  build?: string
  /** The API host the request went to (the app can fail over between several). */
  base?: string
}

const QUEUE_KEY = 'healthlog.clientlog.v1'
const OUTAGE_KEY = 'healthlog.clientlog.outage.v1'
const MAX_QUEUED = 100

const pageLoadedAt = Date.now()
/** The hashed bundle name identifies the frontend build (index-AbC123.js). */
const build = (() => {
  try { return new URL(import.meta.url).pathname.split('/').pop() ?? undefined } catch { return undefined }
})()

/** Storage can be missing or throw (private mode, blocked site data). */
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Diagnostics are best-effort; never break the app over them.
  }
}

function context(): Pick<ClientEvent, 'online' | 'visible' | 'standalone' | 'net' | 'sinceLoadMs'> {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
  let standalone: boolean | undefined
  try {
    standalone = window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    standalone = undefined
  }
  return {
    online: navigator.onLine,
    visible: document.visibilityState === 'visible',
    standalone,
    net: connection?.effectiveType,
    sinceLoadMs: Date.now() - pageLoadedAt,
  }
}

function push(event: ClientEvent): void {
  const queue = readJson<ClientEvent[]>(QUEUE_KEY, [])
  queue.push(event)
  writeJson(QUEUE_KEY, queue.slice(-MAX_QUEUED))
}

interface Outage {
  firstFailAt: string
  failures: number
}

/** A request got no usable answer: no response, a timeout, or a 5xx. */
export function recordFetchFailure(details: { path: string; method: string; kind: 'network' | 'timeout' | 'http'; status?: number; ms: number; error?: string; base?: string }): void {
  const now = new Date().toISOString()
  push({ type: 'fetch-fail', at: now, build, ...details, ...context() })
  const outage = readJson<Outage | null>(OUTAGE_KEY, null)
  writeJson(OUTAGE_KEY, outage ? { ...outage, failures: outage.failures + 1 } : { firstFailAt: now, failures: 1 })
}

/** A request got an answer (from `base`). Closes an open outage with its length. */
export function recordFetchSuccess(base?: string): void {
  const outage = readJson<Outage | null>(OUTAGE_KEY, null)
  if (!outage) return
  const now = new Date()
  push({
    type: 'recovered',
    at: now.toISOString(),
    build,
    firstFailAt: outage.firstFailAt,
    failures: outage.failures,
    outageMs: now.getTime() - new Date(outage.firstFailAt).getTime(),
    base,
    ...context(),
  })
  writeJson(OUTAGE_KEY, null)
}

/** Events waiting to be uploaded (a copy). */
export function pendingEvents(): ClientEvent[] {
  return readJson<ClientEvent[]>(QUEUE_KEY, [])
}

/** Drop the first `count` events after they were uploaded. */
export function acknowledgeEvents(count: number): void {
  const queue = readJson<ClientEvent[]>(QUEUE_KEY, [])
  writeJson(QUEUE_KEY, queue.length > count ? queue.slice(count) : null)
}

/** Record this app start and watch for uncaught errors. Call once at boot. */
export function startClientLog(): void {
  push({ type: 'boot', at: new Date().toISOString(), build, ...context() })
  window.addEventListener('error', (event) => {
    push({ type: 'error', at: new Date().toISOString(), build, source: 'error', error: String(event.message || event.error || 'error'), ...context() })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? `${event.reason.name}: ${event.reason.message}` : String(event.reason)
    // Expected API failures surface as rejected promises too; those are already logged.
    if (reason.startsWith('ApiError')) return
    push({ type: 'error', at: new Date().toISOString(), build, source: 'rejection', error: reason, ...context() })
  })
}
