import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import Redis from 'ioredis'
import { env } from '../config/env'

/** Optional Redis client (caches, rate limits, hot lane later). Null when REDIS_URL is not set. */
const redisPlugin = fp(async (app: FastifyInstance) => {
  if (!env.REDIS_URL) {
    app.decorate('redis', null)
    return
  }
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  redis.on('error', (err) => app.log.warn({ err: err.message }, 'Redis error'))
  app.decorate('redis', redis)
  app.addHook('onClose', async () => {
    redis.disconnect()
  })
})

export default redisPlugin
