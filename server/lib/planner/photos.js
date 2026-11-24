/**
 * Meal photos (M3) — SPEC §6 "Meal planner". The phone resizes to ~1600px
 * JPEG before upload; the server only checks it is a JPEG under the size cap
 * and stores it in DATA_DIR/photos (outside the code, like the database).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../../db.js'
import { HttpError } from '../http.js'
import { findDish } from './meals.js'

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024

export function photosDir() {
  return path.join(dataDir(), 'photos')
}

const fileOf = (id) => path.join(photosDir(), `${id}.jpg`)

/** Read a raw request body up to `limit` bytes. */
export function readRawBody(req, limit = MAX_PHOTO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    // Past the cap, keep reading but drop the bytes, then answer 413: cutting the
    // connection mid-upload leaves the phone with a network error instead of a reason.
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > limit) reject(new HttpError(413, `Photo too large (max ${Math.round(limit / 1048576)} MB)`))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

const isJpeg = (buf) => buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff

export function savePhoto(db, householdId, user, { dishId, entryId = null, bytes }) {
  findDish(db, householdId, dishId)
  if (!isJpeg(bytes)) throw new HttpError(400, 'Send the photo as a JPEG')
  if (entryId && !db.prepare('SELECT 1 FROM plan_entries WHERE id = ? AND household_id = ?').get(entryId, householdId)) {
    throw new HttpError(404, 'That night was not found')
  }
  const id = randomUUID()
  fs.mkdirSync(photosDir(), { recursive: true })
  fs.writeFileSync(fileOf(id), bytes)
  db.prepare('INSERT INTO planner_photos (id, household_id, dish_id, plan_entry_id, bytes, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    householdId,
    dishId,
    entryId,
    bytes.length,
    user.id,
  )
  // The first photo of a meal becomes its cover.
  db.prepare('UPDATE dishes SET cover_photo_id = ? WHERE id = ? AND cover_photo_id IS NULL').run(id, dishId)
  return { id, dishId, entryId }
}

export function photoFile(db, householdId, id) {
  const row = db.prepare('SELECT id FROM planner_photos WHERE id = ? AND household_id = ?').get(id, householdId)
  if (!row || !fs.existsSync(fileOf(id))) throw new HttpError(404, 'Photo not found')
  return fileOf(id)
}

export function deletePhoto(db, householdId, id) {
  const row = db.prepare('SELECT * FROM planner_photos WHERE id = ? AND household_id = ?').get(id, householdId)
  if (!row) throw new HttpError(404, 'Photo not found')
  db.prepare('DELETE FROM planner_photos WHERE id = ?').run(id)
  // Cover falls back to the newest remaining photo.
  const next = db.prepare('SELECT id FROM planner_photos WHERE dish_id = ? ORDER BY created_at DESC, rowid DESC').get(row.dish_id)
  db.prepare('UPDATE dishes SET cover_photo_id = ? WHERE id = ? AND cover_photo_id = ?').run(next?.id ?? null, row.dish_id, id)
  fs.rmSync(fileOf(id), { force: true })
}
