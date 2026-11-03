/**
 * Garmin Connect data export -> HealthLog import payload. Framework-agnostic
 * and pure: the caller hands over the parsed JSON files (keyed by their path in
 * the export ZIP), this returns the compact rows `POST /api/garmin/import`
 * takes. SPEC §6 "Garmin insights".
 *
 * Unit traps in the export (verified against a real export):
 *   - summarizedActivities: calories in kJ, duration/movingDuration in ms, distance and
 *     elevation in cm, avgSpeed in cm/ms, hrTimeInZone_* in ms.
 *   - startTimeLocal is wall-clock time encoded as epoch ms "as if UTC".
 *   - Sleep timestamps are GMT; the local offset comes from the same day's
 *     daily summary (wellnessStartTimeLocal - wellnessStartTimeGmt).
 */

export interface ImportDay {
  day: string
  steps: number | null
  activeKcal: number | null
  totalKcal: number | null
  bmrKcal: number | null
  restingHr: number | null
  sleepSeconds: number | null
  intensityMinutes: number | null
  distanceM: number | null
  floorsM: number | null
  moderateMin: number | null
  vigorousMin: number | null
  stepGoal: number | null
  minHr: number | null
  maxHr: number | null
  stressAvg: number | null
  stressMax: number | null
  stressRestS: number | null
  stressLowS: number | null
  stressMediumS: number | null
  stressHighS: number | null
  bbHigh: number | null
  bbLow: number | null
  bbCharged: number | null
  bbDrained: number | null
  bbWake: number | null
  spo2Avg: number | null
  spo2Low: number | null
  respAvg: number | null
}

export interface ImportSleep {
  day: string
  startLocal: string | null
  endLocal: string | null
  deepS: number | null
  lightS: number | null
  remS: number | null
  awakeS: number | null
  score: number | null
  qualityScore: number | null
  durationScore: number | null
  recoveryScore: number | null
  avgStress: number | null
  avgResp: number | null
  avgSpo2: number | null
  avgHr: number | null
  awakeCount: number | null
  restlessCount: number | null
  feedback: string | null
}

export interface ImportMetrics {
  day: string
  vo2max?: number | null
  race5kS?: number | null
  race10kS?: number | null
  raceHalfS?: number | null
  raceMarathonS?: number | null
  trainingStatus?: string | null
  weeklyLoad?: number | null
  loadMin?: number | null
  loadMax?: number | null
  fitnessAge?: number | null
  heatPct?: number | null
}

export interface ImportActivity {
  externalId: string
  name: string | null
  type: string | null
  startLocal: string
  durationS: number | null
  movingS: number | null
  distanceM: number | null
  kcal: number | null
  avgHr: number | null
  maxHr: number | null
  elevationGainM: number | null
  avgSpeedMps: number | null
  trainingEffect: number | null
  anaerobicTe: number | null
  trainingLoad: number | null
  teLabel: string | null
  vo2max: number | null
  steps: number | null
  cadence: number | null
  location: string | null
  hrZonesS: number[] | null
  sets: number | null
  reps: number | null
}

export interface ImportRecord {
  type: string
  value: number
  achievedAt: string | null
  externalId: string | null
}

export interface GarminImportPayload {
  range: { from: string; to: string } | null
  days: ImportDay[]
  sleep: ImportSleep[]
  metrics: ImportMetrics[]
  activities: ImportActivity[]
  records: ImportRecord[]
  meta: { hrZones?: Record<string, number>; thresholds?: Record<string, number> }
}

/** Which ZIP entries the importer reads; everything else (FIT files, golf, profile images) is skipped. */
export const EXPORT_FILE_PATTERN =
  /(UDSFile_[^/]*\.json|_sleepData\.json|summarizedActivities\.json|TrainingHistory_[^/]*\.json|RunRacePredictions_[^/]*\.json|MetricsMaxMetData_[^/]*\.json|MetricsHeatAltitudeAcclimation_[^/]*\.json|fitnessAgeData\.json|personalRecord\.json|heartRateZones\.json|bioMetrics_latest\.json)$/

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
/** Garmin uses negative sentinels (-1, -2) for "no reading". */
const pos = (v: unknown): number | null => {
  const x = n(v)
  return x !== null && x >= 0 ? x : null
}
const scale = (v: unknown, f: number): number | null => {
  const x = n(v)
  return x === null ? null : x * f
}
const round = (v: number | null, digits = 0): number | null => (v === null ? null : Number(v.toFixed(digits)))
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const dayOf = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/** "2026-01-07T12:47:00.0" (no zone) -> epoch ms, read as UTC. */
const utcMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const ms = Date.parse(`${v.replace(' ', 'T').replace(/\.\d+$/, '')}Z`)
  return Number.isFinite(ms) ? ms : null
}
/** Epoch ms -> "YYYY-MM-DDTHH:MM:SS" in UTC (wall-clock for *Local fields). */
const isoWall = (ms: number): string => new Date(ms).toISOString().slice(0, 19)

function filesMatching(files: Record<string, unknown>, re: RegExp): unknown[] {
  return Object.keys(files).filter((k) => re.test(k)).sort().map((k) => files[k])
}

/** Per-day UTC offsets (ms) with nearest-earlier fallback. */
class Offsets {
  private days: string[] = []
  private map = new Map<string, number>()
  set(day: string, ms: number): void {
    this.map.set(day, ms)
  }
  freeze(): void {
    this.days = [...this.map.keys()].sort()
  }
  get(day: string): number {
    const hit = this.map.get(day)
    if (hit !== undefined) return hit
    let best: string | null = null
    for (const d of this.days) {
      if (d <= day) best = d
      else break
    }
    return this.map.get(best ?? this.days[0] ?? '') ?? 0
  }
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

function parseDays(files: Record<string, unknown>, offsets: Offsets): Map<string, ImportDay> {
  const out = new Map<string, ImportDay>()
  for (const file of filesMatching(files, /UDSFile_[^/]*\.json$/)) {
    for (const u of arr(file)) {
      const day = u.calendarDate
      if (!isDay(day)) continue
      const local = utcMs(u.wellnessStartTimeLocal)
      const gmt = utcMs(u.wellnessStartTimeGmt)
      if (local !== null && gmt !== null) offsets.set(day, local - gmt)
      // Days without a step count are the watch's placeholder rows (BMR only): skip them.
      if (n(u.totalSteps) === null) continue
      // ...and so are days the watch was barely worn (no resting HR, a handful of steps).
      if (pos(u.restingHeartRate) === null && (n(u.totalSteps) ?? 0) < 1000) continue
      const stress = arr(isObj(u.allDayStress) ? u.allDayStress.aggregatorList : null).find((a) => a.type === 'TOTAL') ?? {}
      const bb = isObj(u.bodyBattery) ? u.bodyBattery : {}
      const bbStat = (type: string): number | null => pos(arr(bb.bodyBatteryStatList).find((x) => x.bodyBatteryStatType === type)?.statsValue)
      const resp = isObj(u.respiration) ? u.respiration : {}
      const moderate = n(u.moderateIntensityMinutes)
      const vigorous = n(u.vigorousIntensityMinutes)
      out.set(day, {
        day,
        steps: n(u.totalSteps),
        activeKcal: n(u.activeKilocalories),
        totalKcal: n(u.totalKilocalories),
        bmrKcal: n(u.bmrKilocalories),
        restingHr: pos(u.restingHeartRate),
        sleepSeconds: null, // filled from the sleep files below
        intensityMinutes: moderate === null && vigorous === null ? null : (moderate ?? 0) + 2 * (vigorous ?? 0),
        distanceM: n(u.totalDistanceMeters),
        floorsM: round(n(u.floorsAscendedInMeters), 1),
        moderateMin: moderate,
        vigorousMin: vigorous,
        stepGoal: n(u.dailyStepGoal),
        minHr: pos(u.minHeartRate),
        maxHr: pos(u.maxHeartRate),
        stressAvg: pos(stress.averageStressLevel),
        stressMax: pos(stress.maxStressLevel),
        stressRestS: pos(stress.restDuration),
        stressLowS: pos(stress.lowDuration),
        stressMediumS: pos(stress.mediumDuration),
        stressHighS: pos(stress.highDuration),
        bbHigh: bbStat('HIGHEST'),
        bbLow: bbStat('LOWEST'),
        bbCharged: pos(bb.chargedValue),
        bbDrained: pos(bb.drainedValue),
        bbWake: bbStat('SLEEPEND'),
        spo2Avg: pos(u.averageSpo2Value),
        spo2Low: pos(u.lowestSpo2Value),
        respAvg: pos(resp.avgWakingRespirationValue),
      })
    }
  }
  offsets.freeze()
  // The newest summary is the day the export was made, so its running totals
  // (steps, kcal, stress) are partial. Keep only what is final by morning:
  // resting HR and the Body Battery you woke with. The live sync fills the rest.
  const last = [...out.keys()].sort().pop()
  const partial = last ? out.get(last) : undefined
  if (last && partial) {
    const kept: (keyof ImportDay)[] = ['day', 'restingHr', 'bbWake', 'bbHigh']
    for (const key of Object.keys(partial) as (keyof ImportDay)[]) {
      if (!kept.includes(key)) (partial as unknown as Record<string, null>)[key] = null
    }
  }
  return out
}

function parseSleep(files: Record<string, unknown>, offsets: Offsets): ImportSleep[] {
  const byDay = new Map<string, ImportSleep>()
  for (const file of filesMatching(files, /_sleepData\.json$/)) {
    for (const r of arr(file)) {
      const day = r.calendarDate
      if (!isDay(day)) continue
      const deep = n(r.deepSleepSeconds) ?? 0
      const light = n(r.lightSleepSeconds) ?? 0
      const rem = n(r.remSleepSeconds) ?? 0
      if (deep + light + rem <= 0) continue // off-wrist or unconfirmed night
      const off = offsets.get(day)
      const start = utcMs(r.sleepStartTimestampGMT)
      const end = utcMs(r.sleepEndTimestampGMT)
      const sc = isObj(r.sleepScores) ? r.sleepScores : {}
      const spo2 = isObj(r.spo2SleepSummary) ? r.spo2SleepSummary : {}
      byDay.set(day, {
        day,
        startLocal: start === null ? null : isoWall(start + off),
        endLocal: end === null ? null : isoWall(end + off),
        deepS: deep,
        lightS: light,
        remS: rem,
        awakeS: n(r.awakeSleepSeconds),
        score: n(sc.overallScore),
        qualityScore: n(sc.qualityScore),
        durationScore: n(sc.durationScore),
        recoveryScore: n(sc.recoveryScore),
        avgStress: round(pos(r.avgSleepStress), 1),
        avgResp: round(pos(r.averageRespiration), 1),
        avgSpo2: round(pos(spo2.averageSPO2), 1),
        avgHr: pos(spo2.averageHR),
        awakeCount: n(r.awakeCount),
        restlessCount: n(r.restlessMomentCount),
        feedback: s(sc.feedback),
      })
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

/** Latest entry per calendar day (by timestamp), across a set of files. */
function latestPerDay(files: unknown[], tsKey: string, keep: (r: Obj) => boolean = () => true): Map<string, Obj> {
  const out = new Map<string, Obj>()
  for (const file of files) {
    for (const r of arr(file)) {
      const day = r.calendarDate
      if (!isDay(day) || !keep(r)) continue
      const prev = out.get(day)
      if (!prev || String(r[tsKey] ?? '') >= String(prev[tsKey] ?? '')) out.set(day, r)
    }
  }
  return out
}

function parseMetrics(files: Record<string, unknown>): ImportMetrics[] {
  const rows = new Map<string, ImportMetrics>()
  const row = (day: string): ImportMetrics => {
    let r = rows.get(day)
    if (!r) rows.set(day, (r = { day }))
    return r
  }
  for (const [day, r] of latestPerDay(filesMatching(files, /TrainingHistory_[^/]*\.json$/), 'timestamp')) {
    const m = row(day)
    m.trainingStatus = s(r.trainingStatus)
    m.weeklyLoad = n(r.weeklyTrainingLoadSum)
    m.loadMin = n(r.loadTunnelMin)
    m.loadMax = n(r.loadTunnelMax)
  }
  for (const [day, r] of latestPerDay(filesMatching(files, /RunRacePredictions_[^/]*\.json$/), 'timestamp')) {
    const m = row(day)
    m.race5kS = n(r.raceTime5K)
    m.race10kS = n(r.raceTime10K)
    m.raceHalfS = n(r.raceTimeHalf)
    m.raceMarathonS = n(r.raceTimeMarathon)
  }
  // Running VO2max (entries without a sport are the generic/running estimate; cycling is separate).
  const vo2 = filesMatching(files, /MetricsMaxMetData_[^/]*\.json$/)
  for (const [day, r] of latestPerDay(vo2, 'updateTimestamp', (x) => x.sport === undefined || x.sport === 'RUNNING')) {
    row(day).vo2max = n(r.vo2MaxValue)
  }
  for (const [day, r] of latestPerDay(filesMatching(files, /MetricsHeatAltitudeAcclimation_[^/]*\.json$/), 'timestamp')) {
    row(day).heatPct = pos(r.heatAcclimationPercentage)
  }
  for (const file of filesMatching(files, /fitnessAgeData\.json$/)) {
    for (const r of arr(file)) {
      const day = dayOf(r.asOfDateGmt)
      const age = n(r.currentBioAge)
      if (day && age !== null) row(day).fitnessAge = round(age, 1)
    }
  }
  return [...rows.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
}

function parseActivities(files: Record<string, unknown>): ImportActivity[] {
  const out: ImportActivity[] = []
  for (const file of filesMatching(files, /summarizedActivities\.json$/)) {
    const list = arr(file).flatMap((x) => arr(x.summarizedActivitiesExport))
    for (const a of list) {
      const id = n(a.activityId)
      const startMs = n(a.startTimeLocal)
      if (id === null || startMs === null || a.parent === true) continue // a multisport parent repeats its legs
      const zones = [0, 1, 2, 3, 4, 5].map((i) => n(a[`hrTimeInZone_${i}`]))
      const isRun = typeof a.activityType === 'string' && a.activityType.includes('running')
      out.push({
        externalId: String(id),
        name: s(a.name),
        type: s(a.activityType),
        startLocal: isoWall(startMs),
        durationS: round(scale(a.duration, 1 / 1000)),
        movingS: round(scale(a.movingDuration, 1 / 1000)),
        distanceM: round(scale(a.distance, 1 / 100), 1),
        kcal: round(scale(a.calories, 1 / 4.184)), // the export stores kilojoules
        avgHr: n(a.avgHr),
        maxHr: n(a.maxHr),
        elevationGainM: round(scale(a.elevationGain, 1 / 100), 1),
        avgSpeedMps: round(scale(a.avgSpeed, 10), 3),
        trainingEffect: round(n(a.aerobicTrainingEffect), 1),
        anaerobicTe: round(n(a.anaerobicTrainingEffect), 1),
        trainingLoad: round(n(a.activityTrainingLoad), 1),
        teLabel: s(a.trainingEffectLabel),
        vo2max: n(a.vO2MaxValue),
        steps: n(a.steps),
        cadence: isRun ? round(n(a.avgDoubleCadence)) : null,
        location: s(a.locationName),
        hrZonesS: zones.some((z) => z) ? zones.map((z) => Math.round((z ?? 0) / 1000)) : null,
        sets: n(a.totalSets),
        reps: n(a.totalReps),
      })
    }
  }
  return out.sort((a, b) => (a.startLocal < b.startLocal ? -1 : 1))
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/** "Sat Aug 22 20:00:00 GMT 2026" -> epoch ms. */
function javaDateMs(v: unknown): number | null {
  const m = typeof v === 'string' ? /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) GMT (\d{4})$/.exec(v.trim()) : null
  if (!m || MONTHS[m[1]] === undefined) return null
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
}

function parseRecords(files: Record<string, unknown>, offsets: Offsets): ImportRecord[] {
  const out: ImportRecord[] = []
  for (const file of filesMatching(files, /personalRecord\.json$/)) {
    for (const r of arr(file).flatMap((x) => arr(x.personalRecords))) {
      const type = s(r.personalRecordType)
      const value = n(r.value)
      if (!type || value === null || r.current !== true) continue
      const ms = javaDateMs(r.prStartTimeGMT)
      const local = ms === null ? null : isoWall(ms + offsets.get(isoWall(ms).slice(0, 10)))
      const activityId = n(r.activityId)
      out.push({ type, value, achievedAt: local, externalId: activityId ? String(activityId) : null })
    }
  }
  return out
}

function parseMeta(files: Record<string, unknown>): GarminImportPayload['meta'] {
  const meta: GarminImportPayload['meta'] = {}
  const zones = arr(filesMatching(files, /heartRateZones\.json$/)[0]).find((z) => z.sport === 'DEFAULT') ?? arr(filesMatching(files, /heartRateZones\.json$/)[0])[0]
  if (zones) {
    const pick: Record<string, number> = {}
    for (const [k, key] of [['zone1Floor', 'z1'], ['zone2Floor', 'z2'], ['zone3Floor', 'z3'], ['zone4Floor', 'z4'], ['zone5Floor', 'z5'], ['maxHeartRateUsed', 'max'], ['restingHeartRateUsed', 'resting'], ['lactateThresholdHeartRateUsed', 'lthr']] as const) {
      const v = n(zones[k])
      if (v !== null) pick[key] = v
    }
    if (Object.keys(pick).length) meta.hrZones = pick
  }
  const bio = arr(filesMatching(files, /bioMetrics_latest\.json$/)[0])[0]
  if (bio) {
    const t: Record<string, number> = {}
    const lthr = n(bio.lactateThresholdHeartRate)
    const ftp = n(bio.functionalThresholdPower)
    const ltSpeed = n(bio.lactateThresholdSpeed) // stored in the export as m/s ÷ 10
    if (lthr !== null) t.lthr = lthr
    if (ftp !== null) t.ftp = ftp
    if (ltSpeed !== null && ltSpeed > 0) t.ltPaceSPerKm = Math.round(1000 / (ltSpeed * 10))
    if (Object.keys(t).length) meta.thresholds = t
  }
  return meta
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

/** Turn the export's parsed JSON files into the import payload. */
export function parseGarminExport(files: Record<string, unknown>): GarminImportPayload {
  const offsets = new Offsets()
  const dayMap = parseDays(files, offsets)
  const sleep = parseSleep(files, offsets)
  for (const night of sleep) {
    const d = dayMap.get(night.day)
    if (d) d.sleepSeconds = (night.deepS ?? 0) + (night.lightS ?? 0) + (night.remS ?? 0)
  }
  const days = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
  const metrics = parseMetrics(files)
  const activities = parseActivities(files)
  const allDays = [...days.map((d) => d.day), ...sleep.map((x) => x.day), ...activities.map((a) => a.startLocal.slice(0, 10))].sort()
  return {
    range: allDays.length ? { from: allDays[0], to: allDays[allDays.length - 1] } : null,
    days,
    sleep,
    metrics,
    activities,
    records: parseRecords(files, offsets),
    meta: parseMeta(files),
  }
}

/** Counts for the confirmation screen. */
export function summariseImport(p: GarminImportPayload): { days: number; nights: number; activities: number; records: number; metrics: number } {
  return { days: p.days.length, nights: p.sleep.length, activities: p.activities.length, records: p.records.length, metrics: p.metrics.length }
}
