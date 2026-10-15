import { FastifyInstance } from 'fastify'

type Check = 'ok' | 'down' | 'skipped'

/** /healthz = process is alive. /readyz = dependencies are reachable (DB required, Redis if set). */
export async function healthRoutes(app: FastifyInstance) {
  const body = { type: 'object', additionalProperties: true }

  app.get('/healthz', { schema: { tags: ['Health'], response: { 200: body } } }, async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }))

  app.get(
    '/readyz',
    { schema: { tags: ['Health'], response: { 200: body, 503: body } } },
    async (_req, reply) => {
      const checks: Record<string, Check> = { database: 'down', redis: 'skipped' }

      try {
        await app.prisma.$queryRaw`SELECT 1`
        checks.database = 'ok'
      } catch {
        checks.database = 'down'
      }

      if (app.redis) {
        try {
          await Promise.race([
            app.redis.ping(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
          ])
          checks.redis = 'ok'
        } catch {
          checks.redis = 'down'
        }
      }

      const ready = Object.values(checks).every((c) => c !== 'down')
      return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks })
    },
  )
}
