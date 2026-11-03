/**
 * SQLite backups: consistent snapshots taken with `VACUUM INTO`, which is safe
 * while the server is running (WAL mode). Files land in $DATA_DIR/backups and
 * the oldest are pruned beyond BACKUP_KEEP (default 14).
 *
 * The server calls scheduleBackups() on boot: it takes a snapshot when the
 * newest one is older than BACKUP_INTERVAL_HOURS (default 24) and re-checks
 * every hour. BACKUPS=off disables it. These are on the same disk as the
 * database — they protect against bad writes and bugs, not against losing the
 * box; pull one down with `scripts/hl backup pull` for that.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../db.js'

const PREFIX = 'healthlog-'
const SUFFIX = '.db'

export function backupDir() {
  return path.join(dataDir(), 'backups')
}

function keepCount() {
  const n = Number(process.env.BACKUP_KEEP)
  return Number.isInteger(n) && n > 0 ? n : 14
}

/** Backups, newest first: [{ file, path, bytes, mtime }]. */
export function listBackups() {
  const dir = backupDir()
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .map((file) => {
      const full = path.join(dir, file)
      const st = fs.statSync(full)
      return { file, path: full, bytes: st.size, mtime: st.mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

/** Take a snapshot now and prune old ones. Returns the new backup's info. */
export function backupNow(db, { label = '' } = {}) {
  const dir = backupDir()
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const safeLabel = label.replace(/[^a-z0-9-]/gi, '').slice(0, 24)
  const file = `${PREFIX}${stamp}${safeLabel ? `-${safeLabel}` : ''}${SUFFIX}`
  const target = path.join(dir, file)
  const tmp = `${target}.part`
  fs.rmSync(tmp, { force: true })
  // VACUUM INTO takes a string literal, not a bound parameter.
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
  fs.renameSync(tmp, target)
  prune()
  const st = fs.statSync(target)
  return { file, path: target, bytes: st.size, mtime: st.mtime }
}

function prune() {
  for (const old of listBackups().slice(keepCount())) {
    fs.rmSync(old.path, { force: true })
  }
}

/** Periodic backups inside the server process. Returns a stop function. */
export function scheduleBackups(db) {
  if (['0', 'off', 'false', 'no'].includes((process.env.BACKUPS || '').trim().toLowerCase())) {
    return () => {}
  }
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS) > 0 ? Number(process.env.BACKUP_INTERVAL_HOURS) : 24
  const tick = () => {
    try {
      const newest = listBackups()[0]
      if (newest && Date.now() - newest.mtime.getTime() < hours * 3600_000) return
      const made = backupNow(db)
      console.log(`[healthlog] backup written: ${made.file} (${made.bytes} bytes)`)
    } catch (err) {
      console.error('[healthlog] backup failed:', err?.message || err)
    }
  }
  // Give the server a moment to come up before the first snapshot.
  const first = setTimeout(tick, 30_000)
  const timer = setInterval(tick, 3600_000)
  first.unref()
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
