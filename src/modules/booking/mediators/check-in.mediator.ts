import { HotLane } from '../../../lib/hotlane'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../utils/errors'
import { PassVerificationError, checkInWindow, verifyPass } from '../booking.domain'
import { publishBookingUpdate } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { staffBooking } from '../booking.rules'
import { bookingJson, num, qrSecret } from '../booking.view'
import { StaffActor } from './cancel-booking.mediator'

/** Which booking is being checked in: from the QR pass, the booking code, or the id. */
async function resolveBookingId(
  repo: BookingRepository,
  venueId: string,
  input: { bookingId?: string; token?: string; ref?: string },
) {
  let bookingId = input.bookingId
  if (input.token) {
    let claims
    try {
      claims = verifyPass(input.token, qrSecret())
    } catch (e) {
      if (e instanceof PassVerificationError)
        throw new ConflictError(
          e.code === 'PASS_INVALID'
            ? 'This QR pass is not valid'
            : e.code === 'PASS_EXPIRED'
              ? 'This QR pass has expired'
              : 'This QR pass is not valid yet',
          e.code,
        )
      throw e
    }
    if (claims.vid !== venueId)
      throw new ForbiddenError('This pass is for another venue', 'PASS_WRONG_VENUE')
    if (bookingId && bookingId !== claims.bid)
      throw new ForbiddenError('This pass belongs to another booking', 'PASS_MISMATCH')
    bookingId = claims.bid
  } else if (input.ref) {
    const r = await repo.bookingByRef(input.ref.trim().toUpperCase())
    if (!r || r.venueId !== venueId)
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
    bookingId = r.id
  }
  if (!bookingId)
    throw new BadRequestError('Provide a QR token or the booking code', 'VALIDATION_ERROR')
  return bookingId
}

/** Front desk checks a player in. Idempotent: a repeat answers with `replayed: true`. */
export const checkInMediator =
  (repo: BookingRepository, hotLane: HotLane) =>
  async (
    venueId: string,
    actor: StaffActor,
    input: { bookingId?: string; token?: string; ref?: string },
  ) => {
    const bookingId = await resolveBookingId(repo, venueId, input)
    const pre = await staffBooking(repo, venueId, bookingId)

    const win = checkInWindow(pre.start_at, pre.end_at)
    const out = await repo.transaction(async (q) => {
      const b = (await q.lockBooking(bookingId))!
      if (b.status === 'CHECKED_IN') return { replayed: true, b }
      if (b.status !== 'CONFIRMED')
        throw new ConflictError(
          'Only a confirmed booking can be checked in',
          'BOOKING_NOT_CONFIRMED',
          {
            status: b.status,
          },
        )
      const now = await q.clock()
      const w = checkInWindow(b.start_at, b.end_at)
      if (now < w.from || now > w.until)
        throw new ConflictError(
          'This booking cannot be checked in at this time',
          'OUTSIDE_CHECKIN_WINDOW',
          { from: win.from.toISOString(), until: win.until.toISOString() },
        )
      await q.markCheckedIn(b.id, now)
      await q.emit({
        type: 'booking.checked_in',
        routingKey: 'booking.checked_in',
        producer: 'booking',
        data: { bookingId: b.id, ref: b.ref, venueId, userId: b.user_id, at: now },
      })
      await q.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'BOOKING_CHECKED_IN',
        entity: 'booking',
        entityId: b.id,
        before: { status: 'CONFIRMED' },
        after: { status: 'CHECKED_IN' },
        ip: actor.ip,
      })
      return { replayed: false, b: (await q.bookingById(b.id))! }
    })
    if (!out.replayed)
      publishBookingUpdate(hotLane, {
        bookingId: out.b.id,
        ref: out.b.ref,
        venueId,
        userId: out.b.user_id,
        status: 'CHECKED_IN',
      })
    return {
      replayed: out.replayed,
      booking: bookingJson(out.b, { now: await repo.clock() }),
      balanceDueMinor: num(out.b.balance_due_minor),
    }
  }
