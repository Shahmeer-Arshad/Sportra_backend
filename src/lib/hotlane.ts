import type { Redis } from 'ioredis'

/**
 * The "hot lane": best-effort, at-most-once fan-out of live updates right after a database
 * commit (slot colour changes, booking changes). Correctness never depends on it: clients apply
 * an update only if its `version` is newer and re-fetch the grid after a reconnect.
 *
 * With Redis, messages go through pub/sub so the API, the worker and several API processes all
 * reach every connected client. Without Redis (or if Redis is down) messages are delivered to
 * listeners in this process only. Failures are logged by the caller, never thrown.
 */
export type HotMessage = { type: string; committedAt?: string; [k: string]: unknown }
export type HotListener = (msg: HotMessage) => void

const CHANNEL = 'sportra:hotlane'

export interface HotLane {
  /** Fire and forget. Never throws. */
  publish(msg: HotMessage): void
  subscribe(fn: HotListener): () => void
  /** True when messages travel through Redis. */
  readonly viaRedis: boolean
  close(): Promise<void>
}

export function createHotLane(
  redis: Redis | null,
  onError: (err: Error) => void = () => undefined,
): HotLane {
  const listeners = new Set<HotListener>()
  const deliver = (msg: HotMessage) => {
    for (const fn of listeners) {
      try {
        fn(msg)
      } catch (e) {
        onError(e as Error)
      }
    }
  }

  let sub: Redis | null = null
  if (redis) {
    sub = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: null })
    sub.on('error', (e) => onError(e))
    sub.on('message', (_ch, raw) => {
      try {
        deliver(JSON.parse(raw))
      } catch (e) {
        onError(e as Error)
      }
    })
    sub.subscribe(CHANNEL).catch((e) => onError(e))
  }

  return {
    viaRedis: !!redis,
    publish(msg) {
      const full = { ...msg, committedAt: msg.committedAt ?? new Date().toISOString() }
      if (!redis) return deliver(full)
      redis.publish(CHANNEL, JSON.stringify(full)).catch((e) => {
        // Redis down: still reach clients connected to this process
        onError(e)
        deliver(full)
      })
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async close() {
      listeners.clear()
      sub?.disconnect()
    },
  }
}
