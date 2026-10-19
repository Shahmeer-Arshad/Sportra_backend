import type { FastifyBaseLogger } from 'fastify'
import { env } from '../../config/env'
import { HotLane } from '../../lib/hotlane'
import { addDays, todayIn } from '../../lib/time'
import { OperatingHours, PriceRule } from '../venue/venue.domain'
import { planSlots } from './booking.domain'
import { toUpdate } from './booking.inventory'
import { publishSlotUpdates } from './booking.realtime'
import { BookingRepository } from './booking.repository'

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
  repo: BookingRepository,
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
    const court = await repo.courtForGeneration(courtId)
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
    await repo.transaction(
      async (q) => {
        await q.setLockTimeout('3s')
        for (let i = 0; i < plan.length; i += CHUNK) {
          for (const inserted of await q.upsertPlan(courtId, v.id, plan.slice(i, i + CHUNK))) {
            if (inserted) report.inserted++
            else report.repriced++
          }
        }
        const starts = plan.map((p) => p.startAt.toISOString())
        report.deleted = await q.deleteStaleSlots(courtId, fromDate, toDate, starts)
        report.orphaned = (await q.orphanedSlots(courtId, fromDate, toDate, starts)).map((o) => ({
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
    const out: GenerationReport[] = []
    for (const id of await repo.courtIdsOfVenue(venueId)) out.push(await generateForCourt(id))
    return out
  }

  /** Nightly job: extend the horizon for every verified venue. */
  async function generateAll(only?: string[]): Promise<{ venues: number; inserted: number }> {
    const venueIds = await repo.verifiedVenueIds(only)
    let inserted = 0
    for (const venueId of venueIds) {
      try {
        for (const r of await generateForVenue(venueId)) inserted += r.inserted
      } catch (err) {
        log?.warn({ err, venueId }, 'Slot generation failed for venue')
      }
    }
    return { venues: venueIds.length, inserted }
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
      const done = await repo.transaction((q) => q.releaseExpiredHolds(limit))
      if (done.length === 0) break
      released += done.length
      publishSlotUpdates(hotLane, done.map(toUpdate))
      if (done.length < limit) break
    }
    // pending bookings whose hold ran out (their slots may already belong to someone else)
    const expired = await repo.transaction(async (q) => {
      const rows = await q.expireStaleBookings(limit)
      for (const b of rows)
        await q.emit({
          type: 'booking.hold_expired',
          routingKey: 'booking.hold_expired',
          producer: 'booking',
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
    const completed = await repo.completePlayedBookings()
    return { released, expiredBookings: expired.length, completed }
  }

  /** Idle housekeeping: old idempotency keys are no longer needed after a day. */
  const purgeIdempotencyKeys = (olderThanHours = 24) => repo.purgeIdempotencyKeys(olderThanHours)

  return { generateForCourt, generateForVenue, generateAll, sweep, purgeIdempotencyKeys }
}
