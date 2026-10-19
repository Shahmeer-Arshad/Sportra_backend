/** Admin oversight of bookings: search, detail with audit trail, outage monitor, abuse flags, health. */
import { NotFoundError } from '../../utils/errors'
import { ABUSE_ABANDONED_HOLDS, ABUSE_NO_SHOWS } from './booking.domain'
import { BookingQueries } from './booking.repository'
import { bookingJson } from './booking.view'
import { AdminSearch } from './repositories/admin.queries'

export interface RealtimeStats {
  connections: number
  emitted: number
  p95LatencyMs: number | null
}

export function createAdminService(repo: BookingQueries, realtimeStats: () => RealtimeStats) {
  return {
    async search(q: AdminSearch) {
      const { rows, total } = await repo.searchBookings(q)
      const now = await repo.clock()
      return {
        items: rows.map((r) => ({
          ...bookingJson(r, { now, venueName: r.venue_name }),
          userEmail: r.user_email,
        })),
        total,
      }
    },

    async detail(id: string) {
      const b = await repo.bookingById(id)
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
      const [items, trail, cancellations, v, c, user] = await Promise.all([
        repo.bookingItems(id),
        repo.bookingAuditTrail(id),
        repo.cancellationsOf(id),
        repo.venueName(b.venue_id),
        repo.courtName(b.court_id),
        b.user_id ? repo.userBrief(b.user_id) : null,
      ])
      return {
        ...bookingJson(b, {
          now: await repo.clock(),
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

    async outageLocks(status?: string) {
      const rows = await repo.outagesForAdmin(status)
      const venues = await repo.venueNames([...new Set(rows.map((r) => r.venueId))])
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
      const users = await repo.abuseCandidates(ABUSE_NO_SHOWS, ABUSE_ABANDONED_HOLDS)
      const blocklist = await repo.allBlocklists()
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
      const s = await repo.inventoryHealth()
      const o = await repo.outboxHealth()
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
