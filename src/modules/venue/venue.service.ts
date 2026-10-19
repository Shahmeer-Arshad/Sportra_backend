import { Prisma } from '@prisma/client'
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors'
import { slugify } from './venue.rules'
import { VenueQueries } from './venue.repository'
import { SearchParams } from './venue.search'
import { buildPricingPreview, publicVenueJson, ruleJson, toRule, venueJson } from './venue.view'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ───────────────────────── service (reads and single-step rules) ─────────────────────────
export function createVenueService(repo: VenueQueries) {
  const requireVenue = async (venueId: string) => {
    const v = await repo.venueById(venueId)
    if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
    return v
  }
  const requireCourt = async (venueId: string, courtId: string) => {
    const c = await repo.courtOfVenue(venueId, courtId)
    if (!c) throw new NotFoundError('Court not found', 'COURT_NOT_FOUND')
    return c
  }
  const assertArea = async (areaId: string) => {
    if (!(await repo.areaById(areaId))) throw new BadRequestError('Unknown area', 'AREA_NOT_FOUND')
  }

  const getForStaff = async (venueId: string) => {
    const v = await requireVenue(venueId)
    const courts = await repo.courtsWithRules(venueId)
    return {
      ...venueJson(v),
      courts: courts.map((c) => ({ ...c, pricingRules: c.pricingRules.map(ruleJson) })),
    }
  }

  return {
    requireVenue,
    requireCourt,
    assertArea,
    getForStaff,

    async myVenues(userId: string) {
      const rows = await repo.memberships(userId)
      const venues = await repo.venuesByIds(rows.map((r) => r.venueId))
      return venues.map((v) => ({
        ...venueJson(v),
        myRole: rows.find((r) => r.venueId === v.id)!.role,
      }))
    },

    async verificationStatus(venueId: string) {
      const v = await requireVenue(venueId)
      return {
        status: v.verificationStatus,
        submittedAt: v.submittedAt,
        verifiedAt: v.verifiedAt,
        reviews: await repo.reviews(venueId, 10),
      }
    },

    listCourts: (venueId: string) => repo.courtsOf(venueId),

    async listPricingRules(venueId: string, courtId?: string) {
      return (await repo.rulesOfVenue(venueId, courtId)).map(ruleJson)
    },

    async pricingPreview(venueId: string, courtId: string, date: string) {
      const v = await requireVenue(venueId)
      const court = await requireCourt(venueId, courtId)
      const rules = (await repo.rulesOfCourt(courtId)).map(toRule)
      return buildPricingPreview(v, court, rules, date)
    },

    // ───────── admin ─────────
    async adminList(q: { status?: string; city?: string; limit: number; offset: number }) {
      const where: Prisma.VenueWhereInput = {
        ...(q.status && { verificationStatus: q.status }),
        ...(q.city && { city: q.city }),
      }
      const [items, total] = await repo.adminList(where, q.limit, q.offset)
      const now = Date.now()
      return {
        total,
        items: items.map((v) => ({
          ...venueJson(v),
          hoursInQueue: v.submittedAt
            ? Math.floor((now - v.submittedAt.getTime()) / 3600_000)
            : null,
        })),
      }
    },

    async adminGet(venueId: string) {
      const base = await getForStaff(venueId)
      const v = await requireVenue(venueId)
      const pinDistanceKm = v.areaId ? await repo.pinDistanceKm(venueId) : null
      return {
        ...base,
        reviews: await repo.reviews(venueId),
        pinDistanceKm,
        // Sanity check for the reviewer: the pin should be near the claimed area
        pinWarning:
          pinDistanceKm !== null && pinDistanceKm > 15
            ? `Pin is ${pinDistanceKm.toFixed(1)} km from the claimed area`
            : null,
      }
    },

    // ───────── areas ─────────
    async createArea(input: any) {
      try {
        return await repo.createArea({
          city: input.city.trim(),
          name: input.name.trim(),
          slug: slugify(input.name),
          aliases: input.aliases ?? [],
          lat: input.lat ?? null,
          lng: input.lng ?? null,
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ConflictError('This area already exists in that city', 'AREA_EXISTS')
        throw e
      }
    },
    async updateArea(id: string, input: any) {
      if (!(await repo.areaById(id))) throw new NotFoundError('Area not found', 'AREA_NOT_FOUND')
      return repo.updateArea(id, {
        ...(input.name && { name: input.name.trim(), slug: slugify(input.name) }),
        ...(input.city && { city: input.city.trim() }),
        ...(input.aliases && { aliases: input.aliases }),
        ...(input.lat !== undefined && { lat: input.lat }),
        ...(input.lng !== undefined && { lng: input.lng }),
      })
    },
    async deleteArea(id: string) {
      if ((await repo.venueCountInArea(id)) > 0)
        throw new ConflictError('Area is used by venues', 'AREA_IN_USE')
      await repo.deleteArea(id).catch(() => {
        throw new NotFoundError('Area not found', 'AREA_NOT_FOUND')
      })
    },

    // ───────── public discovery ─────────
    search(q: SearchParams) {
      if ((q.lat === undefined) !== (q.lng === undefined)) {
        throw new BadRequestError('lat and lng must be given together', 'VALIDATION_ERROR')
      }
      return repo.search(q)
    },

    async publicVenue(key: string) {
      const v = await repo.findPublicVenue(key, UUID.test(key))
      if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      return publicVenueJson(v)
    },

    async listAreas(city?: string) {
      return (await repo.areas(city)).map((a) => ({
        id: a.id,
        city: a.city,
        name: a.name,
        slug: a.slug,
        aliases: a.aliases,
        lat: a.lat,
        lng: a.lng,
      }))
    },

    async listCities() {
      return (await repo.cities()).map((c) => c.city)
    },
  }
}

export type VenueService = ReturnType<typeof createVenueService>
