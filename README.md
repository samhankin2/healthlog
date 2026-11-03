# HealthLog

A personal weight **and** calorie tracker. It replaces a localStorage-only weight
tracker with a real app: an API, a SQLite database, accounts with invite codes,
and an AI food log where you describe what you ate in plain language and two
independent models estimate the calories and macros — then get compared.

Frontend: GitHub Pages. API + data: one small Node process on a free Oracle
Cloud VM, SQLite on disk, Caddy for TLS.

---

## What it does

**Weight tracking**
- Log one weight per day, with a note. Editable, deletable.
- Trend chart: raw points plus a 7-day average, with phase shading (cut, bulk,
  maintenance…) so you can see what you were doing when.
- Metrics: current weight, 7-day average, total change, weekly rate, streaks,
  BMI, daily swing, goal progress.
- Import the old weight-tracker JSON export (entries and phases, upserted).

**Calorie and macro tracking**
- Chat first: "two eggs on toast and a coffee with milk" → an estimated meal.
- **Two models run in parallel** (`AI_MODEL_A`, `AI_MODEL_B`) and the app shows
  them side by side — each model's calories, macros, confidence and assumptions.
- **Deterministic reconciliation in code** (no third model guessing): if the two
  agree within 15% take the mean, otherwise take the more confident one. An
  agreement badge (`high`/`medium`/`low`) and the percentage delta are shown.
- A short written comparison of the two estimates — from a judge model when they
  disagree meaningfully, otherwise generated in code so it always exists.
- Save the meal, edit it, or ask again. Day totals and targets on the dashboard,
  a 7-day intake bar chart, saved foods, and CSV import with column mapping.

**Garmin insights** (`#/insights`)
- Import a **Garmin Connect data export** (Account → Export your data → the ZIP).
  The ZIP is unpacked and normalised **in the browser**; only daily numbers go to
  the server — no GPS tracks, no FIT files, no profile. Safe to repeat.
- The scheduled Garmin sync keeps it current: steps and calories plus stress,
  Body Battery, SpO₂, respiration, HRV, sleep stages and score, and a daily
  VO₂ max / race-prediction / training-status snapshot.
- A recovery score for the morning (sleep score, Body Battery at wake, resting HR
  and HRV against your own 30-day norm), fitness (VO₂ max, race predictions,
  training status, fitness age), sleep (stages, timing, consistency, weekday
  pattern), resting HR with a norm band, Body Battery and stress, weekly training
  by sport, a training calendar, HR zones, personal records, and energy in vs out
  when meals are logged.
- **Findings**: comparisons tested on your own days (bedtime vs sleep score,
  hard days vs deep sleep and next-morning RHR, calm vs tense days vs Body Battery,
  and more). One appears only with at least 8 days per side and a real effect
  (|Cohen's d| ≥ 0.3).

---

## Repository layout

```
index.html            Vite entry
src/                  frontend — Svelte 5 components, TypeScript, Chart.js
  lib/                api client, state module, shared components, charts
  views/              Login, Chat, Dashboard, Foods, Settings, History
  design/             the design system (tokens.css + ui.css, global CSS)
server/               API — Node 24, zero runtime dependencies, node:sqlite
public/               static files Vite copies into dist/ (api-config.js, icons, sw)
deploy/               VPS bootstrap, systemd unit, Caddyfile, deploy script
.github/workflows/    pages.yml (frontend) and deploy.yml (API)
qa/                   verification scripts
```

The frontend is **plain Svelte 5** — no SvelteKit, no SSR, no router library.
Routing is hash-based (`#/dashboard`) because GitHub Pages has no rewrites: a
path-based route would 404 on refresh. The build output is still `dist/`, so the
Pages workflow is unchanged.

The database never lives in the repo. On the server it is
`/var/lib/healthlog/healthlog.db`, outside the code directory, so a deploy or a
rollback can never touch it.

---

## Local development

Requires Node 24 (the server uses `node:sqlite`, which is built in).

```bash
npm install                 # frontend dependencies only
npm run build               # svelte-check + vite -> dist/
node server/index.js        # API + the built frontend on http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>. The API and the site are the same origin there, so
`window.APP_API_BASE` stays empty and no configuration is needed.

For frontend work with hot reload:

```bash
npm run dev                 # Vite dev server on :5173
```

That is a different origin from the API on :8787, so the Vite dev server proxies
`/api` to `http://127.0.0.1:8787` (see `vite.config.ts`). Point it elsewhere
with `VITE_DEV_API=https://healthlog.152.69.178.242.sslip.io npm run dev`. Do not
"fix" it by editing `public/api-config.js` — that file is rewritten by the Pages
workflow and must keep its empty default.

Create a first account locally: registration needs an invite code.

```bash
node server/cli.js invite create --note "local"
```

---

## Environment variables

Server-side only, read from `/etc/healthlog/healthlog.env` on the VPS (mode
0600, `EnvironmentFile=` in the systemd unit) or from `.env` / plain environment
variables locally. `.env` is git-ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | API listen port. Caddy proxies to `127.0.0.1:$PORT`. |
| `HOST` | `127.0.0.1` | Bind address. Never `0.0.0.0` — Caddy is the only public door. |
| `DATA_DIR` | `/var/lib/healthlog` | Where `healthlog.db` lives. |
| `COMMIT_FILE` | `$DATA_DIR/commit.txt` | Written by the deploy script; `GET /api/health` reports it. |
| `OPENCODE_API_KEY` | — | **Secret.** The AI key. Server-side only. |
| `AI_BASE_URL` | `https://opencode.ai/inference/go/openai/v1` | OpenAI-compatible endpoint. |
| `AI_MODEL_A` | `claude-haiku-5-5` | First estimator. |
| `AI_MODEL_B` | `gemini-4-argon` | Second estimator. |
| `AI_JUDGE_MODEL` | `minimax-m3.1-flash` | Writes the comparison when the two disagree. |
| `GROQ_API_KEY` | — | **Secret.** Free Groq key; enables the fallback retry on 401/402/403/429. |
| `AI_FALLBACK` | on | Set `off` to disable the fallback. |
| `AI_FALLBACK_BASE_URL` | `https://api.groq.com/openai/v1` | Fallback endpoint. |
| `AI_FALLBACK_MODEL_A` / `_B` | `llama-3.3-70b-versatile` / `llama-3.1-8b-instant` | Fallback replacements for A / B. |
| `AI_FALLBACK_JUDGE_MODEL` | `llama-3.1-8b-instant` | Fallback replacement for the judge. |
| `BACKUPS` | on | Set `off` to stop the server's daily snapshots. |
| `BACKUP_INTERVAL_HOURS` | `24` | Minimum age of the newest snapshot before another is taken. |
| `BACKUP_KEEP` | `14` | Snapshots kept in `$DATA_DIR/backups`. |
| `ACCESS_LOG` | on | Set `off` to stop the one-line-per-request journal log. |
| `GARMIN` | on | Set `off` to disable Garmin sync. |
| `GARMIN_PYTHON` | `/opt/healthlog-garmin/venv/bin/python` | Python that runs `sync/garmin_sync.py`. |
| `GARMIN_SYNC_HOUR` | `6` | Local hour scheduled syncs start each day (none overnight). |
| `GARMIN_SYNC_INTERVAL_HOURS` | `3` | Hours between scheduled syncs (minimum 1). Each fetches only unfinished days. |
| `GARMIN_BACKOFF_HOURS` | `6` | Pause after Garmin answers 429. |

The AI key is never in the repo, never in a GitHub variable the frontend can
read, and never sent to the browser.

---

## Deploying

Two independent pipelines on every push to `main`:

- **`pages.yml`** builds the frontend and publishes `dist/` to GitHub Pages.
- **`deploy.yml`** SSHes to the VPS, runs `/usr/local/bin/healthlog-deploy`
  (fast-forward + restart + health check + rollback), then re-checks the public
  API URL and fails the build if it is unhealthy.

They are separate so a CSS change does not restart the API and a server change
does not republish the site.

### 1. Create the repository

Push this project to GitHub as `healthlog`. `main` is the deploy branch.

### 2. Enable GitHub Pages

Settings → Pages → **Source: GitHub Actions**. With the API:

```http
POST /repos/{owner}/healthlog/pages   {"build_type": "workflow"}
```

### 3. Set the repository variable `API_BASE_URL`

Settings → Secrets and variables → Actions → **Variables** → `API_BASE_URL` =
`https://healthlog.<vps-ip>.sslip.io` (no trailing slash).

The Pages workflow writes this into `dist/api-config.js` after the build. Change
the API address here and nowhere else.

### 4. Provision the VPS

A fresh Ubuntu 24.04 Oracle Cloud instance with ports 22/80/443 open in the
security list attached to the public subnet.

```bash
# from this repo, on your machine
DEPLOY_HOST=<vps-ip> ./deploy/install-vps.sh
```

That SSHes in as `ubuntu`, copies `deploy/` to `/tmp/healthlog-deploy` and runs
`bootstrap.sh` there as root, which:

1. installs Node 24 (NodeSource) and Caddy;
2. ensures the `ubuntu` user, `/opt/healthlog` (code) and `/var/lib/healthlog`
   (data);
3. creates `/etc/healthlog/healthlog.env` with mode 0600 and an **empty**
   `OPENCODE_API_KEY`;
4. clones the repo into `/opt/healthlog`;
5. installs the `healthlog` systemd unit and `/usr/local/bin/healthlog-deploy`;
6. points Caddy at `healthlog.<ip>.sslip.io` and obtains a Let's Encrypt
   certificate (no DNS setup, no cost);
7. fixes Oracle's image-level iptables `REJECT` rule for 80/443 and persists it
   — `ufw allow 80` alone does **not** work on these images.

It is safe to re-run. Re-running with `--skip-apt` is faster once the packages
are in place. It never overwrites the env file and never touches the database.

Then, by hand on the box:

```bash
sudoedit /etc/healthlog/healthlog.env    # OPENCODE_API_KEY=<your key>
sudo systemctl restart healthlog
curl https://healthlog.<vps-ip>.sslip.io/api/health
```

### 5. Create the CI deploy key

```bash
ssh-keygen -t ed25519 -C "healthlog-ci" -f ~/.ssh/healthlog_ci -N ""
ssh-copy-id -i ~/.ssh/healthlog_ci.pub ubuntu@<vps-ip>
```

Add the **private** key (`~/.ssh/healthlog_ci`) as the repository secret
`DEPLOY_SSH_KEY`, and the VPS IP as the repository variable `DEPLOY_HOST`.

Via the API, secrets are sealed with libsodium (`SealedBox`, not
`public_key.encrypt`) against the repo public key, then
`PUT /repos/{owner}/healthlog/actions/secrets/DEPLOY_SSH_KEY` with
`{ encrypted_value, key_id }`. Variables are plain JSON on
`/actions/variables`.

### 6. Install the deploy script once, by hand

`bootstrap.sh` already does this, but the rule matters for later edits to the
script: **the run that introduces a change to `healthlog-deploy.sh` cannot
refresh the copy it is executing.** The script copies its own repository version
over `/usr/local/bin/healthlog-deploy` at the end of every *successful* deploy,
so after the first install it keeps itself up to date. Only the very first
install needs hands:

```bash
scp deploy/healthlog-deploy.sh ubuntu@<vps-ip>:/tmp/
ssh ubuntu@<vps-ip> 'sudo install -m 0755 -o root -g root /tmp/healthlog-deploy.sh /usr/local/bin/healthlog-deploy'
```

(If a change to the deploy logic itself must take effect on the very next run,
install it the same way rather than trusting the self-refresh.)

### 7. Test the rollback — do not skip this

An unexercised rollback is a rumour. Prove it works before you rely on it:

```bash
# on the box, note what is live now
ssh ubuntu@<vps-ip> 'sudo systemctl show healthlog -p ExecStart; cat /var/lib/healthlog/commit.txt'

# push a deliberately broken commit to main, e.g.
#   echo 'throw new Error("deliberate deploy failure")' >> server/index.js && git commit -am "break deploy" && git push
```

What must happen:

1. `deploy.yml` goes **red** on that commit.
2. The SSH step fails because `healthlog-deploy` health-checked for 15 s, ran
   `git reset --hard <previous sha>`, restarted the service and exited 1.
3. `curl https://healthlog.<vps-ip>.sslip.io/api/health` still returns
   `{"ok":true,...,"commit":"<previous sha>"}` — users never noticed.
4. `cat /var/lib/healthlog/commit.txt` shows the **previous** commit again.

Then `git revert` the broken commit. Note that the revert must actually advance
the box: the deploy script compares `git rev-parse HEAD` with
`git rev-parse origin/main`, never `git diff --quiet` (which compares content
and would say "already up to date" after a revert that restores identical files).

### 8. Verify

```bash
curl https://healthlog.<vps-ip>.sslip.io/api/health      # commit = what is live
curl https://<user>.github.io/healthlog/api-config.js    # the injected API base
```

---

## Operations

### `scripts/hl` — the box from your machine

One command for everything you would otherwise SSH in for (Git Bash on
Windows; uses `DEPLOY_HOST` and `SSH_KEY`, defaulting to the live box):

| Task | Command |
| --- | --- |
| Health, commit, memory/disk, backups, recent errors | `scripts/hl status` |
| Users, activity, meals per day, AI models + errors, row counts | `scripts/hl stats [--days 7]` |
| Accounts with activity | `scripts/hl users` |
| API requests by route/status with latency | `scripts/hl traffic [hours]` |
| One query (read-only) | `scripts/hl sql "SELECT day, name, kcal FROM meals ORDER BY created_at DESC LIMIT 10"` |
| One write (backs up first) | `scripts/hl sql --write "UPDATE meals SET kcal = 450 WHERE id = '...'"` |
| Interactive SQL on the live DB | `scripts/hl shell` (`.tables`, `.schema meals`, `.json`, `.quit`); `--write` to allow writes |
| Logs | `scripts/hl logs [N]`, `scripts/hl logs -f`, `scripts/hl errors [hours]` |
| Backups | `scripts/hl backup`, `scripts/hl backup list`, `scripts/hl backup pull` (download to `data/backups/`) |
| Local dev DB = copy of production | `scripts/hl pull` |
| Restart + health check | `scripts/hl restart` |
| Connect Garmin (once, interactive: password + MFA) | `scripts/hl garmin-login you@example.com` |
| Garmin sync now / backfill | `scripts/hl garmin-sync you@example.com [days]` |
| Garmin status per account | `scripts/hl garmin-status` |

SQL goes through `server/cli.js` on the box, so nothing extra is installed
there. Reads open the database read-only; password and token hashes are masked
in every result. For a GUI, `scripts/hl backup pull` and open the file in
DB Browser for SQLite.

**Backups.** The server snapshots the database (`VACUUM INTO`, safe while it is
running) into `/var/lib/healthlog/backups/` once a day and keeps the newest 14
(`BACKUP_KEEP`, `BACKUP_INTERVAL_HOURS`, `BACKUPS=off`). They live on the same
disk — run `scripts/hl backup pull` now and then for an off-box copy.

**Access log.** Every API request writes one journal line,
`[req] POST /api/chat 200 4123ms` — method, path, status, duration only; no
query strings, headers or bodies. `ACCESS_LOG=off` disables it.

### Raw commands

| Task | Command |
| --- | --- |
| Deploy by hand | `ssh ubuntu@<ip> 'sudo /usr/local/bin/healthlog-deploy'` |
| Service state | `ssh ubuntu@<ip> 'systemctl status healthlog'` |
| Live logs | `ssh ubuntu@<ip> 'sudo journalctl -u healthlog -f'` |
| Which commit is live | `curl https://healthlog.<ip>.sslip.io/api/health` |
| Bootstrap log | `ssh ubuntu@<ip> 'sudo tail -n 120 /var/log/healthlog-bootstrap.log'` |
| New invite code | `ssh ubuntu@<ip> 'cd /opt/healthlog && node server/cli.js invite create --note "who"'` |
| Back up the database | `ssh ubuntu@<ip> 'cd /opt/healthlog && DATA_DIR=/var/lib/healthlog node server/cli.js backup'` (a plain `cp` of a WAL database can be inconsistent) |
| Edit server config | `ssh ubuntu@<ip> 'sudoedit /etc/healthlog/healthlog.env'` then `sudo systemctl restart healthlog` |

There is no `npm install` on the server: the API has zero runtime dependencies
and uses only Node built-ins (`node:sqlite`, `node:http`, `node:crypto`). The
`package.json` in this repo is frontend-only.

### When something is wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| SSH works, HTTP/HTTPS times out | Oracle's image iptables `REJECT` rule fires before ufw | re-run `deploy/bootstrap.sh` (it inserts the accepts before the rule) |
| Ports open in the console, still unreachable | wrong security list | open them on the list attached to the **public subnet** |
| `Error getting validation data` from Caddy | Let's Encrypt cannot reach 80/443 | iptables + security list; do not restart Caddy in a loop (rate limit) |
| Certificate `rate limited` | `sslip.io` is shared | wait, or use your own hostname |
| Pages loads but every asset 404s | absolute asset path under a project sub-path | use relative paths (`app.js`, not `/app.js`) |
| Browser console: mixed content / CORS | API not HTTPS, or missing CORS headers | check `https://`, and that `OPTIONS` returns 204 with `access-control-allow-origin` |
| Box is behind `main` after a revert | someone compared trees instead of commits | the deploy script uses `git rev-parse`; check the Actions log |
| Deploy exits 1 but the site is fine | the new commit failed its health check and was rolled back | fix forward |

---

## Privacy

- Your data is a **SQLite file on your own VPS**: `/var/lib/healthlog/healthlog.db`.
  Nothing is sent anywhere except the AI requests described below. There is no
  analytics and no third-party JavaScript.
- **Passwords** are stored as scrypt hashes. Session tokens are stored as SHA-256
  hashes; the raw token only exists in your browser's `localStorage`.
- **The AI key lives only in the server environment.** It is never baked into the
  frontend build, never in a GitHub variable the browser can read, and never
  returned by any endpoint.
- When you send a chat message, the message text, today's intake totals and your
  profile numbers (weight, goal, calorie target) are sent to the AI provider so it
  can estimate the meal. Nothing else, and only when you press send.
- Weight entries, phases, meals, foods and Garmin data are never sent to the AI provider.
- A Garmin export ZIP never leaves your browser whole: it is read locally and only
  the daily summary rows are uploaded to your own server.

Back up `/var/lib/healthlog/healthlog.db` — it is the only copy of your data.
