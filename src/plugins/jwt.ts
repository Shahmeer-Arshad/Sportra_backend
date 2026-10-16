import { FastifyInstance } from 'fastify'
import { fastifyJwt } from '@fastify/jwt'
import fp from 'fastify-plugin'
import { env } from '../config/env'

/** Access tokens only (short-lived JWT). Refresh tokens are opaque and stored hashed in the DB. */
const jwtPlugin = fp(async (app: FastifyInstance) => {
  app.register(fastifyJwt, {
    secret: env.ACCESS_TOKEN_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_EXPIRES_IN },
  })
})

export default jwtPlugin
