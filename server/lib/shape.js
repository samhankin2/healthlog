/**
 * DB row → API payload mappers. All timestamps are ISO-8601 UTC strings
 * (SPEC §4); day-keyed values stay YYYY-MM-DD strings (SPEC §8).
 */

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) → ISO-8601. */
export function iso(value) {
  if (!value) return null
  const s = String(value)
  if (s.includes('T')) return s
  return `${s.replace(' ', 'T')}Z`
}

const num = (v) => (v === null || v === undefined ? null : Number(v))
const round1 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10)
const round2 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100)

export function profilePayload(row) {
  if (!row) return null
  return {
    heightCm: num(row.height_cm),
    startWeightKg: num(row.start_weight_kg),
    goalWeightKg: num(row.goal_weight_kg),
    sex: row.sex ?? null,
    age: num(row.age),
    activityLevel: row.activity_level ?? null,
    kcalTarget: num(row.kcal_target),
    proteinPct: num(row.protein_pct),
    carbPct: num(row.carb_pct),
    fatPct: num(row.fat_pct),
    chartWindowDays: num(row.chart_window_days) ?? 90,
    updatedAt: iso(row.updated_at),
  }
}

export function weightPayload(row) {
  if (!row) return null
  return {
    id: row.id,
    date: row.date,
    weightKg: Number(row.weight_kg),
    note: row.note ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function phasePayload(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    createdAt: iso(row.created_at),
  }
}

export function mealItemPayload(row) {
  return {
    id: row.id,
    foodId: row.food_id ?? null,
    name: row.name,
    quantity: row.quantity ?? null,
    kcal: round1(row.kcal) ?? 0,
    proteinG: round1(row.protein_g) ?? 0,
    carbsG: round1(row.carbs_g) ?? 0,
    fatG: round1(row.fat_g) ?? 0,
  }
}

/**
 * @param {object} row meals row
 * @param {object[]} [items] meal_items rows
 */
export function mealPayload(row, items = []) {
  if (!row) return null
  return {
    id: row.id,
    eatenAt: iso(row.eaten_at),
    day: row.day,
    name: row.name,
    description: row.description ?? null,
    kcal: round1(row.kcal) ?? 0,
    proteinG: round1(row.protein_g) ?? 0,
    carbsG: round1(row.carbs_g) ?? 0,
    fatG: round1(row.fat_g) ?? 0,
    fiberG: round1(row.fiber_g),
    source: row.source,
    confidence: round2(row.confidence),
    analysisId: row.analysis_id ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    items: items.map(mealItemPayload),
  }
}

export function foodPayload(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    serving: row.serving ?? null,
    kcal: round1(row.kcal) ?? 0,
    proteinG: round1(row.protein_g) ?? 0,
    carbsG: round1(row.carbs_g) ?? 0,
    fatG: round1(row.fat_g) ?? 0,
    createdAt: iso(row.created_at),
  }
}

export function chatMessagePayload(row) {
  if (!row) return null
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    mealId: row.meal_id ?? null,
    analysisId: row.analysis_id ?? null,
    createdAt: iso(row.created_at),
  }
}
