/**
 * A fake cronometer.com for tests: login page with an anticsrf token, form
 * login, the GWT RPC endpoint (authenticate / generateAuthorizationToken /
 * logout, rejecting a stale permutation or policy) and the servings CSV export.
 *
 *   const fake = await startFakeCronometer({ diary })
 *   fake.base, fake.state (sessions, exports, logins, logouts, diary), fake.close()
 */
import http from 'node:http'

export const CRONO_EMAIL = 'me@cronometer.test'
export const CRONO_PASSWORD = 'sup3r-secret-crono-pw'
const PERMUTATION = 'ABCDEF0123456789ABCDEF0123456789'
const POLICY = '0123456789ABCDEF0123456789ABCDEF'
const HEADER = ['Day', 'Time', 'Group', 'Food Name', 'Amount', 'Energy (kcal)', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Fiber (g)', 'Category']
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]))
}

/** @param {{ diary: string[][] }} opts  rows: [Day, Time, Group, Food Name, Amount, kcal, protein, carbs, fat, fiber] */
export async function startFakeCronometer({ diary }) {
  const fake = { sessions: new Set(), tokens: new Set(), exports: [], logins: 0, logouts: 0, lastLoginBody: '', diary }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (b) => { body += b })
    req.on('end', () => {
      const send = (status, text, headers = {}) => { res.writeHead(status, headers); res.end(text) }
      if (req.method === 'GET' && url.pathname === '/cronometer/cronometer.nocache.js') return send(200, `var a='${PERMUTATION}';`)
      if (req.method === 'GET' && url.pathname === `/cronometer/${PERMUTATION}.cache.js`) return send(200, `function Xok(){fmk.call(this,m5k(),'app','${POLICY}',Vok)}`)
      if (req.method === 'GET' && url.pathname === '/login/') {
        return send(200, '<form><input type="hidden" name="anticsrf" value="csrf-123"/></form>', { 'set-cookie': 'JSESSIONID=js1; Path=/' })
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        fake.logins++
        fake.lastLoginBody = body
        const form = new URLSearchParams(body)
        if (form.get('anticsrf') !== 'csrf-123' || cookies(req).JSESSIONID !== 'js1') return send(200, JSON.stringify({ error: 'Bad request token' }))
        if (form.get('username') !== CRONO_EMAIL || form.get('password') !== CRONO_PASSWORD) return send(200, JSON.stringify({ error: 'Invalid email or password' }))
        const nonce = `nonce-${fake.logins}`
        fake.sessions.add(nonce)
        return send(200, JSON.stringify({ success: true, redirect: '/' }), { 'set-cookie': `sesnonce=${nonce}; Path=/; HttpOnly` })
      }
      if (req.method === 'POST' && url.pathname === '/cronometer/app') {
        if (req.headers['x-gwt-permutation'] !== PERMUTATION || !body.includes(`|${POLICY}|`)) {
          return send(200, '//EX[2,1,["com.google.gwt.user.client.rpc.IncompatibleRemoteServiceException/3936916533","stale"],0,7]')
        }
        const nonce = cookies(req).sesnonce
        if (!nonce || !fake.sessions.has(nonce)) return send(200, '//EX[2,1,["com.cronometer.shared.user.exceptions.NotLoggedInException/844385496","authentication failed"],0,7]')
        if (body.includes('|authenticate|')) return send(200, '//OK[4242,1,[],0,7]')
        if (body.includes('|generateAuthorizationToken|')) {
          if (!body.includes(`|${nonce}|`) || !body.includes('|4242|')) return send(200, '//EX[1,["bad args"],0,7]')
          const token = `tok-${fake.tokens.size + 1}`
          fake.tokens.add(token)
          return send(200, `//OK[1,["${token}"],0,7]`)
        }
        if (body.includes('|logout|')) { fake.logouts++; fake.sessions.delete(nonce); return send(200, '//OK[[],0,7]') }
        return send(500, 'unknown call')
      }
      if (req.method === 'GET' && url.pathname === '/export') {
        if (!fake.tokens.has(url.searchParams.get('nonce')) || url.searchParams.get('generate') !== 'servings') return send(403, 'nope')
        const start = url.searchParams.get('start')
        const end = url.searchParams.get('end')
        fake.exports.push({ start, end })
        const rows = fake.diary.filter((r) => r[0] >= start && r[0] <= end).map((r) => [...r, 'Food'].map(csvCell).join(','))
        return send(200, [HEADER.join(','), ...rows].join('\r\n') + '\r\n', { 'content-type': 'text/csv' })
      }
      send(404, 'not found')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, state: fake, close: () => server.close() }
}
