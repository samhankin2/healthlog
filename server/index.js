/**
 * HealthLog API server — SPEC §2 / §6 / §9.
 *
 * Zero runtime dependencies. CORS echoes `Origin` only for allow-listed
 * origins (bearer-token auth, no cookies); `OPTIONS` always answers 204 without
 * running a handler.
 *
 * Env: PORT (8787), HOST (127.0.0.1), DATA_DIR (./data), COMMIT_FILE
 *      (DATA_DIR/commit.txt), DIST_DIR (optional built frontend to serve),
 *      CORS_ORIGINS (comma-separated extra allowed origins).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { getDb, dataDir, closeDb } from './db.js'
import { Router, sendJson, toErrorResponse } from './lib/http.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerProfileRoutes } from './routes/profile.js'
import { registerWeightRoutes } from './routes/weights.js'
import { registerPhaseRoutes } from './routes/phases.js'
import { registerDashboardRoutes } from './routes/dashboard.js'
import { registerMealRoutes } from './routes/meals.js'
import { registerFoodRoutes } from './routes/foods.js'
import { registerChatRoutes } from './routes/chat.js'
import { registerAnalysisRoutes } from './routes/analyses.js'
import { registerImportRoutes } from './routes/imports.js'
import { registerGarminRoutes } from './routes/garmin.js'
import { registerLiftingRoutes } from './routes/lifting.js'
import { registerCronometerRoutes } from './routes/cronometer.js'
import { registerCorosRoutes } from './routes/coros.js'
import { scheduleBackups } from './lib/backup.js'
import { scheduleGarminSync } from './lib/garmin.js'
import { scheduleCronometerSync } from './lib/cronometer.js'
import { scheduleCorosSync } from './lib/coros.js'
import { clientIp, requestsByIp } from './lib/ratelimit.js'

const SERVICE = 'healthlog'
const VERSION = '1.0'

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export function buildRouter() {
  const router = new Router()
  registerAuthRoutes(router)
  registerProfileRoutes(router)
  registerWeightRoutes(router)
  registerPhaseRoutes(router)
  registerDashboardRoutes(router)
  registerMealRoutes(router)
  registerFoodRoutes(router)
  registerChatRoutes(router)
  registerAnalysisRoutes(router)
  registerImportRoutes(router)
  registerGarminRoutes(router)
  registerLiftingRoutes(router)
  registerCronometerRoutes(router)
  registerCorosRoutes(router)
  return router
}

/* ------------------------------------------------------------------ */
/* CORS                                                                */
/* ------------------------------------------------------------------ */

// The GitHub Pages frontend. Extra origins come from CORS_ORIGINS.
const DEFAULT_ORIGINS = ['https://samhankin2.github.io']
const ALLOWED_ORIGINS = new Set(
  [...DEFAULT_ORIGINS, ...(process.env.CORS_ORIGINS || '').split(',')]
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
// Local development: Vite (:5173) and the API serving dist/ itself, any port.
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/

/** Is this browser origin allowed to call the API? */
export function originAllowed(origin, host) {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin)) return true
  // Same origin (the API serving the built frontend via DIST_DIR).
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    return false
  }
}

function corsHeaders(origin) {
  return {
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

function readCommit() {
  const file = process.env.COMMIT_FILE || path.join(dataDir(), 'commit.txt')
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return text || null
  } catch {
    return null
  }
}

// Public and unauthenticated, so it reports only what a deploy check needs.
// Usage numbers live behind `node server/cli.js stats` (scripts/hl stats).
function healthPayload() {
  getDb().prepare('SELECT 1').get() // fail the check if the DB is unusable
  return { ok: true, service: SERVICE, commit: readCommit() }
}

/* ------------------------------------------------------------------ */
/* Static files (optional; for local dev with DIST_DIR)                */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Serve a file from DIST_DIR, falling back to index.html (SPA routing).
 * Returns true when a response was written.
 */
function serveStatic(req, res, pathname) {
  const distDir = process.env.DIST_DIR
  if (!distDir) return false
  const root = path.resolve(distDir)
  try {
    if (!fs.statSync(root).isDirectory()) return false
  } catch {
    return false
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  let rel
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return false
  }

  const candidate = path.resolve(root, rel)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return false

  let file = null
  try {
    if (fs.statSync(candidate).isFile()) file = candidate
  } catch {
    file = null
  }
  if (!file) {
    const indexPath = path.join(root, 'index.html')
    try {
      if (fs.statSync(indexPath).isFile()) file = indexPath
    } catch {
      return false
    }
  }
  if (!file) return false

  const body = fs.readFileSync(file)
  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

/**
 * One journal line per API request: method, path (no query string), status,
 * duration. Never logs headers or bodies, so no token or food text leaks.
 * Preflights and health checks are skipped. ACCESS_LOG=off disables it.
 */
const ACCESS_LOG = !['0', 'off', 'false', 'no'].includes((process.env.ACCESS_LOG || '').trim().toLowerCase())

function logRequest(req, res) {
  if (!ACCESS_LOG || req.method === 'OPTIONS') return
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const pathname = (req.url || '/').split('?')[0]
    if (!pathname.startsWith('/api/') || pathname === '/api/health') return
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n)
    console.log(`[req] ${req.method} ${pathname} ${res.statusCode} ${ms}ms`)
  })
}

export function createServer() {
  const router = buildRouter()

  return http.createServer(async (req, res) => {
    logRequest(req, res)
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null
    const origin = originAllowed(rawOrigin, req.headers.host) ? rawOrigin : null
    const cors = corsHeaders(origin)
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)

    // Preflight: never run a handler.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'content-length': '0' })
      res.end()
      return
    }

    let pathname = '/'
    let query = new URLSearchParams()
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      pathname = url.pathname
      query = url.searchParams
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad request URL' }, cors)
      return
    }

    try {
      if (pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, healthPayload(), cors)
        return
      }

      if (pathname === '/api' || pathname === '/api/') {
        sendJson(res, 200, { ok: true, service: SERVICE, version: VERSION }, cors)
        return
      }

      if (!pathname.startsWith('/api/')) {
        if (serveStatic(req, res, pathname)) return
        sendJson(res, 404, { ok: false, error: 'Not found' }, cors)
        return
      }

      // Coarse per-IP flood guard. Direct loopback calls (the deploy health
      // check, local tests) carry no X-Forwarded-For and are not counted.
      if (req.headers['x-forwarded-for'] || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) {
        requestsByIp.consume(`ip:${clientIp(req)}`)
      }

      const match = router.match(req.method || 'GET', pathname)
      if (!match) {
        sendJson(res, 404, { ok: false, error: 'Not found' }, cors)
        return
      }
      if (!match.handler) {
        sendJson(res, 404, { ok: false, error: 'Not found' }, cors)
        return
      }

      await match.handler({ req, res, params: match.params, query, pathname })
    } catch (err) {
      const { status, message } = toErrorResponse(err)
      if (status >= 500) {
        console.error(`[healthlog] ${req.method} ${pathname} failed:`, err)
      }
      if (!res.headersSent) {
        const extra = err?.retryAfter ? { ...cors, 'retry-after': String(err.retryAfter) } : cors
        sendJson(res, status, { ok: false, error: message }, extra)
      } else {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    }
  })
}

export function start() {
  const port = Number(process.env.PORT || 8787)
  const host = process.env.HOST || '127.0.0.1'

  // Opening the DB here creates the schema on an empty data directory.
  const db = getDb()
  const stopBackups = scheduleBackups(db)
  const stopGarmin = scheduleGarminSync(db)
  const stopCronometer = scheduleCronometerSync(db)
  const stopCoros = scheduleCorosSync(db)

  const server = createServer()
  server.listen(port, host, () => {
    console.log(`[healthlog] listening on http://${host}:${port} (data: ${dataDir()})`)
  })

  const shutdown = (signal) => {
    console.log(`[healthlog] ${signal} received, shutting down`)
    stopBackups()
    stopGarmin()
    stopCronometer()
    stopCoros()
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    // Do not hang forever on keep-alive sockets.
    setTimeout(() => {
      closeDb()
      process.exit(0)
    }, 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  server.on('error', (err) => {
    console.error('[healthlog] server error:', err)
    process.exit(1)
  })

  return server
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) start()
