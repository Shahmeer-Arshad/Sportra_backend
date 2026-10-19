import { Prisma, PrismaClient } from '@prisma/client'
import { uuidv7 } from '../../lib/id'
import { Db } from '../../lib/outbox'
import { eventWrites, makeRepository } from '../../lib/repository'
import { addOwnerMembership } from '../identity/identity.membership'
import { searchVenues, SearchParams } from './venue.search'

const publicVenueInclude = {
  area: true,
  courts: {
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: { pricingRules: { orderBy: { priority: 'desc' } } },
  },
} satisfies Prisma.VenueInclude

/** Every venue-module query. Bound to a transaction client inside `transaction(fn)`. */
function queries(db: Db) {
  return {
    ...eventWrites(db),

    // ───────── venues ─────────
    venueById: (id: string) => db.venue.findUnique({ where: { id } }),
    createVenue: (data: Prisma.VenueUncheckedCreateInput) => db.venue.create({ data }),
    updateVenue: (id: string, data: Prisma.VenueUncheckedUpdateInput) =>
      db.venue.update({ where: { id }, data }),
    addOwner: (userId: string, venueId: string) => addOwnerMembership(db, userId, venueId),
    memberships: (userId: string) =>
      db.venueMembership.findMany({ where: { userId, isActive: true } }),
    venuesByIds: (ids: string[]) =>
      db.venue.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'desc' } }),
    findPublicVenue: (key: string, isUuid: boolean) =>
      db.venue.findFirst({
        where: {
          ...(isUuid ? { id: key } : { slug: key }),
          verificationStatus: 'VERIFIED',
          isActive: true,
        },
        include: publicVenueInclude,
      }),
    search: (p: SearchParams) => searchVenues(db as PrismaClient, p),
    adminList: (where: Prisma.VenueWhereInput, limit: number, offset: number) =>
      Promise.all([
        db.venue.findMany({ where, orderBy: { submittedAt: 'asc' }, take: limit, skip: offset }),
        db.venue.count({ where }),
      ]),
    /** Locks the row so two admins cannot decide at once; null when the venue does not exist. */
    lockVerificationStatus: async (venueId: string) => {
      const rows = await db.$queryRaw<
        { verification_status: string }[]
      >`SELECT verification_status FROM venues WHERE id = ${venueId}::uuid FOR UPDATE`
      return rows[0]?.verification_status ?? null
    },
    pinDistanceKm: async (venueId: string) => {
      const rows = await db.$queryRaw<{ km: number | null }[]>`
        SELECT ST_Distance(v.location, ST_SetSRID(ST_MakePoint(a.lng, a.lat), 4326)::geography) / 1000 AS km
        FROM venues v JOIN areas a ON a.id = v.area_id WHERE v.id = ${venueId}::uuid AND a.lat IS NOT NULL`
      return rows[0]?.km ?? null
    },

    // ───────── reviews ─────────
    reviews: (venueId: string, take?: number) =>
      db.venueReview.findMany({ where: { venueId }, orderBy: { createdAt: 'desc' }, take }),
    nextSubmissionNo: async (venueId: string) =>
      1 + (await db.venueReview.count({ where: { venueId, decision: 'CHANGES_REQUESTED' } })),
    createReview: (data: Omit<Prisma.VenueReviewUncheckedCreateInput, 'id'>) =>
      db.venueReview.create({ data: { id: uuidv7(), ...data } }),

    // ───────── courts ─────────
    courtsOf: (venueId: string) =>
      db.court.findMany({ where: { venueId }, orderBy: { createdAt: 'asc' } }),
    courtsWithRules: (venueId: string, activeOnly = false) =>
      db.court.findMany({
        where: { venueId, ...(activeOnly && { isActive: true }) },
        orderBy: { createdAt: 'asc' },
        include: { pricingRules: true },
      }),
    courtOfVenue: (venueId: string, courtId: string) =>
      db.court.findFirst({ where: { id: courtId, venueId } }),
    createCourt: (data: Omit<Prisma.CourtUncheckedCreateInput, 'id'>) =>
      db.court.create({ data: { id: uuidv7(), ...data } }),
    updateCourt: (id: string, data: Prisma.CourtUncheckedUpdateInput) =>
      db.court.update({ where: { id }, data }),

    // ───────── pricing rules ─────────
    rulesOfCourt: (courtId: string) => db.pricingRule.findMany({ where: { courtId } }),
    rulesOfVenue: (venueId: string, courtId?: string) =>
      db.pricingRule.findMany({
        where: { court: { venueId }, ...(courtId && { courtId }) },
        orderBy: [{ courtId: 'asc' }, { priority: 'desc' }],
      }),
    ruleOfVenue: (venueId: string, ruleId: string) =>
      db.pricingRule.findFirst({ where: { id: ruleId, court: { venueId } } }),
    createRule: (data: Omit<Prisma.PricingRuleUncheckedCreateInput, 'id'>) =>
      db.pricingRule.create({ data: { id: uuidv7(), ...data } }),
    deleteRule: (id: string) => db.pricingRule.delete({ where: { id } }),

    // ───────── areas ─────────
    areaById: (id: string) => db.area.findUnique({ where: { id } }),
    areas: (city?: string) =>
      db.area.findMany({
        where: city ? { city: { equals: city, mode: 'insensitive' } } : {},
        orderBy: [{ city: 'asc' }, { name: 'asc' }],
      }),
    cities: () =>
      db.area.findMany({ distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } }),
    createArea: (data: Omit<Prisma.AreaUncheckedCreateInput, 'id'>) =>
      db.area.create({ data: { id: uuidv7(), ...data } }),
    updateArea: (id: string, data: Prisma.AreaUncheckedUpdateInput) =>
      db.area.update({ where: { id }, data }),
    deleteArea: (id: string) => db.area.delete({ where: { id } }),
    venueCountInArea: (areaId: string) => db.venue.count({ where: { areaId } }),
  }
}

export const createVenueRepository = (prisma: PrismaClient) => makeRepository(prisma, queries)
export type VenueQueries = ReturnType<typeof queries>
export type VenueRepository = ReturnType<typeof createVenueRepository>
