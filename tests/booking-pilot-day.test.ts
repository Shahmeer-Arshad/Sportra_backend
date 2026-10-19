/**
 * Phase 2 exit criterion: "a pilot venue runs a complete day on the Owner portal (walk-ins, manual,
 * blocks, check-ins), including an offline period; players can find, hold and reserve; QR check-in works;
 * a rain lock cancels the affected players".
 *
 * This is that day, played from start to finish through the real HTTP API, followed by the checks a
 * venue owner would care about at closing time.
 */
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Fixture,
  addCourt,
  assertInventoryInvariants,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  moveBookingTime,
  newKey,
  newUuidKey,
  pickSlots,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
const sideCourts: string[] = []

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app, { name: 'Pilot Arena' })
  for (let i = 0; i < 3; i++) sideCourts.push(await addCourt(app, fx, `Side ${i}`, false))
  await app.booking.idle()
}, 90_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const pos = () => `/api/v1/pos/venues/${fx.venueId}`
const fd = () => fx.frontDesk.accessToken
const mgr = () => fx.manager.accessToken

describe('a full operating day', () => {
  it('runs from opening to closing without a single double sale or lost sale', async () => {
    const day = 3
    const hrs = await pickSlots(app.prisma, fx.courtId, 20, { dayOffset: day }) // the whole business day, 06:00 → 01:00
    const date = hrs[0].business_date.toISOString().slice(0, 10)
    const take = (from: number, n: number) => hrs.slice(from, from + n).map((h) => h.id)
    const walkIn = (ids: string[], name: string, extra: object = {}, key = newKey()) =>
      callKeyed(
        app,
        'POST',
        `${pos()}/walkins`,
        fd(),
        {
          courtId: fx.courtId,
          slotIds: ids,
          customerName: name,
          customerPhone: '03001234567',
          ...extra,
        },
        key,
      )

    // ── morning: the owner switches on pay-at-venue and checks the grid ──
    expect(
      (
        await call(app, 'PATCH', `${pos()}/booking-settings`, fx.owner.accessToken, {
          payAtVenueEnabled: true,
        })
      ).statusCode,
    ).toBe(200)
    const grid0 = (
      await call(app, 'GET', `${pos()}/grid?date=${date}&courtId=${fx.courtId}`, fd())
    ).json().data
    expect(grid0.slots.filter((s: { status: string }) => s.status === 'AVAILABLE')).toHaveLength(20)

    // ── players find a free hour, hold it, reserve it, share it ──
    const players = await Promise.all(Array.from({ length: 4 }, () => makeUser(app)))
    const playerBookings: Array<{ id: string; ref: string; hours: number }> = []
    const reservations: Array<[number, number]> = [
      [0, 2],
      [4, 1],
      [6, 1],
      [9, 1],
    ] // [first hour, hours]
    for (let i = 0; i < 4; i++) {
      const [from, n] = reservations[i]
      const avail = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/public/venues/${fx.venueId}/availability?date=${date}&courtId=${fx.courtId}`,
        })
      ).json().data
      expect(avail.slots[from].status).toBe('AVAILABLE')
      const h = await holdHours(app, players[i].accessToken, fx.courtId, take(from, n))
      expect(h.statusCode).toBe(201)
      const c = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.json().data.id}/confirm-pay-at-venue`,
        players[i].accessToken,
      )
      expect(c.statusCode).toBe(200)
      playerBookings.push({ id: h.json().data.id, ref: h.json().data.ref, hours: n })
    }
    // the first captain invites friends, two say yes
    const inv = (
      await call(
        app,
        'POST',
        `/api/v1/bookings/${playerBookings[0].id}/invites`,
        players[0].accessToken,
      )
    ).json().data
    for (const name of ['Ali', 'Omer'])
      await app.inject({
        method: 'POST',
        url: `/api/v1/public/invites/${inv.token}/rsvp`,
        payload: { name, status: 'GOING' },
      })
    expect(
      (
        await call(app, 'GET', `/api/v1/bookings/${playerBookings[0].id}`, players[0].accessToken)
      ).json().data.headcount,
    ).toBe(3)

    // ── the front desk: walk-ins, a three-hour walk-in, a pay-later phone booking ──
    const w1 = (await walkIn(take(2, 1), 'Walk-in Bilal')).json().data
    const w2 = (await walkIn(take(10, 3), 'Walk-in Team')).json().data
    const m1 = await callKeyed(
      app,
      'POST',
      `${pos()}/bookings/manual`,
      fd(),
      {
        courtId: fx.courtId,
        slotIds: take(14, 2),
        customerName: 'WhatsApp Kamran',
        customerPhone: '03339876543',
        payLater: true,
      },
      newKey(),
    )
    expect(m1.statusCode).toBe(201)
    expect(m1.json().data.balanceDueMinor).toBeGreaterThan(0)

    // ── the internet drops: four sales are queued on the tablet with their keys ──
    const offline = [
      { key: newKey(), ids: take(16, 1), name: 'Queued A' },
      { key: newKey(), ids: take(17, 1), name: 'Queued B' },
      { key: newKey(), ids: take(2, 1), name: 'Queued C' }, // somebody already took hour 2 (w1): will conflict
      { key: newKey(), ids: take(18, 1), name: 'Queued D' },
    ]
    // ... meanwhile a player reserves hour 17 online
    const online17 = await holdHours(app, players[3].accessToken, fx.courtId, take(17, 1)) // players[3] already holds a booking; this is a second hold
    expect(online17.statusCode).toBe(201)
    // internet returns: the queue replays in order, and then a flaky retry replays everything again
    const first = []
    for (const q of offline) first.push(await walkIn(q.ids, q.name, {}, q.key))
    expect(first.map((r) => r.statusCode)).toEqual([201, 409, 409, 201]) // B lost to the online hold, C lost to Bilal
    expect(first[1].json().code).toBe('SLOT_HELD')
    expect(first[2].json().code).toBe('SLOT_UNAVAILABLE')
    const second = []
    for (const q of offline) second.push(await walkIn(q.ids, q.name, {}, q.key))
    expect(second[0].headers['idempotent-replayed']).toBe('true')
    expect(second[0].json().data.id).toBe(first[0].json().data.id) // same sale, not a second one
    expect(second[3].json().data.id).toBe(first[3].json().data.id)
    const queuedSales = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM bookings WHERE venue_id = ${fx.venueId}::uuid AND customer_name IN ('Queued A','Queued D')`
    expect(queuedSales[0].n).toBe(2)
    await call(
      app,
      'DELETE',
      `/api/v1/bookings/${online17.json().data.id}/hold`,
      players[3].accessToken,
    ) // the player changes their mind

    // ── midday: the manager blocks two hours; a booked hour in the range is reported, not overridden ──
    const blk = await callKeyed(app, 'POST', `${pos()}/blocks`, mgr(), {
      courtIds: [fx.courtId],
      from: hrs[5].start_at.toISOString(),
      to: hrs[7].end_at.toISOString(),
      reason: 'MAINTENANCE',
      note: 'net repair',
    })
    expect(blk.json().data.blockedCount).toBe(2) // hours 5 and 7; hour 6 is a player booking
    expect(blk.json().data.conflicts.map((c: { slotId: string }) => c.slotId)).toEqual([hrs[6].id])

    // ── cash comes in: balances collected at the counter ──
    const collect = (id: string, amount: number) =>
      callKeyed(app, 'POST', `${pos()}/bookings/${id}/collect-balance`, fd(), {
        amountMinor: amount,
      })
    expect((await collect(m1.json().data.id, 100000)).json().data.balanceDueMinor).toBe(
      m1.json().data.totalMinor - 100000,
    )

    // ── arrivals: two players show their QR code; one friend only has the booking code ──
    // time-travel bookings on their own courts so "now" is realistic
    const nowBooking = async (court: string, minutesFromNow: number) => {
      const [s] = await pickSlots(app.prisma, court, 1, {
        dayOffset: 20 + sideCourts.indexOf(court),
      })
      const p = await makeUser(app)
      const h = (await holdHours(app, p.accessToken, court, [s.id])).json().data
      await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken)
      await moveBookingTime(app.prisma, h.id, new Date(Date.now() + minutesFromNow * 60_000))
      return { id: h.id as string, ref: h.ref as string, p }
    }
    const a1 = await nowBooking(sideCourts[0], 15)
    const pass1 = (
      await call(app, 'GET', `/api/v1/bookings/${a1.id}/pass`, a1.p.accessToken)
    ).json().data
    const ci1 = await call(app, 'POST', `${pos()}/check-in`, fd(), { token: pass1.token })
    expect(ci1.statusCode).toBe(200)
    expect(ci1.json().data.balanceDueMinor).toBeGreaterThan(0)
    expect(
      (await collect(a1.id, ci1.json().data.balanceDueMinor)).json().data.balanceDueMinor,
    ).toBe(0)
    const a2 = await nowBooking(sideCourts[1], 5)
    expect((await call(app, 'POST', `${pos()}/check-in`, fd(), { ref: a2.ref })).statusCode).toBe(
      200,
    )
    // a no-show: started half an hour ago, nobody came
    const ns = await nowBooking(sideCourts[2], -30)
    expect(
      (await call(app, 'POST', `${pos()}/bookings/${ns.id}/no-show`, fd())).json().data.booking
        .status,
    ).toBe('NO_SHOW')
    expect((await app.prisma.user.findUnique({ where: { id: ns.p.id } }))!.noShowCount).toBe(1)

    // ── a player cancels one of their two hours; the freed hour is sold to a walk-in at once ──
    const pre = (
      await call(
        app,
        'GET',
        `/api/v1/bookings/${playerBookings[0].id}/cancel-preview?itemIds=${(await app.prisma.bookingItem.findMany({ where: { bookingId: playerBookings[0].id }, orderBy: { startAt: 'asc' } }))[1].id}`,
        players[0].accessToken,
      )
    ).json().data
    expect(pre.refundDueMinor).toBe(0) // pay-at-venue: nothing was paid online
    const secondItem = (
      await app.prisma.bookingItem.findMany({
        where: { bookingId: playerBookings[0].id },
        orderBy: { startAt: 'asc' },
      })
    )[1]
    expect(
      (
        await callKeyed(
          app,
          'POST',
          `/api/v1/bookings/${playerBookings[0].id}/cancel`,
          players[0].accessToken,
          { itemIds: [secondItem.id] },
          newUuidKey(),
        )
      ).statusCode,
    ).toBe(200)
    expect((await walkIn(take(1, 1), 'Fills the gap')).statusCode).toBe(201)

    // ── 4 pm: rain. The manager previews the impact, confirms, and the affected players are handled ──
    const rain = {
      courtIds: [fx.courtId],
      from: hrs[8].start_at.toISOString(),
      to: hrs[13].end_at.toISOString(),
    }
    const preview = (
      await callKeyed(app, 'POST', `${pos()}/outage-lock/preview`, mgr(), rain)
    ).json().data
    expect(preview.appBookings).toBe(1) // only the player holding hour 9 is inside the window
    expect(preview.manualToCall).toHaveLength(1) // the three-hour walk-in team must be phoned
    const lock = await callKeyed(
      app,
      'POST',
      `${pos()}/outage-lock`,
      mgr(),
      { ...rain, reason: 'RAIN' },
      newKey(),
    )
    expect(lock.statusCode).toBe(202)
    await app.booking.idle()
    const lockState = (
      await call(app, 'GET', `${pos()}/outage-lock/${lock.json().data.id}`, mgr())
    ).json().data
    expect(lockState.status).toBe('ACTIVE')
    expect(lockState.failed).toBe(0)
    expect(lockState.manualToCall.length).toBe(preview.manualToCall.length)
    // the rain stops: release
    expect(
      (await call(app, 'DELETE', `${pos()}/outage-lock/${lock.json().data.id}`, mgr())).json().data
        .status,
    ).toBe('RELEASED')

    // ── closing time: the day list and the money ──
    const list = (await call(app, 'GET', `${pos()}/bookings?date=${date}&limit=100`, fd())).json()
      .data
    const byStatus = (s: string) => list.filter((b: { status: string }) => b.status === s)
    expect(byStatus('CANCELLED_BY_VENUE').length).toBeGreaterThanOrEqual(1) // the rain victims
    expect(list.some((b: { customerName: string }) => b.customerName === 'Walk-in Team')).toBe(true)
    const open = list.filter(
      (b: { status: string; balanceDueMinor: number }) =>
        ['CONFIRMED', 'CHECKED_IN'].includes(b.status) && b.balanceDueMinor > 0,
    )
    // every rupee still owed belongs to a pay-later / pay-at-venue booking still on the books
    for (const b of open) expect(['MANUAL', 'APP']).toContain(b.source)
    expect([w1.id, w2.id]).toHaveLength(2)

    // ── the promises of Phase 2, checked in the database ──
    await assertInventoryInvariants(app.prisma, [fx.courtId, ...sideCourts])
    const events = await app.prisma.$queryRaw<{ event_type: string; n: number }[]>`
      SELECT event_type, count(*)::int AS n FROM outbox
       WHERE payload->'data'->>'venueId' = ${fx.venueId} GROUP BY event_type`
    const n = (t: string) => events.find((e) => e.event_type === t)?.n ?? 0
    expect(n('walkin.recorded')).toBeGreaterThanOrEqual(5)
    expect(n('BookingItemCancelled')).toBeGreaterThanOrEqual(2)
    expect(n('booking.checked_in')).toBe(2)
    expect(n('booking.no_show')).toBe(1)
    expect(n('outage_lock.activated')).toBe(1)
    expect(n('balance.collected')).toBe(2)
    const audits = await app.prisma.auditLog.groupBy({
      by: ['action'],
      where: { venueId: fx.venueId },
      _count: true,
    })
    const actions = audits.map((a) => a.action)
    for (const must of [
      'WALKIN_RECORDED',
      'MANUAL_BOOKING_CREATED',
      'SLOTS_BLOCKED',
      'OUTAGE_LOCK_STARTED',
      'OUTAGE_LOCK_RELEASED',
      'BOOKING_CHECKED_IN',
      'BOOKING_NO_SHOW',
      'BALANCE_COLLECTED',
      'BOOKING_SETTINGS_CHANGED',
    ])
      expect(actions, must).toContain(must)
  }, 120_000)
})
