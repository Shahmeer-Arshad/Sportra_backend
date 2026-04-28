import { FastifyInstance } from 'fastify'
import { fastifyHelmet } from '@fastify/helmet'
import { fastifyRateLimit } from '@fastify/rate-limit'
import fp from 'fastify-plugin'

const securityPlugin = fp(async (app: FastifyInstance) => {
  // Security headers
  app.register(fastifyHelmet, {
    contentSecurityPolicy: process.env.NODE_ENV === 'production',
  })

  // Rate limiting
  app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again in ${context.after}`,
    }),
  })

  app.log.info('✅ Security plugins registered')
})

export default securityPlugin
