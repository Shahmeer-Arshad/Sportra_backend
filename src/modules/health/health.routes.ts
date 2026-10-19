import { FastifyInstance } from 'fastify'
import { createHealthController } from './health.controller'
import * as S from './health.schema'

export async function healthRoutes(app: FastifyInstance) {
  const c = createHealthController(app)

  app.get('/healthz', { schema: S.liveness }, c.liveness)
  app.get('/readyz', { schema: S.readiness }, c.readiness)
}
