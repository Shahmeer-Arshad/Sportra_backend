import { PrismaClient } from '@prisma/client'
import pino from 'pino'
import { env } from './config/env'
import { createAmqpBus } from './lib/bus'
import { relayOnce } from './lib/outbox'
import Redis from 'ioredis'
import { createHotLane } from './lib/hotlane'
import { createBookingJobs } from './modules/booking/booking.jobs'

/**
 * Worker process: runs the outbox relay (DB -> RabbitMQ) and the booking housekeeping jobs
 * (hold sweeper every minute, slot horizon nightly). Run separately from the API:
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

  // Housekeeping: live updates reach clients through the Redis hot lane when it is configured
  const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 }) : null
  redis?.on('error', (err) => log.warn({ err: err.message }, 'Redis error'))
  const hotLane = createHotLane(redis, (err) => log.warn({ err: err.message }, 'Hot lane error'))
  const jobs = createBookingJobs(prisma, hotLane, log)
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let busy = false
    const run = async () => {
      if (busy || !running) return
      busy = true
      try {
        const r = await fn()
        log.debug({ job: name, result: r }, 'Job finished')
      } catch (err) {
        log.error({ err, job: name }, 'Job failed')
      } finally {
        busy = false
      }
    }
    void run()
    const t = setInterval(run, ms)
    t.unref()
    return t
  }
  const timers = [
    every(env.SWEEP_INTERVAL_SECONDS * 1000, 'booking.tick', () => jobs.tick()),
    every(24 * 3600 * 1000, 'booking.nightly', () => jobs.nightly()),
  ]

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
  timers.forEach(clearInterval)
  await bus.close()
  await hotLane.close()
  redis?.disconnect()
  await prisma.$disconnect()
  log.info('Worker stopped cleanly')
}

void main()
