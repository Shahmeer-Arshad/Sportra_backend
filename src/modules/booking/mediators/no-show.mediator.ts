import { env } from '../../../config/env'
import { HotLane } from '../../../lib/hotlane'
import { ConflictError } from '../../../utils/errors'
import { publishBookingUpdate } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { staffBooking } from '../booking.rules'
import { bookingJson, num } from '../booking.view'
import { StaffActor } from './cancel-booking.mediator'

/** Front desk marks a no-show once the grace period has passed. The deposit is forfeited. */
export const noShowMediator =
  (repo: BookingRepository, hotLane: HotLane) =>
  async (venueId: string, actor: StaffActor, bookingId: string) => {
    await staffBooking(repo, venueId, bookingId)
    const out = await repo.transaction(async (q) => {
      const b = (await q.lockBooking(bookingId))!
      if (b.status === 'NO_SHOW') return { replayed: true, b }
      if (b.status !== 'CONFIRMED')
        throw new ConflictError(
          'Only a confirmed booking can be a no-show',
          'BOOKING_NOT_CONFIRMED',
          {
            status: b.status,
          },
        )
      const now = await q.clock()
      const earliest = new Date(b.start_at.getTime() + env.NO_SHOW_AFTER_MINUTES * 60_000)
      if (now < earliest)
        throw new ConflictError(
          `A no-show can be marked ${env.NO_SHOW_AFTER_MINUTES} minutes after the start`,
          'TOO_EARLY_FOR_NO_SHOW',
          { earliest: earliest.toISOString() },
        )
      // the deposit (online money, Phase 3) is forfeited; pay-at-venue bookings have none
      await q.markNoShow(bookingId, now)
      // one app, one database: the strike is counted in the same transaction (an event would add a race)
      if (b.user_id) await q.addNoShowStrike(b.user_id)
      await q.emit({
        type: 'booking.no_show',
        routingKey: 'booking.no_show',
        producer: 'booking',
        data: {
          bookingId,
          ref: b.ref,
          venueId,
          userId: b.user_id,
          depositMinor: num(b.deposit_minor),
        },
      })
      await q.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'BOOKING_NO_SHOW',
        entity: 'booking',
        entityId: bookingId,
        before: { status: 'CONFIRMED' },
        after: { status: 'NO_SHOW' },
        ip: actor.ip,
      })
      return { replayed: false, b: (await q.bookingById(bookingId))! }
    })
    if (!out.replayed)
      publishBookingUpdate(hotLane, {
        bookingId,
        ref: out.b.ref,
        venueId,
        userId: out.b.user_id,
        status: 'NO_SHOW',
      })
    return { replayed: out.replayed, booking: bookingJson(out.b, { now: await repo.clock() }) }
  }
