# AGENTS.md

Working notes for any agent (or human) picking up this repository.

## What this is

HealthLog — a personal weight + calorie tracker. Svelte 5 frontend on
GitHub Pages, a zero-dependency Node 24 API with SQLite on a free Oracle Cloud
VPS, and a chat-based food logger that asks two AI models and reconciles their
answers in code.

`SPEC.md` is the authoritative contract. Read it before changing behaviour; if a
change contradicts it, report the conflict instead of silently deviating.

## Read this first

`C:\Users\hanki\Development\vps-deploy-playbook\DEPLOYMENT.md` — the deployment
playbook. It carries every failure mode already paid for: the exact OCI launch
body, Oracle's iptables `REJECT` rule that silently drops 80/443, the GitHub
Pages sub-path trap, `sslip.io` rate limits, and the deploy-and-rollback pattern.
Do not re-derive any of it.

## Layout

```
SPEC.md               the contract
reference/
  svelte-contract.md  the component/state/backend contract the UI is built against
  legacy-ui/          the TypeScript DOM app the Svelte port replaced (reference
                      only — not built, not part of the app)
src/
  main.ts             entry: mount(App) — Svelte 5
  App.svelte          shell: auth gate, hash router, tab bar / side rail
  views/              Login, Chat, Dashboard, Calories, Lifting, Insights, Foods, Settings, History, Activity
  lib/
    api.ts            the ONLY module that calls fetch
    auth.ts format.ts pwa.ts types.ts store.ts   framework-agnostic
    state.svelte.ts   the reactive state + actions (runes)
    icons.ts toast.svelte.ts
    components/       shared Svelte components
    panels/ charts/   view-specific components
    viz/              hand-drawn SVG charts for Insights (no chart library)
    zip.ts garminExport.ts insights.ts   Garmin export reader/normaliser + analysis (pure)
    lifting.ts        lift analysis: e1RM, records, progression, targets, load, Insights merge (pure)
    lifting.svelte.ts lifting state + offline outbox + rest timer
    lift/             the gym logger, exercise picker/page, steppers, rest timer
  design/             tokens.css + ui.css — the design system, global CSS
index.html            Vite entry
public/               files Vite copies verbatim into dist/
  api-config.js       runtime API base — REWRITTEN by the Pages workflow
  .nojekyll           keep Pages from running Jekyll
server/               API — node:http + node:sqlite, zero runtime dependencies
  index.js            server, router, static fallback
  db.js auth.js ai.js lib/ routes/ cli.js   (cli.js: admin - stats, sql, backups, invites)
  lib/garminStore.js  the only writer of Garmin rows (live sync + export import)
sync/
  garmin_sync.py      Garmin fetcher (python-garminconnect); spawned by server/lib/garmin.js
  requirements.txt    the pinned version — the only Python dependency
deploy/
  garmin-setup.sh     installs the Garmin venv at /opt/healthlog-garmin (idempotent)
  bootstrap.sh        one-shot VPS install (Node 24, Caddy, user, dirs, env, unit, firewall)
  healthlog-deploy.sh installed as /usr/local/bin/healthlog-deploy
  healthlog.service   systemd unit
  Caddyfile           TLS + reverse proxy, __PUBLIC_IP__ placeholder
  install-vps.sh      scp + run bootstrap over ssh
.github/workflows/    pages.yml (frontend), deploy.yml (API)
qa/                   smoke / API / browser checks
                      garmin-export-test.mjs <zip>: runs the browser importer on a real export
                      lifting-browser-test.mjs: headless-Edge run of the gym logger (after npm run build)
```

## Commands

```bash
npm install && npm run build     # frontend: svelte-check + vite -> dist/
node server/index.js             # API + built site on http://127.0.0.1:8787
npm run dev                      # Vite dev server (:5173, proxies /api)
npm run check                    # svelte-check only
node server/cli.js invite create --note "local"
node server/cli.js stats | users | sql "..." | backup   # admin; sql is read-only without --write
scripts/hl status | stats | sql "..." | shell | logs -f # the same, against the live box over SSH
```

`scripts/hl` is the way to inspect production (README → Operations). It goes
through `server/cli.js` on the box, so it needs the current `cli.js` deployed.

No `npm install` on the server: the API imports only Node built-ins
(`node:sqlite`, `node:http`, `node:crypto`). `package.json` is frontend-only.

## Hard rules

- **Plain Svelte 5, not SvelteKit.** No SSR, no adapter, no prerendering, no
  routing config. `vite-plugin-svelte` + `vite build` → `dist/`.
- **Hash routing, not path routing.** GitHub Pages has no rewrites, so a deep
  link or a refresh on `/healthlog/dashboard` would 404. The app routes on
  `#/dashboard`.
- **`base: './'`** in `vite.config.ts`, and `relative` asset paths everywhere.
- **Svelte 5 idioms:** `onclick={fn}` (not `on:click`), callback props (not
  `createEventDispatcher`), snippets (not slots). A `$state` primitive cannot be
  exported and reassigned — export an object, or a getter function like
  `route()` in `state.svelte.ts`.
- **Fix a11y warnings; do not silence them.** No `<!-- svelte-ignore -->`.
- **No secrets in the repo.** No keys, tokens or passwords in any file, test,
  fixture or commit message. Use placeholders (`OPENCODE_API_KEY=`). The AI key
  exists only in `/etc/healthlog/healthlog.env` on the box; the GitHub token only
  in Git Credential Manager; the OCI key only in `~/.oci/`.
- **Never print a token.** Read it into a shell variable, use it, drop it. Never
  `echo` it, never write it to a file, never put it in a log or an error message.
  The GitHub token on Windows:
  `$cred = "protocol=https`nhost=github.com`n`n" | git credential-manager get`
  then take the `password=` line.
- **Data lives outside the code directory.** `/var/lib/healthlog/` holds the
  database and `commit.txt`. Deploys and rollbacks must never touch it.
- **Relative asset paths.** GitHub Pages serves this at `/<repo>/`, so `/app.js`
  404s. `vite.config.ts` sets `base: './'`; keep it that way.
- **Never edit `public/api-config.js` by hand.** The Pages workflow overwrites
  `dist/api-config.js` from the `API_BASE_URL` repository variable. Change the
  variable, not the file.
- **Compare commits, not trees.** `git diff --quiet HEAD origin/main` compares
  content; after a revert that restores identical files it reports "up to date"
  and the box never advances. The deploy script uses
  `git rev-parse HEAD` vs `git rev-parse origin/main`.
- **Systemd unit name, paths, port are fixed:** service `healthlog`, code
  `/opt/healthlog`, data `/var/lib/healthlog`, env
  `/etc/healthlog/healthlog.env`, port 8787 on 127.0.0.1, Caddy site
  `healthlog.<ip>.sslip.io`. Changing one means changing `deploy/`, the
  workflows, the README and SPEC §9 together.
- **Never make the Garmin sync log in with a password.** Garmin rate-limits
  SSO logins per IP and keeps 429ing for days. Scheduled and manual syncs only
  resume saved tokens; the only full login is the interactive
  `cli.js garmin login`. Keep the scheduled-sync interval (minimum 1 h, nothing overnight), the
  fetch-only-unfinished-days range, and the 429 backoff (SPEC §6).
- **Do not restart Caddy in a loop.** Let's Encrypt rate-limits `sslip.io`;
  `bootstrap.sh` only restarts it when the Caddyfile actually changed.
- **The deploy script self-refreshes** from `deploy/healthlog-deploy.sh` after a
  successful deploy. The run that *introduces* a change cannot refresh itself —
  install that one by hand (`install -m 0755 ... /usr/local/bin/healthlog-deploy`).

## Deploying

Push to `main`. Two workflows run independently:

- `pages.yml` — `npm ci`, `npm run build`, inject `API_BASE_URL` into
  `dist/api-config.js`, upload `dist/` to Pages.
- `deploy.yml` — paths `server/**`, `deploy/**`, `package.json`, itself. SSH as
  `ubuntu` → `sudo /usr/local/bin/healthlog-deploy` (fetch, fast-forward,
  write `commit.txt`, restart, health-check 15 s, roll back on failure), then
  re-checks the **public** `https://healthlog.<host>.sslip.io/api/health` and
  fails the build if unhealthy.

Repository configuration: secret `DEPLOY_SSH_KEY`, variables `DEPLOY_HOST` and
`API_BASE_URL`, environment `production`.

## Verifying a change

- `curl https://healthlog.<ip>.sslip.io/api/health` → includes `commit`, which
  tells you exactly what is live. If it does not match `main`, the deploy either
  failed and rolled back or never ran.
- `curl https://<user>.github.io/healthlog/api-config.js` → the injected API base.
- CORS: `curl -i -X OPTIONS https://<api>/api/auth/me -H "Origin: https://<user>.github.io" -H "Access-Control-Request-Method: POST"` → `204` and the echoed origin.
- Service: `ssh ubuntu@<ip> 'systemctl status healthlog; journalctl -u healthlog -n 80'`.
- UI: drive the **live Pages URL** in headless Edge over CDP (playbook §7). That
  is the only way to catch mixed-content, CORS and relative-asset failures.
  Check `Runtime.exceptionThrown`, error-level console calls, and
  `document.documentElement.scrollWidth` for horizontal overflow.

## Testing the rollback

Push a commit that breaks `server/index.js` on purpose. Expect: workflow red,
public API still healthy on the previous commit, `commit.txt` back to the
previous SHA. Revert the break afterwards. An unexercised rollback is a rumour.
