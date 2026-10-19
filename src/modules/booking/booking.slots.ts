import { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { env } from '../../config/env'
import { HotLane } from '../../lib/hotlane'
import { uuidv7 } from '../../lib/id'
import { addOutbox } from '../../lib/outbox'
import { addDays, todayIn } from '../../lib/time'
import { PriceRule, OperatingHours } from '../venue/venue.domain'
import { planSlots } from './booking.domain'
import { SlotRow, publishSlotUpdates, toUpdate } from './booking.inventory'

const PRODUCER = 'booking'
const CHUNK = 500

export interface GenerationReport {
  courtId: string
  planned: number
  inserted: number
  repriced: number
  deleted: number
  /** booked / held / blocked hours that fall outside the new opening hours: the owner must resolve them */
  orphaned: Array<{ slotId: string; status: string; startAt: string }>
}
const EMPTY = (courtId: string): GenerationReport => ({
  courtId,
  planned: 0,
  inserted: 0,
  repriced: 0,
  deleted: 0,
  orphaned: [],
})

export function createSlotService(
  prisma: PrismaClient,
  hotLane: HotLane,
  log?: Pick<FastifyBaseLogger, 'warn' | 'info'>,
) {
  /**
   * Create / refresh a court's slots for the rolling horizon (60 days by default). Idempotent:
   * - new hours are inserted (ON CONFLICT on (court_id, start_at))
   * - the price of a FUTURE, AVAILABLE hour is refreshed; held, booked and blocked hours are never touched
   * - future AVAILABLE hours outside the new opening hours are deleted
   * Only verified, active venues with an active court get slots.
   */
  async function generateForCourt(
    courtId: string,
    opts: { fromDate?: string; toDate?: string } = {},
  ): Promise<GenerationReport> {
    const court = await prisma.court.findUnique({
      where: { id: courtId },
      include: { venue: true, pricingRules: true },
    })
    if (!court) return EMPTY(courtId)
    const v = court.venue
    if (v.verificationStatus !== 'VERIFIED' || !v.isActive || !court.isActive) return EMPTY(courtId)

    const tz = v.timezone
    const today = todayIn(tz)
    const fromDate = opts.fromDate && opts.fromDate > today ? opts.fromDate : today
    const toDate = opts.toDate ?? addDays(today, env.SLOT_HORIZON_DAYS - 1)
    const rules: PriceRule[] = court.pricingRules.map((r) => ({
      id: r.id,
      dayType: r.dayType as PriceRule['dayType'],
      startDate: r.startDate,
      endDate: r.endDate,
      fromTime: r.fromTime,
      toTime: r.toTime,
      priceMinor: r.priceMinor,
      priority: r.priority,
      tag: r.tag as PriceRule['tag'],
    }))
    const plan = planSlots({
      hours: (court.hoursOverride ?? v.operatingHours) as unknown as OperatingHours,
      slotMinutes: court.slotMinutes,
      tz,
      rules,
      fromDate,
      toDate,
    })

    const report = EMPTY(courtId)
    report.planned = plan.length
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`)
        for (let i = 0; i < plan.length; i += CHUNK) {
          const part = plan.slice(i, i + CHUNK)
          const rows = await tx.$queryRaw<{ inserted: boolean }[]>`
            INSERT INTO slots (id, court_id, venue_id, start_at, end_at, business_date, price_minor, price_tag)
            SELECT * FROM unnest(
              ${part.map(() => uuidv7())}::uuid[],
              ${part.map(() => courtId)}::uuid[],
              ${part.map(() => v.id)}::uuid[],
              ${part.map((p) => p.startAt.toISOString())}::timestamptz[],
              ${part.map((p) => p.endAt.toISOString())}::timestamptz[],
              ${part.map((p) => p.businessDate)}::date[],
              ${part.map((p) => p.priceMinor.toString())}::bigint[],
              ${part.map((p) => p.priceTag)}::text[])
            ON CONFLICT (court_id, start_at) DO UPDATE
              SET price_minor = EXCLUDED.price_minor, price_tag = EXCLUDED.price_tag,
                  version = slots.version + 1, updated_at = clock_timestamp()
              WHERE slots.status = 'AVAILABLE' AND slots.start_at > clock_timestamp()
                AND (slots.price_minor, slots.price_tag) IS DISTINCT FROM (EXCLUDED.price_minor, EXCLUDED.price_tag)
            RETURNING (xmax = 0) AS inserted`
          for (const r of rows) {
            if (r.inserted) report.inserted++
            else report.repriced++
          }
        }
        const starts = plan.map((p) => p.startAt.toISOString())
        const del = await tx.$executeRaw`
          DELETE FROM slots
           WHERE court_id = ${courtId}::uuid AND business_date BETWEEN ${fromDate}::date AND ${toDate}::date
             AND status = 'AVAILABLE' AND start_at > clock_timestamp()
             AND NOT (start_at = ANY(${starts}::timestamptz[]))`
        report.deleted = del
        const orphans = await tx.$queryRaw<{ id: string; status: string; start_at: Date }[]>`
          SELECT id, status, start_at FROM slots
           WHERE court_id = ${courtId}::uuid AND business_date BETWEEN ${fromDate}::date AND ${toDate}::date
             AND status <> 'AVAILABLE' AND start_at > clock_timestamp()
             AND NOT (start_at = ANY(${starts}::timestamptz[]))
           ORDER BY start_at LIMIT 100`
        report.orphaned = orphans.map((o) => ({
          slotId: o.id,
          status: o.status,
          startAt: o.start_at.toISOString(),
        }))
      },
      { maxWait: 10_000, timeout: 60_000 },
    )
    if (report.inserted + report.repriced + report.deleted > 0)
      hotLane.publish({ type: 'grid.changed', venueId: v.id })
    return report
  }

  async function generateForVenue(venueId: string): Promise<GenerationReport[]> {
    const courts = await prisma.court.findMany({ where: { venueId }, select: { id: true } })
    const out: GenerationReport[] = []
    for (const c of courts) out.push(await generateForCourt(c.id))
    return out
  }

  /** Nightly job: extend the horizon for every verified venue. */
  async function generateAll(only?: string[]): Promise<{ venues: number; inserted: number }> {
    const venues = await prisma.venue.findMany({
      where: { verificationStatus: 'VERIFIED', isActive: true, ...(only && { id: { in: only } }) },
      select: { id: true },
    })
    let inserted = 0
    for (const v of venues) {
      try {
        for (const r of await generateForVenue(v.id)) inserted += r.inserted
      } catch (err) {
        log?.warn({ err, venueId: v.id }, 'Slot generation failed for venue')
      }
    }
    return { venues: venues.length, inserted }
  }

  /**
   * Safety net, NOT needed for correctness (an expired hold is already treated as free). Moves
   * expired HELD slots back to AVAILABLE so clients see the change, expires the pending bookings,
   * and marks played bookings COMPLETED. Safe to run in many workers (SKIP LOCKED).
   */
  async function sweep(
    limit = 200,
  ): Promise<{ released: number; expiredBookings: number; completed: number }> {
    let released = 0
    for (;;) {
      const done = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<SlotRow[]>`
          UPDATE slots SET status = 'AVAILABLE', hold_id = NULL, hold_expires_at = NULL, booking_id = NULL,
                 version = version + 1, updated_at = clock_timestamp()
           WHERE id IN (SELECT id FROM slots WHERE status = 'HELD' AND hold_expires_at <= clock_timestamp()
                         ORDER BY hold_expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
          RETURNING id, court_id, venue_id, business_date, start_at, end_at, price_minor, price_tag,
                    status, hold_id, hold_expires_at, booking_id, block_reason, block_ref, version`
        return rows
      })
      if (done.length === 0) break
      released += done.length
      publishSlotUpdates(hotLane, done.map(toUpdate))
      if (done.length < limit) break
    }
    // pending bookings whose hold ran out (their slots may already belong to someone else)
    const expired = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; ref: string; venue_id: string; user_id: string | null }[]
      >`
        UPDATE bookings SET status = 'EXPIRED', hold_id = NULL, hold_expires_at = NULL,
               version = version + 1, updated_at = clock_timestamp()
         WHERE id IN (SELECT id FROM bookings WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()
                       ORDER BY hold_expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id, ref, venue_id, user_id`
      for (const b of rows)
        await addOutbox(tx, {
          type: 'booking.hold_expired',
          routingKey: 'booking.hold_expired',
          producer: PRODUCER,
          data: { bookingId: b.id, ref: b.ref, venueId: b.venue_id, userId: b.user_id },
        })
      return rows
    })
    for (const b of expired)
      hotLane.publish({
        type: 'booking.updated',
        bookingId: b.id,
        ref: b.ref,
        venueId: b.venue_id,
        userId: b.user_id,
        status: 'EXPIRED',
      })
    const completed = await prisma.$executeRaw`
      UPDATE bookings SET status = 'COMPLETED', version = version + 1, updated_at = clock_timestamp()
       WHERE status = 'CHECKED_IN' AND end_at <= clock_timestamp()`
    return { released, expiredBookings: expired.length, completed }
  }

  /** Idle housekeeping: old idempotency keys are no longer needed after a day. */
  async function purgeIdempotencyKeys(olderThanHours = 24): Promise<number> {
    return prisma.$executeRaw(
      Prisma.sql`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => ${olderThanHours}::int)`,
    )
  }

  return { generateForCourt, generateForVenue, generateAll, sweep, purgeIdempotencyKeys }
}
export type SlotService = ReturnType<typeof createSlotService>
