import { buildApp } from './app'
import { env } from './config/env'

async function main() {
  const app = await buildApp()

  try {
    await app.listen({
      port: env.PORT,
      host: env.HOST,
    })

    console.log(`
╔════════════════════════════════════════╗
║          🚀 Node Starter API           ║
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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...')
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...')
  process.exit(0)
})

main()
