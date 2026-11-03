#!/usr/bin/env node
/**
 * Unit test for the Garmin daily-sync rule (server/lib/garmin.js dueForDailySync).
 * The rule is what keeps the job to one attempt a day and stops it hammering
 * Garmin after a login failure or a 429.   node qa/garmin-test.mjs
 */
import { dueForDailySync } from '../server/lib/garmin.js'

let pass = 0
let fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

const at = (s) => new Date(s) // local time
const now = at('2026-11-03T09:00:00')
const iso = (s) => at(s).toISOString()
const tokens = at('2026-10-01T10:00:00')

ok('never synced -> due', dueForDailySync(null, tokens, now, 6))
ok('before the sync hour -> not due', !dueForDailySync(null, tokens, at('2026-11-03T05:59:00'), 6))
ok('attempted yesterday -> due', dueForDailySync({ status: 'connected', last_attempt_at: iso('2026-11-02T06:05:00') }, tokens, now, 6))
ok('attempted today (ok) -> not due', !dueForDailySync({ status: 'connected', last_attempt_at: iso('2026-11-03T06:05:00') }, tokens, now, 6))
ok('attempted today (error) -> not due: one attempt a day', !dueForDailySync({ status: 'error', last_attempt_at: iso('2026-11-03T06:05:00') }, tokens, now, 6))
ok('needs_login, tokens unchanged -> never retried', !dueForDailySync({ status: 'needs_login', last_attempt_at: iso('2026-10-20T06:05:00') }, tokens, now, 6))
ok('needs_login, fresh login since -> due', dueForDailySync({ status: 'needs_login', last_attempt_at: iso('2026-10-20T06:05:00') }, at('2026-11-03T08:00:00'), now, 6))
ok('inside backoff -> not due', !dueForDailySync({ status: 'rate_limited', last_attempt_at: iso('2026-11-02T06:05:00'), backoff_until: iso('2026-11-03T12:00:00') }, tokens, now, 6))
ok('backoff over, new day -> due', dueForDailySync({ status: 'rate_limited', last_attempt_at: iso('2026-11-02T06:05:00'), backoff_until: iso('2026-11-02T12:05:00') }, tokens, now, 6))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
