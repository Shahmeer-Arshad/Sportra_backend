import { env } from '../../../config/env'
import { HotLane } from '../../../lib/hotlane'
import { hashRequest } from '../../../lib/idempotency'
import { ConflictError, ForbiddenError, NotFoundError } from '../../../utils/errors'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { isBlocklisted, itemise, mapContention, namesOf, ownedBooking } from '../booking.rules'
import { bookingJson, num } from '../booking.view'

/** Pilot: the player confirms a held booking and pays cash at the venue. */
export const payAtVenueMediator =
  (repo: BookingRepository, hotLane: HotLane) =>
  async (userId: string, bookingId: string, key: string) => {
    const b0 = await ownedBooking(repo, userId, bookingId)
    const settings = await repo.bookingSettings(b0.venue_id)
    if (!settings?.payAtVenueEnabled)
      throw new ForbiddenError(
        'This venue does not take pay-at-venue bookings',
        'PAY_AT_VENUE_DISABLED',
      )
    const user = await repo.userContact(userId)
    if (
      (await isBlocklisted(repo, b0.venue_id, b0.customer_phone)) ||
      (await isBlocklisted(repo, b0.venue_id, user?.phone))
    )
      throw new ForbiddenError('This venue cannot take your booking', 'BLOCKED_BY_VENUE')

    try {
      return await repo.idempotent(
        { scope: `reserve:${userId}`, key, hash: hashRequest({ b: bookingId }) },
        async (q) => {
          await q.setLockTimeout('2s')
          await q.advisoryLock(`user-unpaid:${userId}`)
          const b = await q.lockBooking(bookingId)
          if (!b || b.user_id !== userId)
            throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
          if (b.status !== 'PENDING_PAYMENT')
            throw new ConflictError(
              b.status === 'EXPIRED'
                ? 'Your hold has expired'
                : 'This booking is not waiting for confirmation',
              b.status === 'EXPIRED' ? 'HOLD_EXPIRED' : 'BOOKING_NOT_PENDING',
              { status: b.status },
            )
          if ((await q.unpaidBookings(userId)) >= env.MAX_UNPAID_BOOKINGS)
            throw new ConflictError(
              `You can have ${env.MAX_UNPAID_BOOKINGS} unpaid booking at a time. Pay or cancel it first.`,
              'UNPAID_LIMIT_REACHED',
            )
          const { updates } = await q.confirmHold({
            id: b.id,
            hold_id: b.hold_id as string,
            slot_ids: b.slot_ids,
          })
          await itemise(q, b.id, b.slot_ids.length)
          await q.confirmPayAtVenue(b.id)
          await q.emit({
            type: 'booking.confirmed',
            routingKey: 'booking.confirmed',
            producer: 'booking',
            data: {
              bookingId: b.id,
              ref: b.ref,
              venueId: b.venue_id,
              userId,
              source: 'APP',
              payAtVenue: true,
              totalMinor: num(b.total_minor),
              balanceDueMinor: num(b.total_minor),
              startAt: b.start_at,
              endAt: b.end_at,
            },
          })
          await q.audit({
            actorId: userId,
            actorType: 'USER',
            venueId: b.venue_id,
            action: 'BOOKING_RESERVED_PAY_AT_VENUE',
            entity: 'booking',
            entityId: b.id,
            after: { ref: b.ref, totalMinor: num(b.total_minor) },
          })
          const fresh = (await q.bookingById(b.id))!
          const items = await q.bookingItems(b.id)
          return {
            status: 200,
            body: bookingJson(fresh, {
              now: await q.clock(),
              items,
              ...(await namesOf(q, b.venue_id, b.court_id)),
            }),
            after: () => {
              publishSlotUpdates(hotLane, updates)
              publishBookingUpdate(hotLane, {
                bookingId: b.id,
                ref: b.ref,
                venueId: b.venue_id,
                userId,
                status: 'CONFIRMED',
              })
            },
          }
        },
      )
    } catch (e) {
      return mapContention(e)
    }
  }
