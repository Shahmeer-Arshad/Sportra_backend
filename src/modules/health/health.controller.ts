import { FastifyInstance, FastifyReply } from 'fastify'
import { createHealthRepository } from './health.repository'
import { createHealthService } from './health.service'

export function createHealthController(app: FastifyInstance) {
  const svc = createHealthService(createHealthRepository(app.prisma, app.redis))

  return {
    liveness: async () => svc.liveness(),
    readiness: async (_req: unknown, reply: FastifyReply) => {
      const { ready, body } = await svc.readiness()
      return reply.status(ready ? 200 : 503).send(body)
    },
  }
}
