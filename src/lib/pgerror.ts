import { Prisma } from '@prisma/client'

/**
 * Prisma wraps raw-query errors; this pulls out the Postgres SQLSTATE and message so the code can
 * map database exceptions (RAISE EXCEPTION 'ITEM_NOT_CANCELLABLE', lock timeouts, constraint
 * violations) to stable API errors.
 */
export function pgError(e: unknown): { code: string | null; message: string } | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (e.meta ?? {}) as { code?: string; message?: string }
    const text = String(meta.message ?? e.message)
    const fromText = text.match(/Code: `(\w{5})`/)?.[1]
    const msg = text.match(/Message: `(?:ERROR: )?([^`]*)`/)?.[1] ?? text
    return { code: meta.code ?? fromText ?? null, message: msg.replace(/^ERROR:\s*/, '').trim() }
  }
  return null
}

/** True for a lock_timeout (55P03) or a deadlock (40P01): the caller lost a race, retry later. */
export function isLockContention(e: unknown): boolean {
  const pg = pgError(e)
  if (pg && (pg.code === '55P03' || pg.code === '40P01')) return true
  return /lock timeout|deadlock detected/i.test(String((e as Error)?.message ?? ''))
}

/** True when a transaction could not get a pooled connection or ran out of time under load. */
export function isTxTimeout(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028'
}
