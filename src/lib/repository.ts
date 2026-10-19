import { PrismaClient } from '@prisma/client'
import { audit, AuditInput } from './audit'
import { addOutbox, Db } from './outbox'

type OutboxInput = Parameters<typeof addOutbox>[1]
type TxOptions = { maxWait?: number; timeout?: number }

/** Audit and outbox writes bound to `db`, so inside a transaction they commit with the change. */
export const eventWrites = (db: Db) => ({
  audit: (entry: AuditInput) => audit(db, entry),
  emit: (event: OutboxInput) => addOutbox(db, event),
})

/**
 * Builds a repository from a `queries(db)` factory. The result has every query on the normal
 * client plus `transaction(fn)`, which hands `fn` the SAME queries bound to the transaction
 * client. Inside `fn` only that object may touch the database (never the global prisma).
 */
export function makeRepository<Q>(prisma: PrismaClient, queries: (db: Db) => Q) {
  return {
    ...queries(prisma),
    transaction: <T>(fn: (q: Q) => Promise<T>, options?: TxOptions) =>
      prisma.$transaction((tx) => fn(queries(tx)), options),
  }
}
