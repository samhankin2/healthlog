#!/usr/bin/env node
/**
 * Admin CLI. Runs against the same DATA_DIR as the server.
 *
 *   node server/cli.js stats                          overview: users, activity, AI, DB, backups
 *   node server/cli.js users                          one line per account
 *   node server/cli.js sql "SELECT * FROM meals LIMIT 5"
 *   node server/cli.js sql -                          read the query from stdin
 *   node server/cli.js sql                            interactive prompt (when stdin is a TTY)
 *   node server/cli.js backup [list]
 *   node server/cli.js invite create --note "sam"
 *   node server/cli.js invite list
 *   node server/cli.js user create --email me@example.com --password "hunter22"
 *
 * `sql` opens the database READ-ONLY unless --write is given; --write takes a
 * backup first. Never prints password hashes or token hashes: those columns
 * are masked in every result.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { getDb, closeDb, ensureProfile, dbFile, dataDir } from './db.js'
import {
  createInvite,
  findUserByEmail,
  insertUser,
  listInvites,
  normaliseInviteCode,
  publicUser,
  validateCredentials,
} from './auth.js'
import { backupNow, listBackups } from './lib/backup.js'

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
    '  node server/cli.js stats [--days 30]              users, activity, AI, DB size, backups',
    '  node server/cli.js users                          list accounts with activity',
    '  node server/cli.js sql "<query>" [--json] [--wide] [--write]',
    '  node server/cli.js sql -                          read the query from stdin',
    '  node server/cli.js sql                            interactive prompt (.tables, .schema, .quit)',
    '  node server/cli.js backup                         take a snapshot now',
    '  node server/cli.js backup list                    list snapshots',
    '  node server/cli.js invite create [--note "who"]   print a new invite code',
    '  node server/cli.js invite list                    list invite codes',
    '  node server/cli.js invite revoke --code <code>',
    '  node server/cli.js user create --email <email> --password <password>',
    '                                                    create an account without an invite',
    '',
    'sql is read-only unless --write (which takes a backup first).',
    'Env: DATA_DIR (default ./data)',
  ]
  console.log(lines.join('\n'))
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exitCode = 1
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const SECRET_COLUMNS = new Set(['password_hash', 'token_hash'])

function maskRow(row) {
  const out = {}
  for (const [k, v] of Object.entries(row)) out[k] = SECRET_COLUMNS.has(k) && v != null ? '<hidden>' : v
  return out
}

function cell(v, wide) {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`
  let s = typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 100) / 100) : String(v)
  s = s.replace(/\s+/g, ' ')
  if (!wide && s.length > 60) s = `${s.slice(0, 57)}...`
  return s
}

/** Print rows as an aligned text table. */
function printTable(rows, { wide = false } = {}) {
  if (rows.length === 0) {
    console.log('(no rows)')
    return
  }
  const cols = Object.keys(rows[0])
  const body = rows.map((r) => cols.map((c) => cell(r[c], wide)))
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((r) => r[i].length)))
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd()
  console.log(line(cols))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of body) console.log(line(r))
  console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`)
}

function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function heading(text) {
  console.log(`\n== ${text} ==`)
}

/* ------------------------------------------------------------------ */
/* Read-only access                                                    */
/* ------------------------------------------------------------------ */

function openReadOnly() {
  if (!fs.existsSync(dbFile())) throw new Error(`no database at ${dbFile()}`)
  const db = new DatabaseSync(dbFile(), { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

function cmdStats(args) {
  const days = Number.isInteger(Number(args.days)) && Number(args.days) > 0 ? Number(args.days) : 30
  const db = openReadOnly()
  const since = `-${days} days`
  try {
    let commit = null
    try {
      commit = fs.readFileSync(process.env.COMMIT_FILE || path.join(dataDir(), 'commit.txt'), 'utf8').trim()
    } catch {
      /* not deployed */
    }

    heading('Database')
    const backups = listBackups()
    console.log(`file      ${dbFile()}`)
    console.log(`size      ${bytes(fileSize(dbFile()))} (+ wal ${bytes(fileSize(`${dbFile()}-wal`))})`)
    console.log(`commit    ${commit ?? 'unknown'}`)
    console.log(
      `backups   ${backups.length}${backups[0] ? `, newest ${backups[0].file} (${bytes(backups[0].bytes)}, ${backups[0].mtime.toISOString()})` : ' - none yet'}`,
    )

    heading('Rows per table')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    printTable(tables.map((t) => ({ table: t.name, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n })))

    heading(`Activity, last ${days} days`)
    const count = (sql) => db.prepare(sql).get(since).n
    printTable([
      { what: 'meals logged', n: count("SELECT COUNT(*) AS n FROM meals WHERE created_at >= datetime('now', ?)") },
      { what: 'weigh-ins', n: count("SELECT COUNT(*) AS n FROM weight_entries WHERE created_at >= datetime('now', ?)") },
      { what: 'chat messages', n: count("SELECT COUNT(*) AS n FROM chat_messages WHERE created_at >= datetime('now', ?)") },
      { what: 'AI analyses', n: count("SELECT COUNT(*) AS n FROM analyses WHERE created_at >= datetime('now', ?)") },
      {
        what: 'AI analyses with error',
        n: count("SELECT COUNT(*) AS n FROM analyses WHERE error IS NOT NULL AND error <> '' AND created_at >= datetime('now', ?)"),
      },
      { what: 'logins (sessions created)', n: count("SELECT COUNT(*) AS n FROM sessions WHERE created_at >= datetime('now', ?)") },
    ])

    heading(`Meals per day, last 14 days`)
    printTable(
      db
        .prepare(
          `SELECT day, COUNT(*) AS meals, ROUND(SUM(kcal)) AS kcal
             FROM meals WHERE day >= date('now', '-14 days')
            GROUP BY day ORDER BY day DESC`,
        )
        .all(),
    )

    heading(`AI models used, last ${days} days`)
    printTable(
      db
        .prepare(
          `SELECT model_a, model_b, COUNT(*) AS calls,
                  SUM(CASE WHEN error IS NOT NULL AND error <> '' THEN 1 ELSE 0 END) AS errors,
                  MAX(created_at) AS last_used
             FROM analyses WHERE created_at >= datetime('now', ?)
            GROUP BY model_a, model_b ORDER BY calls DESC`,
        )
        .all(since),
    )

    const recentErrors = db
      .prepare(
        `SELECT created_at, error FROM analyses
          WHERE error IS NOT NULL AND error <> '' ORDER BY created_at DESC LIMIT 5`,
      )
      .all()
    if (recentErrors.length) {
      heading('Most recent AI errors')
      printTable(recentErrors, { wide: true })
    }

    heading('Users')
    printTable(usersRows(db))
  } finally {
    db.close()
  }
}

function usersRows(db) {
  return db
    .prepare(
      `SELECT u.email,
              substr(u.created_at, 1, 10) AS joined,
              CASE WHEN u.disabled_at IS NULL THEN '' ELSE 'disabled' END AS status,
              (SELECT COUNT(*) FROM meals m WHERE m.user_id = u.id) AS meals,
              (SELECT COUNT(*) FROM weight_entries w WHERE w.user_id = u.id) AS weights,
              (SELECT COUNT(*) FROM foods f WHERE f.user_id = u.id) AS foods,
              (SELECT MAX(day) FROM meals m WHERE m.user_id = u.id) AS last_meal,
              (SELECT MAX(date) FROM weight_entries w WHERE w.user_id = u.id) AS last_weight,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions
         FROM users u ORDER BY u.created_at`,
    )
    .all()
}

function cmdUsers() {
  const db = openReadOnly()
  try {
    printTable(usersRows(db))
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* sql                                                                 */
/* ------------------------------------------------------------------ */

function runQuery(db, sql, opts) {
  const stmt = db.prepare(sql)
  const rows = stmt.all().map(maskRow)
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }
  // A statement that returns no columns (an UPDATE with --write) has no table.
  if (rows.length === 0 && !/^\s*(select|with|pragma|explain)/i.test(sql)) {
    console.log('ok')
    return
  }
  printTable(rows, opts)
}

function dotCommand(db, line, opts) {
  const [cmd, arg] = line.trim().split(/\s+/)
  if (cmd === '.quit' || cmd === '.exit') return 'quit'
  if (cmd === '.tables') {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name)
    console.log(names.join('  '))
  } else if (cmd === '.schema') {
    const rows = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
           AND (? IS NULL OR tbl_name = ?) ORDER BY type DESC, name`,
      )
      .all(arg ?? null, arg ?? null)
    console.log(rows.map((r) => `${r.sql};`).join('\n'))
  } else if (cmd === '.json') {
    opts.json = !opts.json
    console.log(`json output ${opts.json ? 'on' : 'off'}`)
  } else if (cmd === '.wide') {
    opts.wide = !opts.wide
    console.log(`wide output ${opts.wide ? 'on' : 'off'}`)
  } else {
    console.log('.tables  .schema [table]  .json  .wide  .quit')
  }
  return null
}

function repl(db, opts) {
  console.log(`HealthLog SQL (${opts.write ? 'READ-WRITE' : 'read-only'}) - ${dbFile()}`)
  console.log('End statements with ";". Try .tables, .schema meals, .quit')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sql> ' })
  let buffer = ''
  rl.prompt()
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (!buffer && line.trim().startsWith('.')) {
        if (dotCommand(db, line, opts) === 'quit') {
          rl.close()
          return
        }
        rl.prompt()
        return
      }
      buffer += `${line}\n`
      if (buffer.trim().endsWith(';')) {
        try {
          runQuery(db, buffer, opts)
        } catch (err) {
          console.error(`error: ${err?.message || err}`)
        }
        buffer = ''
        rl.setPrompt('sql> ')
      } else if (buffer.trim()) {
        rl.setPrompt('...> ')
      }
      rl.prompt()
    })
    rl.on('close', resolve)
  })
}

async function cmdSql(args) {
  const opts = { json: Boolean(args.json), wide: Boolean(args.wide), write: Boolean(args.write) }
  let sql = args._[0]
  if (sql === '-') sql = fs.readFileSync(0, 'utf8')

  let db
  if (opts.write) {
    db = getDb()
    const snap = backupNow(db, { label: 'pre-sql' })
    console.error(`backup taken first: ${snap.file}`)
  } else {
    db = openReadOnly()
  }
  try {
    if (sql === undefined) {
      if (!process.stdin.isTTY) {
        fail('no query given (pass one, or "-" to read stdin)')
        return
      }
      await repl(db, opts)
      return
    }
    try {
      runQuery(db, sql, opts)
    } catch (err) {
      fail(err?.message || String(err))
    }
  } finally {
    if (!opts.write) db.close()
  }
}

/* ------------------------------------------------------------------ */
/* backup                                                              */
/* ------------------------------------------------------------------ */

function cmdBackup(action) {
  if (action === 'list') {
    printTable(listBackups().map((b) => ({ file: b.file, size: bytes(b.bytes), taken: b.mtime.toISOString() })))
    return
  }
  const made = backupNow(getDb(), { label: 'manual' })
  console.log(`${made.path} (${bytes(made.bytes)})`)
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const [group, action] = process.argv.slice(2)
  const args = parseArgs(process.argv.slice(3))

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    usage()
    return
  }

  if (group === 'stats') return cmdStats(args)
  if (group === 'users') return cmdUsers()
  if (group === 'sql') return cmdSql(args)
  if (group === 'backup') return cmdBackup(action)

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
  await main()
} catch (err) {
  fail(err?.message || String(err))
} finally {
  closeDb()
}
