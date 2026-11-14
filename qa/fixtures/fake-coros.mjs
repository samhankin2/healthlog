/**
 * A fake COROS MCP for tests, on one port: protected-resource and
 * authorization-server metadata, dynamic client registration, an authorize
 * endpoint that approves at once (302 back with a code), the token endpoint
 * (authorization_code with PKCE S256, rotating refresh tokens), revocation, and
 * the MCP endpoint (streamable HTTP, SSE replies, Mcp-Session-Id) with text
 * tools shaped like COROS's documented examples.
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

  /** Tool name + arguments -> reply text, in the style of COROS's Tool Guide. */
  function tool(name, args) {
    if (name === 'querySportRecords') {
      const hits = fake.activities.filter((x) => inRange(x.day, args.startDate, args.endDate)).slice(0, args.limit ?? 20)
      const lines = [`Sport Records — ${args.startDate} to ${args.endDate} (${hits.length} records)`, '']
      hits.forEach((x, i) => {
        lines.push(`${i + 1}. ${x.name}(${x.sportType}) — ${x.day} ${x.start}`)
        lines.push(`   Label ID: ${x.labelId} | Sport Type: ${x.sportType}`)
        lines.push(`   Duration: ${x.duration} | Distance: ${x.distance}`)
        lines.push(`   Average Pace: 5:00 /km`)
      })
      return lines.join('\n')
    }
    if (name === 'getActivityDetail') {
      const d = fake.details[args.labelId]
      if (!d) throw new Error('no such activity')
      return [`Activity Details`, '', `Workout Time: ${d.workoutTime}`, `Calories: ${d.kcal} kcal`, `Average Heart Rate: ${d.avgHr} bpm`, `Max Heart Rate: ${d.maxHr} bpm`, `Elevation Gain: ${d.ascent} m`].join('\n')
    }
    if (name === 'querySleepOverview') {
      const lines = ['Sleep Overview', '']
      for (const s of fake.sleep.filter((x) => inRange(x.day, args.startDate, args.endDate))) {
        lines.push(s.day, `Sleep Score: ${s.score}`, `Daily Sleep: ${s.main} (incl. naps)`, `Main Sleep (asleep): ${s.main}`, `Deep Sleep Ratio: ${s.deep}%`, `Light Sleep Ratio: ${s.light}%`, `REM Ratio: ${s.rem}%`, `Awake Time: ${s.awake}`, `Main Sleep Window: ${s.window}`, 'Naps Total: 0 min', '')
      }
      return lines.join('\n')
    }
    if (name === 'querySleepHrv') {
      const span = (Date.parse(`${args.endDate.slice(0, 4)}-${args.endDate.slice(4, 6)}-${args.endDate.slice(6)}`) - Date.parse(`${args.startDate.slice(0, 4)}-${args.startDate.slice(4, 6)}-${args.startDate.slice(6)}`)) / 86400000 + 1
      if (span > 7) throw new Error('HRV queries cover at most 7 days')
      const lines = ['Sleep HRV', '']
      for (const h of fake.hrv.filter((x) => inRange(x.day, args.startDate, args.endDate))) lines.push(h.day, `Average HRV: ${h.ms} ms`, 'Normal Range: 50-70 ms', `Evaluation: ${h.eval}`, '')
      return lines.join('\n')
    }
    if (name === 'queryDailyHealthData') {
      if ((args.days ?? 7) > 30) throw new Error('days must be at most 30')
      const days = new Set(recentDays(args.days ?? 7))
      const rows = fake.daily.filter((x) => days.has(x.day))
      return ['Daily Health Overview', '', '| Date | Steps | Calories | Stress |', '|---|---|---|---|', ...rows.map((x) => `| ${x.day} | ${x.steps.toLocaleString('en-US')} | ${x.kcal.toLocaleString('en-US')} kcal | ${x.stress} |`)].join('\n')
    }
    if (name === 'queryRestingHeartRate') {
      const days = new Set(recentDays(args.days ?? 7))
      return [`Resting Heart Rate (last ${args.days ?? 7} days)`, ...fake.rhr.filter((x) => days.has(x.day)).map((x) => `${x.day}: ${x.bpm} bpm`)].join('\n')
    }
    if (name === 'queryStressLevel') {
      const days = new Set(recentDays(args.days ?? 7))
      return ['Stress Level', ...fake.stress.filter((x) => days.has(x.day)).map((x) => `${x.day} — Average Stress: ${x.avg}`)].join('\n')
    }
    if (name === 'queryFitnessAssessmentOverview') return fake.vo2max ? `Fitness Assessment\nVO2max: ${fake.vo2max}\nRunning Level: 72.4` : 'No assessment available.'
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
            return sse({ content: [{ type: 'text', text: tool(name, args ?? {}) }] })
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
