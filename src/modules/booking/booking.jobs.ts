import { PrismaClient } from '@prisma/client'
import { HotLane } from '../../lib/hotlane'
import { createPosService } from './booking.pos'
import { createSlotService } from './booking.slots'

/**
 * Background jobs, run by the worker process (or called directly in tests). None of them is needed
 * for correctness of the inventory: they tidy up, extend the horizon and finish interrupted work.
 */
export function createBookingJobs(
  prisma: PrismaClient,
  hotLane: HotLane,
  log?: { warn: (o: object, m: string) => void },
) {
  const slots = createSlotService(prisma, hotLane)
  const pos = createPosService(prisma, hotLane)

  return {
    /** Every minute: free expired holds, expire stale pending bookings, finish played bookings, resume outage jobs. */
    async tick() {
      const swept = await slots.sweep()
      // an outage job whose API process died while handling players is picked up again (idempotent)
      const stuck = await prisma.outageLock.findMany({
        where: { status: 'PROCESSING', createdAt: { lt: new Date(Date.now() - 30_000) } },
        select: { id: true },
      })
      for (const l of stuck) {
        try {
          await pos.processOutage(l.id)
        } catch (err) {
          log?.warn({ err, lockId: l.id }, 'Outage job could not be resumed')
        }
      }
      return { ...swept, resumedOutages: stuck.length }
    },
    /** Nightly: extend every verified venue's slots to the full horizon and drop old idempotency keys. */
    async nightly(only?: string[]) {
      const gen = await slots.generateAll(only)
      const purged = await slots.purgeIdempotencyKeys()
      return { ...gen, purgedKeys: purged }
    },
  }
}
