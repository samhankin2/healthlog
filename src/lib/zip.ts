/**
 * Minimal ZIP reader for the browser — no dependency. Reads the central
 * directory from the end of the file, then inflates only the entries asked for
 * with the platform's `DecompressionStream('deflate-raw')`, so a 25 MB Garmin
 * export never has to be held in memory whole.
 *
 * Supports stored (0) and deflate (8) entries. ZIP64 archives are rejected
 * with a clear error (a Garmin export is far below the 4 GB limit).
 */

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer())
}

const decoder = new TextDecoder()

/** List every entry in the archive. */
export async function listZip(blob: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(blob.size, 65_557) // EOCD (22) + max comment (65 535)
  const tail = await bytes(blob, blob.size - tailSize, blob.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('This is not a ZIP file.')
  const count = tail.getUint16(eocd + 10, true)
  const dirSize = tail.getUint32(eocd + 12, true)
  const dirOffset = tail.getUint32(eocd + 16, true)
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.')

  const dir = await bytes(blob, dirOffset, dirOffset + dirSize)
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count && p + 46 <= dir.byteLength; i++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new Error('The ZIP directory is damaged.')
    const method = dir.getUint16(p + 10, true)
    const compressedSize = dir.getUint32(p + 20, true)
    const size = dir.getUint32(p + 24, true)
    const nameLen = dir.getUint16(p + 28, true)
    const extraLen = dir.getUint16(p + 30, true)
    const commentLen = dir.getUint16(p + 32, true)
    const localOffset = dir.getUint32(p + 42, true)
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen))
    entries.push({ name, method, compressedSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Inflate one entry to text. */
export async function readZipText(blob: Blob, entry: ZipEntry): Promise<string> {
  const head = await bytes(blob, entry.localOffset, entry.localOffset + 30)
  if (head.getUint32(0, true) !== LOCAL) throw new Error(`ZIP entry ${entry.name} is damaged.`)
  const start = entry.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true)
  const data = blob.slice(start, start + entry.compressedSize)
  if (entry.method === 0) return data.text()
  if (entry.method !== 8) throw new Error(`ZIP entry ${entry.name} uses an unsupported compression method.`)
  const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}
