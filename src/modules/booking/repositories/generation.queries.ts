import { Db } from '../../../lib/outbox'
import { uuidv7 } from '../../../lib/id'
import { PlannedSlot } from '../booking.domain'

/** Slot generation: courts to plan for, idempotent upsert of the plan, cleanup of hours that left it. */
export function generationQueries(db: Db) {
  return {
    courtForGeneration: (courtId: string) =>
      db.court.findUnique({
        where: { id: courtId },
        include: { venue: true, pricingRules: true },
      }),
    courtIdsOfVenue: async (venueId: string) =>
      (await db.court.findMany({ where: { venueId }, select: { id: true } })).map((c) => c.id),
    verifiedVenueIds: async (only?: string[]) =>
      (
        await db.venue.findMany({
          where: {
            verificationStatus: 'VERIFIED',
            isActive: true,
            ...(only && { id: { in: only } }),
          },
          select: { id: true },
        })
      ).map((v) => v.id),

    /** Inserts new hours; refreshes the price of FUTURE AVAILABLE hours only. Returns per row: was it inserted? */
    async upsertPlan(courtId: string, venueId: string, part: PlannedSlot[]) {
      const rows = await db.$queryRaw<{ inserted: boolean }[]>`
        INSERT INTO slots (id, court_id, venue_id, start_at, end_at, business_date, price_minor, price_tag)
        SELECT * FROM unnest(
          ${part.map(() => uuidv7())}::uuid[],
          ${part.map(() => courtId)}::uuid[],
          ${part.map(() => venueId)}::uuid[],
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
      return rows.map((r) => r.inserted)
    },

    deleteStaleSlots: (courtId: string, fromDate: string, toDate: string, keepStarts: string[]) =>
      db.$executeRaw`
        DELETE FROM slots
         WHERE court_id = ${courtId}::uuid AND business_date BETWEEN ${fromDate}::date AND ${toDate}::date
           AND status = 'AVAILABLE' AND start_at > clock_timestamp()
           AND NOT (start_at = ANY(${keepStarts}::timestamptz[]))`,
    orphanedSlots: (courtId: string, fromDate: string, toDate: string, keepStarts: string[]) =>
      db.$queryRaw<{ id: string; status: string; start_at: Date }[]>`
        SELECT id, status, start_at FROM slots
         WHERE court_id = ${courtId}::uuid AND business_date BETWEEN ${fromDate}::date AND ${toDate}::date
           AND status <> 'AVAILABLE' AND start_at > clock_timestamp()
           AND NOT (start_at = ANY(${keepStarts}::timestamptz[]))
         ORDER BY start_at LIMIT 100`,
  }
}
