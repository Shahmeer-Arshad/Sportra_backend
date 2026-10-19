/**
 * Business rules shared by several booking use-cases. They read through the repository and throw
 * AppErrors; they never write SQL themselves.
 */
import { createHash } from 'crypto'
import { isLockContention, isTxTimeout, pgError } from '../../lib/pgerror'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors'
import { SlotLike, checkConsecutive, makeBookingRef, normalizePhone } from './booking.domain'
import { BookingQueries } from './booking.repository'
import { NewBooking } from './repositories/booking.queries'
import { BookingRowRaw } from './repositories/columns'

/** A lost lock race or an exhausted pool is a clean 409 for the caller, never a 500. */
export function mapContention(e: unknown): never {
  if (isLockContention(e) || isTxTimeout(e))
    throw new ConflictError(
      'Those hours are being booked by someone else, try again',
      'SLOT_UNAVAILABLE',
      { reason: 'CONTENTION' },
    )
  throw e
}

/** Maps what the SQL function cancel_booking_items raises to API errors. */
export function mapCancelError(e: unknown): never {
  const pg = pgError(e)
  if (!pg) throw e
  const m = pg.message
  if (m.startsWith('BOOKING_NOT_FOUND'))
    throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
  if (m.startsWith('FORBIDDEN'))
    throw new ForbiddenError('You cannot cancel this booking', 'FORBIDDEN')
  if (m.startsWith('BOOKING_NOT_CANCELLABLE'))
    throw new ConflictError(
      'This booking cannot be cancelled in its current state',
      'BOOKING_NOT_CANCELLABLE',
      { status: m.split(':')[1] ?? null },
    )
  if (m.startsWith('ITEM_ALREADY_STARTED'))
    throw new ConflictError('That hour has already started', 'ITEM_ALREADY_STARTED')
  if (m.startsWith('ITEM_NOT_CANCELLABLE'))
    throw new ConflictError(
      'One or more hours cannot be cancelled (unknown or already cancelled)',
      'ITEM_NOT_CANCELLABLE',
    )
  if (m.startsWith('IDEMPOTENCY_CONFLICT'))
    throw new ConflictError(
      'This Idempotency-Key was already used for a different request',
      'IDEMPOTENCY_CONFLICT',
    )
  if (m.startsWith('NO_ITEMS_SPECIFIED') || m.startsWith('INVALID_ARGUMENT'))
    throw new BadRequestError('Invalid cancellation request', 'VALIDATION_ERROR')
  throw e
}

/** Stable UUID derived from a string, so a retried job reuses the same cancellation id. */
export const derivedUuid = (s: string) => {
  const h = createHash('sha256').update(s).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ───────────── requested hours: validation without locking ─────────────
export interface RequestedSlot {
  id: string
  courtId: string
  venueId: string
  startAt: Date
  endAt: Date
  priceMinor: bigint
  status: string
}
export interface VenueInfo {
  id: string
  name: string
  city: string
  timezone: string
  cancellationCutoffHours: number
  verified: boolean
  isActive: boolean
}

/**
 * Cheap pre-checks on the requested hours: they exist, one court, consecutive, not in the past.
 * This reads without locking; the real guarantee is acquire under row locks.
 */
export async function resolveRequestedSlots(
  q: BookingQueries,
  o: {
    slotIds: string[]
    courtId?: string
    venueId?: string
    maxSlots: number
    /** holds need a future start; POS may sell the hour that is currently being played */
    pastRule: 'START_IN_FUTURE' | 'END_IN_FUTURE'
  },
): Promise<{ slots: RequestedSlot[]; venue: VenueInfo; courtName: string }> {
  const slots: RequestedSlot[] = (await q.requestedSlots(o.slotIds)).map((r) => ({
    id: r.id,
    courtId: r.court_id,
    venueId: r.venue_id,
    startAt: r.start_at,
    endAt: r.end_at,
    priceMinor: r.price_minor,
    status: r.status,
  }))
  if (new Set(o.slotIds).size !== o.slotIds.length)
    throw new BadRequestError('Duplicate hours in the request', 'INVALID_SLOT_SELECTION', {
      reason: 'DUPLICATE_SLOTS',
    })
  if (slots.length !== o.slotIds.length)
    throw new NotFoundError('One or more hours do not exist', 'SLOT_NOT_FOUND')
  const bad = checkConsecutive(slots as unknown as SlotLike[], o.maxSlots)
  if (bad)
    throw new BadRequestError(
      bad === 'NOT_CONSECUTIVE'
        ? 'Hours must be consecutive'
        : bad === 'TOO_MANY_SLOTS'
          ? `You can select at most ${o.maxSlots} hours`
          : bad === 'DIFFERENT_COURTS'
            ? 'All hours must be on the same court'
            : 'Invalid hour selection',
      'INVALID_SLOT_SELECTION',
      { reason: bad },
    )
  const first = slots[0]
  if (o.courtId && first.courtId !== o.courtId)
    throw new BadRequestError('Those hours are not on that court', 'INVALID_SLOT_SELECTION', {
      reason: 'WRONG_COURT',
    })
  if (o.venueId && first.venueId !== o.venueId)
    throw new NotFoundError('One or more hours do not exist', 'SLOT_NOT_FOUND')

  const now = Date.now()
  const past = slots.some((s) =>
    o.pastRule === 'START_IN_FUTURE' ? s.startAt.getTime() <= now : s.endAt.getTime() <= now,
  )
  if (past) throw new BadRequestError('Those hours are in the past', 'SLOT_IN_PAST')

  const v = await q.venueById(first.venueId)
  const court = await q.courtById(first.courtId)
  if (!v || !court) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
  return {
    slots: slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime()),
    venue: {
      id: v.id,
      name: v.name,
      city: v.city,
      timezone: v.timezone,
      cancellationCutoffHours: v.cancellationCutoffHours,
      verified: v.verificationStatus === 'VERIFIED',
      isActive: v.isActive && court.isActive,
    },
    courtName: court.name,
  }
}

/** Phone numbers a venue has blocked (compared in one normalised shape). */
export async function isBlocklisted(
  q: BookingQueries,
  venueId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  if (!phone) return false
  return q.isBlocklisted(venueId, normalizePhone(phone))
}

/** Insert a booking with a fresh readable ref (KHI-7F3K2). A ref collision just picks another ref. */
export async function allocateBooking(
  q: BookingQueries,
  b: Omit<NewBooking, 'ref'> & { city: string },
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = makeBookingRef(b.city)
    if (await q.insertBooking({ ...b, ref })) return ref
  }
  throw new ConflictError('Could not allocate a booking reference, try again', 'REF_COLLISION')
}

/** Create the itemised lines and check every hour got one. */
export async function itemise(
  q: BookingQueries,
  bookingId: string,
  expected: number,
  onlinePaid = 0n,
  deposit = 0n,
) {
  if ((await q.createItems(bookingId, onlinePaid, deposit)) !== expected)
    throw new ConflictError('Could not itemise the booking', 'ITEMISE_FAILED')
}

/** Venue and court names for a booking view. */
export async function namesOf(q: BookingQueries, venueId: string, courtId: string) {
  const [v, c] = await Promise.all([q.venueName(venueId), q.courtName(courtId)])
  return { venueName: v?.name, courtName: c?.name }
}

/** The player's own booking; somebody else's looks exactly like a missing one. */
export async function ownedBooking(
  q: BookingQueries,
  userId: string,
  bookingId: string,
): Promise<BookingRowRaw> {
  const b = await q.bookingById(bookingId)
  if (!b || b.user_id !== userId) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
  return b
}

/** A booking of this venue; one of another venue looks exactly like a missing one. */
export async function staffBooking(
  q: BookingQueries,
  venueId: string,
  bookingId: string,
): Promise<BookingRowRaw> {
  const b = await q.bookingById(bookingId)
  if (!b || b.venue_id !== venueId)
    throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
  return b
}

export async function assertCourtsOfVenue(q: BookingQueries, venueId: string, courtIds: string[]) {
  if ((await q.courtCountInVenue(venueId, courtIds)) !== new Set(courtIds).size)
    throw new NotFoundError('One or more courts do not belong to this venue', 'COURT_NOT_FOUND')
}

/** Parses and validates a [from, to) window from the request. */
export function parseWindow(input: { from: string; to: string }) {
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (!(to > from)) throw new BadRequestError('"to" must be after "from"', 'VALIDATION_ERROR')
  return { from, to }
}
