import { createHash } from 'crypto'
import { FastifyRequest } from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import { BadRequestError, ConflictError } from '../utils/errors'

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reads the Idempotency-Key header. Every money and inventory endpoint requires it. */
export function idempotencyKey(req: FastifyRequest, opts: { uuid?: boolean } = {}): string {
  const key = req.headers['idempotency-key']
  if (typeof key !== 'string' || !KEY_PATTERN.test(key))
    throw new BadRequestError(
      'An Idempotency-Key header (8-128 letters, digits, - or _) is required',
      'IDEMPOTENCY_KEY_REQUIRED',
    )
  if (opts.uuid && !UUID_PATTERN.test(key))
    throw new BadRequestError(
      'Idempotency-Key must be a UUID for this endpoint',
      'IDEMPOTENCY_KEY_NOT_UUID',
    )
  return key
}

export const hashRequest = (parts: unknown) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export interface IdempotentResult<T> {
  status: number
  body: T
  /** Runs once after the transaction commits (hot-lane publishing). Skipped on replays. */
  after?: () => void
}

/**
 * Runs `work` exactly once per (scope, key). The key row is inserted in the SAME transaction as the
 * work, so a rollback leaves no trace and a retry runs again. A concurrent duplicate waits on the
 * unique index until the first one commits, then replays its stored answer. The same key with a
 * different request is a 409 IDEMPOTENCY_CONFLICT.
 */
export async function runIdempotent<T>(
  prisma: PrismaClient,
  args: { scope: string; key: string; hash: string; maxWait?: number; timeout?: number },
  work: (tx: Prisma.TransactionClient) => Promise<IdempotentResult<T>>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const out = await prisma.$transaction(
    async (tx) => {
      const n = await tx.$executeRaw`
        INSERT INTO idempotency_keys (scope, key, request_hash)
        VALUES (${args.scope}, ${args.key}, ${args.hash})
        ON CONFLICT (scope, key) DO NOTHING`
      if (n === 0) {
        const prev = (
          await tx.$queryRaw<
            { request_hash: string; response: T | null; status_code: number | null }[]
          >`SELECT request_hash, response, status_code FROM idempotency_keys
             WHERE scope = ${args.scope} AND key = ${args.key}`
        )[0]
        if (!prev || prev.request_hash !== args.hash)
          throw new ConflictError(
            'This Idempotency-Key was already used for a different request',
            'IDEMPOTENCY_CONFLICT',
          )
        if (prev.response === null || prev.status_code === null)
          throw new ConflictError(
            'The original request is still being processed',
            'REQUEST_IN_PROGRESS',
          )
        return { status: prev.status_code, body: prev.response, replayed: true, after: undefined }
      }
      const r = await work(tx)
      await tx.$executeRaw`
        UPDATE idempotency_keys SET response = ${JSON.stringify(r.body ?? null)}::jsonb, status_code = ${r.status}
         WHERE scope = ${args.scope} AND key = ${args.key}`
      return { status: r.status, body: r.body, replayed: false, after: r.after }
    },
    { maxWait: args.maxWait ?? 20_000, timeout: args.timeout ?? 20_000 },
  )
  if (!out.replayed) out.after?.()
  return { status: out.status, body: out.body, replayed: out.replayed }
}
