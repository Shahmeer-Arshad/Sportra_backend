import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { env } from './config/env'
import { createAmqpBus } from './lib/bus'
import { relayOnce } from './lib/outbox'

/**
 * Worker process: runs the outbox relay (DB -> RabbitMQ). Run separately from the API:
 *   npm run worker
 */
const log = pino({ level: env.NODE_ENV === 'production' ? 'info' : 'debug' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!env.RABBITMQ_URL) {
    log.error('RABBITMQ_URL is not set; the worker cannot publish events')
    process.exit(1)
  }
  const prisma = new PrismaClient({ log: ['error'] })
  const bus = await createAmqpBus(env.RABBITMQ_URL)
  let running = true

  const stop = async (signal: string) => {
    log.info({ signal }, 'Stopping worker')
    running = false
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))

  log.info('Outbox relay started')
  while (running) {
    try {
      const n = await relayOnce(prisma, bus, env.OUTBOX_BATCH)
      if (n > 0) log.info({ published: n }, 'Outbox batch published')
      if (n === 0) await sleep(env.OUTBOX_POLL_MS)
    } catch (err) {
      log.error({ err }, 'Relay error')
      await sleep(2000)
    }
  }
  await bus.close()
  await prisma.$disconnect()
  log.info('Worker stopped cleanly')
}

void main()
