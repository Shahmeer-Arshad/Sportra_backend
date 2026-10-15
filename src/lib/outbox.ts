import { Prisma, PrismaClient } from '@prisma/client'
import { Bus } from './bus'
import { DomainEvent, buildEvent } from './events'

/** A Prisma client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient

/**
 * Write an event to the outbox. Call it with the SAME transaction client as the state change,
 * so the change and its event commit (or roll back) together.
 */
export async function addOutbox<T>(
  tx: Db,
  input: {
    type: string
    routingKey: string
    producer: string
    data: T
    version?: number
    traceId?: string | null
  },
): Promise<DomainEvent<T>> {
  const evt = buildEvent(input)
  await tx.$executeRaw`
    INSERT INTO outbox (id, event_type, routing_key, payload)
    VALUES (${evt.id}::uuid, ${evt.type}, ${input.routingKey}, ${JSON.stringify(evt)}::jsonb)`
  return evt
}

interface OutboxRow {
  id: string
  routing_key: string
  payload: unknown
  headers: Record<string, unknown>
}

/**
 * Publish one batch of unpublished events. Safe to run in many workers at once (SKIP LOCKED).
 * A row is marked published only after the broker confirms it. Failures just bump `attempts`.
 * Returns how many rows were published.
 */
export async function relayOnce(prisma: PrismaClient, bus: Bus, batch = 100): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, routing_key, payload, headers FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED`
      let published = 0
      for (const row of rows) {
        try {
          await bus.publishConfirmed(row.routing_key, row.payload, {
            messageId: row.id,
            headers: row.headers,
          })
          await tx.$executeRaw`UPDATE outbox SET published_at = now() WHERE id = ${row.id}::uuid`
          published++
        } catch {
          await tx.$executeRaw`UPDATE outbox SET attempts = attempts + 1 WHERE id = ${row.id}::uuid`
        }
      }
      return published
    },
    { timeout: 30_000 },
  )
}

/**
 * Inbox gate: returns true the first time an event id is seen for the transaction, false for a
 * duplicate. Use inside the same transaction as the handler's writes.
 */
export async function inboxOnce(tx: Db, eventId: string, consumer: string): Promise<boolean> {
  const n = await tx.$executeRaw`
    INSERT INTO inbox (event_id, consumer) VALUES (${eventId}::uuid, ${consumer})
    ON CONFLICT (event_id) DO NOTHING`
  return n === 1
}

/** Wrap a consumer so a redelivered event has no second effect. */
export function idempotent<T>(
  prisma: PrismaClient,
  consumer: string,
  handler: (tx: Prisma.TransactionClient, evt: DomainEvent<T>) => Promise<void>,
) {
  return async (evt: DomainEvent<T>): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
      if (!(await inboxOnce(tx, evt.id, consumer))) return false
      await handler(tx, evt)
      return true
    })
}
