/**
 * Tiny HTTP helpers: error type, JSON responses, body parsing, router.
 * Zero dependencies — node:http only (see server/index.js).
 */

/** Error carrying an HTTP status. Anything thrown that is not an HttpError becomes a 500. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message human readable, safe to show to the client
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** Send a JSON response. */
export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    ...extraHeaders,
  }
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * Read and parse a JSON request body.
 * - 1 MiB limit (HTTP 400 "Request body too large")
 * - clear 400 on malformed JSON
 * - empty body parses to `{}`
 */
export function readJsonBody(req, { limit = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      // Drain whatever is left so the socket does not hang.
      req.resume()
      reject(err)
    }

    const onData = (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new HttpError(400, 'Request body too large (1 MB limit)'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') {
          resolve({ value: parsed })
          return
        }
        resolve(parsed)
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'))
      }
    }
    const onError = (err) => fail(err instanceof HttpError ? err : new HttpError(400, 'Could not read request body'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** Split a path into segments, ignoring leading/trailing/duplicate slashes. */
function segments(pathname) {
  return pathname.split('/').filter((s) => s.length > 0)
}

/**
 * Minimal method + path router with `:param` segments.
 * `match()` returns `{ handler, params }` or null.
 */
export class Router {
  constructor() {
    /** @type {{method:string, parts:string[], handler:Function}[]} */
    this.routes = []
  }

  /**
   * @param {string} method
   * @param {string} pattern e.g. "/api/weights/:id"
   * @param {(ctx: object) => any} handler
   */
  add(method, pattern, handler) {
    this.routes.push({ method: method.toUpperCase(), parts: segments(pattern), handler })
    return this
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler)
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler)
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler)
  }

  delete(pattern, handler) {
    return this.add('DELETE', pattern, handler)
  }

  match(method, pathname) {
    const want = method.toUpperCase()
    const parts = segments(pathname)
    let pathMatched = false
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i]
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(parts[i])
        } else if (p !== parts[i]) {
          ok = false
          break
        }
      }
      if (!ok) continue
      pathMatched = true
      if (route.method === want) return { handler: route.handler, params }
    }
    return pathMatched ? { handler: null, params: {} } : null
  }
}

/** Convert an unknown thrown value into `{status, message}`. */
export function toErrorResponse(err) {
  if (err instanceof HttpError) return { status: err.status, message: err.message }
  if (err && typeof err === 'object' && typeof err.status === 'number' && typeof err.message === 'string') {
    return { status: err.status, message: err.message }
  }
  return { status: 500, message: 'Internal server error' }
}
