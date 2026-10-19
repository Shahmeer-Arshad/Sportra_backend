/**
 * Pure booking rules (no database, no I/O): slot state machine, slot planning from opening hours,
 * consecutive-hour validation, cancellation amounts, booking refs and QR entry passes.
 * Unit-tested on their own.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { addDays, zonedTimeToUtc } from '../../lib/time'
import {
  HoursWindow,
  OperatingHours,
  PriceRule,
  resolvePrice,
  slotStarts,
  weekdayKey,
} from '../venue/venue.domain'

// ───────────── slot state machine ─────────────
export type SlotStatus = 'AVAILABLE' | 'HELD' | 'BOOKED_APP' | 'BOOKED_WALKIN' | 'BLOCKED'
export const SLOT_STATUSES: SlotStatus[] = [
  'AVAILABLE',
  'HELD',
  'BOOKED_APP',
  'BOOKED_WALKIN',
  'BLOCKED',
]

/** Legal transitions (Backend_Docs/03 section 8.1). Anything else is 409 INVALID_SLOT_TRANSITION. */
const SLOT_TRANSITIONS: Record<SlotStatus, SlotStatus[]> = {
  AVAILABLE: ['HELD', 'BOOKED_WALKIN', 'BLOCKED'],
  HELD: ['BOOKED_APP', 'AVAILABLE'],
  BOOKED_APP: ['AVAILABLE', 'BLOCKED'],
  BOOKED_WALKIN: ['AVAILABLE'],
  BLOCKED: ['AVAILABLE'],
}
export const canTransition = (from: SlotStatus, to: SlotStatus) =>
  SLOT_TRANSITIONS[from].includes(to)

/** What a player may see: a held slot is just "held by someone", bookings are just "booked". */
export function publicStatus(s: SlotStatus): 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED' {
  if (s === 'BOOKED_APP' || s === 'BOOKED_WALKIN') return 'BOOKED'
  return s
}

/** A held slot whose hold has run out counts as free (lazy reclaim). */
export function effectiveStatus(
  s: { status: SlotStatus; holdExpiresAt: Date | null },
  now: Date,
): SlotStatus {
  return s.status === 'HELD' && s.holdExpiresAt && s.holdExpiresAt.getTime() <= now.getTime()
    ? 'AVAILABLE'
    : s.status
}

// ───────────── consecutive hours ─────────────
export interface SlotLike {
  id: string
  courtId: string
  startAt: Date
  endAt: Date
}

/**
 * 1..maxSlots slots, one court, each starting exactly when the previous one ends.
 * Returns an error code or null. Sorts a copy, so input order does not matter.
 */
export function checkConsecutive(slots: SlotLike[], maxSlots: number): string | null {
  if (slots.length === 0) return 'NO_SLOTS'
  if (slots.length > maxSlots) return 'TOO_MANY_SLOTS'
  if (new Set(slots.map((s) => s.id)).size !== slots.length) return 'DUPLICATE_SLOTS'
  if (new Set(slots.map((s) => s.courtId)).size !== 1) return 'DIFFERENT_COURTS'
  const sorted = [...slots].sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startAt.getTime() !== sorted[i - 1].endAt.getTime()) return 'NOT_CONSECUTIVE'
  }
  return null
}

// ───────────── slot planning (generation) ─────────────
export interface PlannedSlot {
  startAt: Date
  endAt: Date
  businessDate: string
  priceMinor: bigint
  priceTag: 'PEAK' | 'OFF_PEAK'
}

/**
 * Slots a court should have between two business dates (inclusive), from its opening hours and
 * price rules. Pure and deterministic. A window that crosses midnight keeps the business date of
 * the day it opened on (a 1 AM slot belongs to the previous day). Times are converted with the
 * IANA zone, so daylight saving is handled. Slots with no matching price rule are skipped.
 */
export function planSlots(input: {
  hours: OperatingHours
  slotMinutes: number
  tz: string
  rules: PriceRule[]
  fromDate: string
  toDate: string
}): PlannedSlot[] {
  const out: PlannedSlot[] = []
  const seen = new Set<number>()
  for (let date = input.fromDate; date <= input.toDate; date = addDays(date, 1)) {
    const windows: HoursWindow[] = input.hours[weekdayKey(date)] ?? []
    for (const w of windows) {
      for (const minute of slotStarts(w, input.slotMinutes)) {
        const startAt = zonedTimeToUtc(date, minute, input.tz)
        if (seen.has(startAt.getTime())) continue // two windows touching the same instant
        seen.add(startAt.getTime())
        const price = resolvePrice(input.rules, startAt, input.tz)
        if (!price) continue
        out.push({
          startAt,
          endAt: new Date(startAt.getTime() + input.slotMinutes * 60_000),
          businessDate: date,
          priceMinor: price.priceMinor,
          priceTag: price.tag,
        })
      }
    }
  }
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
}

// ───────────── cancellation amounts ─────────────
export type CancelledBy = 'USER' | 'VENUE' | 'SYSTEM'
export interface PreviewItem {
  id: string
  startAt: Date
  priceMinor: bigint
  onlinePaidMinor: bigint
  depositShareMinor: bigint
}
export interface PreviewLine {
  itemId: string
  startAt: Date
  priceMinor: bigint
  refundDueMinor: bigint
  forfeitMinor: bigint
  /** false when a player tries to cancel an hour that has already started */
  cancellable: boolean
  fullRefund: boolean
}

/**
 * What cancelling the given hours would refund and forfeit. Same arithmetic as the SQL function
 * cancel_booking_items (a parity test keeps them identical). Judged per hour against that hour's
 * own start time: before the cutoff or venue-caused = refund everything paid for the hour; after the
 * cutoff by the player = forfeit the hour's deposit share, refund the rest.
 */
export function computeCancelPreview(
  items: PreviewItem[],
  opts: { cancelledBy: CancelledBy; cutoffHours: number; now: Date },
) {
  const cutoffMs = opts.cutoffHours * 3_600_000
  const lines: PreviewLine[] = items.map((i) => {
    const fullRefund =
      opts.cancelledBy !== 'USER' || i.startAt.getTime() - cutoffMs > opts.now.getTime()
    return {
      itemId: i.id,
      startAt: i.startAt,
      priceMinor: i.priceMinor,
      refundDueMinor: fullRefund ? i.onlinePaidMinor : i.onlinePaidMinor - i.depositShareMinor,
      forfeitMinor: fullRefund ? 0n : i.depositShareMinor,
      cancellable: !(opts.cancelledBy === 'USER' && i.startAt.getTime() <= opts.now.getTime()),
      fullRefund,
    }
  })
  return {
    lines,
    refundDueMinor: lines.reduce((a, l) => a + l.refundDueMinor, 0n),
    forfeitMinor: lines.reduce((a, l) => a + l.forfeitMinor, 0n),
    allCancellable: lines.every((l) => l.cancellable),
  }
}

// ───────────── booking reference ─────────────
const CITY_CODES: Record<string, string> = {
  karachi: 'KHI',
  lahore: 'LHE',
  islamabad: 'ISB',
  rawalpindi: 'RWP',
  peshawar: 'PEW',
  quetta: 'UET',
  faisalabad: 'LYP',
  multan: 'MUX',
}
// Crockford-style base32 without I, L, O, U, 0, 1 (hard to read out over the phone)
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

export function cityCode(city: string): string {
  const known = CITY_CODES[city.trim().toLowerCase()]
  if (known) return known
  const letters = city.replace(/[^a-zA-Z]/g, '').toUpperCase()
  return (letters + 'XXX').slice(0, 3)
}

/** e.g. KHI-7F3K2. Collisions are handled by the unique index plus a retry in the service. */
export function makeBookingRef(city: string): string {
  const bytes = randomBytes(5)
  let s = ''
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length]
  return `${cityCode(city)}-${s}`
}
export const REF_PATTERN = /^[A-Z]{3}-[2-9A-HJKMNP-TV-Z]{5}$/

// ───────────── QR entry pass ─────────────
export interface PassClaims {
  bid: string // booking id
  vid: string // venue id
  ref: string
  nbf: number // seconds, start - 2h
  exp: number // seconds, end + 2h
  jti: string
}
export type PassError = 'PASS_INVALID' | 'PASS_NOT_YET_VALID' | 'PASS_EXPIRED'
export class PassVerificationError extends Error {
  constructor(public readonly code: PassError) {
    super(code)
  }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const PASS_HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'PASS' }))

/** Signed, tamper-proof token. Holds no personal data, only ids and a time window. */
export function signPass(claims: PassClaims, secret: string): string {
  const body = `${PASS_HEADER}.${b64(JSON.stringify(claims))}`
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`
}

export function verifyPass(token: string, secret: string, nowMs = Date.now()): PassClaims {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PASS_HEADER)
    throw new PassVerificationError('PASS_INVALID')
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
  const given = Buffer.from(parts[2], 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new PassVerificationError('PASS_INVALID')
  let claims: PassClaims
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new PassVerificationError('PASS_INVALID')
  }
  if (
    !claims.bid ||
    !claims.vid ||
    typeof claims.nbf !== 'number' ||
    typeof claims.exp !== 'number'
  )
    throw new PassVerificationError('PASS_INVALID')
  if (nowMs / 1000 < claims.nbf) throw new PassVerificationError('PASS_NOT_YET_VALID')
  if (nowMs / 1000 > claims.exp) throw new PassVerificationError('PASS_EXPIRED')
  return claims
}

/** The window in which a booking may be checked in: from 2 hours before it starts to 2 hours after it ends. */
export function checkInWindow(startAt: Date, endAt: Date) {
  return {
    from: new Date(startAt.getTime() - 2 * 3_600_000),
    until: new Date(endAt.getTime() + 2 * 3_600_000),
  }
}

// ───────────── misc ─────────────
/** Likely no-show: confirmed, but nobody arrived within N minutes of the start. */
export function isLikelyNoShow(
  b: { status: string; startAt: Date },
  now: Date,
  afterMinutes: number,
) {
  return b.status === 'CONFIRMED' && now.getTime() >= b.startAt.getTime() + afterMinutes * 60_000
}

/** Phone numbers are compared in one shape: digits with a leading +. */
export function normalizePhone(p: string): string {
  const digits = p.replace(/[^0-9]/g, '')
  if (digits.startsWith('92')) return `+${digits}`
  if (digits.startsWith('0')) return `+92${digits.slice(1)}`
  return `+${digits}`
}
