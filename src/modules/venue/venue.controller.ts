import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../../config/env'
import { successResponse } from '../../utils/response'
import { changeRequestMediator } from './mediators/change-request.mediator'
import { copyVenueMediator } from './mediators/copy-venue.mediator'
import { courtMediator } from './mediators/court.mediator'
import { createVenueMediator } from './mediators/create-venue.mediator'
import { pricingRuleMediator } from './mediators/pricing-rule.mediator'
import { suspendVenueMediator } from './mediators/suspend-venue.mediator'
import { transitionVenueMediator } from './mediators/transition-venue.mediator'
import { updateVenueMediator } from './mediators/update-venue.mediator'
import { AMENITIES, RADII_KM, SPORTS, SURFACES } from './venue.domain'
import { stopAllPort } from './venue.booking-port'
import { createVenueNotifier } from './venue.notifier'
import { createVenueRepository } from './venue.repository'
import { createVenueService } from './venue.service'

type Req = FastifyRequest
type Params = { venueId: string; courtId?: string; ruleId?: string; id?: string; idOrSlug?: string }
const params = (req: Req) => req.params as Params
const body = (req: Req) => req.body as any
const query = (req: Req) => req.query as any
const venueRole = (req: Req) => (req as any).venueRole as string

/** HTTP layer only: reads the request, calls a service or mediator, wraps the response. */
export function createVenueController(app: FastifyInstance) {
  const repo = createVenueRepository(app.prisma)
  const svc = createVenueService(repo)
  const notify = createVenueNotifier(repo, app.mailer, app.log)
  const create = createVenueMediator(repo, svc)
  const update = updateVenueMediator(repo, svc)
  const courts = courtMediator(repo, svc)
  const rules = pricingRuleMediator(repo, svc)
  const review = transitionVenueMediator(repo, svc, notify)
  const suspension = suspendVenueMediator(
    repo,
    svc,
    review,
    stopAllPort(app.booking),
    env.SLOT_HORIZON_DAYS,
  )
  const changes = changeRequestMediator(repo, svc, courts, rules, update, notify)
  const copy = copyVenueMediator(repo, svc)
  const pending = (reply: FastifyReply, change: object) =>
    reply.status(202).send(successResponse(change, 'Sent to an admin for approval'))

  return {
    // ───────── owner ─────────
    createVenue: async (req: Req, reply: FastifyReply) =>
      reply
        .status(201)
        .send(successResponse(await create(req.user.sub, body(req)), 'Venue created as a draft')),
    myVenues: async (req: Req) => successResponse(await svc.myVenues(req.user.sub)),

    // ───────── owner and manager ─────────
    getVenue: async (req: Req) => successResponse(await svc.getForStaff(params(req).venueId)),
    updateVenue: async (req: Req, reply: FastifyReply) => {
      const { venueId } = params(req)
      const { operatingHours, ...rest } = body(req)
      const g =
        operatingHours === undefined
          ? null
          : await changes.gate(
              'venue.update_hours',
              venueId,
              venueRole(req),
              req.user.sub,
              {},
              {
                operatingHours,
              },
            )
      if (!g) {
        return successResponse(
          await update(venueId, venueRole(req), req.user.sub, body(req)),
          'Venue updated',
        )
      }
      // hours wait for an admin; the other fields in the same request are applied now
      if (Object.keys(rest).length === 0) return pending(reply, g)
      const venue = await update(venueId, venueRole(req), req.user.sub, rest)
      return successResponse(
        { ...venue, pendingChange: g },
        'Venue updated, hours sent for approval',
      )
    },
    submitVenue: async (req: Req) =>
      successResponse(
        await review.submit(params(req).venueId, req.user.sub, req.ip),
        'Submitted for review',
      ),
    verification: async (req: Req) =>
      successResponse(await svc.verificationStatus(params(req).venueId)),

    listCourts: async (req: Req) => successResponse(await svc.listCourts(params(req).venueId)),
    addCourt: async (req: Req, reply: FastifyReply) => {
      const { venueId } = params(req)
      const g = await changes.gate(
        'court.add',
        venueId,
        venueRole(req),
        req.user.sub,
        {},
        body(req),
      )
      if (g) return pending(reply, g)
      return reply
        .status(201)
        .send(successResponse(await courts.add(venueId, req.user.sub, body(req)), 'Court added'))
    },
    updateCourt: async (req: Req, reply: FastifyReply) => {
      const { venueId, courtId } = params(req)
      const g = await changes.gate(
        'court.update',
        venueId,
        venueRole(req),
        req.user.sub,
        { courtId },
        body(req),
      )
      if (g) return pending(reply, g)
      return successResponse(
        await courts.update(venueId, courtId!, req.user.sub, body(req)),
        'Court updated',
      )
    },

    listRules: async (req: Req) =>
      successResponse(await svc.listPricingRules(params(req).venueId, query(req).courtId)),
    addRule: async (req: Req, reply: FastifyReply) => {
      const { venueId } = params(req)
      const g = await changes.gate('rule.add', venueId, venueRole(req), req.user.sub, {}, body(req))
      if (g) return pending(reply, g)
      return reply
        .status(201)
        .send(
          successResponse(await rules.add(venueId, req.user.sub, body(req)), 'Pricing rule added'),
        )
    },
    deleteRule: async (req: Req, reply: FastifyReply) => {
      const { venueId, ruleId } = params(req)
      const g = await changes.gate(
        'rule.delete',
        venueId,
        venueRole(req),
        req.user.sub,
        { ruleId },
        {},
      )
      if (g) return pending(reply, g)
      await rules.remove(venueId, ruleId!, req.user.sub)
      return successResponse(null, 'Pricing rule deleted')
    },
    listChanges: async (req: Req) => successResponse(await svc.listChanges(params(req).venueId)),
    withdrawChange: async (req: Req) =>
      successResponse(
        await changes.withdraw(params(req).venueId, (req.params as any).changeId, req.user.sub),
        'Change withdrawn',
      ),
    copyVenue: async (req: Req, reply: FastifyReply) =>
      reply
        .status(201)
        .send(
          successResponse(
            await copy.copy(params(req).venueId, req.user.sub),
            'Copied as a new draft',
          ),
        ),
    pricingPreview: async (req: Req) =>
      successResponse(
        await svc.pricingPreview(params(req).venueId, query(req).courtId, query(req).date),
      ),

    // ───────── admin ─────────
    adminList: async (req: Req) => successResponse(await svc.adminList(query(req), req.user.sub)),
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
    releaseReview: async (req: Req) =>
      successResponse(
        await review.releaseReview(params(req).id!, req.user.sub, req.ip),
        'Review released',
      ),
    adminDiff: async (req: Req) => successResponse(await svc.adminDiff(params(req).id!)),
    suspendPreview: async (req: Req) => successResponse(await suspension.preview(params(req).id!)),
    suspend: async (req: Req) =>
      successResponse(
        await suspension.suspend(params(req).id!, req.user.sub, body(req), req.ip),
        'Venue suspended',
      ),
    reinstate: async (req: Req) =>
      successResponse(
        await suspension.reinstate(params(req).id!, req.user.sub, body(req).reason, req.ip),
        'Venue reinstated',
      ),
    adminChanges: async (req: Req) => successResponse(await svc.adminChanges(query(req))),
    adminChange: async (req: Req) => successResponse(await svc.adminChange(params(req).id!)),
    approveChange: async (req: Req) => {
      const done = await changes.approve(params(req).id!, req.user.sub, body(req)?.note, req.ip)
      // tells the slot-sync hook which venue's slots to rebuild
      ;(req as any).syncVenueId = done.venueId
      return successResponse(done, 'Change approved and applied')
    },
    rejectChange: async (req: Req) =>
      successResponse(
        await changes.reject(params(req).id!, req.user.sub, body(req).note, req.ip),
        'Change rejected',
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
