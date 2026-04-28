import { FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import fp from 'fastify-plugin'

const prismaPlugin = fp(async (app: FastifyInstance) => {
  const prisma = new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['error'],
  })

  await prisma.$connect()
  app.log.info('✅ Database connected')

  app.decorate('prisma', prisma)

  app.addHook('onClose', async () => {
    await prisma.$disconnect()
    app.log.info('🔌 Database disconnected')
  })
})

export default prismaPlugin
