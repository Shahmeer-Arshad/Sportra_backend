/** Admin oversight of bookings: search, detail with audit trail, emergency overrides, outage monitor, abuse flags, health. */
import { Prisma, PrismaClient } from '@prisma/client'
import { audit } from '../../lib/audit'
import { HotLane } from '../../lib/hotlane'
import { BadRequestError, NotFoundError } from '../../utils/errors'
import { releaseBlocks, publishSlotUpdates } from './booking.inventory'
import {
  BookingRowRaw,
  bookingJson,
  cancelBookingItems,
  cancelResponse,
  dbNowOf,
  loadBooking,
  loadItems,
} from './booking.shared'

/** Users with this many strikes (or more) show up in the abuse list. */
export const ABUSE_NO_SHOWS = 3
export const ABUSE_ABANDONED_HOLDS = 5

export interface RealtimeStats {
  connections: number
  emitted: number
  p95LatencyMs: number | null
}

export function createAdminBookingService(
  prisma: PrismaClient,
  hotLane: HotLane,
  realtimeStats: () => RealtimeStats,
) {
  return {
    async search(q: {
      ref?: string
      email?: string
      phone?: string
      venueId?: string
      date?: string
      status?: string
      limit: number
      offset: number
    }) {
      const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      const where = Prisma.sql`TRUE
        ${q.ref ? Prisma.sql`AND b.ref = ${q.ref.trim().toUpperCase()}` : Prisma.empty}
        ${q.email ? Prisma.sql`AND (u.email ILIKE ${like(q.email)} OR b.customer_email ILIKE ${like(q.email)})` : Prisma.empty}
        ${q.phone ? Prisma.sql`AND b.customer_phone ILIKE ${like(q.phone)}` : Prisma.empty}
        ${q.venueId ? Prisma.sql`AND b.venue_id = ${q.venueId}::uuid` : Prisma.empty}
        ${q.date ? Prisma.sql`AND b.business_date = ${q.date}::date` : Prisma.empty}
        ${q.status ? Prisma.sql`AND b.status = ANY(${q.status.split(',')}::text[])` : Prisma.empty}`
      const rows = await prisma.$queryRaw<
        (BookingRowRaw & { venue_name: string; user_email: string | null })[]
      >`
        SELECT b.*, v.name AS venue_name, u.email AS user_email
          FROM bookings b JOIN venues v ON v.id = b.venue_id LEFT JOIN users u ON u.id = b.user_id
         WHERE ${where} ORDER BY b.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`
      const total = (
        await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM bookings b LEFT JOIN users u ON u.id = b.user_id WHERE ${where}`
      )[0].n
      const now = await dbNowOf(prisma)
      return {
        items: rows.map((r) => ({
          ...bookingJson(r, { now, venueName: r.venue_name }),
          userEmail: r.user_email,
        })),
        total,
      }
    },

    async detail(id: string) {
      const b = await loadBooking(prisma, id)
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
      const [items, trail, cancellations, v, c, user] = await Promise.all([
        loadItems(prisma, id),
        prisma.auditLog.findMany({
          where: { entity: 'booking', entityId: id },
          orderBy: { id: 'asc' },
          take: 200,
        }),
        prisma.bookingCancellation.findMany({
          where: { bookingId: id },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.venue.findUnique({ where: { id: b.venue_id }, select: { name: true } }),
        prisma.court.findUnique({ where: { id: b.court_id }, select: { name: true } }),
        b.user_id
          ? prisma.user.findUnique({
              where: { id: b.user_id },
              select: { email: true, fullName: true },
            })
          : null,
      ])
      return {
        ...bookingJson(b, {
          now: await dbNowOf(prisma),
          items,
          venueName: v?.name,
          courtName: c?.name,
        }),
        user: user && { id: b.user_id, email: user.email, fullName: user.fullName },
        cancellations: cancellations.map((x) => ({
          id: x.id,
          cancelledBy: x.cancelledBy,
          reason: x.reason,
          refundDueMinor: Number(x.refundDueMinor),
          forfeitMinor: Number(x.forfeitMinor),
          at: x.createdAt.toISOString(),
        })),
        // item-level history lives in the items (status, cancelledAt, cancelledBy); the audit trail is the full story
        auditTrail: trail.map((a) => ({
          at: a.at.toISOString(),
          action: a.action,
          actorId: a.actorId,
          actorType: a.actorType,
          before: a.before,
          after: a.after,
        })),
      }
    },

    /** Emergency cancel on behalf of a venue. The reason is mandatory and audited. */
    async cancel(
      adminId: string,
      bookingId: string,
      input: { reason: string; itemIds?: string[] },
      cancellationId: string,
      ip?: string | null,
    ) {
      const reason = input.reason.trim()
      if (reason.length < 5)
        throw new BadRequestError(
          'A reason of at least 5 characters is required',
          'REASON_REQUIRED',
        )
      const b = await loadBooking(prisma, bookingId)
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
      const r = await cancelBookingItems(prisma, hotLane, {
        bookingId,
        itemIds: input.itemIds,
        cancelledBy: 'VENUE',
        reason: `Admin: ${reason}`,
        actorId: adminId,
        cancellationId,
      })
      if (!r.replayed)
        await prisma.$transaction((tx) =>
          audit(tx, {
            actorId: adminId,
            actorType: 'ADMIN',
            venueId: b.venue_id,
            action: 'ADMIN_BOOKING_CANCELLED',
            entity: 'booking',
            entityId: bookingId,
            after: { reason, cancellationId, itemIds: input.itemIds ?? 'all' },
            ip,
          }),
        )
      return cancelResponse(r)
    },

    /** Emergency unblock (manual blocks, outage blocks, tournament blocks). Reason mandatory. */
    async unblock(
      adminId: string,
      input: { slotIds: string[]; reason: string },
      ip?: string | null,
    ) {
      const reason = input.reason.trim()
      if (reason.length < 5)
        throw new BadRequestError(
          'A reason of at least 5 characters is required',
          'REASON_REQUIRED',
        )
      const updates = await prisma.$transaction(async (tx) => {
        const u = await releaseBlocks(tx, { kind: 'ids', slotIds: input.slotIds })
        await audit(tx, {
          actorId: adminId,
          actorType: 'ADMIN',
          action: 'ADMIN_SLOTS_UNBLOCKED',
          entity: 'slots',
          entityId: input.slotIds.join(','),
          after: { reason, released: u.map((x) => x.slotId) },
          ip,
        })
        return u
      })
      publishSlotUpdates(hotLane, updates)
      return { releasedCount: updates.length, releasedSlotIds: updates.map((u) => u.slotId) }
    },

    async outageLocks(status?: string) {
      const rows = await prisma.outageLock.findMany({
        where: status ? { status } : { status: { not: 'RELEASED' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
      const venues = await prisma.venue.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.venueId))] } },
        select: { id: true, name: true },
      })
      const vn = new Map(venues.map((v) => [v.id, v.name]))
      return rows.map((l) => ({
        id: l.id,
        venueId: l.venueId,
        venueName: vn.get(l.venueId),
        status: l.status,
        reason: l.reason,
        from: l.windowStart.toISOString(),
        to: l.windowEnd.toISOString(),
        totalBookings: l.totalBookings,
        processed: l.processed,
        failed: l.failed,
        createdAt: l.createdAt.toISOString(),
      }))
    },

    async abuseFlags() {
      const users = await prisma.$queryRaw<
        { id: string; email: string; full_name: string; no_show_count: number; abandoned: number }[]
      >`
        SELECT u.id, u.email, u.full_name, u.no_show_count,
               (SELECT count(*)::int FROM bookings b
                 WHERE b.user_id = u.id AND b.source = 'APP' AND b.status = 'EXPIRED'
                   AND b.created_at > now() - interval '30 days') AS abandoned
          FROM users u
         WHERE u.no_show_count >= ${ABUSE_NO_SHOWS}
            OR (SELECT count(*) FROM bookings b WHERE b.user_id = u.id AND b.source = 'APP' AND b.status = 'EXPIRED'
                   AND b.created_at > now() - interval '30 days') >= ${ABUSE_ABANDONED_HOLDS}
         ORDER BY u.no_show_count DESC, u.id LIMIT 200`
      const blocklist = await prisma.$queryRaw<
        { venue_id: string; venue_name: string; phone: string; reason: string | null }[]
      >`
        SELECT bl.venue_id, v.name AS venue_name, bl.phone, bl.reason
          FROM venue_blocklist bl JOIN venues v ON v.id = bl.venue_id ORDER BY bl.created_at DESC LIMIT 200`
      return {
        thresholds: { noShows: ABUSE_NO_SHOWS, abandonedHolds30d: ABUSE_ABANDONED_HOLDS },
        users: users.map((u) => ({
          userId: u.id,
          email: u.email,
          fullName: u.full_name,
          noShowCount: u.no_show_count,
          abandonedHolds30d: u.abandoned,
        })),
        venueBlocklist: blocklist.map((b) => ({
          venueId: b.venue_id,
          venueName: b.venue_name,
          phone: b.phone,
          reason: b.reason,
        })),
      }
    },

    /** Tiles for the admin dashboard. */
    async health() {
      const [s] = await prisma.$queryRaw<
        { backlog: number; active_holds: number; stale_pending: number; slots: number }[]
      >`
        SELECT count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at <= clock_timestamp())::int AS backlog,
               count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at > clock_timestamp())::int AS active_holds,
               (SELECT count(*)::int FROM bookings WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()) AS stale_pending,
               count(*)::int AS slots
          FROM slots WHERE start_at > clock_timestamp() - interval '1 day'`
      const [o] = await prisma.$queryRaw<{ unpublished: number; oldest_s: number | null }[]>`
        SELECT count(*)::int AS unpublished,
               EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at)))::float8 AS oldest_s
          FROM outbox WHERE published_at IS NULL`
      return {
        holdExpiryBacklog: s.backlog,
        activeHolds: s.active_holds,
        stalePendingBookings: s.stale_pending,
        recentSlots: s.slots,
        outboxUnpublished: o.unpublished,
        outboxOldestSeconds: o.oldest_s,
        realtime: realtimeStats(),
      }
    },
  }
}
export type AdminBookingService = ReturnType<typeof createAdminBookingService>
