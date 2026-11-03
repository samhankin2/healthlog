#!/usr/bin/env node
// Stand-in for sync/garmin_sync.py in tests (GARMIN_PYTHON=node, GARMIN_SCRIPT=this).
// Behaviour is chosen by a `mode` file in the tokens dir: ok | needs_login | rate_limited | crash.
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
const arg = (name) => argv[argv.indexOf(name) + 1]
const tokens = arg('--tokens')
let mode = 'ok'
try { mode = fs.readFileSync(path.join(tokens, 'mode'), 'utf8').trim() } catch {}
fs.appendFileSync(path.join(tokens, 'calls'), `${argv[0]} ${arg('--from')} ${arg('--to')}\n`)
console.error('garmin WARNING garminconnect.client.sso: strategy mobile-a failed (expected)')
if (mode === 'crash') process.exit(1)
if (mode !== 'ok') {
  console.log(JSON.stringify({ ok: false, error: mode, message: `fake ${mode}` }))
  process.exit(mode === 'needs_login' ? 3 : 4)
}
const from = arg('--from'), to = arg('--to')
const days = []
for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
  days.push({ day: d.toISOString().slice(0, 10), steps: 9000, activeKcal: 600, totalKcal: 2600, bmrKcal: 2000, restingHr: 52, sleepSeconds: 27000, intensityMinutes: 40 })
}
const activities = [
  { externalId: '111', name: 'Morning Run', type: 'running', startLocal: `${to} 07:15:00`, durationS: 1800, movingS: 1750, distanceM: 5000, kcal: 350, avgHr: 150, maxHr: 172, elevationGainM: 40, avgSpeedMps: 2.78, trainingEffect: 3.1 },
  { externalId: '112', name: 'Strength', type: 'strength_training', startLocal: `${from} 18:00:00`, durationS: 2700, movingS: null, distanceM: null, kcal: 250, avgHr: 110, maxHr: 140, elevationGainM: null, avgSpeedMps: null, trainingEffect: 2.0 },
]
console.log(JSON.stringify({ ok: true, days, activities }))
