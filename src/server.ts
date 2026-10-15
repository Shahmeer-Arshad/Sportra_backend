import { buildApp } from './app'
import { env } from './config/env'
import { FastifyInstance } from 'fastify'

// Hold a reference so signal handlers can close the app gracefully
let app: FastifyInstance

async function main() {
  app = await buildApp()

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    })

    console.log(`
╔════════════════════════════════════════╗
║          🚀 Sportra API                 ║
╠════════════════════════════════════════╣
║  Environment : ${env.NODE_ENV.padEnd(22)}║
║  Port        : ${String(env.PORT).padEnd(22)}║
║  API         : http://localhost:${env.PORT}/api/v1  ║
║  Docs        : http://localhost:${env.PORT}/docs    ║
║  Health      : http://localhost:${env.PORT}/health  ║
╚════════════════════════════════════════╝
    `)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

/**
 * Graceful shutdown — closes Fastify app first (triggers all onClose hooks
 * including prisma.$disconnect) then exits.
 */
async function shutdown(signal: string) {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`)
  if (app) {
    await app.close()
    console.log('✅ App closed cleanly.')
  }
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main()
