import { FastifyInstance } from 'fastify'
import { fastifyJwt } from '@fastify/jwt'
import fp from 'fastify-plugin'
import { env } from '../config/env'

const jwtPlugin = fp(async (app: FastifyInstance) => {
  // Access Token Namespace
  app.register(fastifyJwt, {
    secret: env.ACCESS_TOKEN_SECRET,
    namespace: 'access',
    sign: {
      expiresIn: env.ACCESS_TOKEN_EXPIRES_IN,
    },
  })

  // Refresh Token Namespace
  app.register(fastifyJwt, {
    secret: env.REFRESH_TOKEN_SECRET,
    namespace: 'refresh',
    sign: {
      expiresIn: env.REFRESH_TOKEN_EXPIRES_IN,
    },
    cookie: {
      cookieName: 'refreshToken',
      signed: false, // Set to true if you want to sign the cookie itself
    },
  })

  app.log.info('✅ JWT plugin registered')
})

export default jwtPlugin
