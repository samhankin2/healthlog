# HealthLog — build contract

**Status:** authoritative contract. All lanes implement against this file. If a lane
needs to change something here, it must not silently deviate — it reports the
conflict back.

---

## 1. What this is

HealthLog replaces the localStorage-only **weight-tracker** with a real
application: a backend API with a SQLite database and accounts, a frontend that
talks to that API, and an AI food-logging chat where you describe what you ate
and two independent models estimate the calories and macros, which are then
compared and reconciled.

Two products in one app:

- **Weight tracking** — ported from `C:\Users\hanki\Development\weight-tracker`
  (mobile-first, Vite + TypeScript, no UI framework, Chart.js).
- **Calorie / macro tracking** — chat-first, AI-estimated, mostly chat.

## 2. Stack and hosting

| Piece | Where | How |
| --- | --- | --- |
| Frontend | GitHub Pages `https://<user>.github.io/healthlog/` | Vite build → `dist/`, published by `.github/workflows/pages.yml`. |
| API | `https://healthlog.<ip>.sslip.io` | Node 24 app on the Oracle Cloud VPS, Caddy TLS in front, systemd unit `healthlog`. |
| Database | `/var/lib/healthlog/healthlog.db` | SQLite via `node:sqlite`. Never inside the repo. |

- **Two origins** → the API must be HTTPS and must send CORS headers echoing
  the `Origin` header **for allow-listed origins only**: the Pages origin
  (`https://samhankin2.github.io`), any `http://localhost:*` /
  `http://127.0.0.1:*` dev origin, the API's own origin, and anything in the
  `CORS_ORIGINS` env var (comma-separated). Other origins get no
  `Access-Control-Allow-Origin`. `OPTIONS` returns `204` without running the endpoint.
- **Auth is a bearer token**, not a cookie — this avoids credentialed
  cross-origin requests entirely. The frontend stores the token in
  `localStorage` and sends `Authorization: Bearer <token>`.
- The frontend reads the API origin from `window.APP_API_BASE`
  (`public/api-config.js`), rewritten by the Pages workflow from the repo
  variable `API_BASE_URL`. **Never hardcode the API URL, never edit
  `public/api-config.js` by hand.**
- Asset paths inside the frontend must be **relative** (`app.js`, not `/app.js`)
  because Pages serves a project site from a sub-path.
- `vite.config.ts` uses `base: './'`.

## 3. Repository layout

```
healthlog/
  SPEC.md               this contract
  README.md             user-facing docs
  AGENTS.md             working notes for agents
  package.json          frontend deps + scripts
  tsconfig.json
  vite.config.ts
  index.html            Vite entry
  src/                  frontend source (TypeScript, no UI framework)
    design/             tokens.css, ui.css
    ui/                 dom.ts, icons.ts, components.ts
    lib/                api.ts, store.ts, auth.ts, format.ts, types.ts
    charts/             weightChart.ts, miniSparkline.ts, phaseLegend.ts
    views/              login.ts, chat.ts, dashboard.ts, history.ts, foods.ts, settings.ts
    sheets/             logWeight.ts, phaseSheet.ts, importSheet.ts
    main.ts             app shell, router, tab bar
  public/               static assets copied verbatim to Pages
    index.html          (only if not built by Vite — see §9)
    api-config.js
    manifest.webmanifest
    sw.js
    icons...
  server/               backend (Node, zero runtime dependencies)
    index.js            http server + router + static fallback
    db.js               schema + migrations
    auth.js             invite codes, password hashing, sessions
    ai.js               OpenCode Go client, dual-model analysis, reconciliation
    routes/*.js
    lib/http.js         json helpers, body parsing
    cli.js              admin CLI (create invite codes)
  deploy/               VPS provisioning + deploy script + systemd unit + Caddyfile
  .github/workflows/    pages.yml, deploy.yml
  qa/                   verification scripts (smoke, api tests, browser checks)
```

**Write-scope ownership (lanes must not write outside their scope):**

| Lane | Owns |
| --- | --- |
| A (backend) | `server/**`, `qa/api-test.mjs` |
| B (frontend) | `src/**`, `index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`, `public/manifest.webmanifest`, `public/sw.js`, `public/favicon.svg`, `public/icons/**` |
| C (infra) | `deploy/**`, `.github/**`, `public/api-config.js`, `public/.nojekyll`, `README.md`, `AGENTS.md`, `.gitignore` |

## 4. Database schema

SQLite, WAL mode, `PRAGMA foreign_keys = ON`. All timestamps are ISO-8601 UTC
strings (`datetime('now')` style) **except** `entries.date` / `phases.start_date`
/ `phases.end_date`, which are local-calendar `YYYY-MM-DD` strings.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- uuid
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,             -- scrypt: salt:hash
  display_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  disabled_at   TEXT
);

CREATE TABLE invite_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,         -- sha256 hex of the bearer token
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE profile (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  height_cm       REAL,
  start_weight_kg REAL,
  goal_weight_kg  REAL,
  sex             TEXT,                    -- 'male' | 'female' | 'other' | null
  age             INTEGER,
  activity_level  TEXT,                    -- 'sedentary'..'very_active'
  kcal_target     INTEGER,
  protein_g       INTEGER,                 -- daily target, grams
  carb_g          INTEGER,
  fat_g           INTEGER,
  chart_window_days INTEGER NOT NULL DEFAULT 90,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE weight_entries (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,                -- YYYY-MM-DD
  weight_kg  REAL NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, date)
);

CREATE TABLE phases (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3b82f6',
  start_date TEXT NOT NULL,
  end_date   TEXT,                         -- null = ongoing
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meals (                      -- one logged eating occasion
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at   TEXT NOT NULL,                -- ISO datetime, local date derivable
  day        TEXT NOT NULL,                -- YYYY-MM-DD local calendar day
  name       TEXT NOT NULL,
  description TEXT,
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  fiber_g    REAL,
  source     TEXT NOT NULL DEFAULT 'ai',   -- 'ai' | 'manual' | 'import' | 'saved_food' | 'cronometer' | 'shared'
  confidence REAL,                         -- 0..1
  analysis_id TEXT,                        -- -> analyses.id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE foods (                      -- saved reusable food
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  serving    TEXT,                         -- e.g. "100 g"
  kcal       REAL NOT NULL DEFAULT 0,
  protein_g  REAL NOT NULL DEFAULT 0,
  carbs_g    REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meal_items (                 -- breakdown of a meal
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

CREATE TABLE analyses (                   -- one AI analysis (2 models + reconciliation)
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id      TEXT REFERENCES meals(id) ON DELETE CASCADE,
  prompt_text  TEXT NOT NULL,
  model_a      TEXT NOT NULL,
  model_b      TEXT NOT NULL,
  result_a     TEXT NOT NULL,              -- raw JSON from model A
  result_b     TEXT NOT NULL,              -- raw JSON from model B
  reconciled   TEXT NOT NULL,              -- final JSON
  comparison   TEXT,                       -- the written comparison note
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  meal_id    TEXT REFERENCES meals(id) ON DELETE SET NULL,
  analysis_id TEXT REFERENCES analyses(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE imports (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                -- 'weight_json' | 'food_csv'
  filename   TEXT,
  row_count  INTEGER NOT NULL DEFAULT 0,
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,                -- 'preview' | 'done' | 'failed'
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Indexes: `weight_entries(user_id, date)`, `meals(user_id, day)`, `chat_messages(user_id, created_at)`,
`analyses(user_id, created_at)`, `foods(user_id, name)`.

### Garmin tables

`daily_activity` (one row per user per day: steps, active/total/BMR kcal,
resting HR, sleep seconds, intensity minutes), `activities` (one row per
recorded workout, unique on `(user_id, source, external_id)` so re-syncs
upsert), and `integrations` (per user + provider `garmin` | `cronometer` | `coros`:
status, last attempt / success, last error, `backoff_until`; `export_day` /
`export_count` hold Cronometer's daily export budget). Exact DDL lives in
`server/db.js`.

Insights (§6 "Garmin insights"): `daily_wellness` (per user + day: distance,
floors, intensity minutes, min/max HR, stress average/max and time per level,
Body Battery high/low/charged/drained/at wake, SpO₂, respiration, HRV),
`sleep_nights` (per user + the morning a night ends: local start/end, stage
seconds, scores, overnight stress/respiration/SpO₂/HR), `fitness_metrics`
(per user + day: VO₂ max, race predictions, training status and load tunnel,
fitness age, heat acclimation), `personal_records` (per user + record type) and
`garmin_meta` (per user + key: HR zones, thresholds, last import, as JSON).
`activities` gains `anaerobic_te`, `training_load`, `te_label`, `vo2max`,
`steps`, `cadence`, `location`, `hr_zones` (JSON seconds per zone 0–5),
`sets`, `reps`. All Garmin upserts are `COALESCE(new, old)`: a null never
overwrites a stored value.

### Lifting tables

`exercises` (per user: name — unique case-insensitively — `muscle`
chest|back|shoulders|biceps|triceps|quads|hamstrings|glutes|calves|core|other,
`equipment` barbell|dumbbell|machine|cable|bodyweight|kettlebell|other,
`increment_kg` (null = equipment default), `rep_min` / `rep_max` (rep range for
progression, both null = automatic), `per_side` (1 = one side at a time, default 0),
`archived_at`), `workouts` (per user:
`day`, `name`, `notes`, `started_at` / `ended_at` ISO from the client clock,
`ended_at` null while in progress) and `workout_sets` (`workout_id` cascade,
`exercise_id`, `position`, `weight_kg` — added load for bodyweight lifts —
`reps`, `rpe` 1–10 optional, `kind` working|warmup|drop|failure, `done_at`),
`routines` (per user: `name`, `items` JSON `[{exerciseId, alternatives:[exerciseId], priority?:true}]` (at most one priority item),
`position`, `deleted_at` — soft delete, so the default routine is seeded once).
Ids are client-generated (8–64 of `[A-Za-z0-9_-]`) so an offline phone can create
them. Exact DDL lives in `server/db.js`.

### Partner sharing tables

`partners` (`user_id` primary key, `partner_email` case-insensitive): who a user
shares meals with, at most one. The link is **live only when both accounts name
each other**. `shared_meals` (`from_user_id`, `to_user_id`, `source_meal_id` →
the sender's meal, cascade; `status` pending|accepted|dismissed; `meal_id` → the
recipient's copy once accepted, set null; `created_at`, `resolved_at`), unique on
`(source_meal_id, to_user_id)`. A pending offer stores no copy: it reads the
sender's meal live, so a correction made after sharing is what the partner sees.
Exact DDL lives in `server/db.js`.

### Meal planner tables

The meal planner (§6 "Meal planner") stores its data per **household**, not
per user. `households` (`id`, `created_at`); `household_members` (`user_id`
primary key, so one household per user; `household_id`, cascade). `dishes`: a
meal the household cooks, called "meal" in the UI (the name `meals` is the food
log's): `name`, `tags` JSON array, `default_effort` 1–3, `tips`, `link`,
`regular_every_days`, `regular_weekday` (0 = Monday), `never_suggest`,
`archived_at`. `dish_aliases` (`household_id`, `alias` normalised to lower case
with single spaces, `dish_id`, cascade), primary key `(household_id, alias)`.
`dishes.suggested_tags` (JSON) holds tag chips offered but not yet accepted;
`dishes.family` names a section of related meals (e.g. "Pulled pork": the
sandwiches, tacos, soup, bao buns, bowl and the slow roast are separate meals).
`dish_options` (`dish_id`, `axis` e.g. Style / Protein / Fish, `name`,
`position`; unique per dish + axis + name): options on up to two axes.
`plan_entries`: one meal slot (`date` null for undated imports, ordered by
`import_order`; `import_key` unique per household so re-imports are no-ops;
`slot`, `dish_id`, `kind` dish|out|leftovers|takeaway|freezer, `status`
planned|cooked|skipped|swapped|moved, `source` app|notes, `raw`, `cook_name`,
`note`). `plan_entry_options` links an entry to the options cooked.
`dish_ratings`: a standing rating of a meal (`option_id` '') or one option,
primary key `(dish_id, option_id, rated_as)`, `rated_as` 'both' or a member's
user id, `thumbs` −1|1, `stars` 1–5 (older databases had a `want` flag here;
it moved onto `want_list` and the column was dropped). `dish_hidden_options` (`dish_id`, `option_id` an option
or combination key; primary key both): a variation taken off the list because
we've never had it. `planner_notes`: a note to Claude about a
meal (`body`, `reply`, `resolved_at`). `want_list`: the want-to-make scratch
pad, one row per line (`body` as typed, `level` 1 some day | 2 keen | 3 really
want, `dish_id` once matched, `option_ids` JSON, `position`, `created_by`,
`done_at` set when cooked or ticked off). Later milestones add reviews, freezer
stock, photos and shopping lists; every planner table carries `household_id`.

### Model benchmark table

`model_runs` (`analysis_id` → analyses, cascade; `user_id`; `model`; `role`
a|b|bench; `kcal`, `protein_g`, `carbs_g`, `fat_g`, `meal_count`, `confidence`
— null when the model failed; `latency_ms`; `error`; `output` normalised JSON):
one row per model per analysis, primary and background alike. `analyses` gains
`revises_id` — the analysis a chat correction revised — so a correction chain
can be followed to the meal that was finally saved (§7 "Model benchmark").

## 5. Auth model

- **Registration requires an invite code.** `POST /api/auth/register` with
  `{ email, password, inviteCode }`. An invite code is consumed on first use
  (marked `used_by`, `used_at`). Codes are generated by the admin CLI
  (`node server/cli.js invite create --note "sam"`), never by the API.
- **Password hashing**: `node:crypto` `scrypt` (N=16384, r=8, p=1), 16-byte
  salt, 64-byte key, stored as `scrypt$<saltHex>$<hashHex>`. Compare with
  `timingSafeEqual`.
- **Session token**: 32 random bytes → base64url. The raw token goes to the
  client; the DB stores `sha256(token)` hex only. Expiry: 90 days.
  `POST /api/auth/logout` deletes the session row.
- **Every protected route** reads `Authorization: Bearer <token>`, hashes it,
  looks up the session, checks `expires_at > now`, and loads the user.
  No session → `401 { ok: false, error: "Not signed in" }`.
- Email uniqueness is case-insensitive (`COLLATE NOCASE`).
- **Rate limits** (in-memory, `server/lib/ratelimit.js`; client IP is the last
  `X-Forwarded-For` entry when the peer is loopback, i.e. Caddy). Over the limit
  → `429 { ok:false, error }` with a `Retry-After` header (seconds).
  - login: 20 attempts / 15 min per IP; 10 failed attempts / 15 min per
    account, after which that account's sign-in is paused for the rest of the
    window. Both checks run before scrypt.
  - register: 10 attempts / hour per IP.
  - `POST /api/chat`: 60 AI calls / hour per user (idempotent replays are free).
  - `POST /api/cronometer/connect`: 5 attempts / 15 min per user (each one is a
    login relayed to Cronometer).
  - `POST /api/coros/connect`: 10 attempts / 15 min per user (each one opens
    a sign-in at COROS).
  - `POST /api/client-log`: 30 uploads / 15 min per IP.
  - every `/api/*` request except health: 600 / 5 min per IP. Direct loopback
    calls without `X-Forwarded-For` are not counted.
  - `RATE_LIMIT=off` disables them (local experiments only).

## 6. API contract

Base path `/api`. Every response is JSON. Success responses carry
`{ "ok": true, ... }`; failures carry `{ "ok": false, "error": "human message" }`.
Status codes: `400` bad input, `401` not signed in / bad credentials,
`404` not found, `409` conflict (duplicate email, used invite), `429` rate
limited (§5), `500` server error.

### Health
```
GET /api/health -> 200 { ok:true, service:"healthlog", commit:"<sha>" }
```
Public and unauthenticated, so it carries no usage numbers — those are
`node server/cli.js stats` (`scripts/hl stats`).

### Auth
```
POST /api/auth/register   { email, password, inviteCode } -> 200 { ok:true, token, user:{id,email,displayName} }
POST /api/auth/login      { email, password }                -> 200 { ok:true, token, user:{...} }
POST /api/auth/logout                                     -> 200 { ok:true }
GET  /api/auth/me                                         -> 200 { ok:true, user:{...}, profile:{...} }
```

### Profile
```
GET /api/profile -> 200 { ok:true, profile:{ heightCm, startWeightKg, goalWeightKg, sex, age,
                          activityLevel, kcalTarget, proteinG, carbG, fatG, chartWindowDays } }
PUT /api/profile { ...partial profile fields... } -> 200 { ok:true, profile:{...} }
```
PUT also recomputes `kcalTarget` from the profile when `kcalTarget` is not
explicitly supplied and the user has height/weight/age/sex/activity set
(Mifflin–St Jeor + activity multiplier). Supplying `kcalTarget` explicitly
always wins.

### Weights
```
GET    /api/weights?from=YYYY-MM-DD&to=YYYY-MM-DD -> 200 { ok:true, entries:[{id,date,weightKg,note,createdAt,updatedAt}] }
POST   /api/weights { date, weightKg, note? }       -> 201 { ok:true, entry:{...} }   (upsert on (user_id,date))
PUT    /api/weights/:id { date?, weightKg?, note? }  -> 200 { ok:true, entry:{...} }
DELETE /api/weights/:id                             -> 200 { ok:true, deleted:<id> }
```

### Phases
```
GET    /api/phases -> 200 { ok:true, phases:[{id,name,color,startDate,endDate,createdAt}] }
POST   /api/phases { name, color?, startDate, endDate? } -> 201 { ok:true, phase:{...} }
PUT    /api/phases/:id { name?, color?, startDate?, endDate? } -> 200 { ok:true, phase:{...} }
DELETE /api/phases/:id -> 200 { ok:true, deleted:<id> }
```

### Dashboard metrics
```
GET /api/dashboard?days=90 -> 200 { ok:true, metrics:{ ...same metric names as the old tracker... } }
```
`metrics` must include: `currentWeightKg`, `avg7d`, `totalChangeKg`, `weeklyRateKg`,
`streakDays`, `bestStreakDays`, `bmi` (null without height), `dailySwingKg`,
`goalProgressPct`, `startWeightKg`, `goalWeightKg`, plus
`intake:{ day, kcal, kcalTarget, proteinG, carbG, fatG, proteinPct, carbPct, fatPct }`
and `intakeHistory:[{ day, kcal, proteinG, carbsG, fatG }]` for the last `days`.

`metrics.adaptiveTdee` is an **observed maintenance estimate**, shown alongside —
never written to — `profile.kcalTarget` or `activityLevel`:
```
{ kcal|null, avgIntakeKcal|null, weightSlopeKgPerWeek|null, windowStart, windowEnd,
  windowDays:28, loggedDays, weighIns, confidence:"high"|"medium"|"low"|null,
  reason|null, formulaKcal|null, kcalTarget|null }
```
Window: the 28 complete days ending the day before `day`, independent of `days`.
`avgIntakeKcal` averages only days with meals; the weight change is the
least-squares slope through the window's weigh-ins;
`kcal = avgIntake − slopeKgPerDay × 7700`. `kcal` is null (with a human
`reason`) until there are ≥ 14 logged days and ≥ 8 weigh-ins spanning ≥ 14 days.
`formulaKcal` is Mifflin–St Jeor × activity multiplier at the current 7-day
average weight, for comparison.

The **metric maths is ported from the old `src/metrics.ts`** — same definitions,
same edge cases. Read `C:\Users\hanki\Development\weight-tracker\src\metrics.ts`
and mirror it in `server/lib/metrics.js`.

### Meals and foods
```
GET    /api/meals?day=YYYY-MM-DD&limit=50   -> 200 { ok:true, meals:[{id,eatenAt,day,name,description,
                                                  kcal,proteinG,carbsG,fatG,fiberG,source,confidence,
                                                  items:[{id,name,quantity,kcal,proteinG,carbsG,fatG}]}] }
POST   /api/meals { eatenAt?, day?, name, description?, kcal, proteinG, carbsG, fatG, items?[],
                    analysisId?, analysisPart? }
                                               -> 201 { ok:true, meal:{...} }
       # With analysisId the save is idempotent per part: if the analysis already
       # has more than analysisPart (default 0) meals, the existing one at that
       # position (by eatenAt) is returned with 200. A multi-meal chat reply saves
       # parts 0..n-1.
PUT    /api/meals/:id { ... }                -> 200 { ok:true, meal:{...} }
DELETE /api/meals/:id                        -> 200 { ok:true, deleted:<id> }

GET    /api/foods  -> 200 { ok:true, foods:[{id,name,serving,kcal,proteinG,carbsG,fatG,createdAt}] }
POST   /api/foods  { name, serving?, kcal, proteinG, carbsG, fatG } -> 201 { ok:true, food:{...} }
DELETE /api/foods/:id -> 200 { ok:true, deleted:<id> }
```

### Chat / AI
```
GET  /api/chat/messages?limit=100&before=<iso> -> 200 { ok:true, messages:[{id,role,content,mealId,analysisId,createdAt}] }
POST /api/chat { message, day?, save?:boolean }  -> 200 { ok:true, message:{...assistant message...},
                                                          meal:{...}|null, analysis:{...}|null }
```
`POST /api/chat` is the core: it runs the AI pipeline (§7), stores the assistant
message, and (when `save` is not `false`) stores the meal. It must be
**idempotent enough to survive a retry** and must never block longer than
~60 s — the model calls have a 25 s timeout each and run in parallel.

`analysis` returned to the client:
```
{ id, modelA, modelB, modelAOutput:{items,total,confidence,notes},
  modelBOutput:{items,total,confidence,notes}, reconciled:{items,total},
  comparison:"...", agreement:"high"|"medium"|"low", deltaPct: number }
```

### Analyses
```
GET /api/analyses/:id -> 200 { ok:true, analysis:{...} }
```

### Model benchmark
```
GET /api/model-bench?days=90   (1..3650, default 90)
  -> 200 { ok:true,
           config:{ enabled, paused, modelA, modelB, bench:[model], differPct },
           totals:{ logs, benchmarked, differed, corrected, accepted },
           models:[{ model, role:"logged"|"a"|"b"|"bench"|"other", tier, runs, failures,
                     failRate, medianLatencyMs, proteinMedianAbsG,
                     consensus:{ n, medianAbsPct, biasPct, within10, within20 },
                     corrected:{ ...same } }],
           pairs:{ models:[model], cells:[[{ pct, n }]] },
           logs:[{ id, createdAt, text, logged, loggedDevPct, loggedRefDevPct,
                   consensusKcal, spreadPct, abPct, differed,
                   outcome:"unsaved"|"accepted"|"corrected",
                   reference:{ kcal, proteinG, source:"chat correction"|"edited meal" }|null,
                   runs:[{ model, role, kcal, proteinG, carbsG, fatG, mealCount, confidence,
                           latencyMs, error, devPct, looDevPct, refDevPct }] }] }
```
Only the signed-in user's analyses. `logs` is newest first, at most 300. The
"Logged value" entry in `models` scores what the app actually proposed.

### Garmin

```
GET  /api/garmin               -> 200 { ok:true, garmin:{ available, connected, status, syncing,
                                      lastAttemptAt, lastSuccessAt, lastError, backoffUntil, syncHour, syncIntervalHours } }
POST /api/garmin/sync { days? } -> 200 { ok:true, result:{ ok, from, to, days?, activities?, error?, message? }, garmin }
                                   409 not connected / already running, 429 inside backoff, 503 not installed
GET  /api/activities?limit=50&before=<startLocal> -> 200 { ok:true, activities:[{ id, source, name, type,
       startLocal, day, durationS, movingS, distanceM, kcal, avgHr, maxHr, elevationGainM, avgSpeedMps, trainingEffect }] }
GET  /api/activity/daily?from&to -> 200 { ok:true, days:[{ day, steps, activeKcal, totalKcal, bmrKcal,
       restingHr, sleepSeconds, intensityMinutes, source, syncedAt }] }
```
`/api/dashboard` adds `metrics.activity:{ garmin, latest, avgSteps7d, recent[3] }`
and `adaptiveTdee.watchKcal` / `watchDays` (the watch's mean daily total kcal over
the TDEE window; null under 7 days).

**How sync works.** `sync/garmin_sync.py` (python-garminconnect, pinned in
`sync/requirements.txt`, venv at `/opt/healthlog-garmin/venv`) is a pure
fetcher: it prints JSON and never touches the database. Node spawns it
(`server/lib/garmin.js`) and writes the rows. This is the one deliberate
exception to "zero runtime dependencies"; the Node API itself still imports
only built-ins and runs normally when the venv is absent (`available:false`).

**Login rules — Garmin rate-limits SSO logins per IP, for days once tripped:**
- The fetcher is constructed **without credentials** and can only resume the
  saved tokens in `$DATA_DIR/garmin/<userId>/garmin_tokens.json` (refreshing
  them in place). Missing or rejected tokens end in `needs_login`; it never
  falls back to a password login. The Garmin password is never stored.
- The only full login is interactive: `node server/cli.js garmin login --email <e>`
  (or `scripts/hl garmin-login <e>`), with an MFA prompt.
- Scheduled sync: at most **one attempt per user every
  `GARMIN_SYNC_INTERVAL_HOURS`** (default 3, minimum 1), successful or not,
  and only from `GARMIN_SYNC_HOUR` (default 6, server local time) until
  midnight — nothing overnight. `needs_login` is not retried until the token
  file changes.
- `rate_limited` sets `backoff_until` (`GARMIN_BACKOFF_HOURS`, default 6);
  every sync, manual included, is refused until then.
- The first strategies in garminconnect's login chain usually fail; those
  are warnings in the journal, not errors.
- Range: only days that are not final are fetched. A day is final once a
  successful sync has run after 12:00 on the following day; each sync starts at
  the earliest day that was not final at the last success. Normally that is
  today alone, plus yesterday until the first sync after noon. The first sync
  (or a gap longer than 30 days) backfills 30 days; `days` on a manual sync
  forces the last N (max 120). Finished days stay stored and are not re-fetched.

### Garmin insights (phase 2 of the Garmin integration)

```
POST /api/garmin/import { range?, days?, sleep?, metrics?, activities?, records?, meta? }
     -> 200 { ok:true, imported:{ days, wellness, sleep, metrics, activities, records } }
        400 nothing to import / a list over 20 000 rows; body limit 12 MB
GET  /api/insights?from&to   (default: the last 365 days)
     -> 200 { ok:true, from, to, coverage:{ first, last }, days:[...daily_activity + daily_wellness],
              sleep:[...], metrics:[...], activities:[...with insight columns], intake:[{ day, kcal, proteinG }],
              weights:[{ day, weightKg }], records:[...], meta:{ hrZones?, thresholds?, lastImport? },
              sources:{ garmin, coros } }   which watch wrote the data (any date)
```

- **Two sources, one store.** `server/lib/garminStore.js` is the only writer of
  Garmin rows. The live sync (§6 "Garmin") and the export import both go
  through it; each field is range-checked there and out-of-range or sentinel
  values (Garmin's -1/-2) are dropped, never stored.
- **Export import.** The Garmin Connect data-export ZIP is read in the browser
  (`src/lib/zip.ts`, native `DecompressionStream`; `src/lib/garminExport.ts`
  normalises it). Only these entries are read: `UDSFile_*` (daily summaries),
  `*_sleepData`, `summarizedActivities`, `TrainingHistory_*`,
  `RunRacePredictions_*`, `MetricsMaxMetData_*`,
  `MetricsHeatAltitudeAcclimation_*`, `fitnessAgeData`, `personalRecord`,
  `heartRateZones`, `bioMetrics_latest`. FIT files, GPS courses, golf and
  profile files are never read or uploaded. Unit traps, verified on a real
  export: activity calories are kJ, durations ms, distance/elevation cm, speed
  cm/ms; `startTimeLocal` is wall-clock epoch ms; sleep times are GMT and get the
  same day's offset from the daily summary. The newest daily summary is the
  day the export was made, so only its resting HR and Body Battery are kept.
- **Live sync, extended.** `sync/garmin_sync.py fetch` additionally returns
  wellness fields from the same daily summary, the night's sleep (stages,
  score), last-night HRV (one extra call per day), and one fitness snapshot for
  the last day of the range (VO₂ max, race predictions, training status: three
  calls per sync). All of them are optional — a failure is a warning, not a
  failed sync; auth and 429 errors still propagate. The login rules, interval,
  range and backoff of §6 "Garmin" are unchanged.
- **Analysis is client-side** (`src/lib/insights.ts`, pure): the view loads the
  whole history once and re-slices per range. Definitions: a night belongs to
  the morning it ends; a day's training affects the next night and morning;
  baselines are the 30 days before (the day excluded). Recovery = weighted mean
  of sleep score (0.35), Body Battery at wake (0.35), resting HR vs norm
  (0.3; 60 at the norm, -12 per bpm above) and HRV vs norm (0.25, when
  present); needs at least 2 parts. Findings need at least 8 days per side, a
  practical minimum difference and |Cohen's d| ≥ 0.3; strong ≥ 0.8,
  moderate ≥ 0.5.

### Cronometer

```
GET  /api/cronometer -> 200 { ok:true, cronometer:{ available, connected, email, status, syncing,
       lastAttemptAt, lastSuccessAt, lastError, backoffUntil, syncHour, syncIntervalHours,
       exportsToday, exportsPerDay } }
POST /api/cronometer/connect { email, password }
     -> 200 { ok:true, result:<sync result>, cronometer }
        400 Cronometer rejected the login (its message is relayed) / missing fields
        429 too many connect attempts
POST /api/cronometer/sync { days? }   days 1..365 forces the last N days
     -> 200 { ok:true, result:{ ok, from, to, meals?, servings?, format?:'servings'|'daily', error?, message? }, cronometer }
        409 not connected / needs a fresh login / already running
        429 inside backoff, or today's export budget is used
POST /api/cronometer/disconnect { deleteMeals?:boolean }
     -> 200 { ok:true, deletedMeals, cronometer }
```

Cronometer has no public API for individuals. `server/lib/cronometer.js`
drives the endpoints its web app uses (the flow `gocronometer` documents): GET
`/login/` for the `anticsrf` token, POST `/login` (form), GWT RPC
`authenticate` on `/cronometer/app` for the Cronometer user id, GWT
`generateAuthorizationToken` for a short-lived export token, then GET
`/export?generate=servings&start&end&nonce` (or `generate=dailySummary`, see
"Daily totals" below). The GWT permutation and RPC policy
hash change with Cronometer releases, so they are read from
`/cronometer/cronometer.nocache.js` and `/cronometer/<permutation>.cache.js`
(cached 6 h, re-read once on a stale-policy error, last known values as a
fallback). Node built-ins only (`fetch`); `CRONOMETER_BASE` points it at a fake
server in tests (`qa/fixtures/fake-cronometer.mjs`).

**Credentials.** The user enters their Cronometer email and password in
Settings. The password is used for that one login and dropped: it is never
stored, logged or echoed. Only the session cookies (plus the Cronometer user
id and email) are kept, in `$DATA_DIR/cronometer/<userId>/session.json`
(0600, outside the database so DB backups never carry them). When Cronometer
ends the session the status becomes `needs_login`, the session file is
deleted, and nothing syncs until the user connects again. Accounts with
two-factor sign-in are not supported.

**Load on Cronometer** (it allows about 10 exports per account per day):
- One export per sync (two once, on the sync that finds the servings export
  has no nutrients, see "Daily totals"). Scheduled syncs at most every
  `CRONOMETER_SYNC_INTERVAL_HOURS` (default 4, minimum 2), from
  `CRONOMETER_SYNC_HOUR` (default 6, server local time) until midnight.
- A hard cap of `CRONOMETER_DAILY_EXPORTS` (default 8, max 10) exports per user
  per local day, connect and manual syncs included; past it every sync is
  refused until tomorrow without contacting Cronometer.
- HTTP 429 from Cronometer sets `backoff_until` (`CRONOMETER_BACKOFF_HOURS`,
  default 6); every sync is refused until then.
- `CRONOMETER=off` disables the feature.

**What syncs: the food diary only.** The first sync covers the last 90 days,
later ones the last 7 (a manual `days` forces up to 365). Servings are grouped
into one meal per (day, Cronometer group): name = the group ("Breakfast"),
`source = 'cronometer'`, description "From Cronometer", each serving an item
(name, amount as `quantity`, kcal and macros), meal totals = the sum, fibre
summed into `fiber_g`. `eaten_at` is the earliest serving time in the group
(server local time), or a default per group (breakfast 08:00, lunch 12:30,
snacks 15:30, dinner 19:00, otherwise 12:00). Each sync deletes and re-inserts
the user's `cronometer` meals for every day in its range, in one transaction, so
edits and deletions in Cronometer carry over; days outside the range and meals
from any other source are never touched. A synced meal edited in HealthLog
keeps `source = 'cronometer'` and is replaced by the next sync that covers its
day.

**Daily totals.** Some accounts get a servings export with no nutrient
columns at all (`Day, Group, Food Name, Amount, Category`). When the servings
export has Day and Food Name but no Energy column, the same sync fetches
`generate=dailySummary` (one row per day: Date, Energy, macros, fibre) if
today's budget has room for a second export, and stores one meal per day with
energy > 0: name "Day total", description "From Cronometer (day total)", no
items, the day's kcal/macros/fibre, `eaten_at` 12:00 local. `session.json`
then records `format: "daily"`, so later syncs spend their one export on
`dailySummary` only; a fresh connect clears it and tries servings again. With
no room for the second export the sync fails with a message saying daily
totals start tomorrow. Energy headers are matched loosely (case, spacing,
`Energy (kJ)` converted to kcal).

### COROS

```
GET  /api/coros -> 200 { ok:true, coros:{ available, connected, connectedAt, status, syncing,
       lastAttemptAt, lastSuccessAt, lastError, backoffUntil, syncHour, syncIntervalHours } }
POST /api/coros/connect { returnTo }          returnTo: a HealthLog page (allowed origin)
     -> 200 { ok:true, authorizeUrl }          the browser opens it
        400 returnTo not a HealthLog page; 429 too many attempts, or inside backoff
GET  /api/coros/oauth/callback?code&state     COROS redirects the browser here (no bearer token)
     -> 302 to returnTo (also when the user declined; the reason is in lastError)
        400 unknown or expired state (a plain page)
POST /api/coros/sync { days? }   days 1..180 forces the last N days
     -> 200 { ok:true, result:{ ok, from, to, days?, sleep?, activities?, warnings?, error?, message? }, coros }
        409 not connected / needs a fresh connect / already running
        429 inside backoff
POST /api/coros/disconnect { deleteData?:boolean }
     -> 200 { ok:true, deleted:{ days, sleep, activities }, coros }
```

**Route: COROS's official self-service access for apps** ("Build on COROS
MCP": OAuth 2.0 + the COROS MCP server at `https://mcp.coros.com/mcp`, no
application or approval, single-user). COROS's REST Partner API needs a
company and a review, so it is not used.
- `server/lib/corosMcp.js`: OAuth as the MCP authorization spec describes it.
  Discovery from the MCP host's protected-resource metadata (today the
  authorization server is `https://mcpus.coros.com`); dynamic client
  registration (RFC 7591), once per redirect URI, as a public client, cached in
  `$DATA_DIR/coros-client.json`; authorization code + PKCE S256 with
  `resource` (RFC 8707) and scope `openid mcp.tools offline_access`. COROS
  does not offer the device-code grant to registered clients.
- The redirect URI is this API's own public address
  (`https://<host>/api/coros/oauth/callback`, from `X-Forwarded-Proto` / `Host`;
  `COROS_REDIRECT_URI` overrides). The callback is unauthenticated: the
  one-time `state` (15 min, in memory, one pending attempt per user) identifies
  the user. The browser is then sent back to `returnTo`, which must be on an
  allowed origin.
- MCP: JSON-RPC over streamable HTTP (`initialize`,
  `notifications/initialized`, `tools/call`; JSON or SSE replies;
  `Mcp-Session-Id`). Node built-ins only. `COROS_MCP_URL` points it at a fake
  server in tests (`qa/fixtures/fake-coros.mjs`).

**Credentials.** HealthLog never sees the COROS password: the user signs in on
COROS's page. Only the tokens are kept, in
`$DATA_DIR/coros/<userId>/session.json` (0600, outside the database). COROS:
access tokens last 30 days, refresh tokens 180 days and rotate. The access
token is refreshed a day before it expires, or once on a 401, and the new
refresh token is saved at once. A refused refresh means `needs_login`: the
session file is deleted and nothing syncs until the user connects again.
Disconnect revokes the token at COROS (best effort).

**Load on COROS** (no published MCP limits):
- Scheduled syncs at most every `COROS_SYNC_INTERVAL_HOURS` (default 4,
  minimum 2), from `COROS_SYNC_HOUR` (default 6, server local time) until
  midnight. A normal sync is about eight tool calls plus `getActivityDetail`
  for each activity not stored yet (at most 30 per sync). FIT files are never
  fetched (COROS allows 50 a day).
- HTTP 429 sets `backoff_until` (`COROS_BACKOFF_HOURS`, default 6); every sync
  and connect is refused until then without contacting COROS.
- `COROS=off` disables the feature.

**What syncs.** The first sync covers the last 90 days, later ones the last 7
(a manual `days` forces up to 180). Tools: `querySportRecords` (31-day chunks)
+ `getActivityDetail`; `querySleepOverview` (31-day chunks); `querySleepHrv`
(7-day chunks); `queryDailyHealthData`, `queryRestingHeartRate`,
`queryStressLevel` (recent days only: the span is asked for, and a week if
COROS refuses); `queryFitnessAssessmentOverview` (current VO₂ max and race
predictions, stored on the last day; threshold pace into `thresholds.ltPaceSPerKm`,
merged with any Garmin thresholds). One tool failing (other than auth or rate limiting) does not
fail the sync: the rest is stored and the skipped tools are listed in
`warnings` and `lastError`.

The tools answer in human-readable text, not a schema, and COROS JSON-encodes
each text block a second time (the text is a JSON string literal with `\n`
escapes); `corosMcp.js` decodes it once before anything parses it.
`server/lib/corosParse.js` cuts a reply into blocks (one per date or numbered
record), reads `Label: value` fields (also `A | B` lines, markdown tables and
JSON) and finds fields by keyword; unrecognised text is dropped, never guessed
into a column. `node server/cli.js coros dump --email <e>` (or
`scripts/hl coros-dump <e>`) prints the raw replies for tuning. Every sync logs
each tool call (arguments, size, a 300-character preview) to the journal, logs
an error when a reply with dated records parsed to nothing, and keeps the full
replies of the latest sync in `$DATA_DIR/coros/<userId>/last-sync.txt` (0600,
removed on disconnect; `cli.js coros last --email <e>` / `scripts/hl coros-last <e>`).
Everything is
written by `storeGarmin(..., { source: 'coros' })`, so the checks and
`COALESCE` rules of §6 "Garmin insights" apply:
- `activities` (`source = 'coros'`): `external_id` = the label id (or
  start + sport + duration when the list has none); start (the list gives a
  UTC `startTimestamp`; it becomes local time with the watch's offset from
  `querySleepHrv`'s `timezone=` quarter hours, kept only when it lands on the
  record's date, else the date at 00:00), duration, distance,
  moving time, kcal, average / max HR, elevation gain, training load; speed =
  distance / time. Sport codes map to the Garmin type keys (`402` →
  `strength_training`), then the name decides, else `other`.
- `daily_activity` (`source = 'coros'`): steps, calories (active / total /
  resting when labelled; a bare "Calories" is COROS's active calories),
  exercise minutes (`intensity_minutes`), resting HR, main sleep seconds.
  `daily_wellness`: `hrv_night`, `hrv_status` (also the verdict after
  "HRV Avg: 65 ms —"), `stress_avg`. `sleep_nights` (the wake-up date, as COROS
  dates them): window start / end, deep / light / REM from their share of main
  sleep, awake time, score. `fitness_metrics`: `vo2max`, `race_5k_s`,
  `race_10k_s`, `race_half_s`, `race_marathon_s`.
- The Insights tab follows `sources`: COROS-only data shows "COROS insights",
  an overnight HRV chart in place of Body Battery, no empty heart-rate-zone
  card and no Garmin export panel; a connected COROS with no data yet shows a
  waiting card instead of the Garmin import.
- Days are keyed by date only, so a day with both Garmin and COROS data holds
  one merged row.
- Disconnect with `deleteData` removes the `coros` activities, the `coros`
  `daily_activity` rows and the `daily_wellness` and `sleep_nights` rows of
  those days.

### Lifting

```
GET    /api/lifting?from&to              -> 200 { ok:true, exercises:[{id,name,muscle,equipment,incrementKg,repMin,repMax,perSide,archived,createdAt}],
                                                  workouts:[{id,day,name,notes,startedAt,endedAt,createdAt,updatedAt,
                                                  sets:[{id,exerciseId,weightKg,reps,rpe,kind,doneAt}]}],
                                                  routines:[{id,name,items:[{exerciseId,alternatives}],position,updatedAt}] }
POST   /api/lifting/exercises { id?, name, muscle?, equipment?, incrementKg?, repMin?, repMax? } -> 201 { ok:true, exercise }
       # idempotent: a known id, or a name that exists (case-insensitive, un-archived), returns it with 200
PUT    /api/lifting/exercises/:id { name?, muscle?, equipment?, incrementKg?, repMin?, repMax?, perSide?, archived? } -> 200 { ok:true, exercise }
DELETE /api/lifting/exercises/:id        -> 200 { ok:true, archived:<id> } when it has sets, else { ok:true, deleted:<id> }
GET    /api/lifting/workouts/:id         -> 200 { ok:true, workout }
PUT    /api/lifting/workouts/:id { day, name?, notes?, startedAt?, endedAt?, sets:[{ id, exerciseId, weightKg, reps, rpe?, kind? }] }
                                         -> 201 created / 200 replaced { ok:true, workout }   (max 400 sets)
DELETE /api/lifting/workouts/:id         -> 200 { ok:true, deleted:<id> }
PUT    /api/lifting/routines/:id { name, items:[{ exerciseId, alternatives?, priority? }], position? }
                                         -> 201 created / 200 replaced { ok:true, routine }   (max 40 items, 5 alternatives each; priority kept on the first item that sets it)
DELETE /api/lifting/routines/:id         -> 200 { ok:true, deleted:<id> }   (soft delete)
```

- **Replace-all upsert.** `PUT /api/lifting/workouts/:id` writes the whole
  workout and its sets in one transaction, so a retry can never duplicate a set.
  Every set's `exerciseId` must be one of the user's exercises.
- **Starter library.** The first `GET /api/lifting` for a user with no
  exercises seeds 50 common lifts.
- **Default routine.** The first `GET /api/lifting` for a user who has never had
  a routine (deleted ones count) seeds "Upper body": Incline dumbbell press (stand-in:
  Bench press), Pull-up, Inverted row, Dumbbell shoulder press, Incline dumbbell
  curl, Skull crusher (stand-in: Overhead triceps extension), Hanging leg raise,
  Lateral raise. Missing exercises are created and hidden ones un-hidden. A routine
  still exactly as the first version seeded it (skull crusher and extension as two
  items) is merged into that one slot; edited routines are left alone. Every item
  `exerciseId` / alternative must be one of the user's exercises. Routines are
  edited online only, and cached on the device with the exercise list so they start offline.
- **Offline first** (`src/lib/lifting.svelte.ts`). Changes apply on the device
  first and sit in a per-user `localStorage` outbox (new exercises, then workout
  upserts, then deletes) until the API accepts them. Retries: on `online`, when
  the tab becomes visible, every 20 s while offline, on the next change. A
  name clash for an exercise created offline remaps its local id onto the
  server's. The live session id and the planned exercise order are kept
  on the device too, and an unfinished session less than 12 h old resumes on any device.
- **Analysis is client-side** (`src/lib/lifting.ts`, pure). Hard set = not a
  warm-up. e1RM = Epley, weight × (1 + reps / 30), a single is its weight,
  over 12 reps none. Bodyweight lifts add the nearest weigh-in (on or before the
  day, else the first after). Records (best e1RM, heaviest, rep PR) count only
  after the first session. Status: last 4 weeks of training vs the 4 before
  (or everything earlier): ≤ −3 % slipping, the last session a best or ≥ +1 %
  progressing, no step forward (as in the plateau rule below) in the last 3 sessions stalled, else steady. Weekly volume
  per muscle is fractional (Pelland et al. 2026): a hard set counts 1 for the
  exercise's muscle and 0.5 for each synergist (`muscleShares`): presses →
  triceps + front delts (overhead: triceps); dips → chest, triceps, delts; rows,
  pulldowns, pull/chin-ups → biceps (or back when biceps is the target); squats,
  leg press, lunges → glutes (not hamstrings); hinges → hamstrings + glutes,
  conventional deadlift / rack pull also back; hip thrusts and isolation lifts →
  nothing. Bars show the direct part solid and the synergist part light, against
  a 10–20 band; total set counts still count each set once.
- **Progression** (`src/lib/progression.ts`, pure; the header comment has the
  sources). Rep range (`repMin`/`repMax` are both null or both 1–50, max ≥ min) is
  set on the exercise, else a default: 6–12, lateral raises (by name) 6–15. If the median first working set of the last 4
  sessions is more than 1 below or 2 above the default, the preset that starts
  there is used instead. RIR = 10 − RPE, capped at 4; failure = 0; unknown = same
  effort as last time. Prescriptions aim for RPE 8 (RIR 2), never easier than
  last time. The plan for the next session, checked in this order:
  1. 21+ days off → 90 % (85 % from 42 days, 80 % from 90). 10–20 days → repeat.
  2. First top set ≥ 2 below the range bottom, or under it at RIR ≤ 0.5 → lighter
     weight that predicts bottom + 1 reps.
  3. Plateau: ≥ 4 sessions since the latest ≥ 8 % top-weight drop (looking back
     12 sessions), and no step forward in the last 3: a new best (+0.2 %), the rep step
     (same top weight, every top set ≥ the last step forward and one more somewhere,
     or an extra set) or the load step (heavier, best set within 6 % of the last step
     forward), so following the plan is never a plateau. First time → reset to about
     90 %. Already reset, and back within one step of the weight it was reset from → switch rep range
     (≤ 8 → 8–12, ≥ 10 → 6–10, else barbell 5–8 / other 10–15).
  4. Last session ≥ 5 % below the best of the 3 before → repeat.
  5. Every top set at the range top, or all at RIR ≥ 3 → add weight. Reps at
     the new weight come from each set's Epley estimate. Without RPE the step is
     one increment; when easy (or 2+ over the top), up to 3 increments within
     +10 %, while the first set still makes the bottom and none is more than one below it.
     A step that predicts 2+ below the bottom keeps adding reps instead (it jumps
     anyway at 4+ over the top).
  6. Else add reps: one on the weakest set; at RIR ≥ 2 on every set, 2 or more.
  Back-off sets keep their weight ratio to the top set. Mid-session
  (`nextSet`), the next set: under the range at RIR ≤ 1 → lighter; 2+ short of the plan →
  match the last set; RIR ≥ 3 and on plan → one increment more. Lifting home suggests a lighter week when ≥ 3 lifts
  (≥ 40 % of those trained in 3 weeks with 4+ sessions) are stalled or slipping.
- **One side at a time** (`src/lib/sides.ts`, pure). An exercise with
  `perSide` is logged one arm per entry. Two entries in a row (logged order) at
  the same weight and kind are one set: weekly sets per muscle, set counts, lift
  load, the consistency calendar, composition and pre-fatigue count it once;
  rest runs from the second arm of one pair to the first of the next; the plan
  merges each pair into one set at the weaker arm's reps (harder RPE) and shows
  "each side". Mid-session, after one arm the next entry is the same weight and
  reps ("Now the other side"); after a full pair the plan moves on. A lone entry
  is a set on its own. Records and tonnage stay per entry.
- **Exercise order** (`src/lib/fatigue.ts`, pure; the header comment has the
  sources). Each lift in each workout gets a pre-fatigue score F: the hard sets
  of other exercises logged before its first hard set (ordered by `doneAt` when
  every set has one, else stored order), each weighted by muscle overlap (primary
  muscle 1 plus secondaries from the name; overlap = Σ this × earlier ÷ Σ this),
  effort (1 at RPE 8 or none, ±15 % per rep of RIR, 0.7–1.3) and time
  (0.5 + 0.5·e^(−min/20), 0.75 without times). Cost = 2.5 % of estimated max per
  unit of F, at most 15 %. Status, sessions since best and the plan's plateau /
  off-day / reset checks compare fresh-equivalent sessions (best ÷ (1 − cost)).
  The plan scales last session's reps (Epley, same effort) from last time's F to
  today's before its rules run, when that moves the estimate by ≥ 1.5 %; the
  logger passes today's F, timed to now, and planning ahead assumes the same
  order as last time. Records stay raw. A routine can mark one **priority lift**:
  in a live workout named as the routine, opening a lift with overlap ≥ 0.3
  before the priority lift has a hard set warns with its estimated cost.
- **Analysis** (`src/lib/liftAnalysis.ts`, pure; methods in its header).
  Per lift (4+ sessions spanning 14+ days): Theil–Sen trend of session-best e1RM
  over the last 120 days as %/month, a 90 % bootstrap range (400 resamples,
  seeded), verdict (gaining / losing when the range excludes 0, flat when
  |rate| < 0.75 and the range is inside ±2, else not clear), noise (1.4826 × MAD
  of % residuals), one change point (piecewise OLS, kept when BIC improves by > 2
  and the rate moves ≥ 1 %/month), an 8-week projection (when trained within 3
  weeks, 6+ sessions) and e1RM ÷ bodyweight. Strength index: geometric mean over
  lifts of (mean of the last 2 session bests, carried ≤ 8 weeks) ÷ (median of the
  first 3) × 100, weekly. Session form: session best vs a leave-one-out tricube
  local linear fit (±56 days), clipped ±25 %, averaged over the workout's lifts
  (5+ sessions each). Factors (sleep, HRV and resting HR vs the 28-day median
  before, Body Battery at wake, 3-day calories and protein, 3-week weight slope ≤
  −0.2 kg/wk, start before/after 12:00, 1 vs 2+ days since the last session):
  difference in mean form, split at a fixed threshold or the most even split, a
  90 % bootstrap range, needing 5+ sessions per side. Rest: gaps of 20 s–15 min between
  consecutive working sets of one lift; share of reps kept at the same weight per
  rest bucket. Also: sessions per week, week streak, training calendar, routine
  completion (workouts named as the routine; stand-ins count), rep zones, push /
  pull and upper / lower sets, effort logged, muscle × week heatmap, records.
  Exercise order: session form (lifts with 5+ sessions) after related lifts
  (F ≥ 1) vs fresh (F < 0.3), 5+ per side, bootstrap 90 % range; OLS slope of
  form on F (10+ points) against the assumed −2.5 %/unit; per-lift differences
  (2+ per side) with what each usually follows; lifts whose last 8 sessions
  include 2+ fresh and 2+ after related lifts are flagged as varying in order.
- **Insights.** `mergeLifting` folds logged workouts into the Garmin
  activities before `buildInsights` / `buildAdvanced`: a workout on a day with a
  watch strength activity enriches it (sets, reps, the higher of the two loads);
  one without becomes a `strength_training` activity. Lift load = 5 per hard set
  × (RPE − 5) / 3 clamped 0.4–1.7 (1 without RPE) + 1 per warm-up — ~100 for a
  20-set session, because Garmin's heart-rate load under-counts lifting. Nothing
  is written back to Garmin rows.

### Partner sharing
```
GET    /api/partner                 -> 200 { ok:true, partner:{email,status:'linked'|'pending',name}|null }
PUT    /api/partner { email }       -> 200 { ok:true, partner }   # 400 bad email / your own email
DELETE /api/partner                 -> 200 { ok:true, partner:null }
POST   /api/meals/:id/share         -> 201 { ok:true, share:{id,status:'pending',to} }
                                       # 200 with the existing share when already offered (re-offers a
                                       # dismissed one); 404 not your meal; 409 no live link, or 50 pending
GET    /api/shared-meals            -> 200 { ok:true, shares:[{id, from:{name}, sharedAt, meal:{...meal}}] }
POST   /api/shared-meals/:id/accept { name?, day?, eatenAt?, description?, kcal?, proteinG?, carbsG?,
                                      fatG?, items?[] }
                                    -> 201 { ok:true, meal }      # 200 with the same meal on a repeat
POST   /api/shared-meals/:id/dismiss -> 200 { ok:true, dismissed:<id> }
```
- **Mutual link.** `status` is `linked` only when both users name each other;
  `name` (display name's first word, else the email's local part, capitalised)
  is returned only then, so a pending link never reveals whether an email has
  an account. Sharing and the inbox both require a live link: unlinking hides
  pending offers (relinking brings them back).
- **Inbox** lists pending offers from the currently linked partner, oldest
  first, at most 50. Each `meal` is the sender's meal as it is now, without
  `analysisId`, `confidence` or `sharedStatus`.
- **Accept** creates a meal in the recipient's account with `source:'shared'`;
  any field in the body replaces the sender's value, the rest (items included)
  are copied, `day` defaults to the sender's day. The sender's meal is never
  changed. Only the recipient can accept or dismiss (others get `404`).
- Deleting the sender's meal withdraws the offer (cascade).
- Every meal payload carries `sharedStatus` — `pending` | `accepted` |
  `dismissed` | `null` — so the sender can see what happened to an offer.

### Meal planner
The client is the separate **mealplan** frontend (its own repo and GitHub Pages
site, same origin as this one, so CORS needs no change). It signs in with a
HealthLog account; the token key in `localStorage` is shared, so being signed
in to one signs you in to the other.
```
GET    /api/planner/household       -> 200 { ok:true, household:{ id, weekStartDay, members:[{id,name,me}],
                                                partner:{status:'linked'|'pending',email}|null } }
GET    /api/planner/meals           -> 200 { ok:true, meals:[{ id, name, family, tags[], suggestedTags[], effort,
                                                tips, link, neverSuggest, aliases[], options:[{id,axis,name}],
                                                cooked, lastCooked, ratings:[{optionId,ratedAs,thumbs,stars,source}], hidden:[optionId],
                                                notes:[{id,body,reply,resolved,createdAt,createdBy}] }] }
PUT    /api/planner/meals/:id { tags?, suggestedTags?, effort?: 1|2|3|null, tips?, neverSuggest?, archived? }
                                    -> 200 { ok:true, meal|null }   # 400 bad effort / >20 tags / tag >30 chars
                                                                    # archived:true removes it (meal null), false restores
PUT    /api/planner/meals/:id/hidden { optionId, hidden?: true|false }
                                    -> 200 { ok:true, hidden:[optionId] }  # 404 foreign meal/option
PUT    /api/planner/ratings { dishId, optionId?, ratedAs:'both'|'me'|<member id>, thumbs?, stars? }
                                    -> 200 { ok:true, rating|null }  # all empty deletes; 404 foreign meal/option;
                                                                     # want 400 (it's a want-to-make line now)
POST   /api/planner/meals/:id/notes { body } -> 201 { ok:true, note }   # 1–2000 chars
PUT    /api/planner/household { weekStartDay: 0..6 }  -> 200 { ok:true, household }  # 0 = Monday (default)
POST   /api/planner/meals { name }  -> 201 { ok:true, created:true, meal }   # 200 + created:false when the
                                       # name or an alias already means a meal
POST   /api/planner/meals/:id/aliases { alias } -> 200 { ok:true, alias }   # latest correction wins
GET    /api/planner/week?start=YYYY-MM-DD -> 200 { ok:true, week:{ start, end, entries:[{ id, date, slot,
                                       kind, status, dishId, optionIds[], note, raw, updatedAt }] } }
PUT    /api/planner/slots/:date { kind:'dish'|'out'|'leftovers'|'takeaway', dishId?, optionIds?, note?, raw? }
                                    -> 200 { ok:true, entry }   # one dinner per date; replaces it
DELETE /api/planner/slots/:date    -> 200 { ok:true, cleared }
PUT    /api/planner/week-starts { date, replaces? } -> 200 { ok:true, household }   # a week starting on another
                                       # day: weeks run 7 days at a time from the latest start on or before a date
                                       # (short week before a new start); before any, weekStartDay applies.
                                       # replaces = the start being moved (its shopping list moves too).
                                       # household.weekStarts lists them, oldest first
PUT    /api/planner/slots/:date/text { text } -> 200 { ok:true, entry|null, pending }   # a night typed like a
                                       # note: saved as the words (raw) at once; linked to a meal only when
                                       # code is sure (exact name/other name, or every word is the meal's name
                                       # or options); else dishId null and pending:true. "" clears; out etc. kinds
POST   /api/planner/slots/:date/match   -> 200 { ok:true, matched, by?, entry|null, candidates }   # background,
                                       # after /text: code then AI over the household's meals; links at >= 0.7
                                       # if the words haven't changed
PUT    /api/planner/slots/:date/link { dishId|null, optionIds? } -> 200 { ok:true, entry }   # "did you mean" /
                                       # "not this"; keeps the words, note and status
GET    /api/planner/wants          -> 200 { ok:true, wants:[{ id, text, level, dishId|null, optionIds[], createdBy,
                                       createdAt, updatedAt, done }] }   # open lines, in the order typed
POST   /api/planner/wants { text, level?, dishId?, optionIds? } -> 201 { ok:true, want, pending }   # a want-to-make
                                       # line typed like a note (<= 500 chars; level 1–3, default 2): saved at once,
                                       # linked when code is sure (whole text, or the part before the first
                                       # comma/dash); else pending. With dishId it's for that meal and variation
                                       # (from the rating rows); one already open for it is returned, not doubled
PUT    /api/planner/wants/:id { text?, level?, dishId?|null, optionIds?, done? } -> 200 { ok:true, want, pending }
                                       # new words are matched again (old meal dropped unless sure); dishId alone
                                       # is "did you mean" / "not this"; done ticks it off
POST   /api/planner/wants/:id/match -> 200 { ok:true, matched, by?, want, candidates }   # background: code then
                                       # AI; links at >= 0.7 if the words haven't changed
DELETE /api/planner/wants/:id       -> 200 { ok:true, deleted }
POST   /api/planner/slots/move { from, to } -> 200 { ok:true, moved, swapped }   # drag and drop: onto an
                                       # empty night moves, onto a planned night swaps; the entries move
                                       # (options, note, review, freezer link kept)
POST   /api/planner/week/copy { from, to } -> 200 { ok:true, copied, week }   # into empty nights only
POST   /api/planner/parse-week { start, text, ai? } -> 200 { ok:true, items:[{ date, raw, typed, kind,
                                       dishId, optionIds[], confidence, candidates[], newName, by }] }
```
- **The week** is one `dinner` slot per date (unique per household + date +
  slot). Only dated entries show; imported history is undated. A meal night
  needs a `dishId` from the household; options must belong to it, one per
  axis. Setting a night resets its status to `planned`.
- **Review (M3)** — tables `reviews` (`plan_entry_id`, `rated_as`, `thumbs`,
  `stars`; one opinion per person per cook) and `freezer_items` (`dish_id`,
  `option_ids` JSON, `portions_left`, `frozen_on`, `source_entry_id` unique);
  `plan_entries` gains `freezer_item_id`, `freezer_consumed`, `cook_note`,
  `leftovers`, `frozen_portions`, `tweak_retry`, `reviewed_at`;
  `dish_ratings.source` is `estimate` (rated from memory) or `review`.
  ```
  GET  /api/planner/review?today=YYYY-MM-DD -> 200 { ok:true, entries:[entry + reviews[]] }
                                    # meal / freezer nights before today, last 14 days, still planned
  PUT  /api/planner/entries/:id { status?: cooked|skipped|planned, swapToDishId?, swapOptionIds?,
                                  cookNote?, leftovers?, frozenPortions?: 0..20, tweakRetry? } -> { entry }
  PUT  /api/planner/entries/:id/review { ratedAs, thumbs?, stars? } -> { entry }   # both null deletes
  GET  /api/planner/freezer        -> { items:[{ id, dishId, optionIds, portions, frozenOn, fromEntryId }] }
  POST /api/planner/freezer { dishId, optionIds?, portions: 1..20, frozenOn? } -> 201 { item }
  PUT  /api/planner/freezer/:id { portions: 0..50 } -> { item }
  PUT  /api/planner/slots/:date { kind:'freezer', freezerItemId }   # a night eating frozen stock
  ```
  Marking a freezer night cooked takes one portion off (once); skipping,
  undoing, replacing or clearing the night gives it back. `frozenPortions`
  creates or adjusts the stock for that cook. Swapping turns the night into
  what was made (status cooked, note "Planned: <old meal>", opinions cleared).
  An opinion also becomes the standing rating (`source` review) of the meal
  (no options), option (one axis) or combination (two axes), when the cook
  chose an option on every axis; otherwise standing ratings are untouched.
  Copying a week turns freezer nights into plain meal nights.
- **Photos, one-line review, suggestions (M3/M4)** — tables `planner_photos`
  (`dish_id`, `plan_entry_id`, `bytes`; files at `DATA_DIR/photos/<id>.jpg`,
  pulled with `scripts/hl backup pull`) and `suggestion_snoozes` (`dish_id`,
  `until`); `dishes.cover_photo_id`.
  ```
  POST   /api/planner/photos?dishId=&entryId=   body: the JPEG (image/jpeg, max 3 MB) -> 201 { photo }
                                    # 415 other types, 400 not a JPEG, 413 too large
  GET    /api/planner/photos/:id   -> the JPEG (household only; the app fetches it as a blob)
  DELETE /api/planner/photos/:id   -> { deleted }   # the cover falls back to the newest left
  POST   /api/planner/parse-review { today, text } -> { items:[{ entryId, status, stars, thumbs, note }], by }
                                    # 409 when nothing is waiting; proposes, saves nothing
  GET    /api/planner/history      -> { entries:[{ dishId, date }], importedWeeks }   # dated cooks
  PUT    /api/planner/meals/:id/snooze { today, days?: 0..365 (21) } -> { until|null }   # 0 clears
  PUT    /api/planner/meals/:id { regularEveryDays?: 3..120|null, coverPhotoId? }
  ```
  The meals payload adds `regularEveryDays`, `coverPhotoId`, `snoozedUntil`,
  `photos[]` (newest first) and `tipSuggestions[]` (a cook note written 2+
  times that the tips don't already contain). The first photo of a meal
  becomes its cover. The one-line review is read by code (clauses, meal-name
  words, opinion words; a comment right after a named meal is about it; only
  tips like "too much faff" become notes) and by AI when available (§7).
  Suggestions are ranked on the phone (mealplan `src/lib/suggest.ts`).
- **Shopping (M5)** — tables `shopping_lists` (one per household + week),
  `shopping_items` (`name`, `name_key` unique per list, `section`
  market|cold|ambient, `qty` text, `dish_ids` JSON, `checked`),
  `item_sections` (remembered per household; `source` guess|set) and
  `dish_usual_items` (what a meal needed last time).
  ```
  GET    /api/planner/shopping?week=YYYY-MM-DD -> { week, items[], nights:[{ entryId, date, dishId, optionIds }],
                                                    usual:{ <dishId>: [{ name, qty }] } }
  POST   /api/planner/shopping/items { week, name, qty?, dishId?, section? } -> 201 { item }
  PUT    /api/planner/shopping/items/:id { checked?, qty?, section? } -> { item }
  DELETE /api/planner/shopping/items/:id[?dishId=] -> { item|null }   # with dishId: only that meal's claim
  DELETE /api/planner/shopping/checked?week= -> { cleared }
  ```
  Nights to shop for are the week's meal nights (not out / leftovers /
  takeaway / freezer). The same item (normalised name) added for another meal
  is one line: the meal joins `dishIds` and amounts join as "2 + 1"; adding
  again unticks it. Items list in shop order Market → Cold → Ambient, ticked
  last. Section: one we set (remembered, `source` set) → a remembered guess →
  a word list (packaging and pantry words first, so "tinned tomatoes" is
  Ambient; fridge, freezer and fresh produce are Cold) → AI → Ambient. Market
  is never guessed. Adding an item for a meal saves it to that meal's usuals.
  `cli.js planner sections --email` (or `scripts/hl planner-sections EMAIL`)
  loads known sections from JSON on stdin.
- **Parse** saves nothing: it proposes nights for the client to confirm. Text
  splits on new lines, commas and semicolons; a leading day name pins an item
  to that day and the rest fill free nights in order; "out", "leftovers",
  "takeaway" are kinds and "-" / "nothing" leave the night empty. Code matches
  names and aliases first (picking out option words); only items below 0.85
  confidence go to AI (§7), which may pick an existing meal or a `newName`.
- **Ratings** are standing opinions of a meal, one of its options, or a
  combination of options from different axes (`optionId` = option ids joined
  with `+`, stored sorted, at most one per axis; 400 otherwise). The client
  rates a meal with no options as itself, a one-axis meal per option, and a
  two-axis meal per combination. A variation we haven't had but want to make
  goes on the want-to-make list (below); one we've never had and don't want
  is **hidden** for the household (its ratings are kept and return if it is
  put back), and a whole meal is removed with `archived` (history and ratings
  kept). The client counts a meal as rated when every visible variation is
  scored or on the want-to-make list. They are separate from per-cook reviews (M3). Either member may rate as `both`, as themselves,
  or as the other member. `cooked` counts `plan_entries` with kind `dish` and
  status `cooked`; undated imports count but leave `lastCooked` null.
- **Want to make** is one household list, the only "want to make" there is:
  lines are free words with how much we want them, and either member sees and
  edits all of them. "Haven't had it, want to make" on the rating rows adds a
  line for that meal and variation (keen). Marking a night cooked (or swapping to a meal)
  ticks off open lines for that meal; a line naming a variation is ticked
  only when what was cooked includes it. The client raises matched meals in
  Ideas by `level`.
- **Tags:** accepted `tags` and offered `suggestedTags`; the client shows a
  suggestion only while it isn't accepted. Re-imports refill suggestions only
  on a meal with no tags and no suggestions, so they never undo our choices.
- **Import and notes** are admin tasks (`server/cli.js planner import | notes |
  reply`, or `scripts/hl planner-import EMAIL < draft.json`, `planner-notes`,
  `planner-reply ID`). The import takes a backup first, matches meals by name
  or alias and history by import key, and never overwrites tags, effort or
  ratings. A reply to a note shows under it in the app.
- **Split** (`cli.js planner split --meal <name> [--family] [--rest]`, or
  `scripts/hl planner-split EMAIL "Meal" ["Rest name"]`) turns each option of
  a one-axis meal into its own meal named "<meal> <option>" in a family named
  after the meal. History cooked with that option, its ratings, and aliases
  containing the option's name move with it; the original keeps the rest and
  can be renamed. A backup is taken first.
- **Household resolution** runs at the start of every planner request
  (`server/lib/planner/household.js`): no household → one is created for the
  user and their linked partner; a linked partner's household → the user joins
  it; two different households → merged, the one with fewer dishes moving into
  the other. A household holds at most the two linked people: linking a new
  partner leaves the old household, whose data stays with the person left.
  Unlinking alone never splits a household.
- All planner reads and writes are scoped to the caller's household. A row from
  another household answers `404`, never `403`.

### Client diagnostics
```
POST /api/client-log { events:[ClientEvent] } -> 200 { ok:true, accepted }
```
When the device cannot reach the API the server never sees the attempt, so the
device keeps the record. `src/lib/clientLog.ts` queues events in
`localStorage` (key `healthlog.clientlog.v1`, newest 100) and `api.ts` uploads
up to 50 after the next successful request:
- `fetch-fail` — a request got no usable answer: `kind` `network` (no
  response; `error` carries the browser's message), `timeout`, or `http` (5xx),
  with `path`, `method`, `status`, `ms`.
- `recovered` — the first answer after failures: `firstFailAt`, `failures`,
  `outageMs`.
- `boot` — the app started (a reload, or iOS relaunching a killed tab).
- `error` — an uncaught error or non-API promise rejection.

Every event also carries `at`, `build` (the hashed bundle name) and device
context: `online`, `visible`, `standalone`, `net`, `sinceLoadMs`. Sign-in is
optional, so the login screen can report too. The server whitelists and clamps
every field, replaces ids in paths with `:id`, and writes one `[client]`
journal line per event (`scripts/hl client`); nothing goes in the database.
The upload itself is never logged as a failure. Rate limit: 30 uploads / 15 min
per IP (§5).

### Imports
```
POST /api/import/weight-json { json: <the old weight-tracker export as an object> }
    -> 200 { ok:true, imported:{entries,phases}, skipped:{entries,phases} }

POST /api/import/food-csv/preview { csv: "<raw csv text>" }
    -> 200 { ok:true, headers:[...], suggestedMapping:{ name:"name", kcal:"kcal", ... },
              rows:[{ line, raw, parsed:{name,kcal,proteinG,carbsG,fatG,serving} }],
              skipped:[{ line, reason }] }

POST /api/import/food-csv/commit { csv, mapping:{ name, kcal, protein, carbs, fat, serving, date? } }
    -> 200 { ok:true, imported:<n>, skipped:<n>, meals:[...] }
```

**Weight JSON import shape** — the old export
(`weight-tracker` `exportState()`), i.e.
`{ version, profile:{startWeightKg,goalWeightKg,heightCm,unit,chartWindowDays},
entries:[{date,weightKg,note?,createdAt,updatedAt}],
phases:[{id,name,startDate,endDate,color,createdAt}] }`.
Entries with an existing `(user_id, date)` are **updated**, not duplicated.
`profile` fields map onto the `profile` table.

**Food CSV import** — the shape is not decided yet, so the importer must be
**column-mapping based**, not format based:
- The preview endpoint sniffs the header row and proposes a mapping by matching
  header names against aliases:
  `name` ← name/food/meal/item/description; `kcal` ← kcal/calories/energy/cal;
  `protein` ← protein/protein_g/protein (g); `carbs` ← carbs/carbohydrate/carbs_g/carbohydrates;
  `fat` ← fat/fat_g; `serving` ← serving/portion/qty/quantity; `date` ← date/day/timestamp.
  A header like `protein (g)` must still map to `protein`.
- The user can override the mapping in the UI; the commit endpoint honours the
  supplied mapping.
- Rows missing a name or a non-numeric kcal are skipped with a reason.
- Each committed row becomes a **meal** (source `import`) on its date
  (default: today). If a `date` column exists and parses, use it.
- The CSV parser must handle quoted fields, embedded commas and CRLF. No
  dependency — write a small correct parser in `server/lib/csv.js`.

## 7. AI pipeline

**Provider:** OpenCode Go, OpenAI-compatible.
Base URL `https://opencode.ai/inference/go/openai/v1` (override with
`AI_BASE_URL`). Endpoint `POST {base}/chat/completions`.
Auth header `Authorization: Bearer $OPENCODE_API_KEY`.

**Required headers** (the gateway rejects requests without them):
```
x-opencode-session: <stable id per conversation, e.g. "healthlog-<uuid>">
user-agent: healthlog/1.0
```
Plus `content-type: application/json`.

**Models** (override with env):
```
AI_MODEL_A=claude-haiku-5-5
AI_MODEL_B=gemini-4-argon
AI_JUDGE_MODEL=minimax-m3.1-flash
```

**Fallback provider (Groq free tier).** If a call fails with HTTP 401/402/403/429
(key out of usage, rate limited, rejected), it is retried once on
`AI_FALLBACK_BASE_URL` (default `https://api.groq.com/openai/v1`) with its own
key. The fallback is only active when `GROQ_API_KEY` (or `AI_FALLBACK_API_KEY`)
is set. (OpenCode's own free models were tried and rejected: they return
`FreeUsageLimitError` to API callers.)
```
GROQ_API_KEY=                          # secret; env file only
AI_FALLBACK_MODEL_A=llama-3.3-70b-versatile
AI_FALLBACK_MODEL_B=llama-3.1-8b-instant
AI_FALLBACK_JUDGE_MODEL=llama-3.1-8b-instant
AI_FALLBACK=off        # optional: disable the fallback
```
The model actually used is what gets stored as `model_a` / `model_b`.

**Several meals in one message.** Models return `{ meals: [{ name, items, total }],
confidence, notes }`. Ingredients of one dish stay in one meal; drinks, shakes,
coffees, supplements, packaged products and anything with its own stated numbers
are separate meals. Numbers the user states are used exactly. Output without
`meals` (the older `{items,total}` shape) counts as one meal. Reconciliation: if
both models return the same number of meals they are paired by position and
reconciled one by one; if they split differently the model with more meals wins.
`reconciled` carries `meals` plus a flattened `items` / summed `total`.
`POST /api/chat` saves one `meals` row per group (all sharing the `analysis_id`)
and returns `meal` (the first) and `meals` (all).

**Flow for one chat message:**

1. Build the prompt: the user's raw message, today's logged intake (kcal and
   macros so far), the user's profile (weight, goal, kcal target) and the
   instruction to return strict JSON.
2. **Call model A and model B in parallel** (`Promise.allSettled`), each with
   `response_format: { type: "json_object" }`, `temperature: 0.2`,
   `max_tokens: 1200`, and a 25 s timeout (`AbortSignal.timeout(25000)`).
   Each is asked to return **only** this JSON shape:
   ```json
   { "items": [ { "name": "2 eggs", "quantity": "2 large", "kcal": 144,
                  "protein_g": 12.6, "carbs_g": 1.2, "fat_g": 9.6 } ],
     "total": { "kcal": 320, "protein_g": 18, "carbs_g": 30, "fat_g": 12 },
     "confidence": 0.7,
     "notes": "assumed scrambled eggs, no oil" }
   ```
3. **Normalise** each result: parse JSON (tolerate fenced code blocks), clamp
   negatives to 0, coerce to numbers, default missing totals by summing items.
   If a model fails or returns unparseable JSON, its output is
   `{ error: "..." }` and it is excluded from the reconciliation.
4. **Reconcile numerically**, in code, deterministically:
   - Both valid: if `|kcalA - kcalB| / max(kcalA, kcalB) <= 0.15` → take the
     **mean** of the two totals (and of each macro). Otherwise take the value
     from the model with higher `confidence` (tie → the one closer to the
     median of the two, i.e. the more conservative).
   - One valid → use it.
   - Neither valid → the assistant replies with a plain-text apology and no
     meal is saved; `analyses.error` records why.
   - `agreement` = `high` (≤10% delta), `medium` (≤25%), else `low`.
   - `deltaPct` = `|kcalA - kcalB| / max(kcalA, kcalB) * 100`.
   - Items for the reconciled meal: use the items from the **chosen** model,
     scaled so their totals match the reconciled totals.
5. **Compare the notes**: call the **judge model** with both model outputs and
   the numeric reconciliation, asking for a short comparison: what they agree
   on, where they differ, what assumption is most likely wrong, and the final
   verdict. Return **plain text**, max ~120 words. If the judge call fails or
   times out, fall back to a **deterministic** comparison string built in code
   (e.g. "Model A: 320 kcal (confidence 0.7). Model B: 410 kcal (confidence 0.5).
   22% apart — using Model A."). The fallback must never leave the user without
   a reply.
6. Store one `analyses` row with `result_a`, `result_b`, `reconciled`,
   `comparison`, `prompt_text`, and the three model ids.
7. The assistant chat message contains: the reconciled kcal/macros, the
   comparison note, and the assumption notes from the chosen model. The client
   renders a two-column "Model A / Model B" card from `analysis`.
8. After the reply has been sent, the **model benchmark** runs in the
   background (below). It never changes the reply, the analysis or the meal.

**Model benchmark.** To measure whether models A and B are accurate enough,
every new food message (not corrections) is also sent, with the identical
prompt, to a panel of extra models:
```
AI_BENCH_MODELS=qwen3.8-max,kimi-k3,gpt-5.6-luna,deepseek-v4.1-flash,glm-5.3-flash   # default
AI_BENCH_MODELS=off    # disable
```
- Each estimate — A and B too, with their latency — is one `model_runs` row.
  Failures are recorded with their error, not dropped.
- The panel never uses the fallback provider (a fallback answer would be a
  different model under the same name), runs at most 2 batches at once, and
  pauses for an hour after any 402/429 so it cannot spend the quota A and B
  need. Expect roughly 3.5× the AI usage per logged meal while it is on.
- Scoring has two yardsticks, because there is no measured truth:
  **corrected** — the user changed the numbers (a chat correction chain ending
  in a saved meal, or a saved meal whose total differs from the proposal by
  more than max(10 kcal, 3%)); the saved total is the reference. **consensus**
  — each model against the median of the *other* models (leave-one-out, needs
  ≥3 valid estimates). Consensus measures agreement, not truth; a correction
  outranks it.
- Every gap is reported in both **kcal and %** (`devKcal`/`devPct`,
  `looDevKcal`/`looDevPct`, `refDevKcal`/`refDevPct`; per model
  `medianAbsKcal`, `biasKcal`, `totalKcal` — the signed sum over all meals).
  % overstates small items (50% of a 50 kcal coffee is 25 kcal), so the client
  defaults to kcal.
- A meal "differed" when the panel's spread (max − min) exceeds 20% of the
  panel median **and** 100 kcal.
- "Logged value" (A and B reconciled) is still returned in `models`, but the
  client does not rank it: it is not an independent estimate.
- The client shows this at `#/models` (linked from Insights and Settings).
- **Backfill:** `cli.js bench backfill` (`scripts/hl bench-backfill`) asks the
  panel about earlier original analyses, using each one's stored `prompt_text`.
  Only missing answers are requested (`--retry-failed` also re-asks failures),
  one meal at a time with a 1 s pause, runs stamped with the analysis's own
  `created_at`. It takes a backup first, stops at the first 402/429 and resumes
  where it stopped. It refuses to run without a real AI key unless `--mock`.
  A and B are never re-asked: their stored outputs are what was logged.

**Cost control:** the judge call only happens when the two models disagree by
more than 15%; otherwise the deterministic comparison is enough. (The client
must still show the `comparison` string in both cases.)

**Never** let the AI key reach the frontend. It lives only in the server
environment (`OPENCODE_API_KEY`), never in the repo, never in a GitHub variable
that the frontend can read.

### Planner AI tasks

The meal planner's AI tasks (matching typed meals, parsing reviews, suggesting
tags, guessing shopping sections) use `askJson()` in `server/ai.js`: **one**
model (`AI_PLANNER_MODEL`, default model A) with the same Groq fallback, strict
JSON out, never throws. Each task supplies its own mock for `AI_MOCK` runs and
has a non-AI fallback, and every AI result is confirmed by the user before it
is saved.

## 8. Frontend contract

> **Framework decision (2026-10-31): the frontend is plain Svelte 5 + Vite.**
> It started as Vite + TypeScript with a hand-rolled DOM layer and was migrated
> to Svelte components with runes. SvelteKit was considered and rejected: the
> app is a client-side SPA on a GitHub Pages *project* site, and SvelteKit
> brings SSR/prerender/base-path/`404.html` concerns that plain Svelte does
> not. What this section means from here on:
>
> - **Plain Svelte 5 (runes), not SvelteKit.** No SSR, no adapter, no
>   prerendering, no `svelte.config.js` route config. `vite.config.ts` keeps
>   `base: './'` so the build works under any sub-path.
> - **Routing is hash-based** (`#/chat`, `#/dashboard`, …), not path-based —
>   a refresh or a shared link must never 404 on Pages.
> - **Output stays `dist/`**, so `.github/workflows/pages.yml` keeps publishing
>   `dist/` and injecting `dist/api-config.js`. No workflow change is needed.
> - The framework-agnostic TypeScript modules (`api.ts`, `auth.ts`, `types.ts`,
>   `format.ts`) stay as they are; only the UI layer is Svelte.
> - Shared state lives in a runes-aware module (`*.svelte.ts`) using `$state`,
>   not in the old subscribe/notify store.

- **Svelte 5 + TypeScript + Vite.** Chart.js is the only runtime dependency
  (plus `date-fns` if needed).
- Port the visual language from the old app: `src/design/tokens.css`
  (`--color-bg #f3f5f1`, `--color-accent #146c5a`, dark `#101613`/`#7bd8bb`,
  16px radius cards, tabular figures) and `src/ui/components.ts`
  (`el()`, `Sheet`, `StatTile`, `SegmentedControl`, `BigNumberInput`, `Toast`).
  In Svelte these become components; the CSS tokens are imported globally and
  stay unscoped.
- **Mobile-first**, and good on desktop: bottom tab bar on narrow screens,
  a sidebar/rail on wide screens. Same as the old app's shell, extended.
- **Tabs:** Chat (default) · Dashboard · Calories · Lifting · Insights · Settings
  on the mobile bottom bar (six at most). The desktop side rail also lists Foods,
  History and Activity; on a phone Foods and History are reached from the
  Calories view (History also from the Dashboard).
- **Lifting view** (`#/lifting`, sub-pages `#/lifting/log/<workoutId>`,
  `#/lifting/exercise/<exerciseId>`, `#/lifting/history`, `#/lifting/routine/<id|new>`, `#/lifting/analysis`),
  built for one hand in the gym: start a routine (its exercises planned in order) or
  an empty workout, resume one, edit routines (order, stand-ins), repeat a recent session, this week's days /
  sets / volume, a lighter-week suggestion when several lifts stall at once,
  every lift with its e1RM, sparkline, status and next target,
  weekly (fractional) sets per muscle. The logger: an exercise card per lift with last
  time, a one-tap swap to a routine stand-in before any set is logged
  (also in the card menu), the suggested plan with a "Why?" disclosure, a mid-session adjustment
  note, and each set compared with the same set last time;
  an entry pad with large −/+ steppers (hold to repeat, tap to type), warm-up /
  drop / failure and RPE chips, and one large "Log set" button prefilled for the
  next set; a toast on a record; a rest timer above the tab bar (vibrates and
  beeps, default 1–4 min); the screen kept awake (Wake Lock) during a live
  session; a save status (saved / saved on phone / not saved). The exercise page:
  records, status, trend (rate with range, noise, change point, projection,
  × bodyweight), next plan with its reasoning (and a one-tap rep-range switch
  when suggested), e1RM per session with the all-time best as a
  step line, volume per session, best weight for 1/3/5/8/10/12+ reps, sessions.
  The analysis page (linked from Lifting home) shows the Analysis numbers as
  tiles, a strength-index line, a trend row per lift, a forest plot of factors,
  rest-bucket bars, sessions per week, a training calendar, routine completion, a
  muscle × week heatmap (a table), rep-zone and balance bars and records.
  Insights gains a **Strength** block (sessions, hard sets per week, volume,
  records, main lifts, weekly sets per muscle) after Training.
- **Insights view** (`#/insights`): Garmin analysis over a 30D / 90D / 6M / 1Y /
  All range — a recovery hero (score ring, its parts, four vitals vs the 30-day
  norm with sparklines), findings, fitness (VO₂ max, race predictions, training
  status strip), sleep (stages per night, or weekly averages past 120 days;
  share of stages; by night of the week; sleep window), resting HR with a norm
  band, Body Battery range, stress, training (weekly hours by sport, calendar,
  HR zones, totals table), energy in vs out when meals are logged, personal
  records, and the export import. Sports group as Run, Ride, Swim, Strength,
  Tennis, Hike & walk, Pilates & yoga, and Cardio & other (each a fixed colour).
  Ranges under 45 days chart training per day, longer ones per week; Body
  Battery is daily up to 120 days, weekly averages beyond; energy balance is
  daily diverging bars up to 31 days, weekly beyond. The training calendar
  shades by quantile of your own active days, so a short session never looks
  like a rest day. Personal records show only the ones picked in a sheet
  (default 5K, 10K, half marathon; saved in `localStorage`). Findings sit after
  Training. A card links to **Advanced insights** (`#/advanced`, no tab of its
  own; the Insights tab stays highlighted), built by `src/lib/advanced.ts` from
  the same payload: sport deep dive (volume per month, speed at a fixed heart
  rate, zones, weekday / hour pattern, bests), running pace normalised to one
  heart rate by a regression across all runs — the **pace vs heart rate lab**
  (`src/lib/paceHr.ts`): reference HR 130-170 or LTHR, distance and treadmill
  filters, drag-to-zoom trend with breaks (14+ days, lone runs folded in)
  shaded, auto training blocks (split at 21+ days) as zoom presets, a
  pace-vs-HR scatter with fitted lines for the earlier and later half of the
  window, pace at every 5 bpm, and per break the 45-day pre-break pace, first
  runs back and time to return within 1% — acute:chronic load (7-day sum vs
  28-day sum / 4, sweet spot 0.8-1.3), fitness / fatigue / form (42- and 7-day
  EWMA of activity load), race-prediction progression with the training done in
  its biggest 28-day moves, recovery after the top-quartile sessions, sleep need
  (median night when waking with Body Battery 90+), 14-night debt, bedtime
  consistency, sleep-score correlations, weekday heatmap, month table, calories
  vs the scale, protein, stress fingerprint, 90-day baselines and record days.
  Charts are hand-drawn SVG (`src/lib/viz/`):
  hover and arrow-key reading (ARIA slider with value text), a legend for every
  multi-series chart, palette validated for colour-vision deficiency.
- **Login screen** when there is no token: email, password, and an "I have an
  invite code" toggle for registration.
- **Chat view**: message list (user bubbles right / assistant left), an input
  bar fixed to the bottom with a send button, a "thinking" state while the AI
  works, and an assistant message that shows:
  - the reconciled kcal + macro ring/bars,
  - a **Model A / Model B** side-by-side card (each model's kcal, confidence,
    notes) and the agreement badge,
  - buttons: **Save meal** (if not already saved), **Edit**, **Ask again**;
    once saved and with a linked partner, **Share with <name>** (then
    "Shared with <name>" / "<name> logged it too").
  - Suggested quick-phrases when the chat is empty.
  - **Shared meals** (partner sharing, §6): a one-line notification under the
    header — "<name> shared <meal>" — with **Review**, which opens a sheet of
    the pending offers. Each offer shows kcal and macros at a chosen portion
    (½, ¾, Same, 1¼, 1½ of the partner's), and **Add to my log**, **Correct**
    (the meal-edit sheet prefilled at that portion; saving adds it) and
    **Not for me**. The inbox is fetched when the app opens and again whenever
    it returns to the foreground.
- **Dashboard view**: the old trend chart (smoothed trend weight + raw dots +
  phase shading; the trend replaced the old 7-day average, which collapses to
  the single weigh-in in a sparse week) plus a calorie panel for today (kcal vs target, macro split) and a
  7-day intake bar chart. Pending shared meals appear as full cards under the
  header (same actions as in the chat).
- **Weight view** (`#/weight`, side rail; "Details" on the Dashboard weight
  card): built client-side from `GET /api/weights` (`src/lib/weightTrend.ts`),
  no extra endpoint. **Trend weight** = exponential moving average (α 0.1) over
  a daily axis from the first weigh-in, gaps linearly interpolated, held flat
  after the last weigh-in, seeded with the first week's mean. **Pace** =
  least-squares slope through the raw weigh-ins in the last 28 days (also 14
  and 90), null under 3 weigh-ins or a 7-day span; shown per week, per month
  (× 30.44/7) and as ≈ kcal/day at 7700 kcal/kg. Shows: trend chart over
  30d / 90d / 6mo / 1y / All with weigh-in dots and a goal line; trend change
  over 7 / 30 / 90 days and since the first weigh-in; goal date at the 4-week
  pace (beyond 2 years: "2y+"); lowest / highest in range; daily noise (mean
  |weigh-in − trend| less the window's mean gap); weigh-ins in 30 days;
  **weekly** (Monday-start) and **monthly** change bars + tables — change = trend
  at the period's end (or today) minus trend at the previous period's end,
  none after the last weigh-in; and a day-of-week pattern (mean weigh-in − trend
  per weekday over 120 days, minus the overall mean). The Dashboard's trend
  tile and weekly pace use the same maths; the API's `avg7d` / `weeklyRateKg`
  are unchanged.
- **Calories view** (`#/calories`): a day in detail (kcal vs target with a
  progress bar, each macro against its gram target, that day's meals) — today
  by default, with previous / next / date-picker controls to step back to any
  earlier day (totals summed from that day's meals, against the current
  targets) — and the
  intake history over a 7d / 30d / 90d / 1y / All range — a swipeable carousel
  of four charts (Calories, Protein, Carbs, Fat), each with daily bars, a 7-day
  average line and that metric's target, then summary tiles (average intake, vs target,
  days logged, days on target within ±10 %, net balance vs target with a
  ≈ kg estimate at 7700 kcal/kg, macro averages, weekday vs weekend,
  highest / lowest day, logging streak) and a Monday-start week-by-week table.
  Averages use completed days with meals only: zero-filled gaps and today (in
  progress) are excluded. Data comes from `GET /api/dashboard?days=N`'s
  `intake` / `intakeHistory`; no extra endpoint.
- **Foods view**: saved foods list, a "Foods you've eaten" list (logged meals
  grouped by name, most-eaten first, each with one-tap **Save** to the library
  using its most recent nutrition; built from `GET /api/meals` without `day`),
  add-food sheet, and the CSV import flow
  (paste or file → preview table with column mapping → commit).
- **Settings view**: profile (height, start/goal weight, sex, age, activity,
  macro split), chart range, **Partner sharing** (partner's email; Waiting /
  Linked, Check again, Change, Remove), **import old weight JSON**, export
  data, sign out. History meal cards get a **Share** action with a linked
  partner; Calories and History label accepted meals "Shared by partner".
- Accessibility commitments from the old app **must not regress**: accessible
  names on every control, ≥44px touch targets, visible focus rings, focus trap
  in sheets, Escape closes, WCAG AA contrast in light and dark,
  `prefers-reduced-motion`, colour never the only signal.
- Dates: local-calendar `YYYY-MM-DD` strings, never `Date` objects, for
  day-keyed data. Epoch ms for created/updated timestamps.
- Weights are kilograms, fixed.
- `src/lib/api.ts` is the only place that calls `fetch`. It reads the base URL
  from `window.APP_API_BASE` (fallback: same origin), attaches the bearer
  token from `src/lib/auth.ts`, and turns non-2xx into typed errors. It also
  feeds `src/lib/clientLog.ts` (failed requests, recoveries) and uploads its
  queue (§6 "Client diagnostics").
- `src/lib/store.ts` holds app state in memory and notifies subscribers —
  the old `appStore.ts` pattern, but the persistence is the API, not
  `localStorage`. Only the auth token (and the client diagnostics queue) is in
  `localStorage`.

## 9. Build and deploy

**Frontend build:** `npm run build` → `dist/`. The Pages workflow publishes
`dist/`, **not** `public/`. Therefore the static files that must ship
unprocessed (`api-config.js`, `manifest.webmanifest`, `sw.js`, icons) live in
`public/` and are copied into `dist/` by Vite automatically. `api-config.js` is
injected by the workflow **after** the build:

```yaml
- name: Build
  run: npm ci && npm run build
- name: Prepare static site
  run: |
    printf 'window.APP_API_BASE = "%s";\n' '${{ vars.API_BASE_URL }}' > dist/api-config.js
```

**Backend deploy** follows the playbook exactly:
- code at `/opt/healthlog`, data at `/var/lib/healthlog`, service unit
  `healthlog.service`, Caddy site `healthlog.<ip>.sslip.io` → `127.0.0.1:8787`.
- The deploy script does `git fetch` + fast-forward, `npm ci --omit=dev` only if
  `package.json` changed, writes the commit SHA to `/var/lib/healthlog/commit.txt`,
  restarts the service, health-checks `http://127.0.0.1:8787/api/health` for
  15 s, and **rolls back** (`git reset --hard <prev>` + restart) on failure.
- Compare commits with `git rev-parse`, not `git diff --quiet`.
- The workflow re-checks the public API URL after the SSH step and fails the
  build if it is unhealthy.
- The Pages and deploy workflows are triggered by pushes to `main`; the deploy
  workflow's `paths:` filter must include `server/**`, `deploy/**` and `sync/**`.
- Garmin's Python venv is installed by `deploy/garmin-setup.sh` (bootstrap
  runs it; re-run by hand after bumping `sync/requirements.txt`). It lives in
  `/opt/healthlog-garmin`, outside the checkout, so deploys never touch it.

**Environment variables on the server** (systemd `EnvironmentFile`,
`/etc/healthlog/healthlog.env`, mode 0600):
```
PORT=8787
HOST=127.0.0.1
DATA_DIR=/var/lib/healthlog
COMMIT_FILE=/var/lib/healthlog/commit.txt
OPENCODE_API_KEY=<the user's fresh key>
AI_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_MODEL_A=claude-haiku-5-5
AI_MODEL_B=gemini-4-argon
AI_JUDGE_MODEL=minimax-m3.1-flash
```
Local development uses `.env` (git-ignored) or plain env vars.

## 10. Definition of done

- [ ] `npm run build` passes: `svelte-check` clean (Svelte 5 components) and
      `tsc` strict + `verbatimModuleSyntax` + `noUnusedLocals` for the
      framework-agnostic `.ts` modules.
- [ ] `node server/index.js` boots on an empty database, creating the schema.
- [ ] `qa/api-test.mjs` exercises register → login → profile → weight → phase →
      meal → chat (with a **mocked** AI client, no network) → import, and passes.
- [ ] The old weight-tracker JSON import produces the same entries and phases.
- [ ] The chat flow works with a real key: two model outputs, a comparison, a
      saved meal, and the day total updated.
- [ ] The UI works on a 390px phone viewport and on a 1440px desktop viewport,
      with no horizontal overflow and no console errors.
- [ ] Deploys to the VPS via CI, `GET /api/health` returns the live commit, and
      the rollback path has been tested with a deliberately broken commit.
