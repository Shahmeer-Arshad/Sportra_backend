import { HotLane } from '../../../lib/hotlane'
import { uuidv7 } from '../../../lib/id'
import { hashRequest } from '../../../lib/idempotency'
import { BadRequestError } from '../../../utils/errors'
import { normalizePhone } from '../booking.domain'
import { isoDate } from '../booking.inventory'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import {
  allocateBooking,
  itemise,
  mapContention,
  namesOf,
  resolveRequestedSlots,
} from '../booking.rules'
import { bookingJson, num } from '../booking.view'
import { StaffActor } from './cancel-booking.mediator'

export interface StaffBookingInput {
  courtId: string
  slotIds: string[]
  customerName: string
  customerPhone: string
  cashCollectedMinor?: number
  payLater?: boolean
  headcount?: number
}

/** Front desk records a walk-in or a phone/WhatsApp booking; the hours are taken like an online hold. */
export const staffBookingMediator = (repo: BookingRepository, hotLane: HotLane) => {
  async function create(
    kind: 'WALKIN' | 'MANUAL',
    venueId: string,
    actor: StaffActor,
    input: StaffBookingInput,
    key: string,
  ) {
    const { slots, venue } = await resolveRequestedSlots(repo, {
      slotIds: input.slotIds,
      courtId: input.courtId,
      venueId,
      maxSlots: 12,
      pastRule: 'END_IN_FUTURE',
    })
    const total = slots.reduce((a, s) => a + s.priceMinor, 0n)
    // walk-in: cash collected defaults to the full price. manual: pay later keeps the balance open
    const cash =
      kind === 'MANUAL' && input.payLater
        ? 0n
        : input.cashCollectedMinor !== undefined
          ? BigInt(input.cashCollectedMinor)
          : kind === 'WALKIN'
            ? total
            : 0n
    if (cash > total)
      throw new BadRequestError('Cash collected cannot exceed the price', 'CASH_EXCEEDS_TOTAL', {
        totalMinor: num(total),
      })
    const name = input.customerName.trim()
    if (!name) throw new BadRequestError('Customer name is required', 'VALIDATION_ERROR')

    try {
      return await repo.idempotent(
        {
          scope: `${kind.toLowerCase()}:${venueId}`,
          key,
          hash: hashRequest({
            c: input.courtId,
            s: [...input.slotIds].sort(),
            n: name,
            p: input.customerPhone,
            cash: String(cash),
            l: !!input.payLater,
          }),
        },
        async (q) => {
          await q.setLockTimeout('500ms')
          const bookingId = uuidv7()
          // same acquire as an online hold: an active hold gives 409 SLOT_HELD with seconds left
          const { rows, updates, now } = await q.acquire({
            target: 'BOOKED_WALKIN',
            slotIds: input.slotIds,
            bookingId,
            heldCode: 'SLOT_HELD',
          })
          const ordered = [...rows].sort((a, b) => a.start_at.getTime() - b.start_at.getTime())
          const totalMinor = ordered.reduce((a, r) => a + r.price_minor, 0n)
          const ref = await allocateBooking(q, {
            id: bookingId,
            venueId,
            city: venue.city,
            courtId: input.courtId,
            userId: null,
            source: kind,
            customerName: name,
            customerPhone: normalizePhone(input.customerPhone),
            headcount: input.headcount ?? null,
            status: 'CONFIRMED',
            paymentMode: 'CASH_ONLY',
            paymentStatus: cash >= totalMinor ? 'PAID' : 'UNPAID',
            startAt: ordered[0].start_at,
            endAt: ordered[ordered.length - 1].end_at,
            businessDate: isoDate(ordered[0].business_date),
            totalMinor,
            cutoffHours: venue.cancellationCutoffHours,
            slotIds: ordered.map((r) => r.id),
            cashCollectedMinor: cash,
            createdBy: actor.id,
          })
          await itemise(q, bookingId, ordered.length)
          const data = {
            bookingId,
            ref,
            venueId,
            courtId: input.courtId,
            source: kind,
            customerName: name,
            totalMinor: num(totalMinor),
            cashCollectedMinor: num(cash),
            balanceDueMinor: num(totalMinor - cash),
            startAt: ordered[0].start_at,
            endAt: ordered[ordered.length - 1].end_at,
          }
          // ledger writes WALKIN_CASH from walkin.recorded (Phase 3)
          const type = kind === 'WALKIN' ? 'walkin.recorded' : 'booking.confirmed'
          await q.emit({ type, routingKey: type, producer: 'booking', data })
          await q.audit({
            actorId: actor.id,
            actorType: 'STAFF',
            venueId,
            action: kind === 'WALKIN' ? 'WALKIN_RECORDED' : 'MANUAL_BOOKING_CREATED',
            entity: 'booking',
            entityId: bookingId,
            after: data,
            ip: actor.ip,
          })
          const b = (await q.bookingById(bookingId))!
          const items = await q.bookingItems(bookingId)
          return {
            status: 201,
            body: bookingJson(b, { now, items, ...(await namesOf(q, venueId, input.courtId)) }),
            after: () => {
              publishSlotUpdates(hotLane, updates)
              publishBookingUpdate(hotLane, {
                bookingId,
                ref,
                venueId,
                userId: null,
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

  return {
    walkIn: (venueId: string, actor: StaffActor, input: StaffBookingInput, key: string) =>
      create('WALKIN', venueId, actor, input, key),
    manual: (venueId: string, actor: StaffActor, input: StaffBookingInput, key: string) =>
      create('MANUAL', venueId, actor, input, key),
  }
}
