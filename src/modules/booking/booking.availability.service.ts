/**
 * Availability reads. Players get a compact public grid (no customer data, ETag for budget phones).
 * Staff get the live grid with full detail, never cached.
 */
import { createHash } from 'crypto'
import { env } from '../../config/env'
import { addDays, todayIn } from '../../lib/time'
import { BadRequestError, NotFoundError } from '../../utils/errors'
import { effectiveStatus, isLikelyNoShow, publicStatus } from './booking.domain'
import { BookingQueries } from './booking.repository'
import { num } from './booking.view'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function checkDate(date: string, tz: string, horizon = env.SLOT_HORIZON_DAYS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
    throw new BadRequestError('date must be yyyy-mm-dd', 'VALIDATION_ERROR')
  const today = todayIn(tz)
  if (date < addDays(today, -1) || date > addDays(today, horizon))
    throw new BadRequestError(`date must be within ${horizon} days from today`, 'DATE_OUT_OF_RANGE')
}

export function createAvailabilityService(repo: BookingQueries) {
  return {
    /** Public grid for one venue and business date. */
    async publicGrid(idOrSlug: string, date: string, courtId?: string) {
      const v = await repo.venueWithActiveCourts(idOrSlug, UUID.test(idOrSlug))
      if (!v || v.verificationStatus !== 'VERIFIED' || !v.isActive)
        throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      checkDate(date, v.timezone)
      const now = await repo.clock()
      // a court the owner switched off disappears from the public grid
      const activeCourts = new Set(v.courts.map((c) => c.id))
      const rows = (await repo.gridRows(v.id, date, courtId)).filter((r) =>
        activeCourts.has(r.court_id),
      )
      const body = {
        venueId: v.id,
        date,
        timezone: v.timezone,
        courts: v.courts.map((c) => ({
          id: c.id,
          name: c.name,
          sport: c.sport,
          surface: c.surface,
        })),
        slots: rows.map((r) => {
          const st = effectiveStatus({ status: r.status, holdExpiresAt: r.hold_expires_at }, now)
          return {
            id: r.id,
            courtId: r.court_id,
            startAt: r.start_at.toISOString(),
            endAt: r.end_at.toISOString(),
            priceMinor: num(r.price_minor),
            priceTag: r.price_tag,
            // held by someone else is shown as unavailable; no names, no booking details
            status: publicStatus(st),
            version: r.version,
          }
        }),
      }
      // ETag over the content only (not the clock), so an unchanged grid answers 304
      const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 20)}"`
      return { body: { ...body, serverNow: now.toISOString() }, etag }
    },

    /** Live POS grid: full detail, customers, hold timers. Never cached. */
    async posGrid(venueId: string, date: string, courtId?: string) {
      const v = await repo.venueWithAllCourts(venueId)
      if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      checkDate(date, v.timezone, 400)
      const now = await repo.clock()
      const rows = await repo.gridRows(v.id, date, courtId)
      const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((x): x is string => !!x))]
      const bks = bookingIds.length ? await repo.gridBookings(bookingIds) : []
      const byId = new Map(bks.map((b) => [b.id, b]))
      return {
        venueId: v.id,
        date,
        timezone: v.timezone,
        serverNow: now.toISOString(),
        courts: v.courts.map((c) => ({
          id: c.id,
          name: c.name,
          sport: c.sport,
          isActive: c.isActive,
        })),
        slots: rows.map((r) => {
          const st = effectiveStatus({ status: r.status, holdExpiresAt: r.hold_expires_at }, now)
          const b = r.booking_id ? byId.get(r.booking_id) : undefined
          const held = st === 'HELD' && r.hold_expires_at
          return {
            id: r.id,
            courtId: r.court_id,
            startAt: r.start_at.toISOString(),
            endAt: r.end_at.toISOString(),
            priceMinor: num(r.price_minor),
            priceTag: r.price_tag,
            status: st,
            version: r.version,
            holdSecondsLeft: held
              ? Math.max(0, Math.ceil((r.hold_expires_at!.getTime() - now.getTime()) / 1000))
              : null,
            blockReason: st === 'BLOCKED' ? r.block_reason : null,
            blockNote: st === 'BLOCKED' ? r.block_note : null,
            blockRef: st === 'BLOCKED' ? r.block_ref : null,
            booking:
              b && (st === 'BOOKED_APP' || st === 'BOOKED_WALKIN')
                ? {
                    id: b.id,
                    ref: b.ref,
                    source: b.source,
                    customerName: b.customer_name,
                    customerPhone: b.customer_phone,
                    status: b.status,
                    balanceDueMinor: num(b.balance_due_minor),
                    unpaid: num(b.balance_due_minor) > 0,
                    headcount: b.headcount,
                    likelyNoShow: isLikelyNoShow(
                      { status: b.status, startAt: b.start_at },
                      now,
                      env.NO_SHOW_AFTER_MINUTES,
                    ),
                  }
                : null,
          }
        }),
      }
    },
  }
}
