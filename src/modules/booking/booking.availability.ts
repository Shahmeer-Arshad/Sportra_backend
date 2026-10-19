/**
 * Availability reads. Players get a compact public grid (no customer data, ETag for budget phones).
 * Staff get the live grid with full detail, never cached.
 */
import { createHash } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { env } from '../../config/env'
import { BadRequestError, NotFoundError } from '../../utils/errors'
import { addDays, todayIn } from '../../lib/time'
import { SlotStatus, effectiveStatus, isLikelyNoShow, publicStatus } from './booking.domain'
import { dbNowOf, num } from './booking.shared'

interface GridRow {
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

const GRID_SQL = (venueId: string, date: string, courtId?: string | null) => Prisma.sql`
  SELECT id, court_id, start_at, end_at, business_date, price_minor, price_tag, status, hold_expires_at,
         block_reason, block_note, block_ref, version, booking_id
    FROM slots
   WHERE venue_id = ${venueId}::uuid AND business_date = ${date}::date
     ${courtId ? Prisma.sql`AND court_id = ${courtId}::uuid` : Prisma.empty}
   ORDER BY court_id, start_at`

export function createAvailabilityService(prisma: PrismaClient) {
  async function venueByIdOrSlug(idOrSlug: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug)
    return prisma.venue.findFirst({
      where: isUuid ? { id: idOrSlug } : { slug: idOrSlug },
      include: { courts: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
    })
  }

  function checkDate(date: string, tz: string, horizon = env.SLOT_HORIZON_DAYS) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
      throw new BadRequestError('date must be yyyy-mm-dd', 'VALIDATION_ERROR')
    const today = todayIn(tz)
    if (date < addDays(today, -1) || date > addDays(today, horizon))
      throw new BadRequestError(
        `date must be within ${horizon} days from today`,
        'DATE_OUT_OF_RANGE',
      )
    return today
  }

  return {
    /** Public grid for one venue and business date. */
    async publicGrid(idOrSlug: string, date: string, courtId?: string) {
      const v = await venueByIdOrSlug(idOrSlug)
      if (!v || v.verificationStatus !== 'VERIFIED' || !v.isActive)
        throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      checkDate(date, v.timezone)
      const now = await dbNowOf(prisma)
      // a court the owner switched off disappears from the public grid
      const activeCourts = new Set(v.courts.map((c) => c.id))
      const rows = (await prisma.$queryRaw<GridRow[]>(GRID_SQL(v.id, date, courtId))).filter((r) =>
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
      const v = await prisma.venue.findUnique({
        where: { id: venueId },
        include: { courts: { orderBy: { createdAt: 'asc' } } },
      })
      if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      checkDate(date, v.timezone, 400)
      const now = await dbNowOf(prisma)
      const rows = await prisma.$queryRaw<GridRow[]>(GRID_SQL(v.id, date, courtId))
      const bookingIds = [...new Set(rows.map((r) => r.booking_id).filter((x): x is string => !!x))]
      const bks = bookingIds.length
        ? await prisma.$queryRaw<
            {
              id: string
              ref: string
              source: string
              customer_name: string
              customer_phone: string
              status: string
              balance_due_minor: bigint
              start_at: Date
              headcount: number | null
            }[]
          >`SELECT id, ref, source, customer_name, customer_phone, status, balance_due_minor, start_at, headcount
              FROM bookings WHERE id = ANY(${bookingIds}::uuid[])`
        : []
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
export type AvailabilityService = ReturnType<typeof createAvailabilityService>
