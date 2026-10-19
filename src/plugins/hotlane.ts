import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { createHotLane, HotLane } from '../lib/hotlane'

declare module 'fastify' {
  interface FastifyInstance {
    hotLane: HotLane
  }
}

/** Live-update fan-out (Redis pub/sub when configured). Needs the redis plugin registered first. */
const hotLanePlugin = fp(async (app: FastifyInstance) => {
  const lane = createHotLane(app.redis, (err) =>
    app.log.warn({ err: err.message }, 'Hot lane error'),
  )
  app.decorate('hotLane', lane)
  app.addHook('onClose', async () => {
    await lane.close()
  })
})

export default hotLanePlugin
