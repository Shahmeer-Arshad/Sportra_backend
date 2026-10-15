import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import amqp from 'amqplib'
import { PrismaClient } from '@prisma/client'
import { addOutbox } from '../src/lib/outbox'
import { EXCHANGE } from '../src/lib/bus'

const url = process.env.RABBITMQ_URL

async function brokerUp() {
  if (!url) return false
  try {
    ;(await amqp.connect(url)).close()
    return true
  } catch {
    return false
  }
}

// Real worker PROCESS test: start `src/worker.ts`, give it an event, see it reach RabbitMQ, stop it cleanly.
describe('worker process', () => {
  it('publishes outbox events to RabbitMQ and exits cleanly on SIGTERM', async (ctx) => {
    if (!(await brokerUp())) return ctx.skip()
    const prisma = new PrismaClient({ log: ['error'] })
    await prisma.$executeRaw`DELETE FROM outbox`

    const conn = await amqp.connect(url!)
    const ch = await conn.createChannel()
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true })
    const { queue } = await ch.assertQueue('', { exclusive: true })
    await ch.bindQueue(queue, EXCHANGE, 'worker.test')

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      env: { ...process.env, OUTBOX_POLL_MS: '100' },
      stdio: 'ignore',
    })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))

    try {
      const evt = await prisma.$transaction((tx) =>
        addOutbox(tx, {
          type: 'worker.test',
          routingKey: 'worker.test',
          producer: 'test',
          data: { ok: true },
        }),
      )

      const msg = await new Promise<amqp.ConsumeMessage>((res, rej) => {
        const t = setTimeout(() => rej(new Error('worker did not publish in time')), 15000)
        void ch.consume(queue, (m) => {
          if (m) {
            clearTimeout(t)
            res(m)
          }
        })
      })
      expect(JSON.parse(msg.content.toString()).id).toBe(evt.id)

      // The row is marked published right after the broker confirms; poll briefly for it.
      let publishedAt: Date | null = null
      for (let i = 0; i < 50 && !publishedAt; i++) {
        const rows = await prisma.$queryRaw<
          { published_at: Date | null }[]
        >`SELECT published_at FROM outbox WHERE id = ${evt.id}::uuid`
        publishedAt = rows[0].published_at
        if (!publishedAt) await new Promise((r) => setTimeout(r, 100))
      }
      expect(publishedAt).not.toBeNull()

      child.kill('SIGTERM')
      expect(await exited).toBe(0)
    } finally {
      // never leave a worker running: it would steal rows from other tests
      if (child.exitCode === null) child.kill('SIGKILL')
    }

    await ch.close()
    await conn.close()
    await prisma.$disconnect()
  }, 30000)
})
