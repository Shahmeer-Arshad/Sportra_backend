import { FastifyInstance } from 'fastify'
import { fastifyJwt } from '@fastify/jwt'
import fp from 'fastify-plugin'
import { env } from '../config/env'

const jwtPlugin = fp(async (app: FastifyInstance) => {
  app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  })

  app.log.info('✅ JWT plugin registered')
})

export default jwtPlugin
