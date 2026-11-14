/**
 * A fake COROS MCP for tests, on one port: protected-resource and
 * authorization-server metadata, dynamic client registration, an authorize
 * endpoint that approves at once (302 back with a code), the token endpoint
 * (authorization_code with PKCE S256, rotating refresh tokens), revocation, and
 * the MCP endpoint (streamable HTTP, SSE replies, Mcp-Session-Id) with text
 * tools laid out like the real COROS replies, double JSON-encoded as COROS
 * sends them.
 *
 *   const fake = await startFakeCoros({ ... })
 *   fake.base, fake.mcpUrl, fake.state, fake.close()
 */
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'

const b64url = (buf) => buf.toString('base64url')

export async function startFakeCoros({ activities = [], sleep = [], hrv = [], daily = [], rhr = [], stress = [], vo2max = null, details = {} } = {}) {
  const fake = {
    clients: new Map(), // client_id -> { redirect_uris }
    codes: new Map(), // code -> { clientId, challenge, redirectUri }
    access: new Set(),
    refresh: new Set(),
    revoked: 0,
    registrations: 0,
    toolCalls: [],
    rateLimit: false,
    failTool: null, // name of a tool that answers isError
    accessTtl: 30 * 86400,
    activities, sleep, hrv, daily, rhr, stress, vo2max, details,
  }
  let base = ''

  const inRange = (day, a, b) => day.replaceAll('-', '') >= a && day.replaceAll('-', '') <= b
  const recentDays = (n) => {
    const out = []
    for (let i = 0; i < n; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    return out
  }

  /** The watch's offset: Melbourne in summer, +11:00 (COROS: timezone=44 quarter hours). */
  const TZ_Q = 44
  const epochOf = (day, hhmm) => Math.round(Date.parse(`${day}T${hhmm}:00+11:00`) / 1000)
  const compact = (day) => day.replaceAll('-', '')
  const dashed = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`

  /**
   * Tool name + arguments -> reply text, laid out as the real COROS MCP
   * answered on 2026-11-14 (values changed). The server sends each text block
   * JSON-encoded a second time; see the tools/call handler.
   */
  function tool(name, args) {
    if (name === 'querySportRecords') {
      const hits = fake.activities.filter((x) => inRange(x.day, args.startDate, args.endDate)).slice(0, args.limit ?? 20)
      const lines = [`Sport Records — ${dashed(args.startDate)} to ${dashed(args.endDate)} (${hits.length} records)`, '========================', '']
      hits.forEach((x, i) => {
        const start = epochOf(x.day, x.start)
        const kcal = fake.details[x.labelId]?.kcal
        lines.push(`${i + 1}. ${x.name} — ${x.day}`)
        lines.push('   Location: Somewhere Run')
        lines.push('   Start Coordinates: -37.800000, 145.000000')
        lines.push(`   Time Window: startTimestamp=${start} | endTimestamp=${start + 1800}`)
        lines.push(`   Duration: ${x.duration} | Distance: ${x.distance}`)
        lines.push(`   Average Pace: 5:00 /km | Avg HR: ${fake.details[x.labelId]?.avgHr ?? 150} bpm${kcal ? ` | Calories: ${kcal} kcal` : ''}`)
        lines.push(`   LabelId: ${x.labelId} | SportType: ${x.sportType}`)
        lines.push('')
      })
      return lines.join('\n').trim()
    }
    if (name === 'getActivityDetail') {
      const d = fake.details[args.labelId]
      if (!d) throw new Error('no such activity')
      return ['Activity Details', '', `Workout Time: ${d.workoutTime}`, `Calories: ${d.kcal} kcal`, `Average Heart Rate: ${d.avgHr} bpm`, `Max Heart Rate: ${d.maxHr} bpm`, `Elevation Gain: ${d.ascent} m`].join('\n')
    }
    if (name === 'querySleepOverview') {
      const lines = ['Sleep Overview', '========================', 'Note: each record below is dated by its wake-up day.', '']
      for (const s of fake.sleep.filter((x) => inRange(x.day, args.startDate, args.endDate))) {
        lines.push(s.day, `Sleep Score: ${s.score}`, `Daily Sleep: ${s.main} (incl. naps)`, `Main Sleep (asleep): ${s.main}`, `Main Sleep Period (incl. awake): ${s.main}`, 'Sleep metrics scope: daily',
          `Deep Sleep Ratio: ${s.deep}%`, `Light Sleep Ratio: ${s.light}%`, `REM Ratio: ${s.rem}%`, 'Awake Ratio: 3%', `Awake Time: ${s.awake}`, 'Awake Count (>5 min): 0', `Main Sleep Window: ${s.window}`, 'Naps Total: 0 min', '')
      }
      return lines.join('\n').trim()
    }
    if (name === 'querySleepHrv') {
      const span = (Date.parse(dashed(args.endDate)) - Date.parse(dashed(args.startDate))) / 86400000 + 1
      if (span > 7) throw new Error('HRV queries cover at most 7 days')
      const hits = fake.hrv.filter((x) => inRange(x.day, args.startDate, args.endDate))
      const lines = [`Sleep HRV — ${dashed(args.startDate)} to ${dashed(args.endDate)}`, '========================', 'Note: dates are wake-up days (each value comes from the night that ended that morning).', '', 'HRV Assessment — Last 7 days', '========================', '']
      for (const h of hits) lines.push(`${h.day}:`, `  HRV Avg: ${h.ms} ms — ${h.eval}`, '  Normal Range: 50 - 70 ms', '  Baseline: 60 ms')
      lines.push('', 'Sleep HRV Time Series — Last 7 days', '========================', '')
      for (const h of hits) {
        const t = epochOf(h.day, '02:00')
        lines.push(`${h.day}:`, `  timestamp=${t}, timezone=${TZ_Q}, hrv=${h.ms + 10} ms, status=4, confidence=87500`, `  timestamp=${t + 900}, timezone=${TZ_Q}, hrv=${h.ms - 10} ms, status=4, confidence=85000`)
      }
      return lines.join('\n').trim()
    }
    if (name === 'queryDailyHealthData') {
      if ((args.days ?? 7) > 30) throw new Error('days must be at most 30')
      const days = new Set(recentDays(args.days ?? 7))
      const rows = fake.daily.filter((x) => days.has(x.day)).sort((a, b) => a.day.localeCompare(b.day))
      const lines = [`Daily Health Data — Last ${args.days ?? 7} days | Resting HR: 51 bpm | HRV Baseline: 42 ms`, 'Note: sleep entries are dated by their wake-up day.', '']
      for (const x of rows) {
        lines.push(`--- ${compact(x.day)} ---`, `Steps: ${x.steps.toLocaleString('en-US')} | Calories: ${x.kcal.toLocaleString('en-US')} kcal | Exercise: ${x.exercise ?? 0} min`, `Stress: Avg ${x.stress}`,
          'Sleep Summary:', '  Total: 7h 41min | Deep: 1h 58min | Light: 3h 38min | REM: 1h 53min | Awake: 12 min', '  Sleep HR: Avg 52 bpm | Min 45 bpm | Max 67 bpm', '')
      }
      return lines.join('\n').trim()
    }
    if (name === 'queryRestingHeartRate') {
      const days = new Set(recentDays(args.days ?? 7))
      return [`Resting Heart Rate — Last ${args.days ?? 7} days`, '========================', '', ...fake.rhr.filter((x) => days.has(x.day)).map((x) => `${x.day}: ${x.bpm} bpm`)].join('\n')
    }
    if (name === 'queryStressLevel') {
      const days = new Set(recentDays(args.days ?? 7))
      const lines = [`Stress Level — Last ${args.days ?? 7} days`, '========================', '']
      for (const x of fake.stress.filter((y) => days.has(y.day))) lines.push(`${x.day}:`, `Average Stress: ${x.avg}`, 'Relaxed: No data', 'Low: No data', 'Medium: No data', 'High: No data', '')
      return lines.join('\n').trim()
    }
    if (name === 'queryFitnessAssessmentOverview') {
      if (!fake.vo2max) return 'No assessment available.'
      return ['Fitness Assessment Overview', '========================', '', `VO2max: ${fake.vo2max}`, 'Running Level: 75', 'Threshold Pace: 4:40 /km', '5 km Prediction: 21:30', '10 km Prediction: 44:50', 'Half Marathon Prediction: 1:39:00', 'Marathon Prediction: 3:28:15'].join('\n')
    }
    throw new Error(`unknown tool ${name}`)
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (b) => { body += b })
    req.on('end', () => {
      const json = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }
      if (fake.rateLimit) { res.writeHead(429); return res.end('slow down') }
      const p = url.pathname
      if (p === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid', 'mcp.tools', 'offline_access'] })
      if (p === '/.well-known/oauth-authorization-server') {
        return json(200, { issuer: base, authorization_endpoint: `${base}/oauth2/authorize`, token_endpoint: `${base}/oauth2/token`, registration_endpoint: `${base}/connect/register`, revocation_endpoint: `${base}/oauth2/revoke`, code_challenge_methods_supported: ['S256'] })
      }
      if (p === '/connect/register' && req.method === 'POST') {
        const reg = JSON.parse(body || '{}')
        if (!Array.isArray(reg.redirect_uris) || !reg.redirect_uris.length) return json(400, { error: 'invalid_request', error_description: 'redirect_uris cannot be null' })
        fake.registrations++
        const id = `client-${fake.registrations}`
        fake.clients.set(id, { redirect_uris: reg.redirect_uris })
        return json(201, { client_id: id, redirect_uris: reg.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' })
      }
      if (p === '/oauth2/authorize' && req.method === 'GET') {
        const q = url.searchParams
        const client = fake.clients.get(q.get('client_id'))
        if (!client || !client.redirect_uris.includes(q.get('redirect_uri')) || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || q.get('resource') !== `${base}/mcp`) {
          res.writeHead(400); return res.end('bad authorize request')
        }
        const target = new URL(q.get('redirect_uri'))
        if (fake.denyNext) {
          fake.denyNext = false
          target.searchParams.set('error', 'access_denied')
        } else {
          const code = b64url(randomBytes(12))
          fake.codes.set(code, { clientId: q.get('client_id'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') })
          target.searchParams.set('code', code)
        }
        target.searchParams.set('state', q.get('state'))
        res.writeHead(302, { location: target.toString() })
        return res.end()
      }
      if (p === '/oauth2/token' && req.method === 'POST') {
        const f = new URLSearchParams(body)
        const issue = () => {
          const access = `at-${b64url(randomBytes(9))}`
          const refresh = `rt-${b64url(randomBytes(9))}`
          fake.access.add(access)
          fake.refresh.add(refresh)
          return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: fake.accessTtl })
        }
        if (f.get('grant_type') === 'authorization_code') {
          const c = fake.codes.get(f.get('code'))
          fake.codes.delete(f.get('code'))
          const expected = c && b64url(createHash('sha256').update(f.get('code_verifier') || '').digest())
          if (!c || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri') || expected !== c.challenge) return json(400, { error: 'invalid_grant' })
          return issue()
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (!fake.refresh.has(f.get('refresh_token'))) return json(400, { error: 'invalid_grant' })
          fake.refresh.delete(f.get('refresh_token')) // rotation: each refresh token works once
          fake.refreshes = (fake.refreshes ?? 0) + 1
          return issue()
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      if (p === '/oauth2/revoke' && req.method === 'POST') {
        const t = new URLSearchParams(body).get('token')
        fake.refresh.delete(t)
        fake.access.delete(t)
        fake.revoked++
        res.writeHead(200); return res.end()
      }
      if (p === '/mcp' && req.method === 'POST') {
        const auth = String(req.headers.authorization || '')
        if (!auth.startsWith('Bearer ') || !fake.access.has(auth.slice(7))) {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
          return res.end()
        }
        const msg = JSON.parse(body || '{}')
        if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
        const sse = (result, error) => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' })
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) })}\n\n`)
        }
        if (msg.method === 'initialize') return sse({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-coros', version: '0' } })
        if (req.headers['mcp-session-id'] !== 'sess-1') return json(400, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'missing session' } })
        if (msg.method === 'tools/list') return sse({ tools: ['querySportRecords', 'querySleepOverview'].map((name) => ({ name })) })
        if (msg.method === 'tools/call') {
          const { name, arguments: args } = msg.params
          fake.toolCalls.push({ name, args })
          if (fake.failTool === name) return sse({ content: [{ type: 'text', text: 'Service temporarily unavailable' }], isError: true })
          try {
            // As the real server does: the text block is itself a JSON string literal.
            return sse({ content: [{ type: 'text', text: JSON.stringify(tool(name, args ?? {})) }] })
          } catch (e) {
            return sse({ content: [{ type: 'text', text: e.message }], isError: true })
          }
        }
        return sse(null, { code: -32601, message: 'method not found' })
      }
      res.writeHead(404); res.end('not found')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  return { base, mcpUrl: `${base}/mcp`, state: fake, close: () => server.close() }
}
