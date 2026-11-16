/**
 * Partner link — SPEC §6 "Partner sharing".
 *
 * Each user names at most one partner by email. The link is live only when
 * both accounts name each other, so nobody can push meals into an account
 * that did not ask for them, and a pending link never reveals whether the
 * email belongs to an account.
 */

/** Friendly first name for a user row: display name, else the email's local part. */
export function shortName(user) {
  const display = String(user?.display_name ?? '').trim()
  if (display) return display.split(/\s+/)[0].slice(0, 40)
  const local = String(user?.email ?? '').split('@')[0] || 'Partner'
  const word = local.split(/[._+-]/)[0] || local
  return (word.charAt(0).toUpperCase() + word.slice(1)).slice(0, 40)
}

/**
 * The user's partner setting and whether it is mutual.
 * @returns {{ email: string, linked: boolean, user: object|null } | null}
 */
export function partnerLink(db, userId) {
  const mine = db.prepare('SELECT partner_email FROM partners WHERE user_id = ?').get(userId)
  if (!mine) return null
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(userId)
  const other = db
    .prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL AND id <> ?')
    .get(mine.partner_email, userId)
  const mutual =
    other && me
      ? db.prepare('SELECT 1 FROM partners WHERE user_id = ? AND partner_email = ?').get(other.id, me.email)
      : null
  return { email: mine.partner_email, linked: Boolean(mutual), user: mutual ? other : null }
}

/** The linked partner's user row, or null. */
export function linkedPartner(db, userId) {
  const link = partnerLink(db, userId)
  return link?.linked ? link.user : null
}

/** API shape: `{ email, status, name }` — the name only once the link is mutual. */
export function partnerPayload(link) {
  if (!link) return null
  return {
    email: link.email,
    status: link.linked ? 'linked' : 'pending',
    name: link.linked ? shortName(link.user) : null,
  }
}
