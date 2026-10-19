import { Prisma, PrismaClient } from '@prisma/client'
import { Db } from '../../lib/outbox'
import { eventWrites, makeRepository } from '../../lib/repository'
import { runIdempotent, IdempotentResult } from '../../lib/idempotency'
import { inventoryTx } from './booking.inventory'
import { adminQueries } from './repositories/admin.queries'
import { bookingQueries } from './repositories/booking.queries'
import { cancellationQueries } from './repositories/cancellation.queries'
import { generationQueries } from './repositories/generation.queries'
import { outageQueries } from './repositories/outage.queries'
import { slotQueries } from './repositories/slot.queries'

/** Every booking query, bound to one client (the pool, or a transaction). */
function queries(db: Db) {
  return {
    ...eventWrites(db),
    ...bookingQueries(db),
    ...cancellationQueries(db),
    ...slotQueries(db),
    ...generationQueries(db),
    ...outageQueries(db),
    ...adminQueries(db),
  }
}
export type BookingQueries = ReturnType<typeof queries>

export function createBookingRepository(prisma: PrismaClient) {
  const base = makeRepository(prisma, queries)
  return {
    ...base,

    /** Inventory transaction: a short lock timeout, and a lost race becomes a clean 409. */
    inventoryTransaction: <T>(fn: (q: BookingQueries) => Promise<T>) =>
      inventoryTx(prisma, (tx) => fn(queries(tx))),

    /** Runs `work` once per (scope, key) in one transaction; replays return the stored answer. */
    idempotent: <T>(
      args: { scope: string; key: string; hash: string },
      work: (q: BookingQueries) => Promise<IdempotentResult<T>>,
    ) => runIdempotent(prisma, args, (tx: Prisma.TransactionClient) => work(queries(tx))),
  }
}
export type BookingRepository = ReturnType<typeof createBookingRepository>
