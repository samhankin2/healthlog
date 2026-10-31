/** Profile routes — SPEC §6 "Profile". */
import { getDb, ensureProfile } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { asObject, alias, optionalNumber } from '../lib/validate.js'
import { ACTIVITY_LEVELS, mifflinStJeor } from '../lib/metrics.js'
import { profilePayload } from '../lib/shape.js'

const SEXES = ['male', 'female', 'other']

function loadProfile(db, userId) {
  ensureProfile(db, userId)
  return db.prepare('SELECT * FROM profile WHERE user_id = ?').get(userId)
}

/** Read the field bag out of a request body, validating as we go. */
function readFields(body) {
  const out = {}
  const set = (column, value) => {
    if (value !== undefined) out[column] = value
  }
  set('height_cm', optionalNumber(alias(body, 'heightCm', 'height_cm'), 'heightCm', { min: 0, max: 300, nullable: true }))
  set(
    'start_weight_kg',
    optionalNumber(alias(body, 'startWeightKg', 'start_weight_kg'), 'startWeightKg', { min: 0, max: 700, nullable: true }),
  )
  set(
    'goal_weight_kg',
    optionalNumber(alias(body, 'goalWeightKg', 'goal_weight_kg'), 'goalWeightKg', { min: 0, max: 700, nullable: true }),
  )
  set('age', optionalNumber(alias(body, 'age'), 'age', { min: 0, max: 130, integer: true, nullable: true }))
  set(
    'kcal_target',
    optionalNumber(alias(body, 'kcalTarget', 'kcal_target'), 'kcalTarget', { min: 0, max: 20000, integer: true, nullable: true }),
  )
  set(
    'protein_pct',
    optionalNumber(alias(body, 'proteinPct', 'protein_pct'), 'proteinPct', { min: 0, max: 100, integer: true, nullable: true }),
  )
  set('carb_pct', optionalNumber(alias(body, 'carbPct', 'carb_pct'), 'carbPct', { min: 0, max: 100, integer: true, nullable: true }))
  set('fat_pct', optionalNumber(alias(body, 'fatPct', 'fat_pct'), 'fatPct', { min: 0, max: 100, integer: true, nullable: true }))
  set(
    'chart_window_days',
    optionalNumber(alias(body, 'chartWindowDays', 'chart_window_days'), 'chartWindowDays', {
      min: 1,
      max: 3650,
      integer: true,
    }),
  )

  const sex = alias(body, 'sex')
  if (sex !== undefined) {
    if (sex === null || sex === '') out.sex = null
    else if (SEXES.includes(String(sex))) out.sex = String(sex)
    else throw new HttpError(400, `sex must be one of ${SEXES.join(', ')}`)
  }

  const activity = alias(body, 'activityLevel', 'activity_level')
  if (activity !== undefined) {
    if (activity === null || activity === '') out.activity_level = null
    else if (ACTIVITY_LEVELS.includes(String(activity))) out.activity_level = String(activity)
    else throw new HttpError(400, `activityLevel must be one of ${ACTIVITY_LEVELS.join(', ')}`)
  }

  return out
}

/** Latest logged weight, used when the profile has no start weight yet. */
function latestWeightKg(db, userId) {
  const row = db
    .prepare('SELECT weight_kg FROM weight_entries WHERE user_id = ? ORDER BY date DESC LIMIT 1')
    .get(userId)
  return row ? Number(row.weight_kg) : null
}

export function registerProfileRoutes(router) {
  router.get('/api/profile', async ({ req, res }) => {
    const user = requireUser(req)
    const db = getDb()
    sendJson(res, 200, { ok: true, profile: profilePayload(loadProfile(db, user.id)) })
  })

  router.put('/api/profile', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const db = getDb()
    const current = loadProfile(db, user.id)

    const fields = readFields(body)
    const explicitTarget = fields.kcal_target !== undefined
    // Mifflin–St Jeor inputs. Recomputing only when one of them changed (or when
    // there is no target yet) keeps a target the user typed from being silently
    // clobbered by an unrelated edit (e.g. the chart window).
    const formulaInputs = ['height_cm', 'start_weight_kg', 'age', 'sex', 'activity_level']
    const inputsChanged = formulaInputs.some((key) => key in fields)

    for (const [column, value] of Object.entries(fields)) {
      db.prepare(`UPDATE profile SET ${column} = ? WHERE user_id = ?`).run(value, user.id)
    }

    // Recompute kcalTarget unless it was supplied explicitly (SPEC §6 Profile).
    if (!explicitTarget && (inputsChanged || current.kcal_target === null)) {
      const merged = { ...current, ...fields }
      const weight =
        merged.start_weight_kg !== null && merged.start_weight_kg !== undefined
          ? Number(merged.start_weight_kg)
          : latestWeightKg(db, user.id)
      const kcal = mifflinStJeor({
        heightCm: merged.height_cm,
        weightKg: weight,
        age: merged.age,
        sex: merged.sex,
        activityLevel: merged.activity_level,
      })
      if (kcal !== null) db.prepare('UPDATE profile SET kcal_target = ? WHERE user_id = ?').run(kcal, user.id)
    }

    db.prepare("UPDATE profile SET updated_at = datetime('now') WHERE user_id = ?").run(user.id)
    sendJson(res, 200, { ok: true, profile: profilePayload(loadProfile(db, user.id)) })
  })
}
