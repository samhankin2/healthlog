/**
 * A fake COROS Training Hub API for tests: /account/login (MD5 password),
 * /activity/query (paged) and /analyse/query, with the `accesstoken` header,
 * result "1019" for an unknown token and a switchable 429.
 *
 *   const fake = await startFakeCoros({ activities, dayList, t7dayList })
 *   fake.base, fake.state (tokens, logins, calls, lastLoginBody, rateLimit, ...), fake.close()
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

export const COROS_EMAIL = 'me@coros.test'
export const COROS_PASSWORD = 'sup3r-secret-coros-pw'
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')

export async function startFakeCoros({ activities = [], dayList = [], t7dayList = [] } = {}) {
  const fake = { tokens: new Set(), logins: 0, calls: [], lastLoginBody: null, rateLimit: false, activities, dayList, t7dayList }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (b) => { body += b })
    req.on('end', () => {
      const json = (obj, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      fake.calls.push(`${req.method} ${url.pathname}`)
      if (fake.rateLimit) { res.writeHead(429); return res.end('slow down') }
      if (req.method === 'POST' && url.pathname === '/account/login') {
        fake.logins++
        let parsed = {}
        try { parsed = JSON.parse(body) } catch { /* bad body */ }
        fake.lastLoginBody = body
        if (parsed.account !== COROS_EMAIL || parsed.pwd !== md5(COROS_PASSWORD) || parsed.accountType !== 2) {
          return json({ result: '1030', message: 'The login password is incorrect.' })
        }
        const token = `coros-token-${fake.logins}`
        fake.tokens.add(token)
        return json({ result: '0000', message: 'OK', data: { accessToken: token, userId: '987654' } })
      }
      if (!fake.tokens.has(req.headers.accesstoken)) return json({ result: '1019', message: 'Access token is invalid' })
      if (req.method === 'GET' && url.pathname === '/activity/query') {
        const from = Number(url.searchParams.get('startDay'))
        const to = Number(url.searchParams.get('endDay'))
        const size = Number(url.searchParams.get('size'))
        const page = Number(url.searchParams.get('pageNumber'))
        const hits = fake.activities.filter((a) => a.date >= from && a.date <= to)
        const list = hits.slice((page - 1) * size, page * size)
        return json({ result: '0000', data: { count: hits.length, pageNumber: page, totalPage: Math.max(1, Math.ceil(hits.length / size)), dataList: list } })
      }
      if (req.method === 'GET' && url.pathname === '/analyse/query') {
        const from = Number(url.searchParams.get('startDay'))
        const to = Number(url.searchParams.get('endDay'))
        const inRange = (d) => d.happenDay >= from && d.happenDay <= to
        return json({ result: '0000', data: { dayList: fake.dayList.filter(inRange), t7dayList: fake.t7dayList.filter(inRange), weekList: [] } })
      }
      json({ result: '1001', message: 'Service exceptions' })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, state: fake, close: () => server.close() }
}
