import { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { createVenueController } from './venue.controller'
import * as S from './venue.schema'

const sec = [{ bearerAuth: [] }]
const publicLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } }

export async function venueRoutes(app: FastifyInstance) {
  const c = createVenueController(app.prisma)

  // ───────────── Owner: create a venue, list mine ─────────────
  await app.register(
    async (r) => {
      r.addHook('onRequest', authenticate)
      r.post(
        '/venues',
        { schema: { tags: ['Venue'], security: sec, body: S.createVenueBody } },
        c.createVenue,
      )
      r.get('/me/venues', { schema: { tags: ['Venue'], security: sec } }, c.myVenues)
    },
    { prefix: '/api/v1' },
  )

  // ───────────── Owner / manager: /pos/venues/:venueId/* ─────────────
  await app.register(
    async (pos) => {
      pos.addHook('onRequest', authenticate)
      const ownerMgr = requireVenueRole('OWNER', 'MANAGER')
      const owner = requireVenueRole('OWNER')
      const staff = (tag: string, extra = {}) => ({
        onRequest: [ownerMgr],
        schema: { tags: [tag], security: sec, ...extra },
      })

      pos.get('/', staff('Venue'), c.getVenue)
      pos.patch('/', staff('Venue', { body: S.updateVenueBody }), c.updateVenue)
      pos.post(
        '/submit',
        { onRequest: [owner], schema: { tags: ['Venue'], security: sec } },
        c.submitVenue,
      )
      pos.get('/verification', staff('Venue'), c.verification)

      pos.get('/courts', staff('Courts'), c.listCourts)
      pos.post('/courts', staff('Courts', { body: S.courtBody }), c.addCourt)
      pos.patch('/courts/:courtId', staff('Courts', { body: S.courtPatchBody }), c.updateCourt)

      pos.get('/pricing-rules', staff('Pricing', { querystring: S.pricingRulesQuery }), c.listRules)
      pos.post('/pricing-rules', staff('Pricing', { body: S.pricingRuleBody }), c.addRule)
      pos.delete('/pricing-rules/:ruleId', staff('Pricing'), c.deleteRule)
      pos.get(
        '/pricing-preview',
        staff('Pricing', { querystring: S.pricingPreviewQuery }),
        c.pricingPreview,
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── Admin: verification queue, areas ─────────────
  await app.register(
    async (admin) => {
      admin.addHook('onRequest', authenticate)
      admin.addHook('onRequest', requireAdmin)
      const adm = (extra = {}) => ({ schema: { tags: ['Admin'], security: sec, ...extra } })

      admin.get('/venues', adm({ querystring: S.adminListQuery }), c.adminList)
      admin.get('/venues/:id', adm(), c.adminGet)
      admin.post('/venues/:id/open-review', adm(), c.openReview)
      admin.post('/venues/:id/review', adm({ body: S.reviewBody }), c.decide)
      admin.post('/venues/:id/suspend', adm({ body: S.reasonBody }), c.suspend)
      admin.post('/venues/:id/reinstate', adm({ body: S.reasonBody }), c.reinstate)

      admin.post('/areas', adm({ body: S.areaBody }), c.createArea)
      admin.patch('/areas/:id', adm({ body: S.areaPatchBody }), c.updateArea)
      admin.delete('/areas/:id', adm(), c.deleteArea)
    },
    { prefix: '/api/v1/admin' },
  )

  // ───────────── Public discovery (no login) ─────────────
  await app.register(
    async (pub) => {
      const disc = (extra = {}) => ({
        config: publicLimit,
        schema: { tags: ['Discovery'], ...extra },
      })

      pub.get('/venues/search', disc({ querystring: S.searchQuery }), c.search)
      pub.get('/venues/:idOrSlug', disc(), c.publicVenue)
      pub.get('/areas', disc({ querystring: S.areasQuery }), c.areas)
      pub.get('/meta/filters', disc(), c.filters)
    },
    { prefix: '/api/v1/public' },
  )
}
