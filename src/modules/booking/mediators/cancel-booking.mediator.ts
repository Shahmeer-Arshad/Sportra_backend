import { HotLane } from '../../../lib/hotlane'
import { todayIn } from '../../../lib/time'
import { BadRequestError } from '../../../utils/errors'
import { BookingRepository } from '../booking.repository'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { mapCancelError, ownedBooking, staffBooking } from '../booking.rules'
import { CancelCommand, CancelResult, cancelResponse } from '../booking.view'

export interface StaffActor {
  id: string
  role: 'OWNER' | 'MANAGER' | 'FRONT_DESK' | 'ADMIN'
  ip?: string | null
}

/** Only set by the staff/manager POS cancel route; never reachable from the player's own cancel. */
export interface CashRefund {
  amountMinor: number
  recordedBy: string
}

/**
 * One transaction: the SQL function owns every invariant, and — when the staff cancel route
 * handed over a physical cash refund — the matching REFUND_OUT ledger row commits with it. A
 * replay (same cancellationId again) neither re-cancels nor posts a second refund.
 */
export const cancelBookingMediator = (repo: BookingRepository, hotLane: HotLane) => {
  async function run(cmd: CancelCommand, cashRefund?: CashRefund): Promise<CancelResult> {
    let result: CancelResult
    try {
      result = await repo.transaction(
        async (q) => {
          const r = await q.cancelBookingItems(cmd)
          if (!r.replayed && cashRefund && cashRefund.amountMinor > 0) {
            const [now, venue] = await Promise.all([q.clock(), q.venueById(r.venueId)])
            await q.postLedgerEntry({
              venueId: r.venueId,
              businessDate: todayIn(venue?.timezone, now),
              entryType: 'REFUND_OUT',
              direction: 'DEBIT',
              amountMinor: BigInt(cashRefund.amountMinor),
              referenceType: 'BOOKING',
              referenceId: r.bookingId,
              recordedBy: cashRefund.recordedBy,
              note: 'CASH',
            })
          }
          return r
        },
        { maxWait: 20_000, timeout: 20_000 },
      )
    } catch (e) {
      mapCancelError(e)
    }
    if (!result.replayed) {
      publishSlotUpdates(hotLane, result.slots, new Date())
      publishBookingUpdate(hotLane, {
        bookingId: result.bookingId,
        ref: result.bookingRef,
        venueId: result.venueId,
        userId: result.userId,
        status: result.booking.status,
      })
    }
    return result
  }

  return {
    run,

    async byPlayer(
      userId: string,
      bookingId: string,
      itemIds: string[] | undefined,
      cancellationId: string,
      reason?: string,
    ) {
      await ownedBooking(repo, userId, bookingId)
      return cancelResponse(
        await run({
          bookingId,
          itemIds,
          cancelledBy: 'USER',
          reason: reason ?? null,
          actorId: userId,
          cancellationId,
        }),
      )
    },

    async byVenue(
      venueId: string,
      actor: StaffActor,
      bookingId: string,
      itemIds: string[] | undefined,
      reason: string | undefined,
      cancellationId: string,
      cashRefundedMinor?: number,
    ) {
      const b = await staffBooking(repo, venueId, bookingId)
      if (cashRefundedMinor !== undefined && cashRefundedMinor > Number(b.cash_collected_minor))
        throw new BadRequestError(
          'Cannot refund more cash than was collected for this booking',
          'CASH_REFUND_EXCEEDS_COLLECTED',
          { cashCollectedMinor: Number(b.cash_collected_minor) },
        )
      return cancelResponse(
        await run(
          {
            bookingId,
            itemIds,
            cancelledBy: 'VENUE',
            reason: reason ?? 'Cancelled by the venue',
            actorId: actor.id,
            cancellationId,
          },
          cashRefundedMinor ? { amountMinor: cashRefundedMinor, recordedBy: actor.id } : undefined,
        ),
      )
    },
  }
}
export type CancelMediator = ReturnType<typeof cancelBookingMediator>
