import { HotLane } from '../../../lib/hotlane'
import { ConflictError } from '../../../utils/errors'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { ownedBooking } from '../booking.rules'
import { bookingJson } from '../booking.view'

/** The player gives the hours back. Idempotent. */
export const releaseHoldMediator =
  (repo: BookingRepository, hotLane: HotLane) => async (userId: string, bookingId: string) => {
    const b0 = await ownedBooking(repo, userId, bookingId)
    if (b0.status !== 'PENDING_PAYMENT' && b0.status !== 'EXPIRED')
      throw new ConflictError('This booking is not a hold', 'NOT_A_HOLD', { status: b0.status })
    const out = await repo.transaction(async (q) => {
      const b = (await q.lockBooking(bookingId))!
      if (b.status !== 'PENDING_PAYMENT') return { updates: [], b }
      const updates = await q.releaseHold(b.hold_id as string)
      await q.expireBooking(bookingId)
      await q.emit({
        type: 'booking.hold_released',
        routingKey: 'booking.hold_released',
        producer: 'booking',
        data: { bookingId, venueId: b.venue_id, userId },
      })
      return { updates, b }
    })
    publishSlotUpdates(hotLane, out.updates)
    if (out.updates.length)
      publishBookingUpdate(hotLane, {
        bookingId,
        ref: out.b.ref,
        venueId: out.b.venue_id,
        userId,
        status: 'EXPIRED',
      })
    const fresh = (await repo.bookingById(bookingId))!
    return bookingJson(fresh, { now: await repo.clock() })
  }
