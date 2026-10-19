import { HotLane } from '../../../lib/hotlane'
import { BadRequestError } from '../../../utils/errors'
import { publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { assertCourtsOfVenue, mapContention, parseWindow } from '../booking.rules'
import { StaffActor } from './cancel-booking.mediator'

type BlockReason = 'RAIN' | 'POWER_OUTAGE' | 'MAINTENANCE' | 'PRIVATE_EVENT' | 'OTHER'

/** Manual blocks: free hours become BLOCKED; booked hours are reported, never overridden. */
export const blockSlotsMediator = (repo: BookingRepository, hotLane: HotLane) => ({
  async block(
    venueId: string,
    actor: StaffActor,
    input: { courtIds: string[]; from: string; to: string; reason: BlockReason; note?: string },
  ) {
    const { from, to } = parseWindow(input)
    if (to.getTime() - from.getTime() > 62 * 86_400_000)
      throw new BadRequestError('A block can cover at most 62 days', 'VALIDATION_ERROR')
    await assertCourtsOfVenue(repo, venueId, input.courtIds)
    let res
    try {
      res = await repo.inventoryTransaction(async (q) => {
        const r = await q.blockWindow({
          venueId,
          courtIds: input.courtIds,
          from,
          to,
          reason: input.reason,
          note: input.note,
        })
        if (r.blocked.length > 0) {
          await q.emit({
            type: 'slot.blocked',
            routingKey: 'slot.blocked',
            producer: 'booking',
            data: {
              venueId,
              courtIds: input.courtIds,
              from,
              to,
              reason: input.reason,
              slotIds: r.blocked.map((b) => b.slotId),
            },
          })
        }
        await q.audit({
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'SLOTS_BLOCKED',
          entity: 'slots',
          entityId: venueId,
          after: {
            courtIds: input.courtIds,
            from,
            to,
            reason: input.reason,
            note: input.note,
            blocked: r.blocked.length,
            conflicts: r.conflicts.length,
          },
          ip: actor.ip,
        })
        return r
      })
    } catch (e) {
      return mapContention(e)
    }
    publishSlotUpdates(hotLane, res.blocked)
    return {
      blockedCount: res.blocked.length,
      blockedSlotIds: res.blocked.map((b) => b.slotId),
      heldSkipped: res.heldSkipped,
      conflicts: res.conflicts,
      alreadyBlocked: res.alreadyBlocked,
    }
  },

  async unblock(
    venueId: string,
    actor: StaffActor,
    input: { courtIds: string[]; from: string; to: string },
  ) {
    const { from, to } = parseWindow(input)
    await assertCourtsOfVenue(repo, venueId, input.courtIds)
    const updates = await repo.transaction(async (q) => {
      const u = await q.releaseWindow({ venueId, courtIds: input.courtIds, from, to })
      if (u.length)
        await q.audit({
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'SLOTS_UNBLOCKED',
          entity: 'slots',
          entityId: venueId,
          after: { courtIds: input.courtIds, from, to, released: u.length },
          ip: actor.ip,
        })
      return u
    })
    publishSlotUpdates(hotLane, updates)
    return { releasedCount: updates.length, releasedSlotIds: updates.map((u) => u.slotId) }
  },
})
