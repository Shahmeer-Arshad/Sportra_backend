/**
 * Best effort: free the hours (and tell clients) shortly after a hold runs out. Not needed for
 * correctness. One timer per quarter-second bucket, so thousands of holds expiring together
 * cost a single sweep.
 */
export function createHoldSweeper(sweep: () => Promise<unknown>) {
  const timers = new Map<number, NodeJS.Timeout>()

  return {
    schedule(expiresAt: Date) {
      const bucket = Math.ceil((expiresAt.getTime() + 150) / 250) * 250
      if (timers.has(bucket)) return
      const t = setTimeout(
        () => {
          timers.delete(bucket)
          sweep().catch(() => undefined)
        },
        Math.max(0, bucket - Date.now()),
      )
      t.unref()
      timers.set(bucket, t)
    },

    /** Stop pending timers (called when the app closes). */
    stop() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
export type HoldSweeper = ReturnType<typeof createHoldSweeper>
