import { FastifyInstance } from 'fastify'
import { fastifyCors } from '@fastify/cors'
import fp from 'fastify-plugin'

const corsPlugin = fp(async (app: FastifyInstance) => {
  app.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })

  app.log.info('✅ CORS plugin registered')
})

export default corsPlugin
