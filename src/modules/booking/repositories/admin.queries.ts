import { Prisma } from '@prisma/client'
import { Db } from '../../../lib/outbox'
import { BookingRowRaw } from './columns'

export interface AdminSearch {
  ref?: string
  email?: string
  phone?: string
  venueId?: string
  date?: string
  status?: string
  limit: number
  offset: number
}

/** Cross-venue reads for the admin console. */
export function adminQueries(db: Db) {
  return {
    async searchBookings(q: AdminSearch) {
      const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      const where = Prisma.sql`TRUE
        ${q.ref ? Prisma.sql`AND b.ref = ${q.ref.trim().toUpperCase()}` : Prisma.empty}
        ${q.email ? Prisma.sql`AND (u.email ILIKE ${like(q.email)} OR b.customer_email ILIKE ${like(q.email)})` : Prisma.empty}
        ${q.phone ? Prisma.sql`AND b.customer_phone ILIKE ${like(q.phone)}` : Prisma.empty}
        ${q.venueId ? Prisma.sql`AND b.venue_id = ${q.venueId}::uuid` : Prisma.empty}
        ${q.date ? Prisma.sql`AND b.business_date = ${q.date}::date` : Prisma.empty}
        ${q.status ? Prisma.sql`AND b.status = ANY(${q.status.split(',')}::text[])` : Prisma.empty}`
      const rows = await db.$queryRaw<
        (BookingRowRaw & { venue_name: string; user_email: string | null })[]
      >`
        SELECT b.*, v.name AS venue_name, u.email AS user_email
          FROM bookings b JOIN venues v ON v.id = b.venue_id LEFT JOIN users u ON u.id = b.user_id
         WHERE ${where} ORDER BY b.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`
      const total = (
        await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM bookings b LEFT JOIN users u ON u.id = b.user_id WHERE ${where}`
      )[0].n
      return { rows, total }
    },

    bookingAuditTrail: (bookingId: string) =>
      db.auditLog.findMany({
        where: { entity: 'booking', entityId: bookingId },
        orderBy: { id: 'asc' },
        take: 200,
      }),
    cancellationsOf: (bookingId: string) =>
      db.bookingCancellation.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
    userBrief: (id: string) =>
      db.user.findUnique({ where: { id }, select: { email: true, fullName: true } }),

    abuseCandidates: (noShows: number, abandoned: number) =>
      db.$queryRaw<
        { id: string; email: string; full_name: string; no_show_count: number; abandoned: number }[]
      >`
        SELECT u.id, u.email, u.full_name, u.no_show_count,
               (SELECT count(*)::int FROM bookings b
                 WHERE b.user_id = u.id AND b.source = 'APP' AND b.status = 'EXPIRED'
                   AND b.created_at > now() - interval '30 days') AS abandoned
          FROM users u
         WHERE u.no_show_count >= ${noShows}
            OR (SELECT count(*) FROM bookings b WHERE b.user_id = u.id AND b.source = 'APP' AND b.status = 'EXPIRED'
                   AND b.created_at > now() - interval '30 days') >= ${abandoned}
         ORDER BY u.no_show_count DESC, u.id LIMIT 200`,
    allBlocklists: () =>
      db.$queryRaw<
        { venue_id: string; venue_name: string; phone: string; reason: string | null }[]
      >`
        SELECT bl.venue_id, v.name AS venue_name, bl.phone, bl.reason
          FROM venue_blocklist bl JOIN venues v ON v.id = bl.venue_id ORDER BY bl.created_at DESC LIMIT 200`,

    async inventoryHealth() {
      const [s] = await db.$queryRaw<
        { backlog: number; active_holds: number; stale_pending: number; slots: number }[]
      >`
        SELECT count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at <= clock_timestamp())::int AS backlog,
               count(*) FILTER (WHERE status = 'HELD' AND hold_expires_at > clock_timestamp())::int AS active_holds,
               (SELECT count(*)::int FROM bookings WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()) AS stale_pending,
               count(*)::int AS slots
          FROM slots WHERE start_at > clock_timestamp() - interval '1 day'`
      return s
    },
    async outboxHealth() {
      const [o] = await db.$queryRaw<{ unpublished: number; oldest_s: number | null }[]>`
        SELECT count(*)::int AS unpublished,
               EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at)))::float8 AS oldest_s
          FROM outbox WHERE published_at IS NULL`
      return o
    },
  }
}
