/**
 * COROS MCP client — SPEC §6 "COROS". COROS's official, self-service route for
 * apps ("Build on COROS MCP"): OAuth 2.0 + the Model Context Protocol at
 * https://mcp.coros.com/mcp. No application or approval; each user authorises
 * their own data.
 *
 * OAuth, as the MCP authorization spec describes it:
 *   - discovery: the MCP host's protected-resource metadata names the
 *     authorization server; its metadata names the endpoints.
 *   - dynamic client registration (RFC 7591), once per redirect URI, cached in
 *     $DATA_DIR/coros-client.json. Public client, no secret.
 *   - authorization code + PKCE (S256), with `resource` (RFC 8707).
 *   - refresh tokens rotate: every refresh returns a new one, which replaces
 *     the old. (COROS: access 30 days, refresh 180 days.)
 *
 * MCP: JSON-RPC over streamable HTTP. initialize -> notifications/initialized
 * -> tools/call. Replies come as JSON or as an SSE stream; both are read.
 *
 * Node built-ins only. COROS_MCP_URL points it at a fake server in tests.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../db.js'

const DEFAULT_MCP_URL = 'https://mcp.coros.com/mcp'
const SCOPE = 'openid mcp.tools offline_access'
const PROTOCOL_VERSION = '2025-06-18'
const REQUEST_TIMEOUT_MS = 60_000
const DISCOVERY_TTL_MS = 6 * 3600_000
const USER_AGENT = 'HealthLog (personal COROS sync)'
const CLIENT_FILE = 'coros-client.json'

export class CorosError extends Error {
  /** @param {'needs_login'|'unauthorized'|'rate_limited'|'error'|'unavailable'|'busy'|'bad_request'} code */
  constructor(code, message, status = 502) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function mcpUrl() {
  return (process.env.COROS_MCP_URL || DEFAULT_MCP_URL).replace(/\/+$/, '')
}

async function http(url, { method = 'GET', headers = {}, body } = {}) {
  try {
    return await fetch(url, {
      method,
      body,
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new CorosError('error', `Could not reach COROS (${e.name === 'TimeoutError' ? 'timed out' : e.message}).`)
  }
}

async function readJson(res, what) {
  const text = await res.text()
  if (res.status === 429) throw new CorosError('rate_limited', 'COROS is rate-limiting requests.', 429)
  try {
    return JSON.parse(text)
  } catch {
    throw new CorosError('error', `COROS answered unexpectedly (${what}, HTTP ${res.status}).`)
  }
}

const b64url = (buf) => buf.toString('base64url')

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

let discoveryCache = null // { at, url, meta }

/**
 * @returns {Promise<{ resource: string, issuer: string, authorizationEndpoint: string, tokenEndpoint: string,
 *   registrationEndpoint: string|null, revocationEndpoint: string|null }>}
 */
export async function discover() {
  const url = mcpUrl()
  if (discoveryCache && discoveryCache.url === url && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.meta
  const u = new URL(url)
  let pr = null
  for (const candidate of [`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    const res = await http(candidate, { headers: { accept: 'application/json' } })
    if (res.ok) {
      pr = await readJson(res, 'resource metadata')
      if (Array.isArray(pr?.authorization_servers) && pr.authorization_servers.length) break
    } else await res.text()
    pr = null
  }
  if (!pr) throw new CorosError('error', 'COROS MCP did not publish its sign-in details; the sync needs an update.')
  const issuer = String(pr.authorization_servers[0]).replace(/\/+$/, '')
  let as = null
  for (const candidate of [`${issuer}/.well-known/oauth-authorization-server`, `${issuer}/.well-known/openid-configuration`]) {
    const res = await http(candidate, { headers: { accept: 'application/json' } })
    if (res.ok) {
      as = await readJson(res, 'authorization server metadata')
      if (as?.authorization_endpoint && as?.token_endpoint) break
    } else await res.text()
    as = null
  }
  if (!as) throw new CorosError('error', 'COROS\'s sign-in server did not describe itself; the sync needs an update.')
  const meta = {
    resource: typeof pr.resource === 'string' && pr.resource ? pr.resource : url,
    issuer,
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint ?? null,
    revocationEndpoint: as.revocation_endpoint ?? null,
  }
  discoveryCache = { at: Date.now(), url, meta }
  return meta
}

/* ------------------------------------------------------------------ */
/* Client registration (cached per authorization server + redirect URI) */
/* ------------------------------------------------------------------ */

function clientFile() {
  return path.join(dataDir(), CLIENT_FILE)
}

function readClients() {
  try {
    const parsed = JSON.parse(fs.readFileSync(clientFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeClients(all) {
  fs.mkdirSync(dataDir(), { recursive: true })
  const tmp = `${clientFile()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, clientFile())
}

/** @returns {Promise<{ clientId: string, clientSecret: string|null }>} */
export async function ensureClient(meta, redirectUri) {
  const key = `${meta.issuer}|${redirectUri}`
  const all = readClients()
  if (all[key]?.clientId) return all[key]
  if (!meta.registrationEndpoint) throw new CorosError('error', 'COROS no longer lets apps register themselves; the sync needs an update.')
  const res = await http(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'HealthLog',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  })
  const body = await readJson(res, 'client registration')
  if (!res.ok || !body?.client_id) {
    throw new CorosError('error', `COROS refused to register HealthLog: ${String(body?.error_description || body?.error || `HTTP ${res.status}`).slice(0, 200)}`)
  }
  const client = { clientId: String(body.client_id), clientSecret: body.client_secret ? String(body.client_secret) : null, registeredAt: new Date().toISOString() }
  all[key] = client
  writeClients(all)
  console.log(`[coros] registered OAuth client for ${redirectUri}`)
  return client
}

/* ------------------------------------------------------------------ */
/* Authorization code + PKCE                                           */
/* ------------------------------------------------------------------ */

export function pkce() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function authorizeUrl(meta, client, { redirectUri, state, challenge }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: meta.resource,
  })
  return `${meta.authorizationEndpoint}?${q}`
}

/** POST to the token endpoint. Returns { accessToken, refreshToken, expiresAt }. */
async function tokenRequest(meta, client, params) {
  const form = new URLSearchParams({ ...params, client_id: client.clientId, resource: meta.resource })
  if (client.clientSecret) form.set('client_secret', client.clientSecret)
  const res = await http(meta.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  })
  const body = await readJson(res, 'token')
  if (!res.ok || !body?.access_token) {
    const err = String(body?.error || '')
    if (res.status === 400 || res.status === 401 || ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(err)) {
      throw new CorosError('needs_login', 'COROS ended the connection. Connect again in Settings.', 409)
    }
    throw new CorosError('error', `COROS's token endpoint answered unexpectedly (HTTP ${res.status}).`)
  }
  const expiresIn = Number(body.expires_in)
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : params.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000).toISOString(),
  }
}

export function exchangeCode(meta, client, { code, verifier, redirectUri }) {
  return tokenRequest(meta, client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri })
}

export function refreshTokens(meta, client, refreshToken) {
  if (!refreshToken) return Promise.reject(new CorosError('needs_login', 'COROS did not grant a refresh token. Connect again in Settings.', 409))
  return tokenRequest(meta, client, { grant_type: 'refresh_token', refresh_token: refreshToken })
}

/** Best effort: tell COROS to forget the token. */
export async function revoke(meta, client, token) {
  if (!meta.revocationEndpoint || !token) return
  try {
    const form = new URLSearchParams({ token, client_id: client.clientId })
    const res = await http(meta.revocationEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
    await res.text()
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ */
/* MCP over streamable HTTP                                            */
/* ------------------------------------------------------------------ */

/** Pull the JSON-RPC message with `id` out of an SSE body. Exported for tests. */
/**
 * COROS sends each text block JSON-encoded a second time: the text is a JSON
 * string literal ("\"Sport Records ...\\n1. Outdoor Run ...\""), so its line
 * breaks arrive as the two characters \n. Decode it once; anything else is
 * returned as it came.
 */
export function unwrapText(text) {
  const t = String(text ?? '')
  const s = t.trim()
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return t
  try {
    const v = JSON.parse(s)
    return typeof v === 'string' ? v : t
  } catch {
    return t
  }
}

export function messageFromSse(text, id) {
  const events = text.split(/\r?\n\r?\n/)
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const msg = JSON.parse(data)
      if (msg && msg.id === id) return msg
    } catch {
      /* not JSON */
    }
  }
  return null
}

/**
 * Open an MCP session with a bearer token. A 401 throws CorosError('unauthorized')
 * so the caller can refresh and retry.
 * @returns {Promise<{ callTool: (name: string, args?: object) => Promise<{ text: string, structured: unknown }>, tools: () => Promise<string[]> }>}
 */
export async function openMcp(resourceUrl, accessToken) {
  let sessionId = null
  let nextId = 1

  async function post(message) {
    const res = await http(resourceUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
      },
      body: JSON.stringify(message),
    })
    if (res.status === 401 || res.status === 403) {
      await res.text()
      throw new CorosError('unauthorized', 'COROS rejected the access token.', 401)
    }
    if (res.status === 429) {
      await res.text()
      throw new CorosError('rate_limited', 'COROS is rate-limiting requests.', 429)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    if (message.id === undefined) return null // a notification: 202, no body
    if (!res.ok) throw new CorosError('error', `COROS MCP answered HTTP ${res.status}.`)
    const type = res.headers.get('content-type') || ''
    let msg = null
    if (type.includes('text/event-stream')) msg = messageFromSse(text, message.id)
    else {
      try {
        msg = JSON.parse(text)
      } catch {
        msg = null
      }
    }
    if (!msg) throw new CorosError('error', 'COROS MCP sent a reply HealthLog could not read.')
    if (msg.error) throw new CorosError('error', `COROS MCP: ${String(msg.error.message || 'error').slice(0, 200)}`)
    return msg.result
  }

  const request = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params })

  await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'healthlog', version: '1.0' } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' })

  return {
    async tools() {
      const result = await request('tools/list', {})
      return (result?.tools ?? []).map((t) => t.name)
    },
    async callTool(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args })
      const text = (Array.isArray(result?.content) ? result.content : [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => unwrapText(c.text))
        .join('\n')
      if (result?.isError) throw new CorosError('error', `COROS ${name}: ${text.slice(0, 200) || 'tool error'}`)
      return { text, structured: result?.structuredContent ?? null }
    },
  }
}
