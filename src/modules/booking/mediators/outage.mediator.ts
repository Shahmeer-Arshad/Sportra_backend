import { HotLane } from '../../../lib/hotlane'
import { uuidv7 } from '../../../lib/id'
import { hashRequest } from '../../../lib/idempotency'
import { BadRequestError, ConflictError, NotFoundError } from '../../../utils/errors'
import { publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import { assertCourtsOfVenue, derivedUuid, mapContention, parseWindow } from '../booking.rules'
import { manualCallJson, outageJson } from '../booking.view'
import { CancelMediator, StaffActor } from './cancel-booking.mediator'

/**
 * Outage / rain lock: block every free hour in the window, then cancel the app bookings one by
 * one (each in its own transaction, full refund). The cancelling is resumable and idempotent.
 */
export const outageMediator = (
  repo: BookingRepository,
  hotLane: HotLane,
  cancel: CancelMediator,
) => {
  const running = new Set<Promise<unknown>>()
  const windowOf = (l: {
    venueId: string
    courtIds: string[]
    windowStart: Date
    windowEnd: Date
  }) => ({
    venueId: l.venueId,
    courtIds: l.courtIds,
    from: l.windowStart,
    to: l.windowEnd,
  })

  /** Cancel the app bookings of an outage lock. Safe to call again after a crash. */
  async function process(lockId: string): Promise<void> {
    const lock = await repo.outageById(lockId)
    if (!lock || lock.status !== 'PROCESSING') return
    const window = windowOf(lock)
    const attempted = new Set<string>()
    for (;;) {
      const todo = (await repo.affectedAppBookings(window)).filter(
        (b) => !attempted.has(b.booking_id),
      )
      if (todo.length === 0) break
      for (const b of todo) {
        attempted.add(b.booking_id)
        try {
          await cancel.run({
            bookingId: b.booking_id,
            itemIds: b.item_ids,
            cancelledBy: 'VENUE',
            reason: `Venue closed: ${lock.reason.toLowerCase().replace('_', ' ')}`,
            actorId: lock.createdBy,
            // the same job + booking always yields the same id, so a retry never refunds twice
            cancellationId: derivedUuid(`outage:${lockId}:${b.booking_id}`),
            releaseTo: 'BLOCKED',
            blockReason: lock.reason,
            blockRef: lock.id,
          })
        } catch {
          // stays in "remaining"; reported as failed when the loop ends
        }
        const remaining = (await repo.affectedAppBookings(window)).length
        const processed = Math.max(0, lock.totalBookings - remaining)
        await repo.setOutageProgress(lockId, processed)
        hotLane.publish({
          type: 'outage.progress',
          venueId: lock.venueId,
          lockId,
          total: lock.totalBookings,
          processed,
        })
      }
    }
    const remaining = await repo.affectedAppBookings(window)
    await repo.finishOutage(
      lockId,
      remaining.length,
      Math.max(0, lock.totalBookings - remaining.length),
    )
    hotLane.publish({ type: 'outage.progress', venueId: lock.venueId, lockId, done: true })
  }

  function kick(lockId: string) {
    const p = process(lockId)
      .catch(() => undefined)
      .finally(() => running.delete(p))
    running.add(p)
  }

  return {
    process,

    /** Wait for background outage jobs (tests, graceful shutdown). */
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running])
    },

    async start(
      venueId: string,
      actor: StaffActor,
      input: {
        courtIds: string[]
        from: string
        to: string
        reason: 'RAIN' | 'POWER_OUTAGE' | 'MAINTENANCE' | 'OTHER'
        note?: string
      },
      key: string,
    ) {
      const { from, to } = parseWindow(input)
      if (to.getTime() <= Date.now())
        throw new BadRequestError('The window is in the past', 'SLOT_IN_PAST')
      await assertCourtsOfVenue(repo, venueId, input.courtIds)
      try {
        return await repo.idempotent(
          { scope: `outage:${venueId}`, key, hash: hashRequest(input) },
          async (q) => {
            await q.setLockTimeout('1s')
            const lockId = uuidv7()
            // 1) block every free hour in the window (new bookings are paused: nothing is bookable)
            const r = await q.blockWindow({
              venueId,
              courtIds: input.courtIds,
              from,
              to,
              reason: input.reason,
              note: input.note,
              ref: lockId,
            })
            // 2) who is affected
            const window = { venueId, courtIds: input.courtIds, from, to }
            const app = await q.affectedAppBookings(window)
            const manual = (await q.manualToCall(window)).map(manualCallJson)
            await q.createOutage({
              id: lockId,
              venueId,
              courtIds: input.courtIds,
              windowStart: from,
              windowEnd: to,
              reason: input.reason,
              note: input.note ?? null,
              status: app.length === 0 ? 'ACTIVE' : 'PROCESSING',
              totalBookings: app.length,
              manualToCall: manual,
              createdBy: actor.id,
            })
            await q.emit({
              type: 'outage_lock.activated',
              routingKey: 'outage_lock.activated',
              producer: 'booking',
              data: {
                lockId,
                venueId,
                courtIds: input.courtIds,
                from,
                to,
                reason: input.reason,
                affectedBookings: app.length,
              },
            })
            await q.audit({
              actorId: actor.id,
              actorType: 'STAFF',
              venueId,
              action: 'OUTAGE_LOCK_STARTED',
              entity: 'outage_lock',
              entityId: lockId,
              after: { ...input, affectedBookings: app.length, blocked: r.blocked.length },
              ip: actor.ip,
            })
            const lock = await q.outageByIdOrThrow(lockId)
            return {
              status: 202,
              body: {
                ...outageJson(lock),
                blockedFreeHours: r.blocked.length,
                heldSkipped: r.heldSkipped,
              },
              after: () => {
                publishSlotUpdates(hotLane, r.blocked)
                if (app.length > 0) kick(lockId)
              },
            }
          },
        )
      } catch (e) {
        return mapContention(e)
      }
    },

    async release(venueId: string, actor: StaffActor, id: string) {
      const l = await repo.outageOfVenue(venueId, id)
      if (!l) throw new NotFoundError('Outage lock not found', 'OUTAGE_NOT_FOUND')
      if (l.status === 'RELEASED') return outageJson(l)
      if (l.status === 'PROCESSING')
        throw new ConflictError(
          'Players are still being handled, release when it finishes',
          'OUTAGE_STILL_PROCESSING',
        )
      const updates = await repo.transaction(async (q) => {
        const u = await q.releaseByRef(venueId, id)
        await q.releaseOutage(id, actor.id)
        await q.audit({
          actorId: actor.id,
          actorType: actor.role === 'ADMIN' ? 'ADMIN' : 'STAFF',
          venueId,
          action: 'OUTAGE_LOCK_RELEASED',
          entity: 'outage_lock',
          entityId: id,
          after: { released: u.length },
          ip: actor.ip,
        })
        return u
      })
      publishSlotUpdates(hotLane, updates)
      return outageJson(await repo.outageByIdOrThrow(id))
    },
  }
}
