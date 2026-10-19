import { HotLane } from '../../../lib/hotlane'
import { hashRequest } from '../../../lib/idempotency'
import { ConflictError, NotFoundError } from '../../../utils/errors'
import { publishBookingUpdate } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { staffBooking } from '../booking.rules'
import { bookingJson, num } from '../booking.view'
import { StaffActor } from './cancel-booking.mediator'

/** Front desk records cash collected against the balance due. Idempotent by key. */
export const collectBalanceMediator =
  (repo: BookingRepository, hotLane: HotLane) =>
  async (
    venueId: string,
    actor: StaffActor,
    bookingId: string,
    amountMinor: number,
    key: string,
  ) => {
    await staffBooking(repo, venueId, bookingId)
    return repo.idempotent(
      { scope: `collect:${venueId}`, key, hash: hashRequest({ b: bookingId, a: amountMinor }) },
      async (q) => {
        const b = await q.lockBooking(bookingId)
        if (!b || b.venue_id !== venueId)
          throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
        if (!['CONFIRMED', 'CHECKED_IN'].includes(b.status))
          throw new ConflictError(
            'Only a confirmed booking can take a payment',
            'BOOKING_NOT_CONFIRMED',
            { status: b.status },
          )
        const due = num(b.balance_due_minor)
        if (amountMinor > due)
          throw new ConflictError('That is more than the balance due', 'AMOUNT_EXCEEDS_BALANCE', {
            balanceDueMinor: due,
          })
        await q.collectCash(bookingId, amountMinor, due - amountMinor)
        await q.emit({
          type: 'balance.collected',
          routingKey: 'balance.collected',
          producer: 'booking',
          data: { bookingId, ref: b.ref, venueId, amountMinor, balanceDueMinor: due - amountMinor },
        })
        await q.audit({
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'BALANCE_COLLECTED',
          entity: 'booking',
          entityId: bookingId,
          after: { amountMinor, balanceDueMinor: due - amountMinor },
          ip: actor.ip,
        })
        const fresh = (await q.bookingById(bookingId))!
        return {
          status: 200,
          body: bookingJson(fresh, { now: await q.clock() }),
          after: () =>
            publishBookingUpdate(hotLane, {
              bookingId,
              ref: b.ref,
              venueId,
              userId: b.user_id,
              status: b.status,
            }),
        }
      },
    )
  }
