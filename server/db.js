/**
 * SQLite (node:sqlite) — schema, migrations, tiny query helpers.
 *
 * The database lives at `$DATA_DIR/healthlog.db` (DATA_DIR defaults to ./data).
 * `migrate()` is idempotent, so it is safe to call on every boot.
 * Schema mirrors SPEC.md §4 exactly.
 */
import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
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
  protein_g       INTEGER,
  carb_g          INTEGER,
  fat_g           INTEGER,
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

-- Garmin (SPEC §4): one row per day of watch data, one per recorded activity.
CREATE TABLE IF NOT EXISTS daily_activity (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,          -- YYYY-MM-DD
  steps             INTEGER,
  active_kcal       REAL,
  total_kcal        REAL,                   -- the watch's own burn estimate (BMR + active)
  bmr_kcal          REAL,
  resting_hr        INTEGER,
  sleep_seconds     INTEGER,
  intensity_minutes INTEGER,                -- moderate + 2 x vigorous
  source            TEXT NOT NULL DEFAULT 'garmin',
  synced_at         TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS activities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,           -- 'garmin'
  external_id      TEXT NOT NULL,
  name             TEXT,
  type             TEXT,                    -- Garmin typeKey: running, cycling, strength_training, ...
  start_local      TEXT NOT NULL,           -- YYYY-MM-DDTHH:MM:SS, local time of the activity
  day              TEXT NOT NULL,
  duration_s       REAL,
  moving_s         REAL,
  distance_m       REAL,
  kcal             REAL,
  avg_hr           REAL,
  max_hr           REAL,
  elevation_gain_m REAL,
  avg_speed_mps    REAL,
  training_effect  REAL,                    -- aerobic training effect
  synced_at        TEXT NOT NULL,
  UNIQUE (user_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS integrations (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,            -- 'garmin' | 'cronometer'
  status          TEXT NOT NULL,            -- never | connected | needs_login | rate_limited | error
  last_attempt_at TEXT,                     -- ISO timestamps
  last_success_at TEXT,
  last_error      TEXT,
  backoff_until   TEXT,
  PRIMARY KEY (user_id, provider)
);

-- Garmin insights (SPEC §6 "Garmin insights"): the richer watch data, filled by
-- the live sync and by importing a Garmin Connect data export.
CREATE TABLE IF NOT EXISTS daily_wellness (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              TEXT NOT NULL,           -- YYYY-MM-DD
  distance_m       REAL,
  floors_m         REAL,                    -- metres climbed
  moderate_min     INTEGER,
  vigorous_min     INTEGER,
  step_goal        INTEGER,
  min_hr           INTEGER,
  max_hr           INTEGER,
  stress_avg       INTEGER,                 -- 0..100, whole day
  stress_max       INTEGER,
  stress_rest_s    INTEGER,
  stress_low_s     INTEGER,
  stress_medium_s  INTEGER,
  stress_high_s    INTEGER,
  bb_high          INTEGER,                 -- Body Battery
  bb_low           INTEGER,
  bb_charged       INTEGER,
  bb_drained       INTEGER,
  bb_wake          INTEGER,                 -- value when the night's sleep ended
  spo2_avg         REAL,
  spo2_low         REAL,
  resp_avg         REAL,                    -- waking breaths / minute
  hrv_night        REAL,                    -- ms, last-night average
  hrv_status       TEXT,
  synced_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS sleep_nights (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              TEXT NOT NULL,           -- the morning the night ends on
  start_local      TEXT,                    -- YYYY-MM-DDTHH:MM:SS local
  end_local        TEXT,
  deep_s           INTEGER,
  light_s          INTEGER,
  rem_s            INTEGER,
  awake_s          INTEGER,
  score            INTEGER,                 -- overall sleep score 0..100
  quality_score    INTEGER,
  duration_score   INTEGER,
  recovery_score   INTEGER,
  avg_stress       REAL,
  avg_resp         REAL,
  avg_spo2         REAL,
  avg_hr           REAL,
  awake_count      INTEGER,
  restless_count   INTEGER,
  feedback         TEXT,
  synced_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS fitness_metrics (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              TEXT NOT NULL,
  vo2max           REAL,
  race_5k_s        REAL,
  race_10k_s       REAL,
  race_half_s      REAL,
  race_marathon_s  REAL,
  training_status  TEXT,                    -- PRODUCTIVE | MAINTAINING | RECOVERY | ...
  weekly_load      REAL,
  load_min         REAL,
  load_max         REAL,
  fitness_age      REAL,
  heat_pct         REAL,
  synced_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS personal_records (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,           -- e.g. "Best 5km Run"
  value            REAL NOT NULL,
  achieved_at      TEXT,
  external_id      TEXT,                    -- activities.external_id, when tied to one
  synced_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, type)
);

CREATE TABLE IF NOT EXISTS garmin_meta (
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,           -- hrZones | thresholds | lastImport
  value            TEXT NOT NULL,           -- JSON
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Lifting (SPEC §6 "Lifting"): the user's exercise library, one row per gym
-- session, one row per set. Ids are client-generated so an offline phone can
-- create them and retry the save safely.
CREATE TABLE IF NOT EXISTS exercises (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  muscle       TEXT NOT NULL DEFAULT 'other',    -- chest | back | shoulders | biceps | triceps | quads | hamstrings | glutes | calves | core | other
  equipment    TEXT NOT NULL DEFAULT 'barbell',  -- barbell | dumbbell | machine | cable | bodyweight | kettlebell | other
  increment_kg REAL,                             -- next-weight step; null = by equipment
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Routines: a named, ordered list of exercises to start a workout from. Each
-- item can name alternatives (swapped in when the kit is taken). Soft-deleted
-- so the default routine is only ever seeded once per user.
CREATE TABLE IF NOT EXISTS routines (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '[]',         -- JSON [{ exerciseId, alternatives: [exerciseId] }]
  position   INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id, position);

CREATE TABLE IF NOT EXISTS workouts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,                      -- YYYY-MM-DD local
  name       TEXT,
  notes      TEXT,
  started_at TEXT,                               -- ISO, client clock
  ended_at   TEXT,                               -- null = still in progress
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workout_sets (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position    INTEGER NOT NULL,                  -- order within the workout
  weight_kg   REAL NOT NULL DEFAULT 0,           -- bodyweight lifts: added load
  reps        INTEGER NOT NULL,
  rpe         REAL,                              -- 5..10, optional
  kind        TEXT NOT NULL DEFAULT 'working',   -- working | warmup | drop | failure
  done_at     TEXT                               -- ISO, client clock
);

CREATE TABLE IF NOT EXISTS partners (            -- who a user shares meals with
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partner_email TEXT NOT NULL COLLATE NOCASE,      -- linked only when both sides name each other
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shared_meals (        -- a meal offered to a linked partner
  id             TEXT PRIMARY KEY,
  from_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,  -- read live while pending
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed
  meal_id        TEXT REFERENCES meals(id) ON DELETE SET NULL,          -- the recipient's copy
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);

CREATE TABLE IF NOT EXISTS model_runs (          -- one estimate per model per analysis (SPEC §7 "Model benchmark")
  id           TEXT PRIMARY KEY,
  analysis_id  TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  role         TEXT NOT NULL,                    -- a | b (the two the app uses) | bench (background only)
  kcal         REAL,                             -- null when the model failed
  protein_g    REAL,
  carbs_g      REAL,
  fat_g        REAL,
  meal_count   INTEGER,
  confidence   REAL,
  latency_ms   INTEGER,
  error        TEXT,
  output       TEXT,                             -- normalised JSON
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_model_runs_user_created ON model_runs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_runs_analysis     ON model_runs(analysis_id);

-- Meal planner (SPEC §4 "Meal planner tables"). Shared by a household, not a user.
CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (   -- one household per user
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dishes (              -- a meal we cook ("meal" in the UI)
  id                 TEXT PRIMARY KEY,
  household_id       TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  default_effort     INTEGER,                    -- 1 low | 2 medium | 3 high
  tips               TEXT,
  link               TEXT,
  regular_every_days INTEGER,                    -- a regular: suggest again after this many days
  regular_weekday    INTEGER,                    -- optional fixed night, 0 = Monday
  never_suggest      INTEGER NOT NULL DEFAULT 0,
  archived_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dish_aliases (        -- other spellings that mean the same dish
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,                    -- normalised: lower case, single spaces
  dish_id      TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  PRIMARY KEY (household_id, alias)
);

CREATE TABLE IF NOT EXISTS dish_options (        -- options on up to two axes, e.g. Style: Korean, Protein: Beef
  id         TEXT PRIMARY KEY,
  dish_id    TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  axis       TEXT NOT NULL,                     -- 'Style' | 'Protein' | 'Fish' | ...
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_entries (        -- one meal slot: planned, cooked, or imported history
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date         TEXT,                            -- YYYY-MM-DD; null for undated imports
  import_order INTEGER,                         -- order within undated imports
  import_key   TEXT,                            -- makes re-running an import a no-op
  slot         TEXT NOT NULL DEFAULT 'dinner',
  dish_id      TEXT REFERENCES dishes(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'dish',    -- dish | out | leftovers | takeaway | freezer
  status       TEXT NOT NULL DEFAULT 'planned', -- planned | cooked | skipped | swapped | moved
  source       TEXT NOT NULL DEFAULT 'app',     -- app | notes
  raw          TEXT,                            -- what was typed / imported
  cook_name    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_entry_options (
  plan_entry_id TEXT NOT NULL REFERENCES plan_entries(id) ON DELETE CASCADE,
  option_id     TEXT NOT NULL REFERENCES dish_options(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_entry_id, option_id)
);

CREATE TABLE IF NOT EXISTS dish_ratings (        -- standing rating of a meal or one of its options
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id      TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  option_id    TEXT NOT NULL DEFAULT '',        -- '' = the meal itself
  rated_as     TEXT NOT NULL,                   -- 'both' | a member's user id
  thumbs       INTEGER,                         -- -1 | 1
  stars        INTEGER,                         -- 1..5
  updated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dish_id, option_id, rated_as)
);

CREATE TABLE IF NOT EXISTS dish_hidden_options ( -- a variation or combination taken off the list ("never had it")
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id      TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  option_id    TEXT NOT NULL,                   -- an option id, or a combination key like dish_ratings.option_id
  hidden_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  hidden_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dish_id, option_id)
);

CREATE TABLE IF NOT EXISTS planner_notes (       -- notes to Claude about a meal; Claude replies via the CLI
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id      TEXT REFERENCES dishes(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reply        TEXT,
  resolved_at  TEXT
);

CREATE TABLE IF NOT EXISTS reviews (             -- opinion of one cook (M3); facts about the cook live on plan_entries
  plan_entry_id TEXT NOT NULL REFERENCES plan_entries(id) ON DELETE CASCADE,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  rated_as      TEXT NOT NULL,                  -- 'both' | a member's user id
  thumbs        INTEGER,                        -- -1 | 1
  stars         INTEGER,                        -- 1..5
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (plan_entry_id, rated_as)
);

CREATE TABLE IF NOT EXISTS freezer_items (       -- portions in the freezer
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id         TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  option_ids      TEXT NOT NULL DEFAULT '[]',     -- JSON: the variation frozen
  portions_left   INTEGER NOT NULL DEFAULT 0,
  frozen_on       TEXT,                           -- YYYY-MM-DD
  source_entry_id TEXT REFERENCES plan_entries(id) ON DELETE SET NULL, -- the cook it came from
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS planner_photos (      -- a photo of a meal (files in DATA_DIR/photos/<id>.jpg)
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id       TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  plan_entry_id TEXT REFERENCES plan_entries(id) ON DELETE SET NULL, -- the cook it was taken at
  bytes         INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suggestion_snoozes (  -- "not now": a meal stays out of suggestions until a date (M4)
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id      TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  until        TEXT NOT NULL,                   -- YYYY-MM-DD
  PRIMARY KEY (household_id, dish_id)
);

-- Meal plans: started on any night, as many nights as we say; the next one ends the last.
CREATE TABLE IF NOT EXISTS meal_plans (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  start_date   TEXT NOT NULL,                   -- YYYY-MM-DD, the first night
  nights       INTEGER NOT NULL DEFAULT 7,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS meal_plans_start ON meal_plans (household_id, start_date);

-- Weeks that start on a different day: each date starts a run of weeks until the next one.
CREATE TABLE IF NOT EXISTS week_starts (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,                   -- YYYY-MM-DD
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, date)
);

-- Shopping (M5): one list per week, items in shop order, remembered sections and per-meal usuals.
CREATE TABLE IF NOT EXISTS shopping_lists (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  week_start   TEXT NOT NULL,                   -- YYYY-MM-DD
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL,                     -- normalised: same item from two meals is one line
  section    TEXT NOT NULL,                     -- market | cold | ambient
  qty        TEXT,                              -- free text; two meals' amounts join as "2 + 1"
  dish_ids   TEXT NOT NULL DEFAULT '[]',        -- JSON: the meals it's for
  checked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS item_sections (       -- where an item goes, remembered per household
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name_key     TEXT NOT NULL,
  section      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'guess',   -- guess (word list / AI) | set (we chose it)
  PRIMARY KEY (household_id, name_key)
);

CREATE TABLE IF NOT EXISTS dish_usual_items (    -- what a meal needed last time ("add the usual")
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  dish_id      TEXT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  name_key     TEXT NOT NULL,
  name         TEXT NOT NULL,
  qty          TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dish_id, name_key)
);

CREATE TABLE IF NOT EXISTS want_list (           -- the want-to-make scratch pad: lines typed like notes
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,                    -- the words, as typed
  level        INTEGER NOT NULL DEFAULT 2,       -- how much: 1 some day | 2 keen | 3 really want
  dish_id      TEXT REFERENCES dishes(id) ON DELETE SET NULL, -- the meal it is, once found
  option_ids   TEXT NOT NULL DEFAULT '[]',       -- JSON: the variation, if the words name one
  position     INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  done_at      TEXT                              -- cooked it (or ticked off)
);
CREATE INDEX IF NOT EXISTS idx_want_list_household ON want_list(household_id, done_at, position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_lists_week   ON shopping_lists(household_id, week_start);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopping_items_key    ON shopping_items(list_id, name_key);

CREATE INDEX IF NOT EXISTS idx_planner_photos_dish          ON planner_photos(dish_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_household            ON reviews(household_id);
CREATE INDEX IF NOT EXISTS idx_freezer_household            ON freezer_items(household_id, frozen_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_freezer_source        ON freezer_items(source_entry_id) WHERE source_entry_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dish_options_unique   ON dish_options(dish_id, axis, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_entries_import   ON plan_entries(household_id, import_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_entries_slot     ON plan_entries(household_id, date, slot) WHERE date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_entries_household_date  ON plan_entries(household_id, date);
CREATE INDEX IF NOT EXISTS idx_plan_entries_dish            ON plan_entries(dish_id);
CREATE INDEX IF NOT EXISTS idx_dish_ratings_household       ON dish_ratings(household_id);
CREATE INDEX IF NOT EXISTS idx_planner_notes_household      ON planner_notes(household_id, resolved_at);

CREATE INDEX IF NOT EXISTS idx_household_members_household ON household_members(household_id);
CREATE INDEX IF NOT EXISTS idx_dishes_household            ON dishes(household_id, name);
CREATE INDEX IF NOT EXISTS idx_dish_aliases_dish           ON dish_aliases(dish_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_meals_source_to ON shared_meals(source_meal_id, to_user_id);
CREATE INDEX IF NOT EXISTS idx_shared_meals_to_status        ON shared_meals(to_user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_user_name ON exercises(user_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_workouts_user_day         ON workouts(user_id, day);
CREATE INDEX IF NOT EXISTS idx_workout_sets_workout      ON workout_sets(workout_id, position);
CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise     ON workout_sets(exercise_id);

CREATE INDEX IF NOT EXISTS idx_weight_entries_user_date ON weight_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_meals_user_day            ON meals(user_id, day);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created ON chat_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analyses_user_created     ON analyses(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_foods_user_name           ON foods(user_id, name);
CREATE INDEX IF NOT EXISTS idx_phases_user_start         ON phases(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_sessions_token            ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_activities_user_start     ON activities(user_id, start_local);
`

/** Create tables + indexes if they do not exist. Safe to run on every boot. */
export function migrate(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  migrateMacroPctToGrams(db)
  addColumns(db, 'activities', ACTIVITY_EXTRA_COLUMNS)
  addColumns(db, 'exercises', { rep_min: 'INTEGER', rep_max: 'INTEGER' }) // rep range; null = automatic
  addColumns(db, 'exercises', { per_side: 'INTEGER NOT NULL DEFAULT 0' }) // 1 = one side at a time (each arm its own entry)
  addColumns(db, 'integrations', { export_day: 'TEXT', export_count: 'INTEGER' }) // Cronometer's daily export budget
  addColumns(db, 'analyses', { revises_id: 'TEXT' }) // the analysis a chat correction revised (model benchmark ground truth)
  addColumns(db, 'dishes', { suggested_tags: "TEXT NOT NULL DEFAULT '[]'" }) // tag chips offered, not yet accepted
  addColumns(db, 'dishes', { family: 'TEXT' }) // a section of related meals, e.g. "Pulled pork"
  addColumns(db, 'plan_entries', { updated_at: 'TEXT' })
  addColumns(db, 'households', { week_start_day: 'INTEGER NOT NULL DEFAULT 0' }) // 0 = Monday
  addColumns(db, 'shopping_lists', { ends_on: 'TEXT' }) // the last night it shops for (null: six days after week_start)
  // M3 review: facts about a cook, and freezer nights
  addColumns(db, 'plan_entries', {
    freezer_item_id: 'TEXT', // a "from the freezer" night
    freezer_consumed: 'INTEGER NOT NULL DEFAULT 0', // its portion has been taken off
    cook_note: 'TEXT',
    leftovers: 'INTEGER NOT NULL DEFAULT 0', // covered a lunch
    frozen_portions: 'INTEGER NOT NULL DEFAULT 0',
    tweak_retry: 'INTEGER NOT NULL DEFAULT 0',
    reviewed_at: 'TEXT',
  })
  addColumns(db, 'dish_ratings', { source: "TEXT NOT NULL DEFAULT 'estimate'" }) // estimate (rated from memory) | review (from a cook)
  addColumns(db, 'dishes', { cover_photo_id: 'TEXT' })
  migrateRatingWantsToList(db)
}

/**
 * "Want to make" used to be a flag on a rating as well as the want-to-make
 * list. The list is the one place now: each flagged meal or variation becomes
 * a line (keen) unless the list already has it, and the flag column goes.
 */
function migrateRatingWantsToList(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(dish_ratings)').all().map((c) => c.name))
  if (!cols.has('want')) return
  db.exec('BEGIN')
  try {
    const flagged = db
      .prepare(
        `SELECT r.household_id, r.dish_id, r.option_id, MIN(r.updated_by) AS by, d.name
           FROM dish_ratings r JOIN dishes d ON d.id = r.dish_id
          WHERE r.want = 1 GROUP BY r.household_id, r.dish_id, r.option_id ORDER BY MIN(r.updated_at)`,
      )
      .all()
    const optionName = db.prepare('SELECT name, axis FROM dish_options WHERE id = ? AND dish_id = ?')
    const open = db.prepare('SELECT option_ids FROM want_list WHERE household_id = ? AND dish_id = ? AND done_at IS NULL')
    const top = db.prepare('SELECT MAX(position) AS top FROM want_list WHERE household_id = ? AND done_at IS NULL')
    const insert = db.prepare(
      `INSERT INTO want_list (id, household_id, body, level, dish_id, option_ids, position, created_by)
       VALUES (?, ?, ?, 2, ?, ?, ?, (SELECT id FROM users WHERE id = ?))`,
    )
    const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
    for (const f of flagged) {
      const ids = f.option_id ? f.option_id.split('+') : []
      const options = ids.map((id) => optionName.get(id, f.dish_id)).filter(Boolean)
      if (options.length !== ids.length) continue // an option since deleted
      const already = open.all(f.household_id, f.dish_id).some((r) => sameSet(JSON.parse(r.option_ids || '[]'), ids))
      if (already) continue
      // Style reads first, as on the rating screen: "Dirty cabbage (Korean, Beef)".
      options.sort((a, b) => (a.axis === 'Style' ? -1 : b.axis === 'Style' ? 1 : 0))
      const body = options.length ? `${f.name} (${options.map((o) => o.name).join(', ')})` : f.name
      insert.run(crypto.randomUUID(), f.household_id, body, f.dish_id, JSON.stringify(ids), (top.get(f.household_id).top ?? -1) + 1, f.by)
    }
    db.exec('DELETE FROM dish_ratings WHERE want = 1')
    db.exec('ALTER TABLE dish_ratings DROP COLUMN want')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Insight columns on `activities` (added after the table first shipped). */
const ACTIVITY_EXTRA_COLUMNS = {
  anaerobic_te: 'REAL',
  training_load: 'REAL',
  te_label: 'TEXT',
  vo2max: 'REAL',
  steps: 'INTEGER',
  cadence: 'REAL',
  location: 'TEXT',
  hr_zones: 'TEXT', // JSON [z0..z5] seconds
  sets: 'INTEGER',
  reps: 'INTEGER',
}

function addColumns(db, table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name))
  for (const [col, type] of Object.entries(columns)) {
    if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
}

/**
 * Older databases stored macro targets as percent of calories. Convert them to
 * grams (4/4/9 kcal per gram, using the kcal target) and drop the old columns.
 */
function migrateMacroPctToGrams(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(profile)').all().map((c) => c.name))
  if (!cols.has('protein_pct')) return
  for (const col of ['protein_g', 'carb_g', 'fat_g']) {
    if (!cols.has(col)) db.exec(`ALTER TABLE profile ADD COLUMN ${col} INTEGER`)
  }
  db.exec(`
    UPDATE profile SET
      protein_g = CASE WHEN kcal_target > 0 AND protein_pct IS NOT NULL THEN CAST(ROUND(kcal_target * protein_pct / 100.0 / 4) AS INTEGER) END,
      carb_g    = CASE WHEN kcal_target > 0 AND carb_pct IS NOT NULL THEN CAST(ROUND(kcal_target * carb_pct / 100.0 / 4) AS INTEGER) END,
      fat_g     = CASE WHEN kcal_target > 0 AND fat_pct IS NOT NULL THEN CAST(ROUND(kcal_target * fat_pct / 100.0 / 9) AS INTEGER) END
    WHERE protein_g IS NULL AND carb_g IS NULL AND fat_g IS NULL;
    ALTER TABLE profile DROP COLUMN protein_pct;
    ALTER TABLE profile DROP COLUMN carb_pct;
    ALTER TABLE profile DROP COLUMN fat_pct;
  `)
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
