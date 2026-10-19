import { createHealthRepository } from './health.repository'

type Check = 'ok' | 'down' | 'skipped'
const label = (up: boolean): Check => (up ? 'ok' : 'down')

/** /healthz = process is alive. /readyz = dependencies are reachable (DB required, Redis if set). */
export function createHealthService(repo: ReturnType<typeof createHealthRepository>) {
  return {
    liveness: () => ({ status: 'ok', uptime: process.uptime() }),

    async readiness() {
      const checks: Record<string, Check> = {
        database: label(await repo.database()),
        redis: repo.redis ? label(await repo.redis()) : 'skipped',
      }
      const ready = Object.values(checks).every((c) => c !== 'down')
      return { ready, body: { status: ready ? 'ready' : 'not_ready', checks } }
    },
  }
}
