import { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { createBookingController } from './booking.controller'
import * as S from './booking.schema'

const sec = [{ bearerAuth: [] }]

export async function bookingRoutes(app: FastifyInstance) {
  const c = createBookingController(app.booking)
  const holdLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } }

  // ───────────── public: availability grid and invite pages ─────────────
  await app.register(
    async (pub) => {
      pub.get(
        '/venues/:idOrSlug/availability',
        {
          config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
          schema: { tags: ['Booking'], querystring: S.availabilityQuery },
        },
        c.publicGrid,
      )
      pub.get(
        '/invites/:token',
        {
          config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
          schema: { tags: ['Booking'] },
        },
        c.publicInvite,
      )
      pub.post(
        '/invites/:token/rsvp',
        {
          config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
          schema: { tags: ['Booking'], body: S.rsvpBody },
        },
        c.rsvp,
      )
    },
    { prefix: '/api/v1/public' },
  )

  // ───────────── player ─────────────
  await app.register(
    async (u) => {
      u.addHook('onRequest', authenticate)
      const mine = (extra = {}) => ({ schema: { tags: ['Booking'], security: sec, ...extra } })
      const byId = (extra = {}) => mine({ params: S.idParams, ...extra })

      u.post('/bookings/holds', { config: holdLimit, ...mine({ body: S.holdBody }) }, c.createHold)
      u.delete('/bookings/:id/hold', byId(), c.releaseHold)
      u.post('/bookings/:id/confirm-pay-at-venue', { config: holdLimit, ...byId() }, c.payAtVenue)
      u.get('/me/bookings', mine({ querystring: S.myBookingsQuery }), c.myBookings)
      u.get('/bookings/:id', byId(), c.getMine)
      u.get('/bookings/:id/pass', byId(), c.getPass)
      u.get(
        '/bookings/:id/cancel-preview',
        byId({ querystring: S.bookingItemQuery }),
        c.cancelPreview,
      )
      u.post('/bookings/:id/cancel', byId({ body: S.cancelBody }), c.cancelMine)
      u.post('/bookings/:id/invites', byId(), c.createInvite)
      u.get('/bookings/:id/invites', byId(), c.listInvites)
      u.delete('/bookings/:id/invites/:inviteId', mine(), c.revokeInvite)
      u.patch('/bookings/:id/headcount', byId({ body: S.headcountBody }), c.setHeadcount)
    },
    { prefix: '/api/v1' },
  )

  // ───────────── Ground POS: /pos/venues/:venueId/* ─────────────
  await app.register(
    async (p) => {
      p.addHook('onRequest', authenticate)
      const frontDesk = requireVenueRole('OWNER', 'MANAGER', 'FRONT_DESK')
      const manager = requireVenueRole('OWNER', 'MANAGER')
      const owner = requireVenueRole('OWNER')
      const pos = (guard: typeof frontDesk, extra = {}) => ({
        onRequest: [guard],
        schema: { tags: ['POS'], security: sec, ...extra },
      })

      p.get('/grid', pos(frontDesk, { querystring: S.gridQuery }), c.posGrid)

      p.post('/walkins', pos(frontDesk, { body: S.walkInBody }), c.walkIn)
      p.post('/bookings/manual', pos(frontDesk, { body: S.manualBody }), c.manualBooking)
      p.get('/bookings', pos(frontDesk, { querystring: S.dayListQuery }), c.dayList)
      p.get('/bookings/:id', pos(frontDesk, { params: S.idParams }), c.getBooking)
      p.post('/check-in', pos(frontDesk, { body: S.checkInBody }), c.checkIn)
      p.post(
        '/bookings/:id/check-in',
        pos(frontDesk, { params: S.idParams, body: S.checkInBody }),
        c.checkInBooking,
      )
      p.post(
        '/bookings/:id/collect-balance',
        pos(frontDesk, { params: S.idParams, body: S.collectBody }),
        c.collectBalance,
      )
      p.post('/bookings/:id/no-show', pos(frontDesk, { params: S.idParams }), c.noShow)
      p.post(
        '/bookings/:id/cancel',
        pos(manager, { params: S.idParams, body: S.cancelBody }),
        c.cancelByVenue,
      )

      // blocks
      p.post('/blocks', pos(manager, { body: S.blockBody }), c.block)
      p.delete('/blocks', pos(manager, { querystring: S.unblockQuery }), c.unblock)

      // outage / rain lock
      p.post('/outage-lock/preview', pos(manager, { body: S.outagePreviewBody }), c.outagePreview)
      p.post('/outage-lock', pos(manager, { body: S.outageBody }), c.startOutage)
      p.get('/outage-locks', pos(manager), c.listOutages)
      p.get('/outage-lock/:id', pos(manager, { params: S.idParams }), c.getOutage)
      p.delete('/outage-lock/:id', pos(manager, { params: S.idParams }), c.releaseOutage)

      // pilot settings + blocklist
      p.get('/booking-settings', pos(manager), c.getSettings)
      p.patch('/booking-settings', pos(owner, { body: S.settingsBody }), c.updateSettings)
      p.get('/blocklist', pos(manager), c.listBlocklist)
      p.post('/blocklist', pos(manager, { body: S.blocklistBody }), c.addToBlocklist)
      p.delete(
        '/blocklist/:phone',
        pos(manager, { params: S.blocklistParams }),
        c.removeFromBlocklist,
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── admin ─────────────
  await app.register(
    async (a) => {
      a.addHook('onRequest', authenticate)
      a.addHook('onRequest', requireAdmin)
      const adm = (extra = {}) => ({ schema: { tags: ['Admin'], security: sec, ...extra } })

      a.get('/bookings', adm({ querystring: S.adminSearchQuery }), c.adminSearch)
      a.get('/bookings/:id', adm({ params: S.idParams }), c.adminDetail)
      a.post(
        '/bookings/:id/cancel',
        adm({ params: S.idParams, body: S.adminCancelBody }),
        c.adminCancel,
      )
      a.post('/slots/unblock', adm({ body: S.adminUnblockBody }), c.adminUnblock)
      a.get('/outage-locks', adm(), c.adminOutages)
      a.get('/abuse-flags', adm(), c.abuseFlags)
      a.get('/booking-health', adm(), c.bookingHealth)
      // read-only live calendar for support use
      a.get('/venues/:id/grid', adm({ params: S.idParams, querystring: S.gridQuery }), c.adminGrid)
    },
    { prefix: '/api/v1/admin' },
  )
}
