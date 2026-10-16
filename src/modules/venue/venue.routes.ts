import { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { NotFoundError } from '../../utils/errors'
import { successResponse } from '../../utils/response'
import { AMENITIES, RADII_KM, SPORTS, SURFACES } from './venue.domain'
import * as S from './venue.schema'
import { directionsUrl, searchVenues } from './venue.search'
import { createVenueService, ruleJson } from './venue.service'

const sec = [{ bearerAuth: [] }]
const page = {
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  offset: { type: 'integer', minimum: 0, default: 0 },
}
const publicLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } }

export async function venueRoutes(app: FastifyInstance) {
  const svc = createVenueService(app.prisma)

  // ───────────── Owner: create a venue, list mine ─────────────
  await app.register(
    async (r) => {
      r.addHook('onRequest', authenticate)
      r.post(
        '/venues',
        { schema: { tags: ['Venue'], security: sec, body: S.createVenueBody } },
        async (req, reply) =>
          reply
            .status(201)
            .send(
              successResponse(
                await svc.createVenue(req.user.sub, req.body),
                'Venue created as a draft',
              ),
            ),
      )
      r.get('/me/venues', { schema: { tags: ['Venue'], security: sec } }, async (req) =>
        successResponse(await svc.myVenues(req.user.sub)),
      )
    },
    { prefix: '/api/v1' },
  )

  // ───────────── Owner / manager: /pos/venues/:venueId/* ─────────────
  await app.register(
    async (pos) => {
      pos.addHook('onRequest', authenticate)
      const ownerMgr = requireVenueRole('OWNER', 'MANAGER')
      const owner = requireVenueRole('OWNER')
      const p = (req: any) => req.params as { venueId: string; courtId?: string; ruleId?: string }

      pos.get(
        '/',
        { onRequest: [ownerMgr], schema: { tags: ['Venue'], security: sec } },
        async (req) => successResponse(await svc.getForStaff(p(req).venueId)),
      )
      pos.patch(
        '/',
        {
          onRequest: [ownerMgr],
          schema: { tags: ['Venue'], security: sec, body: S.updateVenueBody },
        },
        async (req) =>
          successResponse(
            await svc.updateVenue(p(req).venueId, (req as any).venueRole, req.user.sub, req.body),
            'Venue updated',
          ),
      )
      pos.post(
        '/submit',
        { onRequest: [owner], schema: { tags: ['Venue'], security: sec } },
        async (req) =>
          successResponse(
            await svc.submit(p(req).venueId, req.user.sub, req.ip),
            'Submitted for review',
          ),
      )
      pos.get(
        '/verification',
        { onRequest: [ownerMgr], schema: { tags: ['Venue'], security: sec } },
        async (req) => successResponse(await svc.verificationStatus(p(req).venueId)),
      )

      // courts
      pos.get(
        '/courts',
        { onRequest: [ownerMgr], schema: { tags: ['Courts'], security: sec } },
        async (req) => successResponse(await svc.listCourts(p(req).venueId)),
      )
      pos.post(
        '/courts',
        { onRequest: [ownerMgr], schema: { tags: ['Courts'], security: sec, body: S.courtBody } },
        async (req, reply) =>
          reply
            .status(201)
            .send(
              successResponse(
                await svc.addCourt(p(req).venueId, req.user.sub, req.body),
                'Court added',
              ),
            ),
      )
      pos.patch(
        '/courts/:courtId',
        {
          onRequest: [ownerMgr],
          schema: { tags: ['Courts'], security: sec, body: S.courtPatchBody },
        },
        async (req) =>
          successResponse(
            await svc.updateCourt(p(req).venueId, p(req).courtId!, req.user.sub, req.body),
            'Court updated',
          ),
      )

      // pricing
      pos.get(
        '/pricing-rules',
        {
          onRequest: [ownerMgr],
          schema: {
            tags: ['Pricing'],
            security: sec,
            querystring: {
              type: 'object',
              properties: { courtId: { type: 'string', format: 'uuid' } },
            },
          },
        },
        async (req) =>
          successResponse(await svc.listPricingRules(p(req).venueId, (req.query as any).courtId)),
      )
      pos.post(
        '/pricing-rules',
        {
          onRequest: [ownerMgr],
          schema: { tags: ['Pricing'], security: sec, body: S.pricingRuleBody },
        },
        async (req, reply) =>
          reply
            .status(201)
            .send(
              successResponse(
                await svc.addPricingRule(p(req).venueId, req.user.sub, req.body),
                'Pricing rule added',
              ),
            ),
      )
      pos.delete(
        '/pricing-rules/:ruleId',
        { onRequest: [ownerMgr], schema: { tags: ['Pricing'], security: sec } },
        async (req) => {
          await svc.deletePricingRule(p(req).venueId, p(req).ruleId!, req.user.sub)
          return successResponse(null, 'Pricing rule deleted')
        },
      )
      pos.get(
        '/pricing-preview',
        {
          onRequest: [ownerMgr],
          schema: {
            tags: ['Pricing'],
            security: sec,
            querystring: {
              type: 'object',
              required: ['courtId', 'date'],
              properties: {
                courtId: { type: 'string', format: 'uuid' },
                date: { type: 'string', format: 'date' },
              },
            },
          },
        },
        async (req) => {
          const q = req.query as { courtId: string; date: string }
          return successResponse(await svc.pricingPreview(p(req).venueId, q.courtId, q.date))
        },
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── Admin: verification queue, areas ─────────────
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', authenticate)
      admin.addHook('onRequest', requireAdmin)
      const id = (req: any) => (req.params as { id: string }).id

      admin.get(
        '/venues',
        {
          schema: {
            tags: ['Admin'],
            security: sec,
            querystring: {
              type: 'object',
              properties: { status: { type: 'string' }, city: { type: 'string' }, ...page },
            },
          },
        },
        async (req) => successResponse(await svc.adminList(req.query as any)),
      )
      admin.get('/venues/:id', { schema: { tags: ['Admin'], security: sec } }, async (req) =>
        successResponse(await svc.adminGet(id(req))),
      )
      admin.post(
        '/venues/:id/open-review',
        { schema: { tags: ['Admin'], security: sec } },
        async (req) =>
          successResponse(await svc.openReview(id(req), req.user.sub, req.ip), 'Review started'),
      )
      admin.post(
        '/venues/:id/review',
        { schema: { tags: ['Admin'], security: sec, body: S.reviewBody } },
        async (req) =>
          successResponse(
            await svc.review(id(req), req.user.sub, req.body as any, req.ip),
            'Review saved',
          ),
      )
      admin.post(
        '/venues/:id/suspend',
        { schema: { tags: ['Admin'], security: sec, body: S.reasonBody } },
        async (req) =>
          successResponse(
            await svc.suspend(id(req), req.user.sub, (req.body as any).reason, req.ip),
            'Venue suspended',
          ),
      )
      admin.post(
        '/venues/:id/reinstate',
        { schema: { tags: ['Admin'], security: sec, body: S.reasonBody } },
        async (req) =>
          successResponse(
            await svc.reinstate(id(req), req.user.sub, (req.body as any).reason, req.ip),
            'Venue reinstated',
          ),
      )

      admin.post(
        '/areas',
        { schema: { tags: ['Admin'], security: sec, body: S.areaBody } },
        async (req, reply) =>
          reply.status(201).send(successResponse(await svc.createArea(req.body), 'Area created')),
      )
      admin.patch(
        '/areas/:id',
        {
          schema: {
            tags: ['Admin'],
            security: sec,
            body: { type: 'object', properties: S.areaBody.properties },
          },
        },
        async (req) => successResponse(await svc.updateArea(id(req), req.body), 'Area updated'),
      )
      admin.delete('/areas/:id', { schema: { tags: ['Admin'], security: sec } }, async (req) => {
        await svc.deleteArea(id(req))
        return successResponse(null, 'Area deleted')
      })
    },
    { prefix: '/api/v1/admin' },
  )

  // ───────────── Public discovery (no login) ─────────────
  await app.register(
    async (pub) => {
      pub.get(
        '/venues/search',
        { config: publicLimit, schema: { tags: ['Discovery'], querystring: S.searchQuery } },
        async (req, reply) => {
          const q = req.query as any
          if ((q.lat === undefined) !== (q.lng === undefined)) {
            return reply.status(400).send({
              statusCode: 400,
              error: 'Bad Request',
              code: 'VALIDATION_ERROR',
              message: 'lat and lng must be given together',
            })
          }
          return successResponse(await searchVenues(app.prisma, q))
        },
      )

      pub.get(
        '/venues/:idOrSlug',
        { config: publicLimit, schema: { tags: ['Discovery'] } },
        async (req) => {
          const key = (req.params as { idOrSlug: string }).idOrSlug
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
          const v = await app.prisma.venue.findFirst({
            where: {
              ...(isUuid ? { id: key } : { slug: key }),
              verificationStatus: 'VERIFIED',
              isActive: true,
            },
            include: {
              area: true,
              courts: {
                where: { isActive: true },
                orderBy: { createdAt: 'asc' },
                include: { pricingRules: { orderBy: { priority: 'desc' } } },
              },
            },
          })
          if (!v) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
          return successResponse({
            id: v.id,
            name: v.name,
            slug: v.slug,
            city: v.city,
            address: v.address,
            area: v.area && { id: v.area.id, name: v.area.name },
            lat: v.lat,
            lng: v.lng,
            directionsUrl: directionsUrl(v.lat, v.lng),
            amenities: v.amenities,
            photos: v.photos,
            contactPhone: v.contactPhone,
            operatingHours: v.operatingHours,
            cancellationPolicy: {
              cutoffHours: v.cancellationCutoffHours,
              summary: `Free cancellation until ${v.cancellationCutoffHours} hours before the slot. After that the 20% advance is not refunded.`,
            },
            courts: v.courts.map((c) => ({
              id: c.id,
              name: c.name,
              sport: c.sport,
              surface: c.surface,
              capacity: c.capacity,
              slotMinutes: c.slotMinutes,
              priceBands: c.pricingRules.map((r) => {
                const j = ruleJson(r)
                return {
                  name: j.name,
                  dayType: j.dayType,
                  fromTime: j.fromTime,
                  toTime: j.toTime,
                  priceMinor: j.priceMinor,
                  tag: j.tag,
                }
              }),
            })),
          })
        },
      )

      pub.get(
        '/areas',
        {
          config: publicLimit,
          schema: {
            tags: ['Discovery'],
            querystring: {
              type: 'object',
              properties: { city: { type: 'string', maxLength: 60 } },
            },
          },
        },
        async (req) => {
          const city = (req.query as any).city as string | undefined
          const areas = await app.prisma.area.findMany({
            where: city ? { city: { equals: city, mode: 'insensitive' } } : {},
            orderBy: [{ city: 'asc' }, { name: 'asc' }],
          })
          return successResponse(
            areas.map((a) => ({
              id: a.id,
              city: a.city,
              name: a.name,
              slug: a.slug,
              aliases: a.aliases,
              lat: a.lat,
              lng: a.lng,
            })),
          )
        },
      )

      pub.get(
        '/meta/filters',
        { config: publicLimit, schema: { tags: ['Discovery'] } },
        async () => {
          const cities = await app.prisma.area.findMany({
            distinct: ['city'],
            select: { city: true },
            orderBy: { city: 'asc' },
          })
          return successResponse({
            radiiKm: RADII_KM,
            sports: SPORTS,
            surfaces: SURFACES,
            amenities: AMENITIES,
            cities: cities.map((c) => c.city),
          })
        },
      )
    },
    { prefix: '/api/v1/public' },
  )
}
