#!/usr/bin/env node
/**
 * Admin CLI. Runs against the same DATA_DIR as the server.
 *
 *   node server/cli.js invite create --note "sam"
 *   node server/cli.js invite list
 *   node server/cli.js user create --email me@example.com --password "hunter22"
 *
 * Prints the invite code (and only the code) for `invite create`; never prints
 * password hashes or tokens.
 */
import { getDb, closeDb, ensureProfile } from './db.js'
import {
  createInvite,
  findUserByEmail,
  insertUser,
  listInvites,
  normaliseInviteCode,
  publicUser,
  validateCredentials,
} from './auth.js'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function usage() {
  const lines = [
    'HealthLog admin CLI',
    '',
    '  node server/cli.js invite create [--note "who"]   print a new invite code',
    '  node server/cli.js invite list                    list invite codes',
    '  node server/cli.js user create --email <email> --password <password>',
    '                                                    create an account without an invite',
    '',
    'Env: DATA_DIR (default ./data)',
  ]
  console.log(lines.join('\n'))
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exitCode = 1
}

function main() {
  const [group, action] = process.argv.slice(2)
  const args = parseArgs(process.argv.slice(3))

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    usage()
    return
  }

  const db = getDb()

  if (group === 'invite' && action === 'create') {
    const note = typeof args.note === 'string' ? args.note : null
    const invite = createInvite(db, { note })
    process.stdout.write(`${invite.code}\n`)
    return
  }

  if (group === 'invite' && action === 'list') {
    const rows = listInvites(db)
    if (rows.length === 0) {
      console.log('No invite codes yet. Create one with: node server/cli.js invite create --note "sam"')
      return
    }
    for (const row of rows) {
      const status = row.used_by ? `used ${row.used_at ?? ''}`.trim() : 'unused'
      console.log(`${row.code}  ${status}${row.note ? `  (${row.note})` : ''}`)
    }
    return
  }

  if (group === 'invite' && action === 'revoke' && typeof args.code === 'string') {
    const code = normaliseInviteCode(args.code)
    const result = db.prepare('DELETE FROM invite_codes WHERE code = ? AND used_by IS NULL').run(code)
    if (Number(result.changes) === 0) {
      fail(`no unused invite with code ${code}`)
      return
    }
    console.log(`revoked ${code}`)
    return
  }

  if (group === 'user' && action === 'create') {
    const password = typeof args.password === 'string' ? args.password : ''
    const email = typeof args.email === 'string' ? args.email : ''
    try {
      validateCredentials(email, password)
      if (findUserByEmail(db, email)) {
        fail('that email is already registered')
        return
      }
      const user = insertUser(db, { email: email.trim(), password })
      ensureProfile(db, user.id)
      console.log(`created user ${publicUser(user).email} (${user.id})`)
    } catch (err) {
      fail(err?.message || String(err))
    }
    return
  }

  usage()
  process.exitCode = 1
}

try {
  main()
} finally {
  closeDb()
}
