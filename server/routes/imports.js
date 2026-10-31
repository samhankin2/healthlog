/**
 * Import routes — SPEC §6 "Imports".
 *
 *  - POST /api/import/weight-json        old weight-tracker export → entries + phases + profile
 *  - POST /api/import/food-csv/preview   sniff headers, propose a column mapping
 *  - POST /api/import/food-csv/commit    create one `import` meal per row
 */
import { randomUUID } from 'node:crypto'
import { getDb, withTx, ensureProfile } from '../db.js'
import { requireUser } from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { asObject, optionalString } from '../lib/validate.js'
import { isISODate, today } from '../lib/metrics.js'
import { parseCsv } from '../lib/csv.js'
import { findMeal, insertMeal } from '../lib/meals.js'

/* ------------------------------------------------------------------ */
/* Column sniffing                                                     */
/* ------------------------------------------------------------------ */

/** Lowercase and drop everything that is not a letter or digit: "protein (g)" → "proteing". */
export function normaliseHeader(header) {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

const FIELD_ALIASES = {
  name: ['name', 'food', 'foodname', 'item', 'itemname', 'meal', 'description', 'title'],
  kcal: ['kcal', 'calories', 'calorie', 'energy', 'energykcal', 'kcalories', 'cal'],
  protein: ['protein', 'proteing', 'proteingrams', 'proteingram', 'proteinsperserving'],
  carbs: ['carbs', 'carbsg', 'carbohydrate', 'carbohydrates', 'carb', 'carbg', 'netcarbs'],
  fat: ['fat', 'fatg', 'fats', 'totalfat', 'fatgrams'],
  serving: ['serving', 'servingsize', 'portion', 'portiong', 'portiongrams', 'qty', 'quantity', 'size', 'amount'],
  date: ['date', 'day', 'timestamp', 'datetime', 'eaten', 'logged', 'when'],
}

const MAPPING_FIELDS = ['name', 'kcal', 'protein', 'carbs', 'fat', 'serving', 'date']

/**
 * Propose a logical field → CSV header mapping. Exact (normalised) matches win;
 * otherwise a prefix match is allowed for aliases of 4+ characters.
 */
export function suggestMapping(headers) {
  const used = new Set()
  const mapping = {}
  for (const field of MAPPING_FIELDS) {
    const aliases = FIELD_ALIASES[field] ?? [field]
    let found = -1
    for (const alias of aliases) {
      for (let i = 0; i < headers.length; i++) {
        if (used.has(i)) continue
        if (normaliseHeader(headers[i]) === alias) {
          found = i
          break
        }
      }
      if (found >= 0) break
    }
    if (found < 0) {
      for (const alias of aliases) {
        if (alias.length < 4) continue
        for (let i = 0; i < headers.length; i++) {
          if (used.has(i)) continue
          if (normaliseHeader(headers[i]).startsWith(alias)) {
            found = i
            break
          }
        }
        if (found >= 0) break
      }
    }
    if (found >= 0) {
      used.add(found)
      mapping[field] = headers[found]
    }
  }
  return mapping
}

/* ------------------------------------------------------------------ */
/* Cell parsing                                                        */
/* ------------------------------------------------------------------ */

/** Parse a number, tolerating "12 g", "1,234", "12.5 kcal". NaN when not numeric. */
export function parseNumberCell(value) {
  if (value === null || value === undefined) return NaN
  const cleaned = String(value).replace(/,/g, '').replace(/[^0-9.+-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '+' || cleaned === '.') return NaN
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}

/** Coerce a date cell to YYYY-MM-DD, or null. */
export function parseDateCell(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`
    return isISODate(candidate) ? candidate : null
  }
  const slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s)
  if (slashed) {
    const candidate = `${slashed[1]}-${slashed[2].padStart(2, '0')}-${slashed[3].padStart(2, '0')}`
    return isISODate(candidate) ? candidate : null
  }
  if (/^\d{9,14}$/.test(s)) {
    const n = Number(s)
    const d = new Date(n > 1e12 ? n : n * 1000)
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }
  return null
}

/** Resolve a mapping value (header name) to a column index. */
function columnIndex(headers, headerName) {
  if (!headerName) return -1
  const exact = headers.indexOf(String(headerName))
  if (exact >= 0) return exact
  const wanted = String(headerName).trim().toLowerCase()
  return headers.findIndex((h) => String(h).trim().toLowerCase() === wanted)
}

/** Read a row with a mapping → `{ name, kcal, proteinG, carbsG, fatG, serving, date }`. */
function parseRow(row, headers, mapping) {
  const get = (field) => {
    const idx = columnIndex(headers, mapping[field])
    return idx >= 0 ? (row[idx] ?? '').trim() : ''
  }
  const numOrZero = (field) => {
    const n = parseNumberCell(get(field))
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : Number.isFinite(n) ? 0 : null
  }
  return {
    name: get('name'),
    kcalRaw: get('kcal'),
    kcal: numOrZero('kcal'),
    proteinG: numOrZero('protein'),
    carbsG: numOrZero('carbs'),
    fatG: numOrZero('fat'),
    serving: get('serving') || null,
    date: parseDateCell(get('date')),
  }
}

/* ------------------------------------------------------------------ */
/* Weight JSON import                                                  */
/* ------------------------------------------------------------------ */

function importWeightJson(db, userId, data) {
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const phases = Array.isArray(data?.phases) ? data.phases : []
  const profile = data?.profile && typeof data.profile === 'object' ? data.profile : null

  let importedEntries = 0
  let skippedEntries = 0
  let importedPhases = 0
  let skippedPhases = 0

  const upsert = db.prepare(
    `INSERT INTO weight_entries (id, user_id, date, weight_kg, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, date) DO UPDATE SET
       weight_kg = excluded.weight_kg,
       note = excluded.note,
       updated_at = datetime('now')`,
  )

  for (const entry of entries) {
    const date = typeof entry?.date === 'string' ? entry.date.trim() : ''
    const weight = Number(entry?.weightKg ?? entry?.weight_kg)
    if (!isISODate(date) || !Number.isFinite(weight) || weight <= 0 || weight > 700) {
      skippedEntries++
      continue
    }
    const note = entry?.note === undefined || entry?.note === null ? null : String(entry.note).slice(0, 500)
    const id = typeof entry?.id === 'string' && entry.id.length > 0 && entry.id.length <= 64 ? entry.id : randomUUID()
    const existingId = db.prepare('SELECT id FROM weight_entries WHERE user_id = ? AND date = ?').get(userId, date)?.id
    upsert.run(existingId ?? id, userId, date, weight, note)
    importedEntries++
  }

  for (const phase of phases) {
    const name = typeof phase?.name === 'string' ? phase.name.trim() : ''
    const startDate = typeof phase?.startDate === 'string' ? phase.startDate.trim() : ''
    const endRaw = phase?.endDate
    const endDate = typeof endRaw === 'string' && endRaw.trim() ? endRaw.trim() : null
    if (!name || !isISODate(startDate) || (endDate && !isISODate(endDate))) {
      skippedPhases++
      continue
    }
    const duplicate = db
      .prepare('SELECT id FROM phases WHERE user_id = ? AND name = ? AND start_date = ?')
      .get(userId, name, startDate)
    if (duplicate) {
      skippedPhases++
      continue
    }
    const color = typeof phase?.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(phase.color) ? phase.color : '#3b82f6'
    const preferred =
      typeof phase?.id === 'string' && phase.id.length > 0 && phase.id.length <= 64 ? phase.id : null
    const idTaken = preferred ? db.prepare('SELECT id FROM phases WHERE id = ?').get(preferred) : null
    db.prepare('INSERT INTO phases (id, user_id, name, color, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(
      idTaken ? randomUUID() : (preferred ?? randomUUID()),
      userId,
      name.slice(0, 100),
      color,
      startDate,
      endDate,
    )
    importedPhases++
  }

  if (profile) {
    ensureProfile(db, userId)
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))
    const fields = {
      start_weight_kg: num(profile.startWeightKg),
      goal_weight_kg: num(profile.goalWeightKg),
      height_cm: num(profile.heightCm),
      chart_window_days: num(profile.chartWindowDays),
    }
    for (const [column, value] of Object.entries(fields)) {
      if (value !== null && Number.isFinite(value)) {
        db.prepare(`UPDATE profile SET ${column} = ? WHERE user_id = ?`).run(value, userId)
      }
    }
    db.prepare("UPDATE profile SET updated_at = datetime('now') WHERE user_id = ?").run(userId)
  }

  db.prepare(
    `INSERT INTO imports (id, user_id, kind, filename, row_count, imported, skipped, status, detail)
     VALUES (?, ?, 'weight_json', ?, ?, ?, ?, 'done', ?)`,
  ).run(
    randomUUID(),
    userId,
    null,
    entries.length + phases.length,
    importedEntries + importedPhases,
    skippedEntries + skippedPhases,
    JSON.stringify({ imported: { entries: importedEntries, phases: importedPhases }, skipped: { entries: skippedEntries, phases: skippedPhases } }),
  )

  return {
    imported: { entries: importedEntries, phases: importedPhases },
    skipped: { entries: skippedEntries, phases: skippedPhases },
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function registerImportRoutes(router) {
  router.post('/api/import/weight-json', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const data = body.json && typeof body.json === 'object' ? body.json : body
    if (!Array.isArray(data?.entries) && !Array.isArray(data?.phases)) {
      throw new HttpError(400, 'That does not look like a weight-tracker export (no entries/phases arrays)')
    }
    const db = getDb()
    const result = withTx(db, () => importWeightJson(db, user.id, data))
    sendJson(res, 200, { ok: true, ...result })
  })

  router.post('/api/import/food-csv/preview', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const csv = typeof body.csv === 'string' ? body.csv : ''
    if (!csv.trim()) throw new HttpError(400, 'csv is required')

    const { headers, rows, lines } = parseCsv(csv)
    if (headers.length === 0) throw new HttpError(400, 'That CSV appears to be empty')

    const suggestedMapping = suggestMapping(headers)
    const parsedRows = []
    const skipped = []
    const MAX_PREVIEW = 1000

    for (let i = 0; i < rows.length; i++) {
      const line = lines[i] ?? i + 2
      const parsed = parseRow(rows[i], headers, suggestedMapping)
      if (rows[i].every((cell) => String(cell).trim() === '')) continue

      if (!parsed.kcalRaw) {
        skipped.push({ line, reason: 'no kcal value' })
        continue
      }
      if (!Number.isFinite(parsed.kcal)) {
        skipped.push({ line, reason: `kcal is not a number ("${parsed.kcalRaw}")` })
        continue
      }
      if (!parsed.name) {
        skipped.push({ line, reason: 'missing name' })
        continue
      }
      if (parsedRows.length < MAX_PREVIEW) {
        parsedRows.push({
          line,
          raw: rows[i].join(','),
          parsed: {
            name: parsed.name,
            kcal: parsed.kcal,
            proteinG: parsed.proteinG ?? 0,
            carbsG: parsed.carbsG ?? 0,
            fatG: parsed.fatG ?? 0,
            serving: parsed.serving,
            date: parsed.date,
          },
        })
      }
    }

    const db = getDb()
    db.prepare(
      `INSERT INTO imports (id, user_id, kind, filename, row_count, imported, skipped, status, detail)
       VALUES (?, ?, 'food_csv', ?, ?, 0, ?, 'preview', ?)`,
    ).run(
      randomUUID(),
      user.id,
      typeof body.filename === 'string' ? body.filename.slice(0, 200) : null,
      rows.length,
      skipped.length,
      JSON.stringify({ headers, suggestedMapping }),
    )

    sendJson(res, 200, {
      ok: true,
      headers,
      suggestedMapping,
      rows: parsedRows,
      skipped,
      totalRows: rows.length,
      truncated: parsedRows.length >= MAX_PREVIEW && rows.length > MAX_PREVIEW,
    })
  })

  router.post('/api/import/food-csv/commit', async ({ req, res }) => {
    const user = requireUser(req)
    const body = asObject(await readJsonBody(req))
    const csv = typeof body.csv === 'string' ? body.csv : ''
    if (!csv.trim()) throw new HttpError(400, 'csv is required')

    const { headers, rows, lines } = parseCsv(csv)
    if (headers.length === 0) throw new HttpError(400, 'That CSV appears to be empty')

    const supplied = body.mapping && typeof body.mapping === 'object' ? body.mapping : null
    const mapping = supplied ? { ...suggestMapping(headers), ...supplied } : suggestMapping(headers)
    if (!mapping.name || columnIndex(headers, mapping.name) < 0) {
      throw new HttpError(400, 'mapping.name must point at a CSV column')
    }
    if (!mapping.kcal || columnIndex(headers, mapping.kcal) < 0) {
      throw new HttpError(400, 'mapping.kcal must point at a CSV column')
    }

    const fallbackDay = today()
    const db = getDb()
    const created = []
    let skipped = 0

    withTx(db, () => {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].every((cell) => String(cell).trim() === '')) continue
        const line = lines[i] ?? i + 2
        const parsed = parseRow(rows[i], headers, mapping)
        if (!parsed.name || !Number.isFinite(parsed.kcal)) {
          skipped++
          continue
        }
        const day = parsed.date ?? fallbackDay
        const id = insertMeal(db, user.id, {
          eatenAt: `${day}T12:00:00.000Z`,
          day,
          name: parsed.name.slice(0, 200),
          description: parsed.serving ? `Imported (serving: ${parsed.serving})` : 'Imported from CSV',
          kcal: parsed.kcal,
          proteinG: parsed.proteinG ?? 0,
          carbsG: parsed.carbsG ?? 0,
          fatG: parsed.fatG ?? 0,
          source: 'import',
          items: [],
        })
        created.push(id)
      }

      db.prepare(
        `INSERT INTO imports (id, user_id, kind, filename, row_count, imported, skipped, status, detail)
         VALUES (?, ?, 'food_csv', ?, ?, ?, ?, 'done', ?)`,
      ).run(
        randomUUID(),
        user.id,
        optionalString(body.filename, 'filename', { max: 200 }) ?? null,
        rows.length,
        created.length,
        skipped,
        JSON.stringify({ mapping }),
      )
    })

    sendJson(res, 200, {
      ok: true,
      imported: created.length,
      skipped,
      meals: created.map((id) => findMeal(db, user.id, id)).filter(Boolean),
    })
  })
}
