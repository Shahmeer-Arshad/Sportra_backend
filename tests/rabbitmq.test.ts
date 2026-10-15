import { describe, it, expect } from 'vitest'
import amqp from 'amqplib'
import { PrismaClient } from '@prisma/client'
import { createAmqpBus, EXCHANGE } from '../src/lib/bus'
import { addOutbox, relayOnce } from '../src/lib/outbox'

const url = process.env.RABBITMQ_URL

// Needs RabbitMQ (docker compose up -d). Skipped when RABBITMQ_URL is unset or the broker is unreachable.
async function brokerUp() {
  if (!url) return false
  try {
    const c = await amqp.connect(url)
    await c.close()
    return true
  } catch {
    return false
  }
}
describe('outbox -> RabbitMQ round trip', () => {
  it('an event written in a transaction arrives on a bound queue', async (ctx) => {
    if (!(await brokerUp())) return ctx.skip()
    const prisma = new PrismaClient({ log: ['error'] })
    await prisma.$executeRaw`DELETE FROM outbox`
    const conn = await amqp.connect(url!)
    const ch = await conn.createChannel()
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true })
    const { queue } = await ch.assertQueue('', { exclusive: true })
    await ch.bindQueue(queue, EXCHANGE, 'phase0.roundtrip')

    const evt = await prisma.$transaction((tx) =>
      addOutbox(tx, {
        type: 'test.roundtrip',
        routingKey: 'phase0.roundtrip',
        producer: 'test',
        data: { hello: 'world' },
      }),
    )
    const bus = await createAmqpBus(url!)
    expect(await relayOnce(prisma, bus)).toBe(1)

    const msg = await new Promise<amqp.ConsumeMessage>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no message')), 5000)
      void ch.consume(queue, (m) => {
        if (m) {
          clearTimeout(t)
          resolve(m)
        }
      })
    })
    const body = JSON.parse(msg.content.toString())
    expect(body.id).toBe(evt.id)
    expect(body.data).toEqual({ hello: 'world' })
    expect(msg.properties.messageId).toBe(evt.id)

    await bus.close()
    await ch.close()
    await conn.close()
    await prisma.$disconnect()
  })
})
