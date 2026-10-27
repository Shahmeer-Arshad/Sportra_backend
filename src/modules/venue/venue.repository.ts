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
    lockVenueState: async (venueId: string) => {
      const rows = await db.$queryRaw<
        {
          verification_status: string
          review_claimed_by: string | null
          suspension_mode: string | null
          suspension_lock_id: string | null
          suspended_at: Date | null
        }[]
      >`SELECT verification_status, review_claimed_by, suspension_mode, suspension_lock_id, suspended_at
          FROM venues WHERE id = ${venueId}::uuid FOR UPDATE`
      const r = rows[0]
      return r
        ? {
            status: r.verification_status,
            claimedBy: r.review_claimed_by,
            suspensionMode: r.suspension_mode,
            suspensionLockId: r.suspension_lock_id,
            suspendedAt: r.suspended_at,
          }
        : null
    },
    /** The owner's account name and email, for decision emails (identity table, same database). */
    ownerContact: (userId: string) =>
      db.user.findUnique({ where: { id: userId }, select: { email: true, fullName: true } }),
    countCopiesSince: (ownerUserId: string, since: Date) =>
      db.venue.count({
        where: { ownerUserId, copiedFrom: { not: null }, createdAt: { gte: since } },
      }),
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

    // ───────── submissions (what the owner sent, for the admin diff) ─────────
    createSubmission: async (venueId: string, snapshot: Prisma.InputJsonValue) => {
      const n = (await db.venueSubmission.count({ where: { venueId } })) + 1
      return db.venueSubmission.create({
        data: { id: uuidv7(), venueId, submissionNo: n, snapshot },
      })
    },
    latestSubmissions: (venueId: string, take = 2) =>
      db.venueSubmission.findMany({
        where: { venueId },
        orderBy: { submissionNo: 'desc' },
        take,
      }),

    // ───────── change requests (edits to a live venue) ─────────
    createChange: (data: Omit<Prisma.VenueChangeRequestUncheckedCreateInput, 'id'>) =>
      db.venueChangeRequest.create({ data: { id: uuidv7(), ...data } }),
    changeById: (id: string) => db.venueChangeRequest.findUnique({ where: { id } }),
    /** Locks a pending request so it is approved or rejected exactly once; null if not pending. */
    lockPendingChange: async (id: string) => {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM venue_change_requests WHERE id = ${id}::uuid AND status = 'PENDING' FOR UPDATE`
      return rows.length ? db.venueChangeRequest.findUnique({ where: { id } }) : null
    },
    /** Marks a request FAILED only if nobody decided it meanwhile. */
    failChange: (id: string, decidedBy: string, failureReason: string) =>
      db.venueChangeRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'FAILED', decidedBy, failureReason, decidedAt: new Date() },
      }),
    updateChange: (id: string, data: Prisma.VenueChangeRequestUncheckedUpdateInput) =>
      db.venueChangeRequest.update({ where: { id }, data }),
    pendingChangeCount: (venueId: string) =>
      db.venueChangeRequest.count({ where: { venueId, status: 'PENDING' } }),
    changesOfVenue: (venueId: string) =>
      db.venueChangeRequest.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    adminChanges: (status: string | undefined, limit: number, offset: number) => {
      const where: Prisma.VenueChangeRequestWhereInput = status ? { status } : {}
      return Promise.all([
        db.venueChangeRequest.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          take: limit,
          skip: offset,
          include: { venue: { select: { name: true, city: true } } },
        }),
        db.venueChangeRequest.count({ where }),
      ])
    },

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

/**
 * Runs `fn` in the caller's transaction when one is given, else in a new one. Lets a use-case be
 * applied now (own transaction) or later inside an approval (the approval's transaction).
 */
export const inTx = <T>(
  repo: VenueRepository,
  tx: VenueQueries | undefined,
  fn: (q: VenueQueries) => Promise<T>,
) => (tx ? fn(tx) : repo.transaction(fn))
