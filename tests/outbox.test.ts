import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { addOutbox, relayOnce, idempotent } from '../src/lib/outbox'
import { audit } from '../src/lib/audit'
import { Bus } from '../src/lib/bus'
import { buildEvent } from '../src/lib/events'
import { uuidv7 } from '../src/lib/id'

const prisma = new PrismaClient({ log: ['error'] })

function fakeBus(opts: { failFirst?: number } = {}) {
  const sent: { key: string; id: string }[] = []
  let fails = opts.failFirst ?? 0
  const bus: Bus = {
    async publishConfirmed(key, _payload, { messageId }) {
      if (fails > 0) {
        fails--
        throw new Error('broker down')
      }
      sent.push({ key, id: messageId })
    },
    async close() {},
  }
  return { bus, sent }
}

beforeAll(async () => {
  await prisma.$connect()
})
afterAll(async () => {
  await prisma.$disconnect()
})
beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM outbox`
  await prisma.$executeRaw`DELETE FROM inbox`
})

describe('outbox', () => {
  it('rolls back with the transaction (no event for a failed change)', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await addOutbox(tx, { type: 't', routingKey: 'test.a', producer: 'test', data: {} })
        throw new Error('business rule failed')
      }),
    ).rejects.toThrow()
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox`
    expect(rows[0].n).toBe(0n)
  })

  it('relay publishes once and marks rows published', async () => {
    await prisma.$transaction(async (tx) => {
      await addOutbox(tx, { type: 't', routingKey: 'test.a', producer: 'test', data: { n: 1 } })
      await addOutbox(tx, { type: 't', routingKey: 'test.b', producer: 'test', data: { n: 2 } })
    })
    const { bus, sent } = fakeBus()
    expect(await relayOnce(prisma, bus)).toBe(2)
    expect(await relayOnce(prisma, bus)).toBe(0)
    expect(sent.map((s) => s.key)).toEqual(['test.a', 'test.b'])
  })

  it('a broker failure loses nothing: row stays unpublished and is retried', async () => {
    await prisma.$transaction((tx) =>
      addOutbox(tx, { type: 't', routingKey: 'test.a', producer: 'test', data: {} }),
    )
    const down = fakeBus({ failFirst: 1 })
    expect(await relayOnce(prisma, down.bus)).toBe(0)
    const row = await prisma.$queryRaw<
      { attempts: number; published_at: Date | null }[]
    >`SELECT attempts, published_at FROM outbox`
    expect(row[0].attempts).toBe(1)
    expect(row[0].published_at).toBeNull()
    expect(await relayOnce(prisma, down.bus)).toBe(1)
  })

  it('two relays at once never publish the same row twice', async () => {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < 20; i++)
        await addOutbox(tx, { type: 't', routingKey: 'k', producer: 'test', data: { i } })
    })
    const a = fakeBus()
    const b = fakeBus()
    await Promise.all([relayOnce(prisma, a.bus, 10), relayOnce(prisma, b.bus, 10)])
    await Promise.all([relayOnce(prisma, a.bus, 10), relayOnce(prisma, b.bus, 10)])
    const ids = [...a.sent, ...b.sent].map((s) => s.id)
    expect(ids.length).toBe(20)
    expect(new Set(ids).size).toBe(20)
  })
})

describe('inbox', () => {
  it('same event delivered 20 times (in parallel) has exactly one effect', async () => {
    let effects = 0
    const handler = idempotent(prisma, 'test.consumer', async () => {
      effects++
    })
    const evt = buildEvent({ type: 't', producer: 'test', data: {} })
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handler(evt).catch(() => false)),
    )
    expect(effects).toBe(1)
    expect(results.filter(Boolean).length).toBe(1)
  })

  it('a failing handler does not burn the event id (retry still works)', async () => {
    let attempt = 0
    const handler = idempotent(prisma, 'test.consumer', async () => {
      attempt++
      if (attempt === 1) throw new Error('boom')
    })
    const evt = buildEvent({ type: 't', producer: 'test', data: {} })
    await expect(handler(evt)).rejects.toThrow()
    expect(await handler(evt)).toBe(true)
  })
})

describe('audit log', () => {
  it('appends but cannot be updated or deleted', async () => {
    await audit(prisma, { action: 'TEST', entity: 'thing', entityId: uuidv7(), after: { a: 1 } })
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'X'`).rejects.toThrow(
      /append-only/,
    )
    await expect(prisma.$executeRaw`DELETE FROM audit_logs`).rejects.toThrow(/append-only/)
  })
})

describe('outbox ordering and batching', () => {
  it('publishes oldest first and respects the batch size', async () => {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < 5; i++)
        await addOutbox(tx, { type: 't', routingKey: `k.${i}`, producer: 'test', data: { i } })
    })
    const { bus, sent } = fakeBus()
    expect(await relayOnce(prisma, bus, 2)).toBe(2)
    expect(sent.map((s) => s.key)).toEqual(['k.0', 'k.1'])
    expect(await relayOnce(prisma, bus, 10)).toBe(3)
    expect(sent.map((s) => s.key)).toEqual(['k.0', 'k.1', 'k.2', 'k.3', 'k.4'])
  })

  it('stored payload is the full event envelope', async () => {
    const evt = await prisma.$transaction((tx) =>
      addOutbox(tx, {
        type: 'booking.confirmed',
        routingKey: 'booking.confirmed',
        producer: 'booking',
        data: { a: 1 },
        traceId: 'tr-1',
      }),
    )
    const rows = await prisma.$queryRaw<
      { payload: any }[]
    >`SELECT payload FROM outbox WHERE id = ${evt.id}::uuid`
    expect(rows[0].payload).toMatchObject({
      id: evt.id,
      type: 'booking.confirmed',
      version: 1,
      producer: 'booking',
      traceId: 'tr-1',
      data: { a: 1 },
    })
    expect(new Date(rows[0].payload.occurredAt).toString()).not.toBe('Invalid Date')
  })
})

describe('audit log content', () => {
  it('stores actor, before/after and request id', async () => {
    const id = uuidv7()
    await audit(prisma, {
      actorId: id,
      actorType: 'ADMIN',
      action: 'VENUE_APPROVED',
      entity: 'venue',
      entityId: 'v1',
      before: { s: 'A' },
      after: { s: 'B' },
      requestId: 'rq-1',
    })
    const r = await prisma.$queryRaw<
      any[]
    >`SELECT * FROM audit_logs WHERE request_id = 'rq-1' ORDER BY id DESC LIMIT 1`
    expect(r[0]).toMatchObject({
      actor_id: id,
      actor_type: 'ADMIN',
      action: 'VENUE_APPROVED',
      before: { s: 'A' },
      after: { s: 'B' },
    })
  })
})
