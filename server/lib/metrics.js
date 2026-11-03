/**
 * Pure metric computations, ported from `weight-tracker/src/metrics.ts`
 * (source of truth for definitions and edge cases). No DOM, no storage.
 *
 * All weights in kg. All dates are YYYY-MM-DD calendar strings. Date arithmetic
 * is done in UTC so it never shifts across DST boundaries; the *set* of dates
 * fed in is what defines "local calendar days", so this is behaviour-preserving.
 */

/** ISO date string for a Date, in UTC terms (see note above). */
export function toISODate(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse YYYY-MM-DD into a UTC Date at midnight. */
export function fromISODate(s) {
  const [y, m, d] = String(s).split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1))
}

/** Add days to an ISO date string. */
export function addDays(iso, days) {
  const d = fromISODate(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return toISODate(d)
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const MS = 86400000
  return Math.round((fromISODate(b).getTime() - fromISODate(a).getTime()) / MS)
}

/** Today's ISO date in the server's local calendar. */
export function today() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True for a real YYYY-MM-DD calendar date. */
export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = fromISODate(s)
  return toISODate(d) === s
}

/** Sort entries ascending by date. Returns a new array. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** Find the phase covering a given date, or null. Later phases win on overlap. */
export function phaseForDate(phases, date) {
  for (let i = phases.length - 1; i >= 0; i--) {
    const p = phases[i]
    if (p.startDate <= date && (p.endDate === null || p.endDate === undefined || p.endDate >= date)) return p
  }
  return null
}

/**
 * Build a continuous daily series over the requested window ending `endDate`.
 * Missing days are carried forward for the 7-day average, so the average line
 * stays continuous, but `weightKg` is null on unlogged days.
 */
export function buildDailySeries(entries, phases, endDate = today(), days = 90) {
  const sorted = sortEntries(entries)
  const byDate = new Map(sorted.map((e) => [e.date, e.weightKg]))
  const start = addDays(endDate, -(days - 1))

  // Daily 7-day average: mean of all logged weights within the trailing 7 days.
  const dailyAvg = []
  for (let i = 0; i < days; i++) {
    const dayStart = addDays(start, i)
    let sum = 0
    let n = 0
    for (let k = 0; k < 7; k++) {
      const d = addDays(dayStart, -k)
      const w = byDate.get(d)
      if (w !== undefined) {
        sum += w
        n++
      }
    }
    dailyAvg.push(n === 0 ? null : sum / n)
  }

  const series = []
  let prevLogged = null
  let prevAvg = null
  let prevAvgDate = null

  for (let i = 0; i < days; i++) {
    const date = addDays(start, i)
    const w = byDate.get(date) ?? null
    const avg = dailyAvg[i]

    let delta = null
    if (w !== null && prevLogged) delta = w - prevLogged.weight
    if (w !== null) prevLogged = { date, weight: w }

    let rate = null
    if (avg !== null && prevAvgDate !== null) {
      const gap = daysBetween(prevAvgDate, date)
      if (gap >= 7 && prevAvg !== null) {
        const perWeek = ((avg - prevAvg) / gap) * 7
        rate = Math.abs(perWeek) < 1e-9 ? 0 : perWeek
      }
    }
    if (avg !== null) {
      prevAvg = avg
      prevAvgDate = date
    }

    const ph = phaseForDate(phases, date)
    series.push({
      date,
      weightKg: w,
      avg7Kg: avg,
      rateKgPerWeek: rate,
      deltaKg: delta,
      phaseIndex: ph ? phases.indexOf(ph) : -1,
    })
  }
  return series
}

/** Compute stats over an inclusive date range. */
export function computeRangeStats(entries, startDate, endDate) {
  const inRange = sortEntries(entries).filter((e) => e.date >= startDate && e.date <= endDate)
  const count = inRange.length

  if (count === 0) {
    return {
      count: 0,
      startWeightKg: null,
      endWeightKg: null,
      changeKg: null,
      minKg: null,
      maxKg: null,
      avgKg: null,
      rateKgPerWeek: null,
      volatilityKg: null,
      loggedDays: 0,
      adherence: 0,
    }
  }

  const weights = inRange.map((e) => e.weightKg)
  const start = weights[0]
  const end = weights[weights.length - 1]
  const change = end - start
  const spanDays = Math.max(1, daysBetween(inRange[0].date, inRange[inRange.length - 1].date))
  const rate = (change / spanDays) * 7

  let absSum = 0
  let absN = 0
  for (let i = 1; i < inRange.length; i++) {
    absSum += Math.abs(inRange[i].weightKg - inRange[i - 1].weightKg)
    absN++
  }

  const rangeDays = daysBetween(startDate, endDate) + 1

  return {
    count,
    startWeightKg: start,
    endWeightKg: end,
    changeKg: change,
    minKg: Math.min(...weights),
    maxKg: Math.max(...weights),
    avgKg: weights.reduce((a, b) => a + b, 0) / weights.length,
    rateKgPerWeek: Math.abs(rate) < 1e-9 ? 0 : rate,
    volatilityKg: absN === 0 ? null : absSum / absN,
    loggedDays: count,
    adherence: rangeDays <= 0 ? 0 : count / rangeDays,
  }
}

/** Mean of logged weights within the trailing `days` days ending at `endDate`. */
export function averageLast(entries, endDate, days) {
  const start = addDays(endDate, -(days - 1))
  const inRange = entries.filter((e) => e.date >= start && e.date <= endDate)
  if (inRange.length === 0) return null
  return inRange.reduce((a, e) => a + e.weightKg, 0) / inRange.length
}

/** Current and longest streak of consecutive logged calendar days. */
export function computeStreaks(dates, now = today()) {
  if (dates.length === 0) return { streak: 0, longest: 0 }
  const set = new Set(dates)
  const sorted = [...set].sort()

  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1], sorted[i]) === 1) run++
    else run = 1
    if (run > longest) longest = run
  }

  // Current streak: count back from today, or from yesterday if today unlogged.
  let cursor = set.has(now) ? now : addDays(now, -1)
  let streak = 0
  while (set.has(cursor)) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return { streak, longest }
}

/** Overall dashboard stats across all entries. */
export function computeOverallStats(entries, profile, now = today()) {
  const sorted = sortEntries(entries)
  const base = computeRangeStats(entries, sorted[0]?.date ?? now, now)

  const latest = sorted[sorted.length - 1] ?? null
  const totalChange = latest && sorted.length > 1 ? latest.weightKg - sorted[0].weightKg : null

  const startWeightKg = numOrNull(profile.startWeightKg)
  const goalWeightKg = numOrNull(profile.goalWeightKg)

  let goalProgress = null
  let toGoal = null
  let goalReached = false
  if (startWeightKg !== null && goalWeightKg !== null && latest) {
    const span = goalWeightKg - startWeightKg
    if (Math.abs(span) > 1e-9) {
      const done = latest.weightKg - startWeightKg
      goalProgress = Math.max(0, Math.min(1, done / span))
      toGoal = latest.weightKg - goalWeightKg
      // "Reached" means we are at or past the goal in the direction of travel.
      goalReached = span < 0 ? done <= span : done >= span
    }
  }

  const heightCm = numOrNull(profile.heightCm)
  let bmi = null
  if (heightCm && heightCm > 0 && latest) {
    const m = heightCm / 100
    bmi = latest.weightKg / (m * m)
  }

  // Trend: compare the 7-day average now vs 7 days earlier.
  const avg7now = averageLast(entries, now, 7)
  const avg7prev = averageLast(entries, addDays(now, -7), 7)
  let trend = null
  if (avg7now !== null && avg7prev !== null) {
    const t = avg7now - avg7prev
    trend = Math.abs(t) < 1e-9 ? 0 : t
  }

  const { streak, longest } = computeStreaks(sorted.map((e) => e.date), now)

  return {
    ...base,
    latestKg: latest?.weightKg ?? null,
    latestDate: latest?.date ?? null,
    totalChangeKg: totalChange,
    goalProgress,
    toGoalKg: toGoal,
    goalReached,
    bmi,
    trendKgPerWeek: trend,
    avg7Kg: avg7now,
    currentStreak: streak,
    longestStreak: longest,
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Suggested healthy-rate range bounds per week (kg). */
export const RATE_BOUNDS = { cut: 0.75, bulk: 0.25 }

/** Human label for a weekly rate. */
export function describeRate(rate) {
  if (rate === null) return '—'
  if (Math.abs(rate) < 0.05) return 'holding steady'
  return rate < 0 ? 'losing' : 'gaining'
}

/** Format a kg value with the given precision. */
export function fmtKg(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toFixed(digits)
}

/** Format a signed delta, e.g. "+1.2 kg". */
export function fmtDelta(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = v > 0 ? '+' : v < 0 ? '−' : '±'
  return `${s}${Math.abs(v).toFixed(digits)} kg`
}

/** Format a signed rate as kg per week. */
export function fmtRate(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const s = v > 0 ? '+' : v < 0 ? '−' : '±'
  return `${s}${Math.abs(v).toFixed(2)} kg/wk`
}

/* ------------------------------------------------------------------ */
/* Calorie side (new in HealthLog — no old-tracker equivalent)         */
/* ------------------------------------------------------------------ */

const round1 = (n) => Math.round(n * 10) / 10
const round0 = (n) => Math.round(n)

/**
 * Sum a day's meals into a kcal/macro intake block.
 * `pcts` are the share of *consumed energy* (4/4/9 kcal per gram), not of target.
 */
export function sumIntake(meals) {
  let kcal = 0
  let proteinG = 0
  let carbsG = 0
  let fatG = 0
  for (const m of meals) {
    kcal += Number(m.kcal) || 0
    proteinG += Number(m.proteinG ?? m.protein_g) || 0
    carbsG += Number(m.carbsG ?? m.carbs_g) || 0
    fatG += Number(m.fatG ?? m.fat_g) || 0
  }
  return buildIntakeBlock(kcal, proteinG, carbsG, fatG)
}

/** Build the intake block shape used by /api/dashboard. */
export function buildIntakeBlock(kcal, proteinG, carbsG, fatG) {
  const energy = proteinG * 4 + carbsG * 4 + fatG * 9
  const pct = (part) => (energy > 0 ? round0((part / energy) * 100) : 0)
  return {
    kcal: round0(kcal),
    proteinG: round1(proteinG),
    carbG: round1(carbsG),
    fatG: round1(fatG),
    proteinPct: pct(proteinG * 4),
    carbPct: pct(carbsG * 4),
    fatPct: pct(fatG * 9),
    energyKcal: round0(energy),
  }
}

/**
 * Mifflin–St Jeor BMR + activity multiplier → daily kcal target.
 * Returns null when any input is missing.
 */
export function mifflinStJeor({ heightCm, weightKg, age, sex, activityLevel }) {
  const h = numOrNull(heightCm)
  const w = numOrNull(weightKg)
  const a = numOrNull(age)
  if (h === null || w === null || a === null) return null
  const base = 10 * w + 6.25 * h - 5 * a
  let bmr
  if (sex === 'male') bmr = base + 5
  else if (sex === 'female') bmr = base - 161
  else bmr = base - 78 // midpoint of the male/female constants
  const multiplier = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
  }[activityLevel]
  if (!multiplier) return null
  return Math.round(bmr * multiplier)
}

export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very_active']

/** Coerce/validate a chart window (days). */
export function clampDays(value, fallback = 90) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(3650, Math.round(n)))
}

/** Round to `digits` decimals, passing null through. */
export function roundOrNull(v, digits = 2) {
  const n = numOrNull(v)
  if (n === null) return null
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/* ------------------------------------------------------------------ */
/* Adaptive TDEE — an observed maintenance estimate, shown alongside   */
/* (never replacing) the profile's kcal target and activity level.     */
/* ------------------------------------------------------------------ */

/** Energy in one kg of body-mass change (the usual ~7700 kcal/kg rule). */
export const KCAL_PER_KG = 7700

export const ADAPTIVE_TDEE_RULES = { windowDays: 28, minLoggedDays: 14, minWeighIns: 8, minSpanDays: 14 }

/**
 * Estimate maintenance calories from what was eaten and what the scale did.
 *
 * Window: the `windowDays` complete days ending the day before `endDay` (today
 * is still being logged). Intake is averaged over days with at least one meal
 * — unlogged days are treated as missing, not as zero. Weight change is the
 * least-squares slope through every weigh-in in the window, which is far less
 * noisy than first-vs-last.
 *
 *   tdee = avgIntake − slopeKgPerDay × KCAL_PER_KG
 *
 * `intakeDays`: [{ day, kcal }] (only days with meals). `entries`: [{ date, weightKg }].
 * Returns `kcal: null` with a `reason` when there is not enough data.
 */
export function computeAdaptiveTdee(intakeDays, entries, endDay, rules = ADAPTIVE_TDEE_RULES) {
  const { windowDays, minLoggedDays, minWeighIns, minSpanDays } = rules
  const to = addDays(endDay, -1)
  const from = addDays(to, -(windowDays - 1))

  const logged = intakeDays.filter((d) => d.day >= from && d.day <= to && Number(d.kcal) > 0)
  const weighIns = sortEntries(entries).filter((e) => e.date >= from && e.date <= to)
  const spanDays = weighIns.length > 1 ? daysBetween(weighIns[0].date, weighIns[weighIns.length - 1].date) : 0

  const base = {
    kcal: null,
    avgIntakeKcal: logged.length ? round0(logged.reduce((a, d) => a + Number(d.kcal), 0) / logged.length) : null,
    weightSlopeKgPerWeek: null,
    windowStart: from,
    windowEnd: to,
    windowDays,
    loggedDays: logged.length,
    weighIns: weighIns.length,
    confidence: null,
    reason: null,
  }

  const missing = []
  if (logged.length < minLoggedDays) missing.push(`${minLoggedDays - logged.length} more day${minLoggedDays - logged.length === 1 ? '' : 's'} of food logging`)
  if (weighIns.length < minWeighIns) missing.push(`${minWeighIns - weighIns.length} more weigh-in${minWeighIns - weighIns.length === 1 ? '' : 's'}`)
  else if (spanDays < minSpanDays) missing.push(`weigh-ins spread over at least ${minSpanDays} days`)
  if (missing.length) return { ...base, reason: `Needs ${missing.join(' and ')} in the last ${windowDays} days.` }

  // Least-squares slope, x in days from the window start.
  const xs = weighIns.map((e) => daysBetween(from, e.date))
  const ys = weighIns.map((e) => e.weightKg)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
  }
  const slopePerDay = sxx > 0 ? sxy / sxx : 0
  const avgIntake = logged.reduce((a, d) => a + Number(d.kcal), 0) / logged.length
  const kcal = avgIntake - slopePerDay * KCAL_PER_KG

  const coverage = logged.length / windowDays
  const weighCoverage = weighIns.length / windowDays
  const confidence = coverage >= 0.85 && weighCoverage >= 0.5 ? 'high' : coverage >= 0.65 && weighCoverage >= 0.35 ? 'medium' : 'low'

  return {
    ...base,
    kcal: round0(kcal),
    avgIntakeKcal: round0(avgIntake),
    weightSlopeKgPerWeek: Math.round(slopePerDay * 7 * 100) / 100,
    confidence,
  }
}
