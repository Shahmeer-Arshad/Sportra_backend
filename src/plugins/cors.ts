import { FastifyInstance } from 'fastify'
import { fastifyCors } from '@fastify/cors'
import fp from 'fastify-plugin'
import { env } from '../config/env'

const corsPlugin = fp(async (app: FastifyInstance) => {
  // Parse allowed origins from env (comma-separated), with safe defaults.
  // Using a whitelist is required when credentials:true — browsers reject origin:'*' with credentials.
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3000', 'http://localhost:5173']

  app.register(fastifyCors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (e.g. curl, Postman, server-to-server)
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true)
      } else {
        cb(new Error('Not allowed by CORS'), false)
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })

  app.log.info(`✅ CORS plugin registered (origins: ${allowedOrigins.join(', ')})`)
})

export default corsPlugin
