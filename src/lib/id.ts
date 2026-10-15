import { randomBytes } from 'crypto'

/** UUID v7 (time-ordered). IDs are generated in the app, never by the database. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16)
  b.writeUIntBE(now, 0, 6) // 48-bit unix ms timestamp
  b[6] = (b[6] & 0x0f) | 0x70 // version 7
  b[8] = (b[8] & 0x3f) | 0x80 // variant
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
