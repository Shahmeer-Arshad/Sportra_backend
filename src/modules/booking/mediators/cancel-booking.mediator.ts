import { HotLane } from '../../../lib/hotlane'
import { BookingRepository } from '../booking.repository'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { mapCancelError, ownedBooking, staffBooking } from '../booking.rules'
import { CancelCommand, CancelResult, cancelResponse } from '../booking.view'

export interface StaffActor {
  id: string
  role: 'OWNER' | 'MANAGER' | 'FRONT_DESK' | 'ADMIN'
  ip?: string | null
}

/**
 * One transaction: the SQL function owns every invariant. Afterwards the hot lane is told, but
 * only for a first call: a replay publishes nothing new.
 */
export const cancelBookingMediator = (repo: BookingRepository, hotLane: HotLane) => {
  async function run(cmd: CancelCommand): Promise<CancelResult> {
    let result: CancelResult
    try {
      result = await repo.transaction((q) => q.cancelBookingItems(cmd), {
        maxWait: 20_000,
        timeout: 20_000,
      })
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
    ) {
      await staffBooking(repo, venueId, bookingId)
      return cancelResponse(
        await run({
          bookingId,
          itemIds,
          cancelledBy: 'VENUE',
          reason: reason ?? 'Cancelled by the venue',
          actorId: actor.id,
          cancellationId,
        }),
      )
    },
  }
}
export type CancelMediator = ReturnType<typeof cancelBookingMediator>
