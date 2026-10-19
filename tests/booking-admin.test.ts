import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ABUSE_ABANDONED_HOLDS, ABUSE_NO_SHOWS } from '../src/modules/booking/booking.admin'
import { createBookingJobs } from '../src/modules/booking/booking.jobs'
import {
  Fixture,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  moveBookingTime,
  newUuidKey,
  pickSlots,
  tomorrow,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let day = 2
const nextDay = () => day++

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
  await call(
    app,
    'PATCH',
    `/api/v1/pos/venues/${fx.venueId}/booking-settings`,
    fx.owner.accessToken,
    {
      payAtVenueEnabled: true,
    },
  )
}, 60_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const admin = () => fx.admin.accessToken
const reserve = async (opts: { email?: string; phone?: string } = {}) => {
  const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
  const p = await makeUser(app, {
    ...(opts.email && { email: opts.email }),
    ...(opts.phone && { phone: opts.phone }),
  })
  const h = (await holdHours(app, p.accessToken, fx.courtId, [a.id])).json().data
  await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken)
  return { id: h.id as string, ref: h.ref as string, player: p, slot: a }
}

describe('booking search', () => {
  it('finds bookings by reference, e-mail, phone, venue, date and status', async () => {
    const b = await reserve({ phone: '+923007770001' })
    const walk = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/walkins`,
      fx.frontDesk.accessToken,
      {
        courtId: fx.courtId,
        slotIds: [(await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() }))[0].id],
        customerName: 'Zubair',
        customerPhone: '03007770002',
      },
    )
    const search = async (q: string) =>
      (await call(app, 'GET', `/api/v1/admin/bookings?${q}`, admin())).json()

    expect(
      (await search(`ref=${b.ref.toLowerCase()}`)).data.map((x: { id: string }) => x.id),
    ).toEqual([b.id])
    expect((await search(`email=${encodeURIComponent(b.player.email)}`)).data[0].userEmail).toBe(
      b.player.email,
    )
    expect((await search('phone=7770002')).data[0].id).toBe(walk.json().data.id)
    const byVenue = await search(`venueId=${fx.venueId}&status=CONFIRMED&limit=100`)
    expect(byVenue.data.length).toBeGreaterThanOrEqual(2)
    expect(
      byVenue.data.every(
        (x: { venueId: string; status: string }) =>
          x.venueId === fx.venueId && x.status === 'CONFIRMED',
      ),
    ).toBe(true)
    expect(byVenue.data[0].venueName).toBe('Booking Arena')
    const byDate = await search(
      `venueId=${fx.venueId}&date=${b.slot.business_date.toISOString().slice(0, 10)}`,
    )
    expect(byDate.data.map((x: { id: string }) => x.id)).toContain(b.id)
    expect((await search(`ref=${b.ref}&status=CANCELLED_BY_USER`)).data).toHaveLength(0)
    const paged = await search(`venueId=${fx.venueId}&limit=1&offset=0`)
    expect(paged.data).toHaveLength(1)
    expect(paged.meta.total).toBeGreaterThanOrEqual(2)
    // a wildcard is a literal character, not "match everything"
    expect((await search('email=%25')).data).toHaveLength(0)
  })

  it('is for platform admins only', async () => {
    const q = '/api/v1/admin/bookings'
    expect((await call(app, 'GET', q, fx.owner.accessToken)).statusCode).toBe(403)
    expect((await call(app, 'GET', q, fx.manager.accessToken)).statusCode).toBe(403)
    expect((await call(app, 'GET', q, (await makeUser(app)).accessToken)).statusCode).toBe(403)
    expect((await call(app, 'GET', q)).statusCode).toBe(401)
  })
})

describe('booking detail', () => {
  it('shows the items, the cancellations, the player and the full audit trail', async () => {
    const b = await reserve()
    await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${b.id}/cancel`,
      b.player.accessToken,
      { reason: 'changed plans' },
      newUuidKey(),
    )
    const r = await call(app, 'GET', `/api/v1/admin/bookings/${b.id}`, admin())
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.ref).toBe(b.ref)
    expect(d.status).toBe('CANCELLED_BY_USER')
    expect(d.venueName).toBe('Booking Arena')
    expect(d.user).toMatchObject({ id: b.player.id, email: b.player.email })
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({ status: 'CANCELLED', cancelledBy: 'USER' })
    expect(d.cancellations).toHaveLength(1)
    expect(d.cancellations[0]).toMatchObject({ cancelledBy: 'USER', reason: 'changed plans' })
    const actions = d.auditTrail.map((a: { action: string }) => a.action)
    expect(actions).toContain('BOOKING_RESERVED_PAY_AT_VENUE')
    expect(actions).toContain('BOOKING_ITEMS_CANCELLED')
    expect(actions.indexOf('BOOKING_RESERVED_PAY_AT_VENUE')).toBeLessThan(
      actions.indexOf('BOOKING_ITEMS_CANCELLED'),
    )
    expect(
      (
        await call(
          app,
          'GET',
          '/api/v1/admin/bookings/0198a000-0000-7000-8000-000000000001',
          admin(),
        )
      ).statusCode,
    ).toBe(404)
  })
})

describe('emergency override', () => {
  it('unblocks any blocked hour on behalf of a venue, with a reason, and audits it', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/blocks`,
      fx.manager.accessToken,
      {
        courtIds: [fx.courtId],
        from: a.start_at.toISOString(),
        to: b.end_at.toISOString(),
        reason: 'MAINTENANCE',
      },
    )
    const noReason = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [a.id],
      reason: 'x',
    })
    expect(noReason.statusCode).toBe(400)
    const forbidden = await call(app, 'POST', '/api/v1/admin/slots/unblock', fx.owner.accessToken, {
      slotIds: [a.id],
      reason: 'owner using admin route',
    })
    expect(forbidden.statusCode).toBe(403)
    const r = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [a.id, b.id],
      reason: 'venue asked support to reopen',
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.releasedCount).toBe(2)
    const rows = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM slots WHERE id = ANY(${[a.id, b.id]}::uuid[])`
    expect(rows.every((x) => x.status === 'AVAILABLE')).toBe(true)
    const au = await app.prisma.auditLog.findMany({
      where: { action: 'ADMIN_SLOTS_UNBLOCKED', actorId: fx.admin.id },
    })
    expect(au.length).toBeGreaterThanOrEqual(1)
    expect((au[au.length - 1].after as { reason: string }).reason).toBe(
      'venue asked support to reopen',
    )
  })

  it('can release a tournament block, but only an hour that is really blocked', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    await app.prisma
      .$executeRaw`UPDATE slots SET status = 'BLOCKED', block_reason = 'TOURNAMENT' WHERE id = ${a.id}::uuid`
    const ok = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [a.id],
      reason: 'tournament cancelled by admin',
    })
    expect(ok.json().data.releasedCount).toBe(1)
    // b is simply available: that is an illegal transition and says so
    const illegal = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [b.id],
      reason: 'trying a free hour',
    })
    expect(illegal.statusCode).toBe(409)
    expect(illegal.json().code).toBe('INVALID_SLOT_TRANSITION')
    expect(illegal.json().details).toMatchObject({
      slotId: b.id,
      from: 'AVAILABLE',
      to: 'AVAILABLE',
    })
    // a booked hour cannot be "unblocked" either
    const booked = await reserve()
    const bad = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [booked.slot.id],
      reason: 'trying a booked hour',
    })
    expect(bad.statusCode).toBe(409)
    expect((await app.prisma.booking.findUnique({ where: { id: booked.id } }))!.status).toBe(
      'CONFIRMED',
    )
  })

  it('is all or nothing: one illegal hour in the list changes none of them', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    await app.prisma
      .$executeRaw`UPDATE slots SET status = 'BLOCKED', block_reason = 'OTHER' WHERE id = ${a.id}::uuid`
    const r = await call(app, 'POST', '/api/v1/admin/slots/unblock', admin(), {
      slotIds: [a.id, b.id],
      reason: 'mixed list of hours',
    })
    expect(r.statusCode).toBe(409)
    const rows = await app.prisma.$queryRaw<
      { id: string; status: string }[]
    >`SELECT id, status FROM slots WHERE id = ANY(${[a.id, b.id]}::uuid[])`
    expect(rows.find((x) => x.id === a.id)!.status).toBe('BLOCKED')
  })

  it('cancels a booking on behalf of the venue (see the cancellation tests for amounts)', async () => {
    const b = await reserve()
    const r = await callKeyed(
      app,
      'POST',
      `/api/v1/admin/bookings/${b.id}/cancel`,
      admin(),
      { reason: 'venue shut down' },
      newUuidKey(),
    )
    expect(r.statusCode).toBe(200)
    expect((await app.prisma.booking.findUnique({ where: { id: b.id } }))!.status).toBe(
      'CANCELLED_BY_VENUE',
    )
  })
})

describe('outage monitor', () => {
  it('lists active outage locks with progress, and hides released ones unless asked', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const start = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/outage-lock`,
      fx.manager.accessToken,
      {
        courtIds: [fx.courtId],
        from: a.start_at.toISOString(),
        to: a.end_at.toISOString(),
        reason: 'RAIN',
      },
    )
    expect(start.statusCode).toBe(202)
    await app.booking.idle()
    const lockId = start.json().data.id
    const list = (await call(app, 'GET', '/api/v1/admin/outage-locks', admin())).json().data
    const mine = list.find((l: { id: string }) => l.id === lockId)
    expect(mine).toMatchObject({
      venueId: fx.venueId,
      venueName: 'Booking Arena',
      status: 'ACTIVE',
      reason: 'RAIN',
      totalBookings: 0,
      failed: 0,
    })
    await call(
      app,
      'DELETE',
      `/api/v1/pos/venues/${fx.venueId}/outage-lock/${lockId}`,
      fx.manager.accessToken,
    )
    expect(
      (await call(app, 'GET', '/api/v1/admin/outage-locks', admin()))
        .json()
        .data.map((l: { id: string }) => l.id),
    ).not.toContain(lockId)
    expect(
      (await call(app, 'GET', '/api/v1/admin/outage-locks?status=RELEASED', admin()))
        .json()
        .data.map((l: { id: string }) => l.id),
    ).toContain(lockId)
    expect(
      (await call(app, 'GET', '/api/v1/admin/outage-locks', fx.manager.accessToken)).statusCode,
    ).toBe(403)
  })
})

describe('abuse flags', () => {
  it('lists players with repeated no-shows or abandoned holds, and venue blocklists', async () => {
    const striker = await makeUser(app)
    await app.prisma.user.update({
      where: { id: striker.id },
      data: { noShowCount: ABUSE_NO_SHOWS },
    })
    const hoarder = await makeUser(app)
    const slots = await pickSlots(app.prisma, fx.courtId, ABUSE_ABANDONED_HOLDS, {
      dayOffset: nextDay(),
    })
    for (const s of slots) {
      const h = (await holdHours(app, hoarder.accessToken, fx.courtId, [s.id])).json().data
      await call(app, 'DELETE', `/api/v1/bookings/${h.id}/hold`, hoarder.accessToken) // hold, then give it back
    }
    const fine = await makeUser(app)
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/blocklist`,
      fx.manager.accessToken,
      { phone: '0300 4440000', reason: 'abusive' },
    )

    const r = (await call(app, 'GET', '/api/v1/admin/abuse-flags', admin())).json().data
    expect(r.thresholds).toEqual({
      noShows: ABUSE_NO_SHOWS,
      abandonedHolds30d: ABUSE_ABANDONED_HOLDS,
    })
    const ids = r.users.map((u: { userId: string }) => u.userId)
    expect(ids).toContain(striker.id)
    expect(ids).toContain(hoarder.id)
    expect(ids).not.toContain(fine.id)
    expect(r.users.find((u: { userId: string }) => u.userId === hoarder.id).abandonedHolds30d).toBe(
      ABUSE_ABANDONED_HOLDS,
    )
    expect(
      r.venueBlocklist.some(
        (b: { phone: string; venueName: string }) =>
          b.phone === '+923004440000' && b.venueName === 'Booking Arena',
      ),
    ).toBe(true)
    expect(
      (await call(app, 'GET', '/api/v1/admin/abuse-flags', fx.owner.accessToken)).statusCode,
    ).toBe(403)
  })
})

describe('platform health tiles', () => {
  it('reports the hold-expiry backlog, which the sweeper clears', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const h = (await holdHours(app, p.accessToken, fx.courtId, [a.id])).json().data
    const before = (await call(app, 'GET', '/api/v1/admin/booking-health', admin())).json().data
    expect(before.activeHolds).toBeGreaterThanOrEqual(1)
    await app.prisma
      .$executeRaw`UPDATE slots SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE booking_id = ${h.id}::uuid`
    await app.prisma
      .$executeRaw`UPDATE bookings SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h.id}::uuid`
    const backlog = (await call(app, 'GET', '/api/v1/admin/booking-health', admin())).json().data
    expect(backlog.holdExpiryBacklog).toBeGreaterThanOrEqual(1)
    expect(backlog.stalePendingBookings).toBeGreaterThanOrEqual(1)
    await createBookingJobs(app.prisma, app.hotLane).tick()
    const after = (await call(app, 'GET', '/api/v1/admin/booking-health', admin())).json().data
    expect(after.holdExpiryBacklog).toBe(0)
    expect(after.stalePendingBookings).toBe(0)
    expect(after).toHaveProperty('outboxUnpublished')
    expect(after.realtime).toEqual({
      connections: expect.any(Number),
      emitted: expect.any(Number),
      p95LatencyMs: expect.anything(),
    })
    expect(
      (await call(app, 'GET', '/api/v1/admin/booking-health', fx.owner.accessToken)).statusCode,
    ).toBe(403)
  })
})

describe('venue calendar viewer', () => {
  it('shows an admin the live grid of any venue, and nobody else', async () => {
    const r = await call(
      app,
      'GET',
      `/api/v1/admin/venues/${fx.venueId}/grid?date=${tomorrow()}`,
      admin(),
    )
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.json().data.slots.length).toBeGreaterThanOrEqual(20)
    expect(
      (
        await call(
          app,
          'GET',
          `/api/v1/admin/venues/${fx.venueId}/grid?date=${tomorrow()}`,
          fx.owner.accessToken,
        )
      ).statusCode,
    ).toBe(403)
  })
})

describe('housekeeping jobs', () => {
  it('marks played checked-in bookings COMPLETED and drops old idempotency keys; both are safe to repeat', async () => {
    const b = await reserve()
    const ref = b.ref
    await moveBookingTime(app.prisma, b.id, new Date(Date.now() - 90 * 60_000))
    const ci = await call(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/check-in`,
      fx.frontDesk.accessToken,
      { ref },
    )
    expect(ci.statusCode).toBe(200)
    const jobs = createBookingJobs(app.prisma, app.hotLane)
    const t = await jobs.tick()
    expect(t.completed).toBeGreaterThanOrEqual(1)
    expect((await app.prisma.booking.findUnique({ where: { id: b.id } }))!.status).toBe('COMPLETED')
    expect((await jobs.tick()).completed).toBe(0)

    await app.prisma
      .$executeRaw`INSERT INTO idempotency_keys (scope, key, request_hash, created_at) VALUES ('hold:old', 'old-key-123456', 'x', now() - interval '3 days')
      ON CONFLICT (scope, key) DO UPDATE SET created_at = now() - interval '3 days'`
    const n = await jobs.nightly([fx.venueId])
    expect(n.purgedKeys).toBeGreaterThanOrEqual(1)
    const left = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM idempotency_keys WHERE scope = 'hold:old'`
    expect(left[0].n).toBe(0)
  })
})
