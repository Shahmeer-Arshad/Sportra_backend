import { Db } from '../../../lib/outbox'
import { CancelCommand, CancelResult } from '../booking.view'

/** Placeholder id for a replayed full cancellation: no CONFIRMED items are left to name. */
const NO_ITEM = '00000000-0000-0000-0000-000000000000'

export function cancellationQueries(db: Db) {
  return {
    /**
     * Calls the SQL function cancel_booking_items, which owns every invariant (per-hour cutoff, money,
     * freeing the hours, parent recalculation, event, audit). Run it inside a transaction.
     */
    async cancelBookingItems(cmd: CancelCommand): Promise<CancelResult> {
      await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`)
      let itemIds = cmd.itemIds
      if (!itemIds || itemIds.length === 0) {
        const rows = await db.$queryRaw<{ id: string }[]>`
          SELECT id FROM booking_items WHERE booking_id = ${cmd.bookingId}::uuid AND status = 'CONFIRMED'`
        itemIds = rows.map((r) => r.id)
        // a replay of a full cancellation has no CONFIRMED items left: let the function answer from its stored result
        if (itemIds.length === 0) itemIds = [NO_ITEM]
      }
      const rows = await db.$queryRaw<{ r: CancelResult }[]>`
        SELECT cancel_booking_items(${cmd.bookingId}::uuid, ${itemIds}::uuid[], ${cmd.cancelledBy}, ${cmd.reason ?? null},
          ${cmd.actorId}::uuid, ${cmd.cancellationId}::uuid, ${cmd.releaseTo ?? 'AVAILABLE'}, ${cmd.blockReason ?? null},
          ${cmd.blockRef ?? null}::uuid) AS r`
      return rows[0].r
    },
  }
}
