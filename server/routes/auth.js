/** Auth routes — SPEC §6 "Auth". */
import { getDb, ensureProfile, withTx } from '../db.js'
import {
  createSession,
  deleteSession,
  findInvite,
  findUserByEmail,
  insertUser,
  pruneSessions,
  publicUser,
  requireUser,
  validateCredentials,
  verifyPassword,
  bearerToken,
} from '../auth.js'
import { readJsonBody, sendJson, HttpError } from '../lib/http.js'
import { requireString } from '../lib/validate.js'
import { profilePayload } from '../lib/shape.js'
import { clientIp, loginByIp, loginFailsByAccount, registerByIp } from '../lib/ratelimit.js'
export function registerAuthRoutes(router) {
  router.post('/api/auth/register', async ({ req, res }) => {
    // Every attempt counts: it is how invite codes would be guessed.
    registerByIp.consume(`ip:${clientIp(req)}`)
    const body = await readJsonBody(req)
    const { email, password } = validateCredentials(body.email, body.password)
    const db = getDb()

    // Duplicate email is a 409 even before the invite is inspected: it is the
    // more actionable message and SPEC §6 lists it as a conflict.
    if (findUserByEmail(db, email)) throw new HttpError(409, 'That email is already registered')

    const inviteCode = requireString(body.inviteCode, 'inviteCode', { max: 64 })

    const invite = findInvite(db, inviteCode)
    if (!invite) throw new HttpError(400, 'That invite code is not valid')
    if (invite.used_by || invite.used_at) throw new HttpError(409, 'That invite code has already been used')

    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 100) : null

    const user = withTx(db, () => {
      const created = insertUser(db, { email, password, displayName })
      db.prepare("UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE id = ? AND used_by IS NULL").run(
        created.id,
        invite.id,
      )
      return created
    })

    const token = createSession(db, user.id, req.headers['user-agent'] ?? null)
    sendJson(res, 200, { ok: true, token, user: publicUser(user) })
  })

  router.post('/api/auth/login', async ({ req, res }) => {
    const body = await readJsonBody(req)
    const email = String(body.email ?? '').trim()
    const password = String(body.password ?? '')
    if (!email || !password) throw new HttpError(400, 'Email and password are required')

    // Rate limits run before scrypt, so a flood cannot burn the CPU either.
    const accountKey = `acct:${email.toLowerCase()}`
    loginByIp.consume(`ip:${clientIp(req)}`)
    loginFailsByAccount.check(accountKey)

    const db = getDb()
    const user = findUserByEmail(db, email)
    // Verify even when the user is missing-shaped, to keep the timing similar.
    const ok = user ? verifyPassword(password, user.password_hash) : verifyPassword(password, 'scrypt$00$00')
    if (!user || !ok) {
      loginFailsByAccount.hit(accountKey)
      throw new HttpError(401, 'Email or password is incorrect')
    }
    loginFailsByAccount.reset(accountKey)
    if (user.disabled_at) throw new HttpError(401, 'This account is disabled')

    pruneSessions(db)
    ensureProfile(db, user.id)
    const token = createSession(db, user.id, req.headers['user-agent'] ?? null)
    sendJson(res, 200, { ok: true, token, user: publicUser(user) })
  })

  router.post('/api/auth/logout', async ({ req, res }) => {
    requireUser(req)
    deleteSession(getDb(), bearerToken(req.headers.authorization))
    sendJson(res, 200, { ok: true })
  })

  router.get('/api/auth/me', async ({ req, res }) => {
    const user = requireUser(req)
    const db = getDb()
    ensureProfile(db, user.id)
    const profile = db.prepare('SELECT * FROM profile WHERE user_id = ?').get(user.id)
    sendJson(res, 200, { ok: true, user: publicUser(user), profile: profilePayload(profile) })
  })
}
