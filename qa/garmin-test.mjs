#!/usr/bin/env node
/**
 * Unit test for the Garmin sync rules (server/lib/garmin.js dueForSync and
 * syncRange). They are what keep the job to one attempt per interval, fetching
 * only unfinished days, and stop it hammering Garmin after a login failure or
 * a 429.   node qa/garmin-test.mjs
 */
import { dueForSync, syncRange } from '../server/lib/garmin.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail === undefined ? '' : `  (${JSON.stringify(detail)})`}`) } }
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), actual)

const at = (s) => new Date(s) // local time
const now = at('2026-11-03T09:00:00')
const iso = (s) => at(s).toISOString()
const tokens = at('2026-10-01T10:00:00')
const row = (status, lastAttempt, extra = {}) => ({ status, last_attempt_at: iso(lastAttempt), ...extra })

/* ---------- dueForSync (sync hour 6, every 3 hours) ---------- */
ok('never synced -> due', dueForSync(null, tokens, now, 6, 3))
ok('before the sync hour -> not due (nothing overnight)', !dueForSync(null, tokens, at('2026-11-03T05:59:00'), 6, 3))
ok('attempted last night -> due at the sync hour', dueForSync(row('connected', '2026-11-02T21:05:00'), tokens, at('2026-11-03T06:01:00'), 6, 3))
ok('attempted 2h ago (ok) -> not due', !dueForSync(row('connected', '2026-11-03T07:00:00'), tokens, now, 6, 3))
ok('attempted 3h ago (ok) -> due', dueForSync(row('connected', '2026-11-03T06:00:00'), tokens, now, 6, 3))
ok('attempted 2h ago (error) -> not due: one attempt per interval', !dueForSync(row('error', '2026-11-03T07:00:00'), tokens, now, 6, 3))
ok('interval below 1h is clamped to 1h', !dueForSync(row('connected', '2026-11-03T08:30:00'), tokens, now, 6, 0))
ok('needs_login, tokens unchanged -> never retried', !dueForSync(row('needs_login', '2026-10-20T06:05:00'), tokens, now, 6, 3))
ok('needs_login, fresh login since -> due', dueForSync(row('needs_login', '2026-10-20T06:05:00'), at('2026-11-03T08:00:00'), now, 6, 3))
ok('inside backoff -> not due', !dueForSync(row('rate_limited', '2026-11-02T06:05:00', { backoff_until: iso('2026-11-03T12:00:00') }), tokens, now, 6, 3))
ok('backoff over -> due', dueForSync(row('rate_limited', '2026-11-02T06:05:00', { backoff_until: iso('2026-11-02T12:05:00') }), tokens, now, 6, 3))

/* ---------- syncRange: only days that are not final ---------- */
const T = '2026-11-03'
eq('first sync backfills 30 days', syncRange(null, T), { from: '2026-10-05', to: T })
eq('last success after noon today -> today only', syncRange(iso('2026-11-03T15:00:00'), T), { from: T, to: T })
eq('last success this morning -> yesterday + today', syncRange(iso('2026-11-03T09:00:00'), T), { from: '2026-11-02', to: T })
eq('last success yesterday afternoon -> yesterday + today', syncRange(iso('2026-11-02T18:00:00'), T), { from: '2026-11-02', to: T })
eq('last success 3 days ago -> picks up from the first unfinished day', syncRange(iso('2026-10-31T10:00:00'), T), { from: '2026-10-30', to: T })
eq('a gap longer than 30 days is capped at the backfill', syncRange(iso('2026-08-01T10:00:00'), T), { from: '2026-10-05', to: T })
eq('explicit days forces the last N days', syncRange(iso('2026-11-03T15:00:00'), T, 7), { from: '2026-10-28', to: T })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
