import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { env } from '../config/env'
import { createMailer, Mailer } from '../lib/mailer'

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer
  }
}

const mailerPlugin = fp(async (app: FastifyInstance) => {
  app.decorate(
    'mailer',
    createMailer({
      from: env.MAIL_FROM,
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      capture: env.NODE_ENV === 'test',
    }),
  )
})

export default mailerPlugin
