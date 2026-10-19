import { FastifyInstance } from 'fastify'
import { fastifySwagger } from '@fastify/swagger'
import { fastifySwaggerUi } from '@fastify/swagger-ui'
import fp from 'fastify-plugin'

/**
 * Endpoints that need an `Idempotency-Key` header. It is only added to the API DOCS here (so Swagger
 * UI shows a field for it): adding it to the route schema would make Ajv strip every other header.
 */
const KEYED: Array<{ re: RegExp; uuid?: boolean }> = [
  { re: /^\/api\/v1\/bookings\/holds$/ },
  { re: /^\/api\/v1\/bookings\/:id\/confirm-pay-at-venue$/ },
  { re: /^\/api\/v1\/bookings\/:id\/cancel$/, uuid: true },
  { re: /^\/api\/v1\/pos\/venues\/:venueId\/walkins$/ },
  { re: /^\/api\/v1\/pos\/venues\/:venueId\/bookings\/manual$/ },
  { re: /^\/api\/v1\/pos\/venues\/:venueId\/bookings\/:id\/collect-balance$/ },
  { re: /^\/api\/v1\/pos\/venues\/:venueId\/bookings\/:id\/cancel$/, uuid: true },
  { re: /^\/api\/v1\/pos\/venues\/:venueId\/outage-lock$/ },
  { re: /^\/api\/v1\/admin\/bookings\/:id\/cancel$/, uuid: true },
]

const swaggerPlugin = fp(async (app: FastifyInstance) => {
  app.register(fastifySwagger, {
    transform: ({ schema, url, route }) => {
      const hit = KEYED.find((k) => k.re.test(route.url) && String(route.method).includes('POST'))
      if (!schema || !hit) return { schema, url }
      return {
        url,
        schema: {
          ...schema,
          headers: {
            type: 'object',
            required: ['Idempotency-Key'],
            properties: {
              'Idempotency-Key': {
                type: 'string',
                description: hit.uuid
                  ? 'A new UUID per request. Repeating the same request with the same key is safe.'
                  : 'Any 8-128 characters (letters, digits, - or _), new per request. Repeating the same request with the same key is safe.',
              },
            },
          },
        },
      }
    },
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Sportra API',
        description: 'Fastify + TypeScript + Prisma API',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
  })

  app.log.info('✅ Swagger docs registered at /docs')
})

export default swaggerPlugin
