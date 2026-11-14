/**
 * COROS MCP replies -> storeGarmin rows. Pure, for tests.
 *
 * The COROS MCP tools answer in human-readable text meant for an AI, e.g.
 *
 *     Sleep Overview
 *
 *     2026-10-15
 *     Sleep Score: 91
 *     Main Sleep (asleep): 7h 57min
 *     Deep Sleep Ratio: 27%
 *     Main Sleep Window: 2026-10-15 00:28 - 2026-10-15 08:30
 *
 * The exact wording is not a contract, so nothing here depends on line order or
 * exact labels: a reply is cut into blocks (one per date or numbered record),
 * each block into `Label: value` fields (also `A: 1 | B: 2` on one line and
 * markdown tables), and fields are found by keyword. A JSON reply (or MCP
 * structuredContent) goes through the same field lookup. Anything not
 * recognised is left out, never guessed into the wrong column; storeGarmin
 * range-checks what remains. `node server/cli.js coros dump` prints the raw
 * replies for tuning.
 */

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

const ISO_DAY = /(\d{4})-(\d{2})-(\d{2})/
const SLASH_DAY = /(\d{4})\/(\d{2})\/(\d{2})/
const COMPACT_DAY = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/
const ANY_DAY = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{4}/\\d{2}/\\d{2}|20\\d{6})'
/** "2026-09-19 to 2026-10-18", "20260919 – 20261018": a heading over a range of days. */
const RANGE = new RegExp(`${ANY_DAY}\\s*(?:to|until|–|—|-|~)\\s*${ANY_DAY}`)

/** The first calendar date in a string, as YYYY-MM-DD. */
export function findDay(s) {
  const t = String(s ?? '')
  const m = t.match(ISO_DAY) ?? t.match(SLASH_DAY) ?? t.match(COMPACT_DAY)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** First number in a string ("1,234 steps" -> 1234), else null. */
export function number(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null
  const m = String(s ?? '').replace(/(\d),(\d{3})/g, '$1$2').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** Durations: "7h 57min", "1 h 5 m", "2:12:38", "45:10" (m:ss), "5 min", "90 s", "1.5 h". Seconds or null. */
export function duration(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null
  const t = String(s ?? '').toLowerCase().trim()
  if (!t) return null
  const clock = t.match(/^(\d+):(\d{2})(?::(\d{2}))?\b/)
  if (clock) return clock[3] !== undefined ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2])
  let total = 0
  let any = false
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m(?!s)|seconds?|secs?|s)\b/g)) {
    const v = Number(m[1])
    const unit = m[2]
    total += unit.startsWith('h') ? v * 3600 : unit.startsWith('m') ? v * 60 : v
    any = true
  }
  return any ? Math.round(total) : null
}

/** Distance in metres from "12.03 km", "800 m", "3.1 mi". */
export function distance(s) {
  if (typeof s === 'number') return s
  const t = String(s ?? '').toLowerCase()
  const v = number(t)
  if (v === null) return null
  if (/\bmi(les?)?\b/.test(t)) return Math.round(v * 1609.344)
  if (/\bkm\b|kilomet/.test(t)) return Math.round(v * 1000)
  if (/\bm\b|met(er|re)s?\b/.test(t)) return v
  return Math.round(v * 1000) // COROS reports activity distance in km
}

/** "27%" -> 0.27; "0.27" -> 0.27. */
function ratio(s) {
  const v = number(s)
  if (v === null) return null
  return /%/.test(String(s)) || v > 1 ? v / 100 : v
}

/** "2026-10-15 00:28 - 2026-10-15 08:30" or "00:28 - 08:30" (with the wake day) -> local timestamps. */
export function clockRange(s, wakeDay) {
  const t = String(s ?? '')
  const full = [...t.matchAll(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/g)]
  if (full.length >= 2) return [full[0], full[1]].map((m) => `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00`)
  const clocks = [...t.matchAll(/(?<![\d-])(\d{1,2}):(\d{2})(?![\d:])/g)]
  if (clocks.length >= 2 && wakeDay) {
    const [a, b] = clocks
    const startMin = Number(a[1]) * 60 + Number(a[2])
    const endMin = Number(b[1]) * 60 + Number(b[2])
    const startDay = startMin > endMin ? shiftDay(wakeDay, -1) : wakeDay
    return [`${startDay}T${a[1].padStart(2, '0')}:${a[2]}:00`, `${wakeDay}T${b[1].padStart(2, '0')}:${b[2]}:00`]
  }
  return null
}

function shiftDay(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

/** "Main Sleep (asleep)" -> "main sleep asleep"; "avgSleepHrv" -> "avg sleep hrv". */
export function normLabel(s) {
  return String(s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/₂/g, '2')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
}

const FIELD = /^\s*[-*•]?\s*([A-Za-z][A-Za-z0-9 ()%/₂.'&+-]{0,60}?)\s*[:：]\s*(.+?)\s*$/

/**
 * Cut a reply into blocks: [{ title, day, fields: [[label, value], ...] }].
 * A new block starts at a line that carries a date but is not itself a field
 * ("2026-10-15", "1. Sport(9807) — 2026-10-03", "2026-10-15: 48 bpm").
 */
export function blocks(text) {
  const t = String(text ?? '').trim()
  if (!t) return []
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return jsonBlocks(JSON.parse(t))
    } catch {
      /* not JSON after all */
    }
  }
  const out = []
  let cur = { title: '', day: null, fields: [] }
  const push = () => {
    if (cur.fields.length || cur.day) out.push(cur)
  }
  const lines = t.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^#+\s*/, '').replace(/\*\*/g, '')
    if (!line) continue
    // Markdown table: header row, separator row, data rows.
    if (line.startsWith('|') && lines[i + 1]?.trim().match(/^\|?\s*:?-{2,}/)) {
      const header = splitRow(line)
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i].trim())
        const fields = header.map((h, k) => [h, cells[k] ?? '']).filter(([, v]) => v !== '')
        const day = fields.map(([, v]) => findDay(v)).find(Boolean) ?? null
        out.push({ title: cells[0] ?? '', day, fields })
        i++
      }
      i--
      continue
    }
    const parts = line.split(/\s+\|\s+/)
    const asFields = parts.map((p) => p.match(FIELD)).filter(Boolean)
    const isField = asFields.length === parts.length && asFields.length > 0
    const day = findDay(line)
    // "Sport Records — 2026-09-19 to 2026-10-18": a heading over a range, not a record.
    const isRange = !isField && RANGE.test(line)
    if (isRange) {
      push()
      cur = { title: line, day: null, fields: [] }
      continue
    }
    if (!isField && day) {
      push()
      cur = { title: line, day, fields: [] }
      // "2026-10-15: 48 bpm" / "2026-10-15 — 48 bpm": keep what follows the date.
      const rest = line.slice(line.indexOf(day.slice(0, 4))).replace(/^[\d/-]+/, '').replace(/^\s*[:：—–-]\s*/, '').trim()
      if (rest && !/^\(?\d{1,2}:\d{2}/.test(rest)) cur.fields.push(['_value', rest])
      continue
    }
    if (isField) {
      for (const m of asFields) {
        cur.fields.push([m[1], m[2]])
        if (/^date$|^day$/i.test(m[1].trim()) && findDay(m[2])) cur.day = findDay(m[2])
      }
    } else if (!cur.fields.length && !cur.day) cur.title = cur.title ? `${cur.title} ${line}` : line
  }
  push()
  return out
}

function splitRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

const DAY_KEYS = /^(date|day|happen ?day|sleep ?date|wake ?date|calendar ?date)$/

/** JSON reply -> blocks: arrays of objects become one block each; nested arrays are searched. */
export function jsonBlocks(value) {
  const out = []
  const visit = (v, title) => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item, title)
      return
    }
    if (!v || typeof v !== 'object') return
    const fields = []
    let day = null
    let nested = false
    for (const [k, x] of Object.entries(v)) {
      if (Array.isArray(x) && x.some((e) => e && typeof e === 'object')) {
        nested = true
        visit(x, k)
      } else if (x && typeof x === 'object') {
        for (const [k2, x2] of Object.entries(x)) if (x2 === null || typeof x2 !== 'object') fields.push([`${k} ${k2}`, x2])
      } else {
        fields.push([k, x])
        if (DAY_KEYS.test(normLabel(k))) day = findDay(String(x)) ?? day
      }
    }
    if (fields.length && (day || !nested)) out.push({ title: title ?? '', day, fields })
  }
  visit(value)
  return out
}

/** The first field whose normalised label matches `include` and none of `exclude`. */
export function pick(block, include, exclude = null) {
  for (const [label, value] of block.fields) {
    const n = normLabel(label)
    if (include.test(n) && !(exclude && exclude.test(n))) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

/**
 * COROS sport codes -> the activity type keys the app already knows (Garmin's
 * typeKeys). Best effort from community clients; then the name decides.
 */
const SPORT_TYPES = {
  100: 'running', 101: 'indoor_running', 102: 'trail_running', 103: 'track_running', 104: 'hiking', 105: 'mountaineering',
  200: 'road_biking', 201: 'indoor_cycling', 202: 'cycling', 203: 'gravel_cycling', 204: 'mountain_biking', 205: 'e_bike',
  299: 'cycling', 300: 'lap_swimming', 301: 'open_water_swimming', 400: 'cardio', 401: 'cardio', 402: 'strength_training',
  403: 'indoor_rowing', 404: 'elliptical', 405: 'stair_climbing', 500: 'resort_skiing', 501: 'resort_snowboarding',
  700: 'rowing', 701: 'indoor_rowing', 800: 'indoor_climbing', 801: 'bouldering', 900: 'walking', 901: 'jump_rope',
  10000: 'multi_sport', 10001: 'multi_sport',
}

function typeFrom(code, name) {
  if (code !== null && SPORT_TYPES[code]) return SPORT_TYPES[code]
  const n = String(name ?? '').toLowerCase()
  if (/strength|weight|gym/.test(n)) return 'strength_training'
  if (/trail/.test(n)) return 'trail_running'
  if (/treadmill|indoor run/.test(n)) return 'indoor_running'
  if (/run/.test(n)) return 'running'
  if (/indoor (bike|cycl)|trainer/.test(n)) return 'indoor_cycling'
  if (/bike|cycl|ride/.test(n)) return 'cycling'
  if (/open water/.test(n)) return 'open_water_swimming'
  if (/swim/.test(n)) return 'lap_swimming'
  if (/hike|hiking/.test(n)) return 'hiking'
  if (/walk/.test(n)) return 'walking'
  if (/row/.test(n)) return 'rowing'
  return 'other'
}

/** querySportRecords -> [{ externalId, labelId, sportType, startLocal, name, type, durationS, distanceM, ... }]. */
export function parseSportRecords(text) {
  const out = []
  for (const b of blocks(text)) {
    if (!b.day || !b.fields.length) continue
    const titleCode = b.title.match(/\((\d{2,6})\)/)
    const codeRaw = pick(b, /^(sport ?type|sport ?code|sport ?type ?code|mode)$/)
    const sportType = number(codeRaw) ?? (titleCode ? Number(titleCode[1]) : null)
    const labelId = pick(b, /^(label ?id|activity ?id|id|record ?id)$/)
    const startRaw = pick(b, /^(start|start time|start local|started|time)$/)
    const startTs = [startRaw, b.title].map((s) => String(s ?? '').match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/)).find(Boolean)
    const startLocal = startTs ? `${startTs[1]}T${startTs[2].padStart(2, '0')}:${startTs[3]}:${startTs[4] ?? '00'}` : `${b.day}T00:00:00`
    const name =
      String(pick(b, /^(name|title|activity name)$/) ?? '')
        .trim() ||
      b.title
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/\s*[—–-]\s*\d{4}-\d{2}-\d{2}.*$/, '')
        .replace(/\s*\(\d{2,6}\)\s*/, '')
        .trim() ||
      null
    const durationS = duration(pick(b, /^(duration|total time|workout time|elapsed time|time)$/))
    const distanceM = distance(pick(b, /^distance$/))
    const row = {
      labelId: labelId !== undefined && String(labelId).trim() ? String(labelId).trim() : null,
      sportType,
      startLocal,
      name: name && name.toLowerCase() !== 'sport' ? name : null,
      type: typeFrom(sportType, name),
      durationS,
      movingS: duration(pick(b, /^(moving time|workout time)$/)),
      distanceM,
      kcal: number(pick(b, /calorie|kcal|energy/)),
      avgHr: number(pick(b, /^(avg|average) (heart rate|hr)$/)),
      maxHr: number(pick(b, /^(max|maximum) (heart rate|hr)$/)),
      elevationGainM: number(pick(b, /elevation gain|ascent|total ascent|climb/)),
      trainingLoad: number(pick(b, /training load/)),
    }
    row.externalId = row.labelId ?? `${startLocal}~${sportType ?? row.type}~${Math.round(durationS ?? 0)}`
    const moving = row.movingS ?? durationS
    row.avgSpeedMps = distanceM && moving ? Math.round((distanceM / moving) * 1000) / 1000 : null
    out.push(row)
  }
  return out
}

/** getActivityDetail -> the extra numbers the list lacks. */
export function parseActivityDetail(text) {
  const b = { title: '', day: null, fields: blocks(text).flatMap((x) => x.fields) }
  return {
    kcal: number(pick(b, /calorie|kcal|energy/)),
    avgHr: number(pick(b, /^(avg|average) (heart rate|hr)$/)),
    maxHr: number(pick(b, /^(max|maximum) (heart rate|hr)$/)),
    elevationGainM: number(pick(b, /elevation gain|ascent|total ascent|climb/)),
    movingS: duration(pick(b, /^(moving time|workout time)$/)),
    trainingLoad: number(pick(b, /training load/)),
    cadence: number(pick(b, /cadence/)),
    trainingEffect: number(pick(b, /aerobic (training )?effect/, /anaerobic/)),
    anaerobicTe: number(pick(b, /anaerobic (training )?effect/)),
  }
}

/** querySleepOverview -> { sleep: [sleep_nights rows], days: [{ day, sleepSeconds }] }. */
export function parseSleep(text) {
  const sleep = []
  const days = []
  for (const b of blocks(text)) {
    if (!b.day) continue
    const mainS = duration(pick(b, /main sleep/, /window|ratio|score|start|end/)) ?? duration(pick(b, /^(sleep|total sleep|sleep duration|daily sleep)/, /window|ratio|score|nap/))
    const stage = (name) => {
      const hit = b.fields.find(([label]) => new RegExp(`^${name}`).test(normLabel(label)))
      if (!hit) return null
      const [label, v] = hit
      if (/%/.test(String(v)) || /ratio|percent/.test(normLabel(label))) {
        const r = ratio(v)
        return r !== null && mainS ? Math.round(r * mainS) : null
      }
      return duration(v)
    }
    const window = clockRange(pick(b, /window|sleep time|bed ?time|start/), b.day)
    const row = {
      day: b.day,
      startLocal: window?.[0] ?? null,
      endLocal: window?.[1] ?? null,
      deepS: stage('deep'),
      lightS: stage('light'),
      remS: stage('rem'),
      awakeS: duration(pick(b, /^awake|^wake/, /count|times|ratio/)) ?? stage('awake'),
      score: number(pick(b, /sleep score|^score$/)),
      avgHr: number(pick(b, /(avg|average) (heart rate|hr)/)),
    }
    if (Object.entries(row).some(([k, v]) => k !== 'day' && v !== null)) sleep.push(row)
    if (mainS) days.push({ day: b.day, sleepSeconds: mainS })
  }
  return { sleep, days }
}

/** querySleepHrv -> [{ day, hrvNight, hrvStatus }]. */
export function parseHrv(text) {
  const out = []
  for (const b of blocks(text)) {
    if (!b.day) continue
    const v = pick(b, /^(avg|average|daily|nightly|sleep)\b.*hrv|^hrv( avg| average)?$|^value$/, /range|base|baseline|normal|sd|interval/)
    const hrv = number(v)
    const status = pick(b, /evaluation|assessment|status/)
    if (hrv === null && status === undefined) continue
    out.push({ day: b.day, hrvNight: hrv, hrvStatus: status !== undefined ? String(status).slice(0, 32) : null })
  }
  return out
}

/** queryDailyHealthData -> [{ day, steps, activeKcal, totalKcal, bmrKcal, stressAvg, restingHr }]. */
export function parseDailyHealth(text) {
  const out = []
  for (const b of blocks(text)) {
    if (!b.day) continue
    const plainKcal = number(pick(b, /^(calories|calorie|kcal|energy)( burned)?$/))
    const row = {
      day: b.day,
      steps: number(pick(b, /^steps?\b|step count/, /goal/)),
      activeKcal: number(pick(b, /active.*(calorie|kcal|energy)/)),
      totalKcal: number(pick(b, /total.*(calorie|kcal|energy)/)),
      bmrKcal: number(pick(b, /(rest|resting|basal|bmr).*(calorie|kcal|energy)/)),
      stressAvg: number(pick(b, /stress/, /max|high|low|time|duration/)),
      restingHr: number(pick(b, /resting (heart rate|hr)|^rhr$/)),
    }
    // A bare "Calories" line: COROS's daily figure. Large values are a whole-day total.
    if (plainKcal !== null && row.activeKcal === null && row.totalKcal === null) {
      if (plainKcal >= 1000) row.totalKcal = plainKcal
      else row.activeKcal = plainKcal
    }
    if (Object.entries(row).some(([k, v]) => k !== 'day' && v !== null)) out.push(row)
  }
  return out
}

/** queryRestingHeartRate / queryStressLevel -> [{ day, value }]. */
export function parsePerDay(text, include, exclude = null) {
  const out = []
  for (const b of blocks(text)) {
    if (!b.day) continue
    const v = number(pick(b, include, exclude) ?? pick(b, /^value$/))
    if (v !== null) out.push({ day: b.day, value: v })
  }
  return out
}

/** queryFitnessAssessmentOverview -> { vo2max }. */
export function parseFitness(text) {
  const b = { title: '', day: null, fields: blocks(text).flatMap((x) => x.fields) }
  return { vo2max: number(pick(b, /vo2 ?max/)) }
}
