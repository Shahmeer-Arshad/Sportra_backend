import { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, requireAdmin, requireVenueRole } from '../../hooks/auth.hook'
import { idempotencyKey } from '../../lib/idempotency'
import { successResponse } from '../../utils/response'
import { Actor } from './booking.pos'
import * as S from './booking.schema'

const sec = [{ bearerAuth: [] }]
const staffActor = (req: FastifyRequest): Actor => ({
  id: req.user.sub,
  role: (req as FastifyRequest & { venueRole: Actor['role'] }).venueRole,
  ip: req.ip,
})
const params = (req: FastifyRequest) => req.params as Record<string, string>

export async function bookingRoutes(app: FastifyInstance) {
  const { bookings, pos, availability, admin } = app.booking
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
        async (req, reply) => {
          const q = req.query as { date: string; courtId?: string }
          const { body, etag } = await availability.publicGrid(
            params(req).idOrSlug,
            q.date,
            q.courtId,
          )
          reply.header('etag', etag).header('cache-control', 'public, max-age=2, must-revalidate')
          if (req.headers['if-none-match'] === etag) return reply.status(304).send()
          return successResponse(body)
        },
      )
      pub.get(
        '/invites/:token',
        {
          config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
          schema: { tags: ['Booking'] },
        },
        async (req) => successResponse(await bookings.publicInvite(params(req).token)),
      )
      pub.post(
        '/invites/:token/rsvp',
        {
          config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
          schema: { tags: ['Booking'], body: S.rsvpBody },
        },
        async (req) =>
          successResponse(
            await bookings.rsvp(params(req).token, req.body as never),
            'Thanks, your answer is saved',
          ),
      )
    },
    { prefix: '/api/v1/public' },
  )

  // ───────────── player ─────────────
  await app.register(
    async (u) => {
      u.addHook('onRequest', authenticate)

      u.post(
        '/bookings/holds',
        { config: holdLimit, schema: { tags: ['Booking'], security: sec, body: S.holdBody } },
        async (req, reply) => {
          const r = await bookings.createHold(req.user.sub, req.body as never, idempotencyKey(req))
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, r.replayed ? 'Hold already created' : 'Hours held'))
        },
      )
      u.delete(
        '/bookings/:id/hold',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req) =>
          successResponse(
            await bookings.releaseHold(req.user.sub, params(req).id),
            'Hold released',
          ),
      )
      u.post(
        '/bookings/:id/confirm-pay-at-venue',
        { config: holdLimit, schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req, reply) => {
          const r = await bookings.confirmPayAtVenue(
            req.user.sub,
            params(req).id,
            idempotencyKey(req),
          )
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, 'Reserved. Pay at the venue.'))
        },
      )
      u.get(
        '/me/bookings',
        { schema: { tags: ['Booking'], security: sec, querystring: S.myBookingsQuery } },
        async (req) => {
          const q = req.query as {
            tab: 'upcoming' | 'past' | 'cancelled'
            limit: number
            offset: number
          }
          const r = await bookings.listMine(req.user.sub, q.tab, q.limit, q.offset)
          return {
            ...successResponse(r.items),
            meta: { total: r.total, limit: q.limit, offset: q.offset },
          }
        },
      )
      u.get(
        '/bookings/:id',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req) => successResponse(await bookings.getMine(req.user.sub, params(req).id)),
      )
      u.get(
        '/bookings/:id/pass',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req) => successResponse(await bookings.getPass(req.user.sub, params(req).id)),
      )
      u.get(
        '/bookings/:id/cancel-preview',
        {
          schema: {
            tags: ['Booking'],
            security: sec,
            params: S.idParams,
            querystring: S.bookingItemQuery,
          },
        },
        async (req) =>
          successResponse(
            await bookings.cancelPreview(
              req.user.sub,
              params(req).id,
              (req.query as { itemIds?: string[] }).itemIds,
            ),
          ),
      )
      u.post(
        '/bookings/:id/cancel',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams, body: S.cancelBody } },
        async (req) => {
          const b = (req.body ?? {}) as { itemIds?: string[]; reason?: string }
          const r = await bookings.cancel(
            req.user.sub,
            params(req).id,
            b.itemIds,
            idempotencyKey(req, { uuid: true }),
            b.reason,
          )
          return successResponse(r, r.replayed ? 'Already cancelled' : 'Cancelled')
        },
      )
      u.post(
        '/bookings/:id/invites',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req, reply) =>
          reply
            .status(201)
            .send(successResponse(await bookings.createInvite(req.user.sub, params(req).id))),
      )
      u.get(
        '/bookings/:id/invites',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams } },
        async (req) => successResponse(await bookings.listInvites(req.user.sub, params(req).id)),
      )
      u.delete(
        '/bookings/:id/invites/:inviteId',
        { schema: { tags: ['Booking'], security: sec } },
        async (req) =>
          successResponse(
            await bookings.revokeInvite(req.user.sub, params(req).id, params(req).inviteId),
          ),
      )
      u.patch(
        '/bookings/:id/headcount',
        { schema: { tags: ['Booking'], security: sec, params: S.idParams, body: S.headcountBody } },
        async (req) =>
          successResponse(
            await bookings.setHeadcount(
              req.user.sub,
              params(req).id,
              (req.body as { headcount: number }).headcount,
            ),
          ),
      )
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
      const tag = ['POS']
      const vid = (req: FastifyRequest) => params(req).venueId

      p.get(
        '/grid',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, querystring: S.gridQuery } },
        async (req, reply) => {
          const q = req.query as { date: string; courtId?: string }
          reply.header('cache-control', 'no-store') // the live grid is never cached
          return successResponse(await availability.posGrid(vid(req), q.date, q.courtId))
        },
      )

      p.post(
        '/walkins',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, body: S.walkInBody } },
        async (req, reply) => {
          const r = await pos.walkIn(
            vid(req),
            staffActor(req),
            req.body as never,
            idempotencyKey(req),
          )
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, r.replayed ? 'Already recorded' : 'Walk-in recorded'))
        },
      )
      p.post(
        '/bookings/manual',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, body: S.manualBody } },
        async (req, reply) => {
          const r = await pos.manualBooking(
            vid(req),
            staffActor(req),
            req.body as never,
            idempotencyKey(req),
          )
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, r.replayed ? 'Already recorded' : 'Booking recorded'))
        },
      )
      p.get(
        '/bookings',
        {
          onRequest: [frontDesk],
          schema: { tags: tag, security: sec, querystring: S.dayListQuery },
        },
        async (req) => {
          const q = req.query as {
            date?: string
            status?: string
            q?: string
            limit: number
            offset: number
          }
          const r = await pos.dayList(vid(req), q)
          return {
            ...successResponse(r.items),
            meta: { total: r.total, limit: q.limit, offset: q.offset },
          }
        },
      )
      p.get(
        '/bookings/:id',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, params: S.idParams } },
        async (req) => successResponse(await pos.getBooking(vid(req), params(req).id)),
      )
      p.post(
        '/check-in',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, body: S.checkInBody } },
        async (req) =>
          successResponse(
            await pos.checkIn(vid(req), staffActor(req), req.body as never),
            'Checked in',
          ),
      )
      p.post(
        '/bookings/:id/check-in',
        {
          onRequest: [frontDesk],
          schema: { tags: tag, security: sec, params: S.idParams, body: S.checkInBody },
        },
        async (req) =>
          successResponse(
            await pos.checkIn(vid(req), staffActor(req), {
              ...((req.body ?? {}) as object),
              bookingId: params(req).id,
            }),
            'Checked in',
          ),
      )
      p.post(
        '/bookings/:id/collect-balance',
        {
          onRequest: [frontDesk],
          schema: { tags: tag, security: sec, params: S.idParams, body: S.collectBody },
        },
        async (req, reply) => {
          const r = await pos.collectBalance(
            vid(req),
            staffActor(req),
            params(req).id,
            (req.body as { amountMinor: number }).amountMinor,
            idempotencyKey(req),
          )
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, 'Payment recorded'))
        },
      )
      p.post(
        '/bookings/:id/no-show',
        { onRequest: [frontDesk], schema: { tags: tag, security: sec, params: S.idParams } },
        async (req) =>
          successResponse(
            await pos.markNoShow(vid(req), staffActor(req), params(req).id),
            'Marked as a no-show',
          ),
      )
      p.post(
        '/bookings/:id/cancel',
        {
          onRequest: [manager],
          schema: { tags: tag, security: sec, params: S.idParams, body: S.cancelBody },
        },
        async (req) => {
          const b = (req.body ?? {}) as { itemIds?: string[]; reason?: string }
          return successResponse(
            await pos.cancel(
              vid(req),
              staffActor(req),
              params(req).id,
              b.itemIds,
              b.reason,
              idempotencyKey(req, { uuid: true }),
            ),
            'Cancelled',
          )
        },
      )

      // blocks
      p.post(
        '/blocks',
        { onRequest: [manager], schema: { tags: tag, security: sec, body: S.blockBody } },
        async (req) =>
          successResponse(await pos.block(vid(req), staffActor(req), req.body as never), 'Blocked'),
      )
      p.delete(
        '/blocks',
        { onRequest: [manager], schema: { tags: tag, security: sec, querystring: S.unblockQuery } },
        async (req) =>
          successResponse(
            await pos.unblock(vid(req), staffActor(req), req.query as never),
            'Unblocked',
          ),
      )

      // outage / rain lock
      p.post(
        '/outage-lock/preview',
        { onRequest: [manager], schema: { tags: tag, security: sec, body: S.outagePreviewBody } },
        async (req) => successResponse(await pos.outagePreview(vid(req), req.body as never)),
      )
      p.post(
        '/outage-lock',
        { onRequest: [manager], schema: { tags: tag, security: sec, body: S.outageBody } },
        async (req, reply) => {
          const r = await pos.startOutage(
            vid(req),
            staffActor(req),
            req.body as never,
            idempotencyKey(req),
          )
          return reply
            .status(r.status)
            .header('idempotent-replayed', String(r.replayed))
            .send(successResponse(r.body, 'Outage lock started'))
        },
      )
      p.get(
        '/outage-locks',
        { onRequest: [manager], schema: { tags: tag, security: sec } },
        async (req) => successResponse(await pos.listOutages(vid(req))),
      )
      p.get(
        '/outage-lock/:id',
        { onRequest: [manager], schema: { tags: tag, security: sec, params: S.idParams } },
        async (req) => successResponse(await pos.getOutage(vid(req), params(req).id)),
      )
      p.delete(
        '/outage-lock/:id',
        { onRequest: [manager], schema: { tags: tag, security: sec, params: S.idParams } },
        async (req) =>
          successResponse(
            await pos.releaseOutage(vid(req), staffActor(req), params(req).id),
            'Outage lock released',
          ),
      )

      // pilot settings + blocklist
      p.get(
        '/booking-settings',
        { onRequest: [manager], schema: { tags: tag, security: sec } },
        async (req) => successResponse(await pos.getSettings(vid(req))),
      )
      p.patch(
        '/booking-settings',
        { onRequest: [owner], schema: { tags: tag, security: sec, body: S.settingsBody } },
        async (req) =>
          successResponse(
            await pos.updateSettings(vid(req), staffActor(req), req.body as never),
            'Settings saved',
          ),
      )
      p.get(
        '/blocklist',
        { onRequest: [manager], schema: { tags: tag, security: sec } },
        async (req) => successResponse(await pos.listBlocklist(vid(req))),
      )
      p.post(
        '/blocklist',
        { onRequest: [manager], schema: { tags: tag, security: sec, body: S.blocklistBody } },
        async (req, reply) =>
          reply
            .status(201)
            .send(
              successResponse(
                await pos.addToBlocklist(vid(req), staffActor(req), req.body as never),
              ),
            ),
      )
      p.delete(
        '/blocklist/:phone',
        { onRequest: [manager], schema: { tags: tag, security: sec, params: S.blocklistParams } },
        async (req) =>
          successResponse(
            await pos.removeFromBlocklist(vid(req), staffActor(req), params(req).phone),
          ),
      )
    },
    { prefix: '/api/v1/pos/venues/:venueId' },
  )

  // ───────────── admin ─────────────
  await app.register(
    async (a) => {
      a.addHook('onRequest', authenticate)
      a.addHook('onRequest', requireAdmin)
      const tag = ['Admin']

      a.get(
        '/bookings',
        { schema: { tags: tag, security: sec, querystring: S.adminSearchQuery } },
        async (req) => {
          const q = req.query as Parameters<typeof admin.search>[0]
          const r = await admin.search(q)
          return {
            ...successResponse(r.items),
            meta: { total: r.total, limit: q.limit, offset: q.offset },
          }
        },
      )
      a.get(
        '/bookings/:id',
        { schema: { tags: tag, security: sec, params: S.idParams } },
        async (req) => successResponse(await admin.detail(params(req).id)),
      )
      a.post(
        '/bookings/:id/cancel',
        { schema: { tags: tag, security: sec, params: S.idParams, body: S.adminCancelBody } },
        async (req) =>
          successResponse(
            await admin.cancel(
              req.user.sub,
              params(req).id,
              req.body as never,
              idempotencyKey(req, { uuid: true }),
              req.ip,
            ),
            'Cancelled on behalf of the venue',
          ),
      )
      a.post(
        '/slots/unblock',
        { schema: { tags: tag, security: sec, body: S.adminUnblockBody } },
        async (req) =>
          successResponse(
            await admin.unblock(req.user.sub, req.body as never, req.ip),
            'Unblocked',
          ),
      )
      a.get('/outage-locks', { schema: { tags: tag, security: sec } }, async (req) =>
        successResponse(await admin.outageLocks((req.query as { status?: string }).status)),
      )
      a.get('/abuse-flags', { schema: { tags: tag, security: sec } }, async () =>
        successResponse(await admin.abuseFlags()),
      )
      a.get('/booking-health', { schema: { tags: tag, security: sec } }, async () =>
        successResponse(await admin.health()),
      )
      // read-only live calendar for support use
      a.get(
        '/venues/:id/grid',
        { schema: { tags: tag, security: sec, params: S.idParams, querystring: S.gridQuery } },
        async (req, reply) => {
          const q = req.query as { date: string; courtId?: string }
          reply.header('cache-control', 'no-store')
          return successResponse(await availability.posGrid(params(req).id, q.date, q.courtId))
        },
      )
    },
    { prefix: '/api/v1/admin' },
  )
}
