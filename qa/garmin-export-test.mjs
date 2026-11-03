#!/usr/bin/env node
/**
 * Garmin export importer check: runs the browser's own ZIP reader and parser
 * (src/lib/zip.ts, src/lib/garminExport.ts — Node strips their types) against a
 * real Garmin Connect export and prints what it would import.
 *
 *   node qa/garmin-export-test.mjs <path-to-export.zip> [--json out.json]
 *
 * Personal data: pass the ZIP path in; never commit an export or its output.
 */
import fs from 'node:fs'
import { listZip, readZipText } from '../src/lib/zip.ts'
import { EXPORT_FILE_PATTERN, parseGarminExport, summariseImport } from '../src/lib/garminExport.ts'

const zipPath = process.argv[2]
if (!zipPath) {
  console.error('usage: node qa/garmin-export-test.mjs <export.zip> [--json out.json]')
  process.exit(2)
}
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

const buf = fs.readFileSync(zipPath)
const blob = new Blob([buf])
const t0 = Date.now()
const entries = await listZip(blob)
const wanted = entries.filter((e) => EXPORT_FILE_PATTERN.test(e.name))
const files = {}
for (const e of wanted) files[e.name] = JSON.parse(await readZipText(blob, e))
const payload = parseGarminExport(files)
const size = JSON.stringify(payload).length
console.log(`read ${wanted.length}/${entries.length} entries in ${Date.now() - t0} ms; payload ${(size / 1024).toFixed(0)} KB`)
console.log(summariseImport(payload), payload.range)

ok('zip: has entries', entries.length > 0)
ok('days parsed', payload.days.length > 30)
ok('nights parsed', payload.sleep.length > 30)
ok('activities parsed', payload.activities.length > 10)
ok('payload under the 12 MB import limit', size < 12 * 1024 * 1024)

const run = payload.activities.find((a) => a.type === 'running' && a.distanceM)
ok('run distance in metres (1-60 km)', run && run.distanceM > 1000 && run.distanceM < 60_000, JSON.stringify(run))
ok('run speed in m/s (1.5-7)', run && run.avgSpeedMps > 1.5 && run.avgSpeedMps < 7)
ok('run duration in seconds (5 min-6 h)', run && run.durationS > 300 && run.durationS < 6 * 3600)
ok('run kcal per km is plausible (40-120)', run && run.kcal / (run.distanceM / 1000) > 40 && run.kcal / (run.distanceM / 1000) < 120, String(run?.kcal))
ok('run elevation in metres', run && (run.elevationGainM === null || run.elevationGainM < 3000))
ok('run zones sum ≈ duration', run && run.hrZonesS && Math.abs(run.hrZonesS.reduce((a, b) => a + b, 0) - run.durationS) < run.durationS * 0.15)
ok('activity startLocal is a local timestamp', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(payload.activities[0].startLocal))

const night = payload.sleep[payload.sleep.length - 1]
const bedHour = Number(night.startLocal?.slice(11, 13))
ok('bedtime is evening/night local time', bedHour >= 19 || bedHour <= 3, night.startLocal)
ok('wake is morning local time', Number(night.endLocal?.slice(11, 13)) >= 4 && Number(night.endLocal?.slice(11, 13)) <= 12, night.endLocal)
ok('night ends on its calendar day', night.endLocal?.slice(0, 10) === night.day)
ok('sleep score 0-100', payload.sleep.every((x) => x.score === null || (x.score >= 0 && x.score <= 100)))
const d = payload.days.find((x) => x.sleepSeconds)
ok('daily sleep seconds filled from nights', d && d.sleepSeconds > 3 * 3600 && d.sleepSeconds < 14 * 3600)
ok('stress avg 0-100', payload.days.every((x) => x.stressAvg === null || (x.stressAvg >= 0 && x.stressAvg <= 100)))
ok('body battery wake 0-100', payload.days.some((x) => x.bbWake !== null))
ok('vo2max present', payload.metrics.some((m) => m.vo2max))
ok('race predictions present', payload.metrics.some((m) => m.race5kS))
ok('records present', payload.records.length > 0)

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(payload))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
