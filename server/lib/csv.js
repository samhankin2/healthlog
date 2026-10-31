/**
 * Small RFC-4180-ish CSV parser.
 *
 * Handles: quoted fields, embedded commas and newlines inside quotes, escaped
 * `""` inside quoted fields, CRLF / LF / CR line endings, and a leading UTF-8
 * BOM. No dependencies.
 *
 * `parseCsv(text) -> { headers, rows, lines }`
 *   headers: first record
 *   rows:    subsequent records (always arrays of strings; short rows are padded
 *            to the header length)
 *   lines:   1-based physical line number each row starts on (for error messages)
 */

/** Strip a UTF-8 BOM (as a character, or as the mojibake that appears when decoded as latin1). */
function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1)
  if (text.startsWith('\u00ef\u00bb\u00bf')) return text.slice(3)
  return text
}

/** Split CSV text into records of fields, tracking the physical line each record starts on. */
export function parseRecords(text) {
  const src = stripBom(String(text ?? ''))
  /** @type {{fields: string[], line: number}[]} */
  const records = []
  let field = ''
  let row = []
  let inQuotes = false
  let line = 1
  let rowLine = 1
  let fieldStarted = false

  const endField = () => {
    row.push(field)
    field = ''
    fieldStarted = false
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++
        field += ch
      }
      continue
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      continue
    }
    if (ch === ',') {
      endField()
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      // Finish the record, then the next record starts on the next line.
      endField()
      records.push({ fields: row, line: rowLine })
      row = []
      line++
      rowLine = line
      continue
    }
    field += ch
    fieldStarted = true
  }

  // Trailing partial record (no trailing newline).
  if (field !== '' || row.length > 0 || fieldStarted) {
    endField()
    records.push({ fields: row, line: rowLine })
  }

  return records
}

/**
 * @param {string} text
 * @returns {{headers: string[], rows: string[][], lines: number[]}}
 */
export function parseCsv(text) {
  const records = parseRecords(text).filter((r) => !(r.fields.length === 1 && r.fields[0].trim() === ''))
  if (records.length === 0) return { headers: [], rows: [], lines: [] }

  const headers = records[0].fields.map((h) => h.trim())
  const lines = []
  const rows = records.slice(1).map((r) => {
    lines.push(r.line)
    const fields = r.fields.slice(0, headers.length)
    while (fields.length < headers.length) fields.push('')
    return fields
  })
  return { headers, rows, lines }
}
