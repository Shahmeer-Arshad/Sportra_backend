import Fastify, { FastifyInstance } from 'fastify'
import { env } from './config/env'
import { AppError } from './utils/errors'

// Plugins
import prismaPlugin from './plugins/prisma'
import jwtPlugin from './plugins/jwt'
import corsPlugin from './plugins/cors'
import securityPlugin from './plugins/security'
import swaggerPlugin from './plugins/swagger'

// Routes
import { userRoutes } from './modules/user/user.routes'

/**
 * Builds and configures the Fastify application.
 * Exported so it can be used in tests as well.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.body.password', 'req.headers.authorization'],
      transport:
        env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        coerceTypes: true,
        allErrors: true,
      },
    },
  })

  // ─────────────────────────────────────────
  // Register plugins (order matters!)
  // ─────────────────────────────────────────
  await app.register(corsPlugin)
  await app.register(securityPlugin)
  await app.register(swaggerPlugin)
  await app.register(prismaPlugin)
  await app.register(jwtPlugin)

  // ─────────────────────────────────────────
  // Global error handler
  // ─────────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    // Known operational errors
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        message: error.message,
      })
    }

    // Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: 'Invalid request data',
        details: error.validation,
      })
    }

    // JWT errors
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: error.message,
      })
    }

    // Unhandled errors
    app.log.error(error)
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      message: env.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
    })
  })

  // ─────────────────────────────────────────
  // Routes
  // ─────────────────────────────────────────

  // Health check
  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Health check endpoint',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              timestamp: { type: 'string' },
              uptime: { type: 'number' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.send({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      })
    },
  )

  // API v1 routes
  app.register(userRoutes, { prefix: '/api/v1/users' })

  return app
}
