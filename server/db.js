/**
 * SQLite (node:sqlite) — schema, migrations, tiny query helpers.
 *
 * The database lives at `$DATA_DIR/healthlog.db` (DATA_DIR defaults to ./data).
 * `migrate()` is idempotent, so it is safe to call on every boot.
 * Schema mirrors SPEC.md §4 exactly.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

/** Absolute data directory (created on demand). */
export function dataDir() {
  return path.resolve(process.env.DATA_DIR || './data')
}

/** Absolute path of the database file. */
export function dbFile() {
  return path.join(dataDir(), 'healthlog.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS profile (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  height_cm       REAL,
  start_weight_kg REAL,
  goal_weight_kg  REAL,
  sex             TEXT,
  age             INTEGER,
  activity_level  TEXT,
  kcal_target     INTEGER,
  protein_pct     INTEGER,
  carb_pct        INTEGER,
  fat_pct         INTEGER,
  chart_window_days INTEGER NOT NULL DEFAULT 90,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weight_entries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  weight_kg  REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS phases (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3b82f6',
  start_date TEXT NOT NULL,
  end_date   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at   TEXT NOT NULL,
  day        TEXT NOT NULL,
  name       TEXT NOT NULL,
  description TEXT,
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  fiber_g    REAL,
  source     TEXT NOT NULL DEFAULT 'ai',
  confidence REAL,
  analysis_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS foods (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  serving    TEXT,
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meal_items (
  id         TEXT PRIMARY KEY,
  meal_id    TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id    TEXT REFERENCES foods(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  quantity   TEXT,
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS analyses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id      TEXT REFERENCES meals(id) ON DELETE CASCADE,
  prompt_text  TEXT NOT NULL,
  model_a      TEXT NOT NULL,
  model_b      TEXT NOT NULL,
  result_a     TEXT NOT NULL,
  result_b     TEXT NOT NULL,
  reconciled   TEXT NOT NULL,
  comparison   TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  meal_id    TEXT REFERENCES meals(id) ON DELETE SET NULL,
  analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imports (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  filename   TEXT,
  row_count  INTEGER NOT NULL DEFAULT 0,
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_weight_entries_user_date ON weight_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_meals_user_day            ON meals(user_id, day);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created ON chat_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_user_created     ON analyses(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_foods_user_name           ON foods(user_id, name);
CREATE INDEX IF NOT EXISTS idx_phases_user_start         ON phases(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_sessions_token            ON sessions(token_hash);
`

/** Create tables + indexes if they do not exist. Safe to run on every boot. */
export function migrate(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
}

let singleton = null

/** Open (once) and return the process-wide database handle. */
export function getDb() {
  if (singleton) return singleton
  fs.mkdirSync(dataDir(), { recursive: true })
  const db = new DatabaseSync(dbFile())
  migrate(db)
  singleton = db
  return db
}

/** Close the singleton (used by tests / clean shutdown). */
export function closeDb() {
  if (!singleton) return
  try {
    singleton.close()
  } catch {
    /* ignore */
  }
  singleton = null
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Run `fn` inside a transaction, rolling back on error. */
export function withTx(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

/** Insert a `profile` row for a user if it does not exist yet. */
export function ensureProfile(db, userId) {
  db.prepare('INSERT OR IGNORE INTO profile (user_id) VALUES (?)').run(userId)
}

/** Current UTC timestamp in SQLite `datetime('now')` format. */
export function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}
