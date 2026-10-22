import dc from 'node:diagnostics_channel'
import type { FastifyInstance } from 'fastify'

/**
 * Records "METHOD url" for every route any Fastify instance registers, using Fastify's own
 * `fastify.initialization` channel so the hook is in place before buildApp() registers routes.
 * Returns a function that stops listening.
 */
export function diagnosticsChannel(onRoute: (route: string) => void) {
  const handler = (msg: unknown) => {
    const { fastify } = msg as { fastify: FastifyInstance }
    fastify.addHook('onRoute', (opts) => {
      for (const m of [opts.method].flat()) onRoute(`${m} ${opts.url}`)
    })
  }
  dc.subscribe('fastify.initialization', handler)
  return () => dc.unsubscribe('fastify.initialization', handler)
}
