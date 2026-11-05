import { uuidv7 } from '../../../lib/id'
import { todayIn } from '../../../lib/time'
import { BadRequestError, ConflictError, NotFoundError } from '../../../utils/errors'
import { BookingRepository } from '../booking.repository'
import { num } from '../booking.view'
import { StaffActor } from './cancel-booking.mediator'

export interface CloseDayInput {
  businessDate: string
  countedCashMinor: number
  notes?: string | null
}

/** Closing a day: the expected cash is always computed server-side, never trusted from the client. */
export const closeDayMediator = (repo: BookingRepository) => ({
  async close(venueId: string, actor: StaffActor, input: CloseDayInput) {
    const venue = await repo.venueById(venueId)
    if (!venue) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
    const today = todayIn(venue.timezone)
    if (input.businessDate > today)
      throw new BadRequestError("Can't close a day that hasn't happened yet", 'DATE_IN_FUTURE')

    return repo.transaction(async (q) => {
      const totals = await q.ledgerTotalsForDay(venueId, input.businessDate)
      const expected = {
        walkinCashMinor: num(totals.walkinCashMinor),
        cashCollectedMinor: num(totals.cashCollectedMinor),
        cashRefundMinor: num(totals.cashRefundMinor),
        expectedCashMinor: num(totals.expectedCashMinor),
      }
      const now = await q.clock()
      const id = uuidv7()
      const ok = await q.insertClosing({
        id,
        venueId,
        businessDate: input.businessDate,
        expected,
        countedCashMinor: BigInt(input.countedCashMinor),
        varianceMinor: BigInt(input.countedCashMinor) - totals.expectedCashMinor,
        notes: input.notes ?? null,
        closedBy: actor.id,
        closedAt: now,
        ledgerWatermark: now,
      })
      if (!ok)
        throw new ConflictError(
          `${input.businessDate} is already closed for this venue`,
          'ALREADY_CLOSED',
        )
      await q.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'DAY_CLOSED',
        entity: 'daily_closing',
        entityId: id,
        after: { businessDate: input.businessDate, countedCashMinor: input.countedCashMinor, expected },
        ip: actor.ip,
      })
      const closing = await q.getClosing(venueId, input.businessDate)
      return {
        id,
        venueId,
        businessDate: input.businessDate,
        expected,
        countedCashMinor: input.countedCashMinor,
        varianceMinor: num(closing!.variance_minor),
        notes: closing!.notes,
        status: closing!.status,
        closedBy: closing!.closed_by,
        closedAt: closing!.closed_at.toISOString(),
      }
    })
  },

  async reopen(venueId: string, actor: StaffActor, businessDate: string, reason: string) {
    return repo.transaction(async (q) => {
      const ok = await q.reopenClosing(venueId, businessDate, actor.id, reason)
      if (!ok)
        throw new NotFoundError(
          `${businessDate} has no closed day to reopen for this venue`,
          'CLOSING_NOT_FOUND',
        )
      await q.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'DAY_REOPENED',
        entity: 'daily_closing',
        entityId: businessDate,
        after: { reason },
        ip: actor.ip,
      })
      const closing = await q.getClosing(venueId, businessDate)
      return {
        venueId,
        businessDate,
        status: closing!.status,
        reopenedBy: closing!.reopened_by,
        reopenedAt: closing!.reopened_at!.toISOString(),
        reopenReason: closing!.reopen_reason,
      }
    })
  },
})
export type CloseDayMediator = ReturnType<typeof closeDayMediator>
