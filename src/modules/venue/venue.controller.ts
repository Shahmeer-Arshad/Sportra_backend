import { PrismaClient } from '@prisma/client'
import { FastifyReply, FastifyRequest } from 'fastify'
import { successResponse } from '../../utils/response'
import { courtMediator } from './mediators/court.mediator'
import { createVenueMediator } from './mediators/create-venue.mediator'
import { pricingRuleMediator } from './mediators/pricing-rule.mediator'
import { transitionVenueMediator } from './mediators/transition-venue.mediator'
import { updateVenueMediator } from './mediators/update-venue.mediator'
import { AMENITIES, RADII_KM, SPORTS, SURFACES } from './venue.domain'
import { createVenueRepository } from './venue.repository'
import { createVenueService } from './venue.service'

type Req = FastifyRequest
type Params = { venueId: string; courtId?: string; ruleId?: string; id?: string; idOrSlug?: string }
const params = (req: Req) => req.params as Params
const body = (req: Req) => req.body as any
const query = (req: Req) => req.query as any
const venueRole = (req: Req) => (req as any).venueRole as string

/** HTTP layer only: reads the request, calls a service or mediator, wraps the response. */
export function createVenueController(prisma: PrismaClient) {
  const repo = createVenueRepository(prisma)
  const svc = createVenueService(repo)
  const create = createVenueMediator(repo, svc)
  const update = updateVenueMediator(repo, svc)
  const courts = courtMediator(repo, svc)
  const rules = pricingRuleMediator(repo, svc)
  const review = transitionVenueMediator(repo, svc)

  return {
    // ───────── owner ─────────
    createVenue: async (req: Req, reply: FastifyReply) =>
      reply
        .status(201)
        .send(successResponse(await create(req.user.sub, body(req)), 'Venue created as a draft')),
    myVenues: async (req: Req) => successResponse(await svc.myVenues(req.user.sub)),

    // ───────── owner and manager ─────────
    getVenue: async (req: Req) => successResponse(await svc.getForStaff(params(req).venueId)),
    updateVenue: async (req: Req) =>
      successResponse(
        await update(params(req).venueId, venueRole(req), req.user.sub, body(req)),
        'Venue updated',
      ),
    submitVenue: async (req: Req) =>
      successResponse(
        await review.submit(params(req).venueId, req.user.sub, req.ip),
        'Submitted for review',
      ),
    verification: async (req: Req) =>
      successResponse(await svc.verificationStatus(params(req).venueId)),

    listCourts: async (req: Req) => successResponse(await svc.listCourts(params(req).venueId)),
    addCourt: async (req: Req, reply: FastifyReply) =>
      reply
        .status(201)
        .send(
          successResponse(
            await courts.add(params(req).venueId, req.user.sub, body(req)),
            'Court added',
          ),
        ),
    updateCourt: async (req: Req) =>
      successResponse(
        await courts.update(params(req).venueId, params(req).courtId!, req.user.sub, body(req)),
        'Court updated',
      ),

    listRules: async (req: Req) =>
      successResponse(await svc.listPricingRules(params(req).venueId, query(req).courtId)),
    addRule: async (req: Req, reply: FastifyReply) =>
      reply
        .status(201)
        .send(
          successResponse(
            await rules.add(params(req).venueId, req.user.sub, body(req)),
            'Pricing rule added',
          ),
        ),
    deleteRule: async (req: Req) => {
      await rules.remove(params(req).venueId, params(req).ruleId!, req.user.sub)
      return successResponse(null, 'Pricing rule deleted')
    },
    pricingPreview: async (req: Req) =>
      successResponse(
        await svc.pricingPreview(params(req).venueId, query(req).courtId, query(req).date),
      ),

    // ───────── admin ─────────
    adminList: async (req: Req) => successResponse(await svc.adminList(query(req))),
    adminGet: async (req: Req) => successResponse(await svc.adminGet(params(req).id!)),
    openReview: async (req: Req) =>
      successResponse(
        await review.openReview(params(req).id!, req.user.sub, req.ip),
        'Review started',
      ),
    decide: async (req: Req) =>
      successResponse(
        await review.review(params(req).id!, req.user.sub, body(req), req.ip),
        'Review saved',
      ),
    suspend: async (req: Req) =>
      successResponse(
        await review.suspend(params(req).id!, req.user.sub, body(req).reason, req.ip),
        'Venue suspended',
      ),
    reinstate: async (req: Req) =>
      successResponse(
        await review.reinstate(params(req).id!, req.user.sub, body(req).reason, req.ip),
        'Venue reinstated',
      ),
    createArea: async (req: Req, reply: FastifyReply) =>
      reply.status(201).send(successResponse(await svc.createArea(body(req)), 'Area created')),
    updateArea: async (req: Req) =>
      successResponse(await svc.updateArea(params(req).id!, body(req)), 'Area updated'),
    deleteArea: async (req: Req) => {
      await svc.deleteArea(params(req).id!)
      return successResponse(null, 'Area deleted')
    },

    // ───────── public discovery ─────────
    search: async (req: Req) => successResponse(await svc.search(query(req))),
    publicVenue: async (req: Req) => successResponse(await svc.publicVenue(params(req).idOrSlug!)),
    areas: async (req: Req) => successResponse(await svc.listAreas(query(req).city)),
    filters: async () =>
      successResponse({
        radiiKm: RADII_KM,
        sports: SPORTS,
        surfaces: SURFACES,
        amenities: AMENITIES,
        cities: await svc.listCities(),
      }),
  }
}
