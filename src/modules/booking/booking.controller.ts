import { FastifyReply, FastifyRequest } from 'fastify'
import { idempotencyKey } from '../../lib/idempotency'
import { successResponse } from '../../utils/response'
import { BookingModule } from './booking.module'
import { StaffActor } from './mediators/cancel-booking.mediator'

type Req = FastifyRequest
type Res = FastifyReply
const params = (req: Req) => req.params as Record<string, string>
const query = (req: Req) => req.query as any
const body = (req: Req) => (req.body ?? {}) as any
const vid = (req: Req) => params(req).venueId
const staffActor = (req: Req): StaffActor => ({
  id: req.user.sub,
  role: (req as Req & { venueRole: StaffActor['role'] }).venueRole,
  ip: req.ip,
})
const meta = (q: { limit: number; offset: number }, total: number) => ({
  total,
  limit: q.limit,
  offset: q.offset,
})

/** Answer of an idempotent command: the stored status and a header that says if it was a replay. */
const replayable = (
  reply: Res,
  r: { status: number; body: unknown; replayed: boolean },
  message: string,
) =>
  reply
    .status(r.status)
    .header('idempotent-replayed', String(r.replayed))
    .send(successResponse(r.body, message))

/** HTTP layer only: reads the request, calls a service or mediator, wraps the response. */
export function createBookingController(m: BookingModule) {
  return {
    // ───────── public ─────────
    publicGrid: async (req: Req, reply: Res) => {
      const q = query(req)
      const { body: grid, etag } = await m.availability.publicGrid(
        params(req).idOrSlug,
        q.date,
        q.courtId,
      )
      reply.header('etag', etag).header('cache-control', 'public, max-age=2, must-revalidate')
      if (req.headers['if-none-match'] === etag) return reply.status(304).send()
      return successResponse(grid)
    },
    publicInvite: async (req: Req) =>
      successResponse(await m.bookings.publicInvite(params(req).token)),
    rsvp: async (req: Req) =>
      successResponse(await m.rsvp(params(req).token, body(req)), 'Thanks, your answer is saved'),

    // ───────── player ─────────
    createHold: async (req: Req, reply: Res) => {
      const r = await m.createHold(req.user.sub, body(req), idempotencyKey(req))
      return replayable(reply, r, r.replayed ? 'Hold already created' : 'Hours held')
    },
    releaseHold: async (req: Req) =>
      successResponse(await m.releaseHold(req.user.sub, params(req).id), 'Hold released'),
    payAtVenue: async (req: Req, reply: Res) =>
      replayable(
        reply,
        await m.payAtVenue(req.user.sub, params(req).id, idempotencyKey(req)),
        'Reserved. Pay at the venue.',
      ),
    myBookings: async (req: Req) => {
      const q = query(req)
      const r = await m.bookings.listMine(req.user.sub, q.tab, q.limit, q.offset)
      return { ...successResponse(r.items), meta: meta(q, r.total) }
    },
    getMine: async (req: Req) =>
      successResponse(await m.bookings.getMine(req.user.sub, params(req).id)),
    getPass: async (req: Req) =>
      successResponse(await m.bookings.getPass(req.user.sub, params(req).id)),
    cancelPreview: async (req: Req) =>
      successResponse(
        await m.bookings.cancelPreview(req.user.sub, params(req).id, query(req).itemIds),
      ),
    cancelMine: async (req: Req) => {
      const b = body(req)
      const r = await m.cancel.byPlayer(
        req.user.sub,
        params(req).id,
        b.itemIds,
        idempotencyKey(req, { uuid: true }),
        b.reason,
      )
      return successResponse(r, r.replayed ? 'Already cancelled' : 'Cancelled')
    },
    createInvite: async (req: Req, reply: Res) =>
      reply
        .status(201)
        .send(successResponse(await m.bookings.createInvite(req.user.sub, params(req).id))),
    listInvites: async (req: Req) =>
      successResponse(await m.bookings.listInvites(req.user.sub, params(req).id)),
    revokeInvite: async (req: Req) =>
      successResponse(
        await m.bookings.revokeInvite(req.user.sub, params(req).id, params(req).inviteId),
      ),
    setHeadcount: async (req: Req) =>
      successResponse(
        await m.bookings.setHeadcount(req.user.sub, params(req).id, body(req).headcount),
      ),

    // ───────── Ground POS ─────────
    posGrid: async (req: Req, reply: Res) => {
      const q = query(req)
      reply.header('cache-control', 'no-store') // the live grid is never cached
      return successResponse(await m.availability.posGrid(vid(req), q.date, q.courtId))
    },
    walkIn: async (req: Req, reply: Res) => {
      const r = await m.staffBooking.walkIn(
        vid(req),
        staffActor(req),
        body(req),
        idempotencyKey(req),
      )
      return replayable(reply, r, r.replayed ? 'Already recorded' : 'Walk-in recorded')
    },
    manualBooking: async (req: Req, reply: Res) => {
      const r = await m.staffBooking.manual(
        vid(req),
        staffActor(req),
        body(req),
        idempotencyKey(req),
      )
      return replayable(reply, r, r.replayed ? 'Already recorded' : 'Booking recorded')
    },
    dayList: async (req: Req) => {
      const q = query(req)
      const r = await m.staff.dayList(vid(req), q)
      return { ...successResponse(r.items), meta: meta(q, r.total) }
    },
    getBooking: async (req: Req) =>
      successResponse(await m.staff.getBooking(vid(req), params(req).id)),
    checkIn: async (req: Req) =>
      successResponse(await m.checkIn(vid(req), staffActor(req), body(req)), 'Checked in'),
    checkInBooking: async (req: Req) =>
      successResponse(
        await m.checkIn(vid(req), staffActor(req), { ...body(req), bookingId: params(req).id }),
        'Checked in',
      ),
    collectBalance: async (req: Req, reply: Res) =>
      replayable(
        reply,
        await m.collectBalance(
          vid(req),
          staffActor(req),
          params(req).id,
          body(req).amountMinor,
          idempotencyKey(req),
        ),
        'Payment recorded',
      ),
    noShow: async (req: Req) =>
      successResponse(
        await m.noShow(vid(req), staffActor(req), params(req).id),
        'Marked as a no-show',
      ),
    cancelByVenue: async (req: Req) => {
      const b = body(req)
      return successResponse(
        await m.cancel.byVenue(
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

    block: async (req: Req) =>
      successResponse(await m.blocks.block(vid(req), staffActor(req), body(req)), 'Blocked'),
    unblock: async (req: Req) =>
      successResponse(await m.blocks.unblock(vid(req), staffActor(req), query(req)), 'Unblocked'),

    outagePreview: async (req: Req) =>
      successResponse(await m.staff.outagePreview(vid(req), body(req))),
    startOutage: async (req: Req, reply: Res) =>
      replayable(
        reply,
        await m.outage.start(vid(req), staffActor(req), body(req), idempotencyKey(req)),
        'Outage lock started',
      ),
    listOutages: async (req: Req) => successResponse(await m.staff.listOutages(vid(req))),
    getOutage: async (req: Req) =>
      successResponse(await m.staff.getOutage(vid(req), params(req).id)),
    releaseOutage: async (req: Req) =>
      successResponse(
        await m.outage.release(vid(req), staffActor(req), params(req).id),
        'Outage lock released',
      ),

    getSettings: async (req: Req) => successResponse(await m.staff.getSettings(vid(req))),
    updateSettings: async (req: Req) =>
      successResponse(
        await m.staff.updateSettings(vid(req), staffActor(req), body(req)),
        'Settings saved',
      ),
    listBlocklist: async (req: Req) => successResponse(await m.staff.listBlocklist(vid(req))),
    addToBlocklist: async (req: Req, reply: Res) =>
      reply
        .status(201)
        .send(successResponse(await m.staff.addToBlocklist(vid(req), staffActor(req), body(req)))),
    removeFromBlocklist: async (req: Req) =>
      successResponse(
        await m.staff.removeFromBlocklist(vid(req), staffActor(req), params(req).phone),
      ),

    // ───────── admin ─────────
    adminSearch: async (req: Req) => {
      const q = query(req)
      const r = await m.admin.search(q)
      return { ...successResponse(r.items), meta: meta(q, r.total) }
    },
    adminDetail: async (req: Req) => successResponse(await m.admin.detail(params(req).id)),
    adminCancel: async (req: Req) =>
      successResponse(
        await m.override.cancel(
          req.user.sub,
          params(req).id,
          body(req),
          idempotencyKey(req, { uuid: true }),
          req.ip,
        ),
        'Cancelled on behalf of the venue',
      ),
    adminUnblock: async (req: Req) =>
      successResponse(await m.override.unblock(req.user.sub, body(req), req.ip), 'Unblocked'),
    adminOutages: async (req: Req) => successResponse(await m.admin.outageLocks(query(req).status)),
    abuseFlags: async () => successResponse(await m.admin.abuseFlags()),
    bookingHealth: async () => successResponse(await m.admin.health()),
    adminGrid: async (req: Req, reply: Res) => {
      const q = query(req)
      reply.header('cache-control', 'no-store')
      return successResponse(await m.availability.posGrid(params(req).id, q.date, q.courtId))
    },
  }
}
