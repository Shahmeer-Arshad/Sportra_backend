import { Prisma } from '@prisma/client'
import { uuidv7 } from '../../../lib/id'
import { Db } from '../../../lib/outbox'

type Window = { venueId: string; courtIds: string[]; from: Date; to: Date }

export interface AffectedBooking {
  booking_id: string
  user_id: string | null
  ref: string
  customer_name: string
  item_ids: string[]
}

/** Outage-lock rows and the bookings a lock window touches. */
export function outageQueries(db: Db) {
  return {
    affectedAppBookings: (o: Window) =>
      db.$queryRaw<AffectedBooking[]>`
        SELECT b.id AS booking_id, b.user_id, b.ref, b.customer_name, array_agg(i.id ORDER BY i.start_at) AS item_ids
          FROM booking_items i JOIN bookings b ON b.id = i.booking_id
         WHERE i.venue_id = ${o.venueId}::uuid AND i.court_id = ANY(${o.courtIds}::uuid[]) AND i.status = 'CONFIRMED'
           AND i.start_at >= ${o.from} AND i.start_at < ${o.to} AND b.source = 'APP' AND b.status = 'CONFIRMED'
         GROUP BY b.id, b.user_id, b.ref, b.customer_name
         ORDER BY min(i.start_at)`,

    manualToCall: (o: Window) =>
      db.$queryRaw<
        {
          id: string
          ref: string
          source: string
          customer_name: string
          customer_phone: string
          start_at: Date
        }[]
      >`
        SELECT DISTINCT b.id, b.ref, b.source, b.customer_name, b.customer_phone, b.start_at
          FROM booking_items i JOIN bookings b ON b.id = i.booking_id
         WHERE i.venue_id = ${o.venueId}::uuid AND i.court_id = ANY(${o.courtIds}::uuid[]) AND i.status = 'CONFIRMED'
           AND i.start_at >= ${o.from} AND i.start_at < ${o.to} AND b.source IN ('WALKIN','MANUAL')
           AND b.status IN ('CONFIRMED','CHECKED_IN')
         ORDER BY b.start_at`,

    outageById: (id: string) => db.outageLock.findUnique({ where: { id } }),
    outageByIdOrThrow: (id: string) => db.outageLock.findUniqueOrThrow({ where: { id } }),
    outageOfVenue: (venueId: string, id: string) =>
      db.outageLock.findFirst({ where: { id, venueId } }),
    outagesOfVenue: (venueId: string) =>
      db.outageLock.findMany({ where: { venueId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    outagesForAdmin: (status?: string) =>
      db.outageLock.findMany({
        where: status ? { status } : { status: { not: 'RELEASED' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    stuckOutageIds: async (olderThan: Date) =>
      (
        await db.outageLock.findMany({
          where: { status: 'PROCESSING', createdAt: { lt: olderThan } },
          select: { id: true },
        })
      ).map((l) => l.id),
    createOutage: (data: Prisma.OutageLockUncheckedCreateInput) =>
      db.outageLock.create({ data: { ...data, id: data.id ?? uuidv7() } }),
    setOutageProgress: (id: string, processed: number) =>
      db.outageLock.update({ where: { id }, data: { processed } }),
    finishOutage: (id: string, failed: number, processed: number) =>
      db.outageLock.updateMany({
        where: { id, status: 'PROCESSING' },
        data: { status: 'ACTIVE', failed, processed },
      }),
    releaseOutage: (id: string, releasedBy: string) =>
      db.outageLock.update({
        where: { id },
        data: { status: 'RELEASED', releasedAt: new Date(), releasedBy },
      }),
  }
}
