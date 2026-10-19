/**
 * Slot inventory core. EVERY way of taking or releasing a court-hour (online hold, walk-in, manual
 * booking, block, outage lock, tournament reservation, cancellation, expiry) goes through the
 * functions in this file, so the "never sold twice" guarantee lives in one place:
 *
 *   layer 1  SELECT ... FOR UPDATE in a fixed order (start_at, court_id), then a conditional UPDATE
 *            that only moves AVAILABLE slots (or HELD slots whose hold has run out)
 *   layer 2  UNIQUE (court_id, start_at): a duplicate slot row cannot exist
 *   layer 3  booking_items_no_overlap exclusion constraint: the database refuses two active
 *            items on overlapping time, even if the code above had a bug
 *
 * Inventory correctness never depends on Redis, timers or cron: an expired hold is treated as free
 * by every read and every acquire (lazy reclaim). All SQL here is raw on purpose, so locking is explicit.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import { isLockContention, isTxTimeout } from '../../lib/pgerror'
import { ConflictError, NotFoundError } from '../../utils/errors'
import { SlotStatus, canTransition } from './booking.domain'

export interface SlotRow {
  id: string
  court_id: string
  venue_id: string
  business_date: Date
  start_at: Date
  end_at: Date
  price_minor: bigint
  price_tag: 'PEAK' | 'OFF_PEAK'
  status: SlotStatus
  hold_id: string | null
  hold_expires_at: Date | null
  booking_id: string | null
  block_reason: string | null
  block_ref: string | null
  version: number
}

/** A slot after a state change: what the hot lane and API responses carry. */
export interface SlotUpdate {
  slotId: string
  courtId: string
  venueId: string
  businessDate: string
  status: SlotStatus
  version: number
  holdExpiresAt: string | null
  bookingId: string | null
  blockReason: string | null
}

const SLOT_COLS = Prisma.sql`id, court_id, venue_id, business_date, start_at, end_at, price_minor, price_tag,
  status, hold_id, hold_expires_at, booking_id, block_reason, block_ref, version`

export const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function toUpdate(r: SlotRow): SlotUpdate {
  return {
    slotId: r.id,
    courtId: r.court_id,
    venueId: r.venue_id,
    businessDate: isoDate(r.business_date),
    status: r.status,
    version: r.version,
    holdExpiresAt: r.hold_expires_at ? r.hold_expires_at.toISOString() : null,
    bookingId: r.booking_id,
    blockReason: r.block_reason,
  }
}

/** Run an inventory transaction. Under a burst, waiting for a pooled connection must not turn into a 500. */
export async function inventoryTx<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // never wait long on a row lock: the loser of a race gets a clean 409 instead of queueing
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`)
        return fn(tx)
      },
      { maxWait: 20_000, timeout: 20_000 },
    )
  } catch (e) {
    if (isLockContention(e) || isTxTimeout(e))
      throw new ConflictError(
        'Those hours are being booked by someone else, try again',
        'SLOT_UNAVAILABLE',
        {
          reason: 'CONTENTION',
        },
      )
    throw e
  }
}

export async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  return (await tx.$queryRaw<{ n: Date }[]>`SELECT clock_timestamp() AS n`)[0].n
}

/** Lock the given slots in the global lock order. Returns the rows as they are now. */
export async function lockSlots(tx: Prisma.TransactionClient, ids: string[]): Promise<SlotRow[]> {
  return tx.$queryRaw<SlotRow[]>`
    SELECT ${SLOT_COLS} FROM slots WHERE id = ANY(${ids}::uuid[])
    ORDER BY start_at, court_id FOR UPDATE`
}

const isFree = (s: SlotRow, now: Date) =>
  s.status === 'AVAILABLE' ||
  (s.status === 'HELD' && !!s.hold_expires_at && s.hold_expires_at.getTime() <= now.getTime())

export type AcquireTarget = 'HELD' | 'BOOKED_APP' | 'BOOKED_WALKIN' | 'BLOCKED'

export interface AcquireOptions {
  target: AcquireTarget
  slotIds: string[]
  /** The booking the hours belong to (HELD and BOOKED_*). */
  bookingId?: string
  holdId?: string
  holdSeconds?: number
  blockReason?: string
  blockRef?: string
  blockNote?: string
  /** Code to use when an active hold by someone else is in the way. */
  heldCode?: 'SLOT_HELD' | 'SLOT_UNAVAILABLE'
}

/**
 * Take ALL the given hours or none (all-or-nothing). Throws 409 SLOT_UNAVAILABLE / SLOT_HELD
 * (the transaction rolls back). Expired holds are reclaimed here, and their pending bookings are
 * marked EXPIRED in the same transaction.
 */
export async function acquireSlots(
  tx: Prisma.TransactionClient,
  o: AcquireOptions,
): Promise<{ rows: SlotRow[]; updates: SlotUpdate[]; now: Date }> {
  const locked = await lockSlots(tx, o.slotIds)
  if (locked.length !== new Set(o.slotIds).size)
    throw new NotFoundError('One or more hours do not exist', 'SLOT_NOT_FOUND')

  const now = await dbNow(tx)
  const blockers = locked.filter((s) => !isFree(s, now))
  if (blockers.length > 0) {
    const activeHolds = blockers.filter((s) => s.status === 'HELD')
    if (o.heldCode === 'SLOT_HELD' && activeHolds.length > 0) {
      const secondsRemaining = Math.max(
        0,
        Math.ceil(
          Math.min(...activeHolds.map((s) => s.hold_expires_at!.getTime())) / 1000 -
            now.getTime() / 1000,
        ),
      )
      throw new ConflictError('Someone is paying for this hour right now', 'SLOT_HELD', {
        secondsRemaining,
        slotIds: activeHolds.map((s) => s.id),
      })
    }
    throw new ConflictError('One or more hours are no longer available', 'SLOT_UNAVAILABLE', {
      slotIds: blockers.map((s) => s.id),
    })
  }

  const expiredHoldIds = locked
    .filter((s) => s.status === 'HELD' && s.hold_id)
    .map((s) => s.hold_id as string)

  // Layer 1: conditional UPDATE. The WHERE repeats the eligibility test on the locked rows.
  const free = Prisma.sql`(status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))`
  let rows: SlotRow[]
  if (o.target === 'HELD') {
    rows = await tx.$queryRaw<SlotRow[]>`
      UPDATE slots SET status = 'HELD', hold_id = ${o.holdId}::uuid,
             hold_expires_at = clock_timestamp() + make_interval(secs => ${o.holdSeconds}::int),
             booking_id = ${o.bookingId ?? null}::uuid, block_reason = NULL, block_ref = NULL, block_note = NULL,
             version = version + 1, updated_at = clock_timestamp()
       WHERE id = ANY(${o.slotIds}::uuid[]) AND ${free}
      RETURNING ${SLOT_COLS}`
  } else if (o.target === 'BLOCKED') {
    rows = await tx.$queryRaw<SlotRow[]>`
      UPDATE slots SET status = 'BLOCKED', hold_id = NULL, hold_expires_at = NULL, booking_id = NULL,
             block_reason = ${o.blockReason ?? 'OTHER'}, block_ref = ${o.blockRef ?? null}::uuid,
             block_note = ${o.blockNote ?? null}, version = version + 1, updated_at = clock_timestamp()
       WHERE id = ANY(${o.slotIds}::uuid[]) AND ${free}
      RETURNING ${SLOT_COLS}`
  } else {
    rows = await tx.$queryRaw<SlotRow[]>`
      UPDATE slots SET status = ${o.target}, hold_id = NULL, hold_expires_at = NULL,
             booking_id = ${o.bookingId ?? null}::uuid, block_reason = NULL, block_ref = NULL, block_note = NULL,
             version = version + 1, updated_at = clock_timestamp()
       WHERE id = ANY(${o.slotIds}::uuid[]) AND ${free}
      RETURNING ${SLOT_COLS}`
  }
  if (rows.length !== new Set(o.slotIds).size)
    throw new ConflictError('One or more hours are no longer available', 'SLOT_UNAVAILABLE')

  if (expiredHoldIds.length > 0) await expireBookingsOfHolds(tx, expiredHoldIds)
  return { rows, updates: rows.map(toUpdate), now }
}

/** Mark pending bookings of runs-out holds EXPIRED. Idempotent. */
export async function expireBookingsOfHolds(tx: Prisma.TransactionClient, holdIds: string[]) {
  await tx.$executeRaw`
    UPDATE bookings SET status = 'EXPIRED', hold_id = NULL, hold_expires_at = NULL,
           version = version + 1, updated_at = clock_timestamp()
     WHERE hold_id = ANY(${holdIds}::uuid[]) AND status = 'PENDING_PAYMENT'`
}

/**
 * HELD -> BOOKED_APP for a booking whose hold is still valid. Fails with 409 HOLD_EXPIRED when the
 * hold ran out (another player may already own the hours).
 */
export async function confirmHold(
  tx: Prisma.TransactionClient,
  b: { id: string; hold_id: string; slot_ids: string[] },
): Promise<{ updates: SlotUpdate[] }> {
  const locked = await lockSlots(tx, b.slot_ids)
  const now = await dbNow(tx)
  const ok =
    locked.length === b.slot_ids.length &&
    locked.every(
      (s) =>
        s.status === 'HELD' &&
        s.hold_id === b.hold_id &&
        s.hold_expires_at &&
        s.hold_expires_at.getTime() > now.getTime(),
    )
  if (!ok) throw new ConflictError('Your hold has expired', 'HOLD_EXPIRED')
  const rows = await tx.$queryRaw<SlotRow[]>`
    UPDATE slots SET status = 'BOOKED_APP', hold_id = NULL, hold_expires_at = NULL, booking_id = ${b.id}::uuid,
           version = version + 1, updated_at = clock_timestamp()
     WHERE id = ANY(${b.slot_ids}::uuid[]) AND hold_id = ${b.hold_id}::uuid AND status = 'HELD'
    RETURNING ${SLOT_COLS}`
  if (rows.length !== b.slot_ids.length)
    throw new ConflictError('Your hold has expired', 'HOLD_EXPIRED')
  return { updates: rows.map(toUpdate) }
}

/** HELD -> AVAILABLE for one hold (player released it, or it ran out). Idempotent. */
export async function releaseHold(
  tx: Prisma.TransactionClient,
  holdId: string,
): Promise<SlotUpdate[]> {
  await tx.$queryRaw`SELECT id FROM slots WHERE hold_id = ${holdId}::uuid ORDER BY start_at, court_id FOR UPDATE`
  const rows = await tx.$queryRaw<SlotRow[]>`
    UPDATE slots SET status = 'AVAILABLE', hold_id = NULL, hold_expires_at = NULL, booking_id = NULL,
           version = version + 1, updated_at = clock_timestamp()
     WHERE hold_id = ${holdId}::uuid AND status = 'HELD'
    RETURNING ${SLOT_COLS}`
  return rows.map(toUpdate)
}

export interface WindowBlockResult {
  blocked: SlotUpdate[]
  /** active holds in the way: they free themselves within the hold time */
  heldSkipped: Array<{ slotId: string; courtId: string; startAt: string; secondsRemaining: number }>
  /** confirmed bookings in the way: never overridden, they need the cancellation flow */
  conflicts: Array<{
    slotId: string
    courtId: string
    startAt: string
    status: SlotStatus
    bookingId: string | null
    bookingRef: string | null
    source: string | null
    customerName: string | null
  }>
  alreadyBlocked: number
}

/**
 * Block every free hour of the given courts in [from, to). Partial by design: free hours are
 * blocked, active holds are skipped and reported, booked hours are reported as conflicts and are
 * NEVER silently blocked. Expired holds count as free.
 */
export async function blockWindow(
  tx: Prisma.TransactionClient,
  o: {
    venueId: string
    courtIds: string[]
    from: Date
    to: Date
    reason: string
    note?: string | null
    ref?: string | null
  },
): Promise<WindowBlockResult> {
  const locked = await tx.$queryRaw<SlotRow[]>`
    SELECT ${SLOT_COLS} FROM slots
     WHERE venue_id = ${o.venueId}::uuid AND court_id = ANY(${o.courtIds}::uuid[])
       AND start_at >= ${o.from} AND start_at < ${o.to}
     ORDER BY start_at, court_id FOR UPDATE`
  const now = await dbNow(tx)
  const free = locked.filter((s) => isFree(s, now))
  const held = locked.filter((s) => !isFree(s, now) && s.status === 'HELD')
  const booked = locked.filter((s) => s.status === 'BOOKED_APP' || s.status === 'BOOKED_WALKIN')
  const alreadyBlocked = locked.filter((s) => s.status === 'BLOCKED').length

  let blocked: SlotUpdate[] = []
  const freeIds = free.map((s) => s.id)
  const expiredHoldIds = free.filter((s) => s.status === 'HELD' && s.hold_id).map((s) => s.hold_id!)
  if (freeIds.length > 0) {
    const rows = await tx.$queryRaw<SlotRow[]>`
      UPDATE slots SET status = 'BLOCKED', hold_id = NULL, hold_expires_at = NULL, booking_id = NULL,
             block_reason = ${o.reason}, block_ref = ${o.ref ?? null}::uuid, block_note = ${o.note ?? null},
             version = version + 1, updated_at = clock_timestamp()
       WHERE id = ANY(${freeIds}::uuid[])
         AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))
      RETURNING ${SLOT_COLS}`
    blocked = rows.map(toUpdate)
    if (expiredHoldIds.length > 0) await expireBookingsOfHolds(tx, expiredHoldIds)
  }

  const bookingIds = booked.map((s) => s.booking_id).filter((x): x is string => !!x)
  const info = bookingIds.length
    ? await tx.$queryRaw<{ id: string; ref: string; source: string; customer_name: string }[]>`
        SELECT id, ref, source, customer_name FROM bookings WHERE id = ANY(${bookingIds}::uuid[])`
    : []
  const byId = new Map(info.map((b) => [b.id, b]))

  return {
    blocked,
    heldSkipped: held.map((s) => ({
      slotId: s.id,
      courtId: s.court_id,
      startAt: s.start_at.toISOString(),
      secondsRemaining: Math.max(
        0,
        Math.ceil((s.hold_expires_at!.getTime() - now.getTime()) / 1000),
      ),
    })),
    conflicts: booked.map((s) => {
      const b = s.booking_id ? byId.get(s.booking_id) : undefined
      return {
        slotId: s.id,
        courtId: s.court_id,
        startAt: s.start_at.toISOString(),
        status: s.status,
        bookingId: s.booking_id,
        bookingRef: b?.ref ?? null,
        source: b?.source ?? null,
        customerName: b?.customer_name ?? null,
      }
    }),
    alreadyBlocked,
  }
}

/**
 * BLOCKED -> AVAILABLE. Only future hours. By window (manual blocks), by block reference (an outage
 * lock) or by explicit slot ids (admin override). Tournament blocks are never released by a
 * plain unblock.
 */
export async function releaseBlocks(
  tx: Prisma.TransactionClient,
  o:
    | { kind: 'window'; venueId: string; courtIds: string[]; from: Date; to: Date }
    | { kind: 'ref'; venueId: string; ref: string }
    | { kind: 'ids'; slotIds: string[] },
): Promise<SlotUpdate[]> {
  let cands: SlotRow[]
  if (o.kind === 'window') {
    cands = await tx.$queryRaw<SlotRow[]>`
      SELECT ${SLOT_COLS} FROM slots
       WHERE venue_id = ${o.venueId}::uuid AND court_id = ANY(${o.courtIds}::uuid[])
         AND start_at >= ${o.from} AND start_at < ${o.to} AND status = 'BLOCKED'
         AND block_ref IS NULL AND COALESCE(block_reason, '') <> 'TOURNAMENT'
       ORDER BY start_at, court_id FOR UPDATE`
  } else if (o.kind === 'ref') {
    cands = await tx.$queryRaw<SlotRow[]>`
      SELECT ${SLOT_COLS} FROM slots
       WHERE venue_id = ${o.venueId}::uuid AND block_ref = ${o.ref}::uuid AND status = 'BLOCKED'
       ORDER BY start_at, court_id FOR UPDATE`
  } else {
    cands = await lockSlots(tx, o.slotIds)
    for (const s of cands)
      if (!canTransition(s.status, 'AVAILABLE') || s.status !== 'BLOCKED')
        throw new ConflictError(
          `Hour ${s.id} cannot go from ${s.status} to AVAILABLE`,
          'INVALID_SLOT_TRANSITION',
          { slotId: s.id, from: s.status, to: 'AVAILABLE' },
        )
  }
  const ids = cands.filter((s) => s.end_at.getTime() > Date.now()).map((s) => s.id)
  if (ids.length === 0) return []
  const rows = await tx.$queryRaw<SlotRow[]>`
    UPDATE slots SET status = 'AVAILABLE', block_reason = NULL, block_ref = NULL, block_note = NULL,
           version = version + 1, updated_at = clock_timestamp()
     WHERE id = ANY(${ids}::uuid[]) AND status = 'BLOCKED'
    RETURNING ${SLOT_COLS}`
  return rows.map(toUpdate)
}
