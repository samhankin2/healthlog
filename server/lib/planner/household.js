/**
 * Meal planner households — SPEC §6 "Meal planner".
 *
 * Planner data belongs to a household, not a user, so two partners share one
 * plan. A household is resolved on every planner request from the partner
 * link (lib/partners.js):
 *
 * - No household yet → one is created for the user (and their linked partner).
 * - Linked partner already has a household → the user joins it.
 * - Both already have different households → they are merged; the one with
 *   fewer dishes moves into the other, so nobody's history is lost.
 * - A household holds at most the two linked people. Someone who links a new
 *   partner leaves their old household; its data stays with whoever remains.
 * - Unlinking alone never splits a household.
 */
import { randomUUID } from 'node:crypto'
import { withTx } from '../../db.js'
import { linkedPartner, partnerLink, shortName } from '../partners.js'

/** Tables carrying `household_id`, moved together when two households merge. */
const HOUSEHOLD_TABLES = ['dishes', 'dish_aliases', 'plan_entries', 'dish_ratings', 'dish_hidden_options', 'planner_notes', 'reviews', 'freezer_items', 'planner_photos', 'suggestion_snoozes']

function householdOf(db, userId) {
  return db.prepare('SELECT household_id FROM household_members WHERE user_id = ?').get(userId)?.household_id ?? null
}

function memberIds(db, householdId) {
  return db
    .prepare('SELECT user_id FROM household_members WHERE household_id = ? ORDER BY joined_at, user_id')
    .all(householdId)
    .map((r) => r.user_id)
}

function createHousehold(db, userIds) {
  const id = randomUUID()
  db.prepare('INSERT INTO households (id) VALUES (?)').run(id)
  const add = db.prepare('INSERT INTO household_members (user_id, household_id) VALUES (?, ?)')
  for (const userId of userIds) add.run(userId, id)
  return id
}

function addMember(db, householdId, userId) {
  db.prepare(
    `INSERT INTO household_members (user_id, household_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET household_id = excluded.household_id, joined_at = datetime('now')`,
  ).run(userId, householdId)
}

/** Leave a household; an emptied household is deleted with its data. */
function leave(db, userId) {
  const householdId = householdOf(db, userId)
  if (!householdId) return
  db.prepare('DELETE FROM household_members WHERE user_id = ?').run(userId)
  if (memberIds(db, householdId).length === 0) db.prepare('DELETE FROM households WHERE id = ?').run(householdId)
}

function dishCount(db, householdId) {
  return db.prepare('SELECT COUNT(*) AS n FROM dishes WHERE household_id = ?').get(householdId).n
}

/** Move everything from `fromId` into `toId`, then delete `fromId`. */
export function mergeHouseholds(db, fromId, toId) {
  for (const table of HOUSEHOLD_TABLES) {
    // OR IGNORE: an alias both households used stays with the surviving one.
    db.prepare(`UPDATE OR IGNORE ${table} SET household_id = ? WHERE household_id = ?`).run(toId, fromId)
  }
  db.prepare('UPDATE household_members SET household_id = ? WHERE household_id = ?').run(toId, fromId)
  db.prepare('DELETE FROM households WHERE id = ?').run(fromId) // cascades any leftovers
}

/**
 * The user's household id, created / joined / merged as the partner link says.
 * Idempotent: a settled household costs two reads.
 */
export function ensureHousehold(db, user) {
  const partner = linkedPartner(db, user.id)
  let mine = householdOf(db, user.id)

  if (!partner) {
    return mine ?? withTx(db, () => createHousehold(db, [user.id]))
  }

  let theirs = householdOf(db, partner.id)
  if (mine && mine === theirs) return mine

  return withTx(db, () => {
    // A third person (a previous partner) in either household: the linked
    // person leaves it and their old data stays behind.
    if (mine && memberIds(db, mine).some((id) => id !== user.id && id !== partner.id)) {
      leave(db, user.id)
      mine = null
    }
    if (theirs && memberIds(db, theirs).some((id) => id !== user.id && id !== partner.id)) {
      leave(db, partner.id)
      theirs = null
    }

    if (!mine && !theirs) return createHousehold(db, [user.id, partner.id])
    if (mine && !theirs) {
      addMember(db, mine, partner.id)
      return mine
    }
    if (!mine && theirs) {
      addMember(db, theirs, user.id)
      return theirs
    }
    // Both have one: keep the household with more dishes (ties: the partner's).
    const [from, to] = dishCount(db, mine) > dishCount(db, theirs) ? [theirs, mine] : [mine, theirs]
    mergeHouseholds(db, from, to)
    return to
  })
}

/** Payload for GET /api/planner/household. */
export function householdPayload(db, user, householdId) {
  const rows = db
    .prepare(
      `SELECT u.* FROM household_members m JOIN users u ON u.id = m.user_id
        WHERE m.household_id = ? ORDER BY m.joined_at, u.id`,
    )
    .all(householdId)
  const link = partnerLink(db, user.id)
  const week = db.prepare('SELECT week_start_day FROM households WHERE id = ?').get(householdId)
  return {
    id: householdId,
    weekStartDay: week?.week_start_day ?? 0,
    members: rows.map((u) => ({ id: u.id, name: shortName(u), me: u.id === user.id })),
    partner: link ? { status: link.linked ? 'linked' : 'pending', email: link.email } : null,
  }
}
