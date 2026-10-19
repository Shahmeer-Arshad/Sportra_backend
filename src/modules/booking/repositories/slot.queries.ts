import { Prisma } from '@prisma/client'
import { Db } from '../../../lib/outbox'
import {
  AcquireOptions,
  SlotRow,
  acquireSlots,
  blockWindow,
  confirmHold,
  releaseBlocks,
  releaseHold,
} from '../booking.inventory'
import { SlotStatus } from '../booking.domain'
import { BookingRowRaw } from './columns'

export interface GridRow {
  id: string
  court_id: string
  start_at: Date
  end_at: Date
  business_date: Date
  price_minor: bigint
  price_tag: string
  status: SlotStatus
  hold_expires_at: Date | null
  block_reason: string | null
  block_note: string | null
  block_ref: string | null
  version: number
  booking_id: string | null
}

export interface RequestedSlotRow {
  id: string
  court_id: string
  venue_id: string
  start_at: Date
  end_at: Date
  price_minor: bigint
  status: string
}

type Window = { venueId: string; courtIds: string[]; from: Date; to: Date }

/**
 * Slot reads and the inventory operations. The operations delegate to booking.inventory.ts, the
 * ONLY code that moves a slot (locks in a fixed order, then a conditional UPDATE).
 */
export function slotQueries(db: Db) {
  const tx = db as Prisma.TransactionClient

  return {
    // ───────── inventory operations (bound to this client) ─────────
    acquire: (o: AcquireOptions) => acquireSlots(tx, o),
    confirmHold: (b: { id: string; hold_id: string; slot_ids: string[] }) => confirmHold(tx, b),
    releaseHold: (holdId: string) => releaseHold(tx, holdId),
    blockWindow: (o: Window & { reason: string; note?: string | null; ref?: string | null }) =>
      blockWindow(tx, o),
    releaseWindow: (o: Window) => releaseBlocks(tx, { kind: 'window', ...o }),
    releaseByRef: (venueId: string, ref: string) =>
      releaseBlocks(tx, { kind: 'ref', venueId, ref }),
    releaseByIds: (slotIds: string[]) => releaseBlocks(tx, { kind: 'ids', slotIds }),

    // ───────── reads ─────────
    requestedSlots: (slotIds: string[]) =>
      db.$queryRaw<RequestedSlotRow[]>`
        SELECT id, court_id, venue_id, start_at, end_at, price_minor, status FROM slots WHERE id = ANY(${slotIds}::uuid[])`,
    slotTimes: (slotIds: string[]) =>
      db.$queryRaw<{ start_at: Date; end_at: Date }[]>`
        SELECT start_at, end_at FROM slots WHERE id = ANY(${slotIds}::uuid[]) ORDER BY start_at`,
    freeSlotsBetween: (venueId: string, from: Date, to: Date) =>
      db.$queryRaw<
        { id: string; court_id: string; start_at: Date; end_at: Date; price_minor: bigint }[]
      >`
        SELECT id, court_id, start_at, end_at, price_minor FROM slots
         WHERE venue_id = ${venueId}::uuid AND start_at > clock_timestamp() AND start_at >= ${from} AND start_at < ${to}
           AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))
         ORDER BY court_id, start_at`,
    freeHourCount: async (o: Window) =>
      (
        await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM slots
           WHERE venue_id = ${o.venueId}::uuid AND court_id = ANY(${o.courtIds}::uuid[]) AND start_at >= ${o.from} AND start_at < ${o.to}
             AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))`
      )[0].n,

    gridRows: (venueId: string, date: string, courtId?: string | null) =>
      db.$queryRaw<GridRow[]>(Prisma.sql`
        SELECT id, court_id, start_at, end_at, business_date, price_minor, price_tag, status, hold_expires_at,
               block_reason, block_note, block_ref, version, booking_id
          FROM slots
         WHERE venue_id = ${venueId}::uuid AND business_date = ${date}::date
           ${courtId ? Prisma.sql`AND court_id = ${courtId}::uuid` : Prisma.empty}
         ORDER BY court_id, start_at`),
    gridBookings: (bookingIds: string[]) =>
      db.$queryRaw<
        Pick<
          BookingRowRaw,
          | 'id'
          | 'ref'
          | 'source'
          | 'customer_name'
          | 'customer_phone'
          | 'status'
          | 'balance_due_minor'
          | 'start_at'
          | 'headcount'
        >[]
      >`SELECT id, ref, source, customer_name, customer_phone, status, balance_due_minor, start_at, headcount
          FROM bookings WHERE id = ANY(${bookingIds}::uuid[])`,
    venueWithActiveCourts: (idOrSlug: string, isUuid: boolean) =>
      db.venue.findFirst({
        where: isUuid ? { id: idOrSlug } : { slug: idOrSlug },
        include: { courts: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
      }),
    venueWithAllCourts: (id: string) =>
      db.venue.findUnique({
        where: { id },
        include: { courts: { orderBy: { createdAt: 'asc' } } },
      }),

    // ───────── sweep (safety net, never needed for correctness) ─────────
    releaseExpiredHolds: (limit: number) =>
      db.$queryRaw<SlotRow[]>`
        UPDATE slots SET status = 'AVAILABLE', hold_id = NULL, hold_expires_at = NULL, booking_id = NULL,
               version = version + 1, updated_at = clock_timestamp()
         WHERE id IN (SELECT id FROM slots WHERE status = 'HELD' AND hold_expires_at <= clock_timestamp()
                       ORDER BY hold_expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id, court_id, venue_id, business_date, start_at, end_at, price_minor, price_tag,
                  status, hold_id, hold_expires_at, booking_id, block_reason, block_ref, version`,
    expireStaleBookings: (limit: number) =>
      db.$queryRaw<{ id: string; ref: string; venue_id: string; user_id: string | null }[]>`
        UPDATE bookings SET status = 'EXPIRED', hold_id = NULL, hold_expires_at = NULL,
               version = version + 1, updated_at = clock_timestamp()
         WHERE id IN (SELECT id FROM bookings WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()
                       ORDER BY hold_expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id, ref, venue_id, user_id`,
    completePlayedBookings: () =>
      db.$executeRaw`
        UPDATE bookings SET status = 'COMPLETED', version = version + 1, updated_at = clock_timestamp()
         WHERE status = 'CHECKED_IN' AND end_at <= clock_timestamp()`,
    purgeIdempotencyKeys: (olderThanHours: number) =>
      db.$executeRaw(
        Prisma.sql`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => ${olderThanHours}::int)`,
      ),
  }
}
