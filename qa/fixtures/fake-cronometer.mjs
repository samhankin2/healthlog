/**
 * A fake cronometer.com for tests: login page with an anticsrf token, form
 * login, the GWT RPC endpoint (authenticate / generateAuthorizationToken /
 * logout, rejecting a stale permutation or policy) and the servings and daily
 * nutrition CSV exports.
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
const DAILY_HEADER = ['Date', 'Energy (kcal)', 'Alcohol (g)', 'Carbs (g)', 'Fiber (g)', 'Fat (g)', 'Protein (g)', 'Completed']
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]))
}

/** @param {{ diary: string[][] }} opts  rows: [Day, Time, Group, Food Name, Amount, kcal, protein, carbs, fat, fiber] */
export async function startFakeCronometer({ diary }) {
  // servingsNutrients: false makes the servings export come back with no nutrient columns.
  const fake = { sessions: new Set(), tokens: new Set(), exports: [], logins: 0, logouts: 0, lastLoginBody: '', diary, servingsNutrients: true }
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
        const generate = url.searchParams.get('generate')
        if (!fake.tokens.has(url.searchParams.get('nonce')) || !['servings', 'dailySummary'].includes(generate)) return send(403, 'nope')
        const start = url.searchParams.get('start')
        const end = url.searchParams.get('end')
        fake.exports.push({ start, end, generate })
        const inRange = fake.diary.filter((r) => r[0] >= start && r[0] <= end)
        if (generate === 'dailySummary') {
          // One row per day in the range, logged or not, like Cronometer's daily nutrition export.
          const totals = new Map()
          for (const r of inRange) {
            const t = totals.get(r[0]) ?? [0, 0, 0, 0, 0]
            for (let i = 0; i < 5; i++) t[i] += Number(r[5 + i]) || 0
            totals.set(r[0], t)
          }
          const days = []
          for (let d = new Date(`${start}T12:00:00`); d <= new Date(`${end}T12:00:00`); d.setDate(d.getDate() + 1)) {
            days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
          }
          const rows = days.map((day) => {
            const [kcal, protein, carbs, fat, fiber] = (totals.get(day) ?? [0, 0, 0, 0, 0]).map((n) => n.toFixed(2))
            return [day, kcal, '0.00', carbs, fiber, fat, protein, totals.has(day) ? 'true' : 'false'].join(',')
          })
          return send(200, [DAILY_HEADER.join(','), ...rows].join('\r\n') + '\r\n', { 'content-type': 'text/csv' })
        }
        if (!fake.servingsNutrients) {
          // What some accounts get: the diary without any nutrient columns.
          const rows = inRange.map((r) => [r[0], r[2], r[3], r[4], 'Food'].map(csvCell).join(','))
          return send(200, ['Day,Group,Food Name,Amount,Category', ...rows].join('\r\n') + '\r\n', { 'content-type': 'text/csv' })
        }
        const rows = inRange.map((r) => [...r, 'Food'].map(csvCell).join(','))
        return send(200, [HEADER.join(','), ...rows].join('\r\n') + '\r\n', { 'content-type': 'text/csv' })
      }
      send(404, 'not found')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, state: fake, close: () => server.close() }
}
