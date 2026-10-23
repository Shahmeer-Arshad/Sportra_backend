import Fastify, { FastifyInstance } from 'fastify'
import { env } from './config/env'
import { AppError } from './utils/errors'

// Plugins
import fastifyCookie from '@fastify/cookie'
import prismaPlugin from './plugins/prisma'
import jwtPlugin from './plugins/jwt'
import corsPlugin from './plugins/cors'
import securityPlugin from './plugins/security'
import swaggerPlugin from './plugins/swagger'
import redisPlugin from './plugins/redis'
import mailerPlugin from './plugins/mailer'
import hotLanePlugin from './plugins/hotlane'
import bookingPlugin from './plugins/booking'
import realtimePlugin from './plugins/realtime'
import { randomUUID } from 'crypto'

// Routes
import { identityRoutes } from './modules/identity/identity.routes'
import { venueRoutes } from './modules/venue/venue.routes'
import { bookingRoutes } from './modules/booking/booking.routes'
import { healthRoutes } from './modules/health/health.routes'

/**
 * Builds and configures the Fastify application.
 * Exported so it can be used in tests as well.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Reuse the caller's request id when present, so one request can be traced across services
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    requestIdHeader: 'x-request-id',
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
        coerceTypes: 'array',
        allErrors: true,
      },
    },
  })

  // Many HTTP clients send `Content-Type: application/json` even on requests with no body
  // (DELETE /hold, POST /no-show ...). Fastify rejects that by default; treat an empty body as "no body".
  // Invalid JSON and prototype-poisoning payloads are still refused.
  const jsonParser = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || body === undefined) return done(null, undefined)
    jsonParser(req, body as string, done)
  })

  // ─────────────────────────────────────────
  // Register plugins (order matters!)
  // ─────────────────────────────────────────
  await app.register(corsPlugin)
  await app.register(securityPlugin)
  await app.register(swaggerPlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(mailerPlugin)
  await app.register(fastifyCookie)
  await app.register(jwtPlugin)
  await app.register(hotLanePlugin)
  await app.register(bookingPlugin)
  await app.register(realtimePlugin)

  // ─────────────────────────────────────────
  // Global error handler
  // ─────────────────────────────────────────
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })

  app.setErrorHandler((error, _request, reply) => {
    // Known operational errors
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: error.name,
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      })
    }

    // Cast to any for Fastify-specific and JWT error shapes
    // (Fastify's error handler receives FastifyError which extends Error but TS types it as unknown)
    const err = error as any

    // Fastify validation errors — Fastify attaches .validation to its own error type
    if (err.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.validation,
      })
    }

    // A malformed id in the path (not a UUID) reaches the database as a cast error: answer 400, not 500
    if (err.code === 'P2023' || /invalid input syntax for type uuid/.test(String(err.message))) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        code: 'INVALID_ID',
        message: 'An id in the request is not a valid UUID',
      })
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        message: err.message,
      })
    }

    // Other 4xx errors raised by Fastify and plugins (rate limit 429, CORS, payload too large...)
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        statusCode: err.statusCode,
        error: err.error ?? err.name ?? 'Error',
        code: err.statusCode === 429 ? 'RATE_LIMITED' : (err.code ?? 'BAD_REQUEST'),
        message: err.message,
      })
    }

    // Unhandled errors — hide details in production
    app.log.error(error)
    return reply.status(500).send({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Something went wrong' : err.message,
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
  app.register(healthRoutes)
  app.register(identityRoutes)
  app.register(venueRoutes)
  app.register(bookingRoutes)

  return app
}
