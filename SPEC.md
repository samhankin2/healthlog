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
  the `Origin` header. `OPTIONS` returns `204` without running the endpoint.
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
  source     TEXT NOT NULL DEFAULT 'ai',   -- 'ai' | 'manual' | 'import' | 'saved_food'
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
upsert), and `integrations` (per user + provider: status, last attempt /
success, last error, `backoff_until`). Exact DDL lives in `server/db.js`.

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

## 6. API contract

Base path `/api`. Every response is JSON. Success responses carry
`{ "ok": true, ... }`; failures carry `{ "ok": false, "error": "human message" }`.
Status codes: `400` bad input, `401` not signed in / bad credentials,
`404` not found, `409` conflict (duplicate email, used invite), `500` server error.

### Health
```
GET /api/health -> 200 { ok:true, service:"healthlog", commit:"<sha>", users:<n>, meals:<n> }
```

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
POST   /api/meals { eatenAt?, day?, name, description?, kcal, proteinG, carbsG, fatG, items?[] }
                                               -> 201 { ok:true, meal:{...} }
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

### Garmin

```
GET  /api/garmin               -> 200 { ok:true, garmin:{ available, connected, status, syncing,
                                      lastAttemptAt, lastSuccessAt, lastError, backoffUntil, syncHour } }
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
- Scheduled sync: at most **one attempt per user per day**, after
  `GARMIN_SYNC_HOUR` (default 6, server local time), successful or not.
  `needs_login` is not retried until the token file changes.
- `rate_limited` sets `backoff_until` (`GARMIN_BACKOFF_HOURS`, default 6);
  every sync, manual included, is refused until then.
- The first strategies in garminconnect's login chain usually fail; those
  are warnings in the journal, not errors.
- Range: the first sync backfills 30 days, later syncs re-fetch the last 7
  (so yesterday's final numbers replace its partial ones). Max 120.

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

**Cost control:** the judge call only happens when the two models disagree by
more than 15%; otherwise the deterministic comparison is enough. (The client
must still show the `comparison` string in both cases.)

**Never** let the AI key reach the frontend. It lives only in the server
environment (`OPENCODE_API_KEY`), never in the repo, never in a GitHub variable
that the frontend can read.

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
- **Tabs:** Chat (default) · Dashboard · Calories · Foods · Settings. The
  desktop side rail also lists History (between Foods and Settings); the mobile
  bottom bar keeps five tabs and reaches History from the Dashboard and Calories views.
- **Login screen** when there is no token: email, password, and an "I have an
  invite code" toggle for registration.
- **Chat view**: message list (user bubbles right / assistant left), an input
  bar fixed to the bottom with a send button, a "thinking" state while the AI
  works, and an assistant message that shows:
  - the reconciled kcal + macro ring/bars,
  - a **Model A / Model B** side-by-side card (each model's kcal, confidence,
    notes) and the agreement badge,
  - buttons: **Save meal** (if not already saved), **Edit**, **Ask again**.
  - Suggested quick-phrases when the chat is empty.
- **Dashboard view**: the old trend chart (7-day average + raw dots + phase
  shading) plus a calorie panel for today (kcal vs target, macro split) and a
  7-day intake bar chart.
- **Calories view** (`#/calories`): today in detail (kcal vs target with a
  progress bar, each macro against its gram target, today's meals) and the
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
  macro split), chart range, **import old weight JSON**, export data, sign out.
- Accessibility commitments from the old app **must not regress**: accessible
  names on every control, ≥44px touch targets, visible focus rings, focus trap
  in sheets, Escape closes, WCAG AA contrast in light and dark,
  `prefers-reduced-motion`, colour never the only signal.
- Dates: local-calendar `YYYY-MM-DD` strings, never `Date` objects, for
  day-keyed data. Epoch ms for created/updated timestamps.
- Weights are kilograms, fixed.
- `src/lib/api.ts` is the only place that calls `fetch`. It reads the base URL
  from `window.APP_API_BASE` (fallback: same origin), attaches the bearer
  token from `src/lib/auth.ts`, and turns non-2xx into typed errors.
- `src/lib/store.ts` holds app state in memory and notifies subscribers —
  the old `appStore.ts` pattern, but the persistence is the API, not
  `localStorage`. Only the auth token is in `localStorage`.

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
