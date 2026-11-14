/**
 * Dashboard metrics — SPEC §6 "Dashboard metrics".
 * Weight maths is the ported old-tracker maths (server/lib/metrics.js); the
 * calorie block is new. Field names are the tracker's names (see SPEC §6):
 * `currentWeightKg`, `avg7d`, `weeklyRateKg`, `streakDays`, `dailySwingKg`, ...
 */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { sendJson, HttpError } from '../lib/http.js'
import {
  ADAPTIVE_TDEE_RULES,
  clampDays,
  computeAdaptiveTdee,
  computeOverallStats,
  isISODate,
  mifflinStJeor,
  PARTIAL_DAY_RULES,
  partialDays,
  sumIntake,
  today,
} from '../lib/metrics.js'
import { profilePayload } from '../lib/shape.js'
import { activityPayload, dailyActivityPayload, garminStatus } from '../lib/garmin.js'

const r0 = (n) => (n === null || n === undefined ? null : Math.round(Number(n)))
const r1 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10)
const r2 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100)

/** Meals grouped by day for a date range → array of raw sums. */
function intakeByDay(db, userId, from, to) {
  return db
    .prepare(
      `SELECT day,
              SUM(kcal)      AS kcal,
              SUM(protein_g) AS protein_g,
              SUM(carbs_g)   AS carbs_g,
              SUM(fat_g)     AS fat_g
         FROM meals
        WHERE user_id = ? AND day >= ? AND day <= ?
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(userId, from, to)
}

export function registerDashboardRoutes(router) {
  router.get('/api/dashboard', async ({ req, res, query }) => {
    const user = requireUser(req)
    const db = getDb()

    const profileRow = db.prepare('SELECT * FROM profile WHERE user_id = ?').get(user.id)
    const profile = profilePayload(profileRow)

    // `day` lets a client pin "today" (useful across timezones and in tests).
    const dayParam = query.get('day')
    if (dayParam && !isISODate(dayParam)) throw new HttpError(400, 'day must be a calendar date (YYYY-MM-DD)')
    const day = dayParam || today()
    const days = clampDays(query.get('days') ?? profile?.chartWindowDays ?? 90, 90)

    const entries = db
      .prepare('SELECT id, date, weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date ASC')
      .all(user.id)
      .map((row) => ({ id: row.id, date: row.date, weightKg: Number(row.weight_kg) }))

    const phases = db
      .prepare('SELECT * FROM phases WHERE user_id = ? ORDER BY start_date ASC')
      .all(user.id)
      .map((row) => ({ id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date ?? null, color: row.color }))

    const stats = computeOverallStats(
      entries,
      { heightCm: profile?.heightCm ?? null, startWeightKg: profile?.startWeightKg ?? null, goalWeightKg: profile?.goalWeightKg ?? null },
      day,
    )

    const mealsToday = db
      .prepare('SELECT kcal, protein_g, carbs_g, fat_g FROM meals WHERE user_id = ? AND day = ?')
      .all(user.id, day)
      .map((m) => ({ kcal: m.kcal, proteinG: m.protein_g, carbsG: m.carbs_g, fatG: m.fat_g }))
    const intakeBlock = sumIntake(mealsToday)

    // Partial-day detection compares each day with its neighbours, so read a
    // margin before the range (and before the TDEE window, below).
    const margin = PARTIAL_DAY_RULES.radiusDays
    const historyRows = intakeByDay(db, user.id, addDaysLocal(day, -(days - 1) - margin), day)
    const partial = partialDays(historyRows.map((row) => ({ day: row.day, kcal: Number(row.kcal) })), day)
    const historyByDay = new Map(historyRows.map((row) => [row.day, row]))
    const intakeHistory = []
    for (let i = 0; i < days; i++) {
      const d = addDaysLocal(day, -(days - 1) + i)
      const row = historyByDay.get(d)
      intakeHistory.push({
        day: d,
        kcal: row ? r0(row.kcal) : 0,
        proteinG: row ? r1(row.protein_g) : 0,
        carbsG: row ? r1(row.carbs_g) : 0,
        fatG: row ? r1(row.fat_g) : 0,
        partial: partial.has(d),
      })
    }

    // Adaptive TDEE always looks at its own fixed window, whatever the chart range.
    const tdeeRows = intakeByDay(db, user.id, addDaysLocal(day, -ADAPTIVE_TDEE_RULES.windowDays - margin), addDaysLocal(day, -1))
    const tdeePartial = partialDays(tdeeRows.map((row) => ({ day: row.day, kcal: Number(row.kcal) })), day)
    const adaptive = computeAdaptiveTdee(
      tdeeRows.map((row) => ({ day: row.day, kcal: Number(row.kcal), partial: tdeePartial.has(row.day) })),
      entries,
      day,
    )
    const formulaKcal = mifflinStJeor({
      heightCm: profile?.heightCm,
      weightKg: stats.avg7Kg ?? stats.latestKg ?? profile?.startWeightKg,
      age: profile?.age,
      sex: profile?.sex,
      activityLevel: profile?.activityLevel,
    })

    // Garmin: the watch's own burn estimate over the same TDEE window, plus the
    // latest day's numbers and the most recent activities.
    const watch = db
      .prepare('SELECT AVG(total_kcal) AS kcal, COUNT(total_kcal) AS n FROM daily_activity WHERE user_id = ? AND day >= ? AND day <= ? AND total_kcal > 0')
      .get(user.id, adaptive.windowStart, adaptive.windowEnd)
    const latestDaily = db
      .prepare('SELECT * FROM daily_activity WHERE user_id = ? AND day <= ? ORDER BY day DESC LIMIT 1')
      .get(user.id, day)
    const avgSteps = db
      .prepare('SELECT AVG(steps) AS steps FROM daily_activity WHERE user_id = ? AND day >= ? AND day <= ? AND steps IS NOT NULL')
      .get(user.id, addDaysLocal(day, -6), day)
    const recentActivities = db
      .prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY start_local DESC LIMIT 3')
      .all(user.id)
      .map(activityPayload)

    const metrics = {
      /* trend / weight (old-tracker names) */
      currentWeightKg: r2(stats.latestKg),
      avg7d: r2(stats.avg7Kg),
      totalChangeKg: r2(stats.totalChangeKg),
      weeklyRateKg: r2(stats.trendKgPerWeek),
      streakDays: stats.currentStreak,
      bestStreakDays: stats.longestStreak,
      bmi: r1(stats.bmi),
      dailySwingKg: r2(stats.volatilityKg),
      goalProgressPct: stats.goalProgress === null ? null : Math.round(stats.goalProgress * 100),
      startWeightKg: profile?.startWeightKg ?? null,
      goalWeightKg: profile?.goalWeightKg ?? null,

      /* extras the UI can use without recomputing */
      latestDate: stats.latestDate,
      toGoalKg: r2(stats.toGoalKg),
      goalReached: stats.goalReached,
      entryCount: stats.count,
      adherence: Math.round(stats.adherence * 100) / 100,
      days,

      /* calories */
      intake: {
        day,
        kcal: intakeBlock.kcal,
        kcalTarget: profile?.kcalTarget ?? null,
        proteinG: intakeBlock.proteinG,
        carbG: intakeBlock.carbG,
        fatG: intakeBlock.fatG,
        proteinPct: intakeBlock.proteinPct,
        carbPct: intakeBlock.carbPct,
        fatPct: intakeBlock.fatPct,
      },
      intakeHistory,

      /* observed maintenance — shown beside kcalTarget, never written to it */
      adaptiveTdee: {
        ...adaptive,
        formulaKcal,
        kcalTarget: profile?.kcalTarget ?? null,
        watchKcal: watch && Number(watch.n) >= 7 ? r0(watch.kcal) : null,
        watchDays: watch ? Number(watch.n) : 0,
      },

      /* Garmin watch data (null fields until a sync has run) */
      activity: {
        garmin: garminStatus(db, user.id),
        latest: latestDaily ? dailyActivityPayload(latestDaily) : null,
        avgSteps7d: avgSteps?.steps == null ? null : r0(avgSteps.steps),
        recent: recentActivities,
      },
    }

    sendJson(res, 200, { ok: true, metrics })
  })
}

/** Local-calendar day arithmetic without importing Date maths twice. */
function addDaysLocal(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}
