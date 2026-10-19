import { HotLane } from '../../../lib/hotlane'
import { BadRequestError, NotFoundError } from '../../../utils/errors'
import { publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { cancelResponse } from '../booking.view'
import { CancelMediator } from './cancel-booking.mediator'

const reasonOf = (raw: string) => {
  const reason = raw.trim()
  if (reason.length < 5)
    throw new BadRequestError('A reason of at least 5 characters is required', 'REASON_REQUIRED')
  return reason
}

/** Emergency actions on behalf of a venue. The reason is mandatory and audited. */
export const adminOverrideMediator = (
  repo: BookingRepository,
  hotLane: HotLane,
  cancel: CancelMediator,
) => ({
  async cancel(
    adminId: string,
    bookingId: string,
    input: { reason: string; itemIds?: string[] },
    cancellationId: string,
    ip?: string | null,
  ) {
    const reason = reasonOf(input.reason)
    const b = await repo.bookingById(bookingId)
    if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
    const r = await cancel.run({
      bookingId,
      itemIds: input.itemIds,
      cancelledBy: 'VENUE',
      reason: `Admin: ${reason}`,
      actorId: adminId,
      cancellationId,
    })
    if (!r.replayed)
      await repo.audit({
        actorId: adminId,
        actorType: 'ADMIN',
        venueId: b.venue_id,
        action: 'ADMIN_BOOKING_CANCELLED',
        entity: 'booking',
        entityId: bookingId,
        after: { reason, cancellationId, itemIds: input.itemIds ?? 'all' },
        ip,
      })
    return cancelResponse(r)
  },

  /** Emergency unblock (manual blocks, outage blocks, tournament blocks). */
  async unblock(adminId: string, input: { slotIds: string[]; reason: string }, ip?: string | null) {
    const reason = reasonOf(input.reason)
    const updates = await repo.transaction(async (q) => {
      const u = await q.releaseByIds(input.slotIds)
      await q.audit({
        actorId: adminId,
        actorType: 'ADMIN',
        action: 'ADMIN_SLOTS_UNBLOCKED',
        entity: 'slots',
        entityId: input.slotIds.join(','),
        after: { reason, released: u.map((x) => x.slotId) },
        ip,
      })
      return u
    })
    publishSlotUpdates(hotLane, updates)
    return { releasedCount: updates.length, releasedSlotIds: updates.map((u) => u.slotId) }
  },
})
