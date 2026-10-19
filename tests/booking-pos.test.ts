import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBookingJobs } from '../src/modules/booking/booking.jobs'
import {
  Fixture,
  addCourt,
  addStaff,
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
  tomorrow,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let other: Fixture // a second, unrelated venue
let day = 2
const nextDay = () => day++
// courts used by tests that move a booking to "now": one court each, so such bookings never overlap
const timeCourts: string[] = []
const nextTimeCourt = () => {
  const c = timeCourts.shift()
  if (!c) throw new Error('out of time-travel courts')
  return c
}

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
  other = await buildFixture(app, { name: 'Other Arena' })
  for (let i = 0; i < 12; i++) timeCourts.push(await addCourt(app, fx, `Time court ${i}`, false))
  await app.booking.idle()
  await call(
    app,
    'PATCH',
    `/api/v1/pos/venues/${fx.venueId}/booking-settings`,
    fx.owner.accessToken,
    { payAtVenueEnabled: true },
  )
}, 60_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const base = () => `/api/v1/pos/venues/${fx.venueId}`
const walkInBody = (slotIds: string[], extra: object = {}) => ({
  courtId: fx.courtId,
  slotIds,
  customerName: 'Walk In',
  customerPhone: '0300 1234567',
  ...extra,
})
const walkIn = (
  slotIds: string[],
  extra: object = {},
  key = newKey(),
  token = fx.frontDesk.accessToken,
) => callKeyed(app, 'POST', `${base()}/walkins`, token, walkInBody(slotIds, extra), key)
const manual = (
  slotIds: string[],
  extra: object = {},
  key = newKey(),
  token = fx.frontDesk.accessToken,
) => callKeyed(app, 'POST', `${base()}/bookings/manual`, token, walkInBody(slotIds, extra), key)
const slotRow = async (id: string) =>
  (
    await app.prisma.$queryRaw<
      { status: string; version: number; block_reason: string | null; block_ref: string | null }[]
    >`
    SELECT status, version, block_reason, block_ref FROM slots WHERE id = ${id}::uuid`
  )[0]
const booking = async (id: string) =>
  (
    await app.prisma.$queryRaw<
      {
        status: string
        balance_due_minor: bigint
        cash_collected_minor: bigint
        no_show_at: Date | null
      }[]
    >`
    SELECT status, balance_due_minor, cash_collected_minor, no_show_at FROM bookings WHERE id = ${id}::uuid`
  )[0]
const iso = (d: Date) => d.toISOString()

describe('one-tap walk-in', () => {
  it('records the sale, defaults the cash to the full price and flips the hour', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const r = await walkIn([a.id])
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.source).toBe('WALKIN')
    expect(d.status).toBe('CONFIRMED')
    expect(d.paymentMode).toBe('CASH_ONLY')
    expect(d.customerPhone).toBe('+923001234567') // stored in one shape
    expect(d.cashCollectedMinor).toBe(Number(a.price_minor))
    expect(d.balanceDueMinor).toBe(0)
    expect(d.paymentStatus).toBe('PAID')
    expect(d.items).toHaveLength(1)
    const s = await slotRow(a.id)
    expect(s.status).toBe('BOOKED_WALKIN')
    expect(s.version).toBe(a.version + 1)
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'walkin.recorded' AND payload->'data'->>'bookingId' = ${d.id}`
    expect(ev[0].n).toBe(1)
    const au = await app.prisma.auditLog.findMany({
      where: { entity: 'booking', entityId: d.id, action: 'WALKIN_RECORDED' },
    })
    expect(au).toHaveLength(1)
    expect(au[0].actorId).toBe(fx.frontDesk.id)
  })

  it('takes a part payment, refuses more cash than the price', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    const part = await walkIn([a.id], { cashCollectedMinor: 50000 })
    expect(part.json().data.balanceDueMinor).toBe(Number(a.price_minor) - 50000)
    expect(part.json().data.paymentStatus).toBe('UNPAID')
    const over = await walkIn([b.id], { cashCollectedMinor: Number(b.price_minor) + 1 })
    expect(over.statusCode).toBe(400)
    expect(over.json().code).toBe('CASH_EXCEEDS_TOTAL')
    expect((await slotRow(b.id)).status).toBe('AVAILABLE')
  })

  it('sells several consecutive hours as one booking (drag to select)', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    const r = await walkIn(hs.map((h) => h.id))
    expect(r.statusCode).toBe(201)
    expect(r.json().data.items).toHaveLength(3)
    expect(r.json().data.totalMinor).toBe(hs.reduce((s, h) => s + Number(h.price_minor), 0))
    // hours that are not next to each other cannot be one booking
    const [x, , z] = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    const gap = await walkIn([x.id, z.id])
    expect(gap.statusCode).toBe(400)
    expect(gap.json().details.reason).toBe('NOT_CONSECUTIVE')
    expect((await slotRow(x.id)).status).toBe('AVAILABLE')
  })

  it('an offline replay returns the original result and never sells twice', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const key = newKey()
    const first = await walkIn([a.id], {}, key)
    const replay = await walkIn([a.id], {}, key)
    expect(replay.statusCode).toBe(201)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json().data.id).toBe(first.json().data.id)
    expect((await slotRow(a.id)).version).toBe(a.version + 1)
    // the same key for a different sale is refused
    const [b] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const clash = await walkIn([b.id], {}, key)
    expect(clash.statusCode).toBe(409)
    expect(clash.json().code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('an hour that was sold while the device was offline is reported as a conflict', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const online = await makeUser(app)
    expect((await holdHours(app, online.accessToken, fx.courtId, [a.id])).statusCode).toBe(201)
    const queued = await walkIn([a.id], {}, newKey()) // replayed from the offline queue
    expect(queued.statusCode).toBe(409)
    expect(queued.json().code).toBe('SLOT_HELD')
    expect(queued.json().details.secondsRemaining).toBeGreaterThan(0)
  })

  it('can sell the hour that is being played right now, not an hour already over', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    await app.prisma
      .$executeRaw`UPDATE slots SET start_at = now() - interval '10 minutes', end_at = now() + interval '50 minutes' WHERE id = ${a.id}::uuid`
    expect((await walkIn([a.id])).statusCode).toBe(201)
    await app.prisma
      .$executeRaw`UPDATE slots SET start_at = now() - interval '3 hours', end_at = now() - interval '2 hours' WHERE id = ${b.id}::uuid`
    const past = await walkIn([b.id])
    expect(past.statusCode).toBe(400)
    expect(past.json().code).toBe('SLOT_IN_PAST')
  })

  it('refuses hours of another venue, a missing key, and anyone who is not staff of this venue', async () => {
    const [mine] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const [theirs] = await pickSlots(app.prisma, other.courtId, 1, { dayOffset: nextDay() })
    const wrong = await callKeyed(
      app,
      'POST',
      `${base()}/walkins`,
      fx.frontDesk.accessToken,
      walkInBody([theirs.id], { courtId: other.courtId }),
    )
    expect(wrong.statusCode).toBe(404)
    expect((await slotRow(theirs.id)).status).toBe('AVAILABLE')
    const noKey = await callKeyed(
      app,
      'POST',
      `${base()}/walkins`,
      fx.frontDesk.accessToken,
      walkInBody([mine.id]),
      null,
    )
    expect(noKey.statusCode).toBe(400)
    const player = await makeUser(app)
    expect((await walkIn([mine.id], {}, newKey(), player.accessToken)).statusCode).toBe(403)
    expect((await walkIn([mine.id], {}, newKey(), other.frontDesk.accessToken)).statusCode).toBe(
      403,
    )
    expect((await walkIn([mine.id], {}, newKey(), other.owner.accessToken)).statusCode).toBe(403)
    const scorer = await makeUser(app)
    await addStaff(app.prisma, fx.venueId, scorer.id, 'SCORER')
    expect((await walkIn([mine.id], {}, newKey(), scorer.accessToken)).statusCode).toBe(403)
    expect(
      (await callKeyed(app, 'POST', `${base()}/walkins`, undefined, walkInBody([mine.id])))
        .statusCode,
    ).toBe(401)
    expect((await slotRow(mine.id)).status).toBe('AVAILABLE')
  })

  it('a deactivated staff member loses access at once', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const temp = await makeUser(app)
    await addStaff(app.prisma, fx.venueId, temp.id, 'FRONT_DESK')
    expect(
      (await call(app, 'GET', `${base()}/grid?date=${tomorrow()}`, temp.accessToken)).statusCode,
    ).toBe(200)
    await app.prisma.venueMembership.updateMany({
      where: { userId: temp.id },
      data: { isActive: false },
    })
    expect((await walkIn([a.id], {}, newKey(), temp.accessToken)).statusCode).toBe(403)
  })
})

describe('manual (phone / WhatsApp) booking and balance collection', () => {
  it('pay-later keeps the booking unpaid until the balance is collected, in parts if needed', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const r = await manual([a.id], { payLater: true })
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.source).toBe('MANUAL')
    expect(d.cashCollectedMinor).toBe(0)
    expect(d.balanceDueMinor).toBe(Number(a.price_minor))
    expect((await slotRow(a.id)).status).toBe('BOOKED_WALKIN') // orange on the grid

    const grid = (
      await call(
        app,
        'GET',
        `${base()}/grid?date=${a.business_date.toISOString().slice(0, 10)}`,
        fx.frontDesk.accessToken,
      )
    ).json().data
    const cell = grid.slots.find((s: { id: string }) => s.id === a.id)
    expect(cell.booking.unpaid).toBe(true)
    expect(cell.booking.balanceDueMinor).toBe(Number(a.price_minor))

    const part = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: 50000 },
    )
    expect(part.statusCode).toBe(200)
    expect(part.json().data.balanceDueMinor).toBe(Number(a.price_minor) - 50000)
    expect(part.json().data.paymentStatus).toBe('UNPAID')
    const rest = Number(a.price_minor) - 50000
    const over = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: rest + 1 },
    )
    expect(over.statusCode).toBe(409)
    expect(over.json().code).toBe('AMOUNT_EXCEEDS_BALANCE')
    const done = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: rest },
    )
    expect(done.json().data.balanceDueMinor).toBe(0)
    expect(done.json().data.paymentStatus).toBe('PAID')
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'balance.collected' AND payload->'data'->>'bookingId' = ${d.id}`
    expect(ev[0].n).toBe(2)
  })

  it('collecting the same payment twice (same key) records it once', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await manual([a.id], { payLater: true })).json().data
    const key = newKey()
    const r1 = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: 70000 },
      key,
    )
    const r2 = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: 70000 },
      key,
    )
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r2.headers['idempotent-replayed']).toBe('true')
    expect(Number((await booking(d.id)).cash_collected_minor)).toBe(70000)
    // 20 identical retries in parallel
    const key2 = newKey()
    const many = await Promise.all(
      Array.from({ length: 20 }, () =>
        callKeyed(
          app,
          'POST',
          `${base()}/bookings/${d.id}/collect-balance`,
          fx.frontDesk.accessToken,
          { amountMinor: 10000 },
          key2,
        ),
      ),
    )
    expect(many.every((m) => m.statusCode === 200)).toBe(true)
    expect(Number((await booking(d.id)).cash_collected_minor)).toBe(80000)
  })

  it('cannot collect on a booking of another venue or on a cancelled one', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await manual([a.id], { payLater: true })).json().data
    const wrongVenue = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${other.venueId}/bookings/${d.id}/collect-balance`,
      other.frontDesk.accessToken,
      { amountMinor: 100 },
    )
    expect(wrongVenue.statusCode).toBe(404)
    await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/cancel`,
      fx.manager.accessToken,
      {},
      newUuidKey(),
    )
    const after = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: 100 },
    )
    expect(after.statusCode).toBe(409)
    expect(after.json().code).toBe('BOOKING_NOT_CONFIRMED')
  })
})

describe('the live grid', () => {
  it('shows every hour of every court with status, hold timer, customer and unpaid flag; never cached', async () => {
    const [a, b, c, d] = await pickSlots(app.prisma, fx.courtId, 4, { dayOffset: nextDay() })
    const date = a.business_date.toISOString().slice(0, 10)
    await walkIn([a.id])
    const player = await makeUser(app)
    await holdHours(app, player.accessToken, fx.courtId, [b.id])
    await manual([c.id], { payLater: true })
    await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(d.start_at),
      to: iso(d.end_at),
      reason: 'RAIN',
      note: 'wet pitch',
    })

    const r = await call(
      app,
      'GET',
      `${base()}/grid?date=${date}&courtId=${fx.courtId}`,
      fx.frontDesk.accessToken,
    )
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    const g = r.json().data
    expect(g.courts.map((c: { id: string }) => c.id)).toContain(fx.courtId)
    expect(g.slots).toHaveLength(20)
    const cell = (id: string) => g.slots.find((s: { id: string }) => s.id === id)
    expect(cell(a.id).status).toBe('BOOKED_WALKIN')
    expect(cell(a.id).booking.customerName).toBe('Walk In')
    expect(cell(b.id).status).toBe('HELD')
    expect(cell(b.id).holdSecondsLeft).toBeGreaterThan(290)
    expect(cell(c.id).booking.unpaid).toBe(true)
    expect(cell(d.id).status).toBe('BLOCKED')
    expect(cell(d.id).blockReason).toBe('RAIN')
    expect(cell(d.id).blockNote).toBe('wet pitch')
    expect(g.serverNow).toBeTruthy()
  })

  it('is for staff only', async () => {
    const player = await makeUser(app)
    const url = `${base()}/grid?date=${tomorrow()}`
    expect((await call(app, 'GET', url, player.accessToken)).statusCode).toBe(403)
    expect((await call(app, 'GET', url, other.owner.accessToken)).statusCode).toBe(403)
    expect((await call(app, 'GET', url)).statusCode).toBe(401)
    expect(
      (await call(app, 'GET', `${base()}/grid?date=not-a-date`, fx.frontDesk.accessToken))
        .statusCode,
    ).toBe(400)
  })
})

describe('blocks', () => {
  it('blocks free hours, skips live holds and never overrides bookings (conflicts list)', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 6, { dayOffset: nextDay() })
    const player = await makeUser(app)
    await walkIn([hs[1].id])
    await holdHours(app, player.accessToken, fx.courtId, [hs[2].id])
    const r = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(hs[0].start_at),
      to: iso(hs[5].end_at),
      reason: 'MAINTENANCE',
      note: 'repaint lines',
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.blockedCount).toBe(4) // hours 0, 3, 4, 5
    expect(d.conflicts).toHaveLength(1)
    expect(d.conflicts[0].slotId).toBe(hs[1].id)
    expect(d.conflicts[0].customerName).toBe('Walk In')
    expect(d.conflicts[0].bookingRef).toMatch(/^[A-Z]{3}-/)
    expect(d.heldSkipped).toHaveLength(1)
    expect(d.heldSkipped[0].slotId).toBe(hs[2].id)
    expect(d.heldSkipped[0].secondsRemaining).toBeGreaterThan(0)
    expect((await slotRow(hs[1].id)).status).toBe('BOOKED_WALKIN') // untouched
    expect((await slotRow(hs[2].id)).status).toBe('HELD')
    const s0 = await slotRow(hs[0].id)
    expect(s0.status).toBe('BLOCKED')
    expect(s0.block_reason).toBe('MAINTENANCE')
    expect(s0.version).toBe(hs[0].version + 1)
    // blocking again reports them as already blocked
    const again = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(hs[0].start_at),
      to: iso(hs[0].end_at),
      reason: 'RAIN',
    })
    expect(again.json().data.blockedCount).toBe(0)
    expect(again.json().data.alreadyBlocked).toBe(1)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  })

  it('an expired hold counts as free and is blocked', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const player = await makeUser(app)
    const h = (await holdHours(app, player.accessToken, fx.courtId, [a.id])).json().data
    await app.prisma
      .$executeRaw`UPDATE slots SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${a.id}::uuid`
    const r = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(a.start_at),
      to: iso(a.end_at),
      reason: 'OTHER',
    })
    expect(r.json().data.blockedCount).toBe(1)
    const [old] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM bookings WHERE id = ${h.id}::uuid`
    expect(old.status).toBe('EXPIRED')
  })

  it('unblocks manual blocks, but not tournament or outage blocks', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(hs[0].start_at),
      to: iso(hs[1].end_at),
      reason: 'RAIN',
    })
    // hour 2 is reserved by a tournament (Phase 5 will do this through the internal API)
    await app.prisma
      .$executeRaw`UPDATE slots SET status = 'BLOCKED', block_reason = 'TOURNAMENT' WHERE id = ${hs[2].id}::uuid`
    const q = new URLSearchParams({ from: iso(hs[0].start_at), to: iso(hs[2].end_at) })
    q.append('courtIds', fx.courtId)
    const r = await call(app, 'DELETE', `${base()}/blocks?${q}`, fx.manager.accessToken)
    expect(r.statusCode).toBe(200)
    expect(r.json().data.releasedCount).toBe(2)
    expect((await slotRow(hs[0].id)).status).toBe('AVAILABLE')
    expect((await slotRow(hs[2].id)).status).toBe('BLOCKED')
  })

  it('validates the window and the courts', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const bad = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(a.end_at),
      to: iso(a.start_at),
      reason: 'RAIN',
    })
    expect(bad.statusCode).toBe(400)
    const foreign = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [other.courtId],
      from: iso(a.start_at),
      to: iso(a.end_at),
      reason: 'RAIN',
    })
    expect(foreign.statusCode).toBe(404)
    const tournament = await callKeyed(app, 'POST', `${base()}/blocks`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(a.start_at),
      to: iso(a.end_at),
      reason: 'TOURNAMENT',
    })
    expect(tournament.statusCode).toBe(400) // only the tournament service may reserve for a tournament
    expect((await slotRow(a.id)).status).toBe('AVAILABLE')
  })
})

describe('outage / rain lock', () => {
  /** Two app bookings (one spans out of the window), a walk-in, a live hold and free hours in a window. */
  async function scene() {
    const hs = await pickSlots(app.prisma, fx.courtId, 8, { dayOffset: nextDay() })
    const p1 = await makeUser(app)
    const p2 = await makeUser(app)
    const book = async (p: { accessToken: string }, ids: string[]) => {
      const h = (await holdHours(app, p.accessToken, fx.courtId, ids)).json().data
      const c = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(c.statusCode).toBe(200)
      return h.id as string
    }
    const b1 = await book(p1, [hs[1].id]) // inside the window
    const b2 = await book(p2, [hs[0].id]) // before the window
    const p3 = await makeUser(app)
    const b3 = await book(p3, [hs[2].id, hs[3].id]) // both inside
    const walk = (await walkIn([hs[4].id])).json().data.id as string
    const p4 = await makeUser(app)
    await holdHours(app, p4.accessToken, fx.courtId, [hs[5].id])
    return {
      hs,
      p1,
      p2,
      p3,
      b1,
      b2,
      b3,
      walk,
      window: { from: iso(hs[1].start_at), to: iso(hs[6].end_at) },
    }
  }

  it('previews the impact before anything happens', async () => {
    const s = await scene()
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/outage-lock/preview`,
      fx.manager.accessToken,
      { courtIds: [fx.courtId], ...s.window },
    )
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.appBookings).toBe(2) // b1 and b3 (b2 is before the window)
    expect(d.players).toBe(2)
    expect(d.manualToCall).toHaveLength(1)
    expect(d.manualToCall[0].bookingId).toBe(s.walk)
    expect(d.freeHoursToBlock).toBe(1) // only the last hour of the window is free
    // nothing changed
    expect((await slotRow(s.hs[1].id)).status).toBe('BOOKED_APP')
  })

  it('cancels affected app bookings with a full refund, blocks the window, keeps walk-ins for a phone call, shows progress', async () => {
    const s = await scene()
    const key = newKey()
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/outage-lock`,
      fx.manager.accessToken,
      { courtIds: [fx.courtId], ...s.window, reason: 'POWER_OUTAGE', note: 'transformer' },
      key,
    )
    expect(r.statusCode).toBe(202)
    const lockId = r.json().data.id as string
    expect(r.json().data.totalBookings).toBe(2)
    await app.booking.idle()

    const lock = (
      await call(app, 'GET', `${base()}/outage-lock/${lockId}`, fx.manager.accessToken)
    ).json().data
    expect(lock.status).toBe('ACTIVE')
    expect(lock.processed).toBe(2)
    expect(lock.failed).toBe(0)
    expect(lock.progress).toBe('2 of 2 players handled')
    expect(lock.manualToCall.map((m: { bookingId: string }) => m.bookingId)).toEqual([s.walk])

    for (const id of [s.b1, s.b3]) {
      const b = await booking(id)
      expect(b.status).toBe('CANCELLED_BY_VENUE')
    }
    expect((await booking(s.b2)).status).toBe('CONFIRMED') // before the window: untouched
    expect((await booking(s.walk)).status).toBe('CONFIRMED') // walk-ins are never cancelled automatically
    for (const i of [1, 2, 3, 6]) {
      const st = await slotRow(s.hs[i].id)
      expect(st.status).toBe('BLOCKED')
      expect(st.block_reason).toBe('POWER_OUTAGE')
      expect(st.block_ref).toBe(lockId)
    }
    expect((await slotRow(s.hs[4].id)).status).toBe('BOOKED_WALKIN')
    expect((await slotRow(s.hs[5].id)).status).toBe('HELD') // a live hold is left to expire
    expect((await slotRow(s.hs[0].id)).status).toBe('BOOKED_APP')
    const evs = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'BookingItemCancelled' AND payload->'data'->>'bookingId' = ANY(${[s.b1, s.b3]}::text[])`
    expect(evs[0].n).toBe(2)
    expect((await app.prisma.outageLock.findUnique({ where: { id: lockId } }))!.processed).toBe(2)
    await assertInventoryInvariants(app.prisma, [fx.courtId])

    // the same request again (same key) returns the same lock, nothing is processed twice
    const replay = await callKeyed(
      app,
      'POST',
      `${base()}/outage-lock`,
      fx.manager.accessToken,
      { courtIds: [fx.courtId], ...s.window, reason: 'POWER_OUTAGE', note: 'transformer' },
      key,
    )
    expect(replay.json().data.id).toBe(lockId)

    // release when resolved: blocked hours reopen, cancelled bookings stay cancelled
    const rel = await call(app, 'DELETE', `${base()}/outage-lock/${lockId}`, fx.manager.accessToken)
    expect(rel.statusCode).toBe(200)
    expect(rel.json().data.status).toBe('RELEASED')
    expect((await slotRow(s.hs[1].id)).status).toBe('AVAILABLE')
    expect((await slotRow(s.hs[6].id)).status).toBe('AVAILABLE')
    expect((await booking(s.b1)).status).toBe('CANCELLED_BY_VENUE')
    expect((await slotRow(s.hs[4].id)).status).toBe('BOOKED_WALKIN')
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  })

  it('an outage in the middle of a longer booking cancels only the hours inside the window', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 4, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const h = (
      await holdHours(
        app,
        p.accessToken,
        fx.courtId,
        hs.map((x) => x.id),
      )
    ).json().data
    await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken)
    const r = await callKeyed(app, 'POST', `${base()}/outage-lock`, fx.manager.accessToken, {
      courtIds: [fx.courtId],
      from: iso(hs[1].start_at),
      to: iso(hs[2].end_at),
      reason: 'RAIN',
    })
    expect(r.statusCode).toBe(202)
    await app.booking.idle()
    const items = await app.prisma.$queryRaw<
      { slot_id: string; status: string }[]
    >`SELECT slot_id, status FROM booking_items WHERE booking_id = ${h.id}::uuid ORDER BY start_at`
    expect(items.map((i) => i.status)).toEqual(['CONFIRMED', 'CANCELLED', 'CANCELLED', 'CONFIRMED'])
    const b = await app.prisma.$queryRaw<
      { status: string; total_minor: bigint }[]
    >`SELECT status, total_minor FROM bookings WHERE id = ${h.id}::uuid`
    expect(b[0].status).toBe('CONFIRMED')
    expect(b[0].total_minor).toBe(hs[0].price_minor + hs[3].price_minor)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  })

  it('an interrupted job is resumed by the worker and never refunds twice', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const h = (await holdHours(app, p.accessToken, fx.courtId, [hs[0].id])).json().data
    await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken)
    // the API died right after creating the lock: the row says PROCESSING, nothing was cancelled yet
    const lockId = newUuidKey()
    await app.prisma.outageLock.create({
      data: {
        id: lockId,
        venueId: fx.venueId,
        courtIds: [fx.courtId],
        windowStart: hs[0].start_at,
        windowEnd: hs[1].end_at,
        reason: 'RAIN',
        status: 'PROCESSING',
        totalBookings: 1,
        createdBy: fx.manager.id,
        createdAt: new Date(Date.now() - 120_000),
      },
    })
    const jobs = createBookingJobs(app.prisma, app.hotLane)
    const t1 = await jobs.tick()
    expect(t1.resumedOutages).toBeGreaterThanOrEqual(1)
    expect((await booking(h.id)).status).toBe('CANCELLED_BY_VENUE')
    expect((await app.prisma.outageLock.findUnique({ where: { id: lockId } }))!.status).toBe(
      'ACTIVE',
    )
    // two workers resuming at the same time still cancel once
    const lock2 = newUuidKey()
    const h2 = (await holdHours(app, p.accessToken, fx.courtId, [hs[2].id])).json().data
    await callKeyed(app, 'POST', `/api/v1/bookings/${h2.id}/confirm-pay-at-venue`, p.accessToken)
    await app.prisma.outageLock.create({
      data: {
        id: lock2,
        venueId: fx.venueId,
        courtIds: [fx.courtId],
        windowStart: hs[2].start_at,
        windowEnd: hs[2].end_at,
        reason: 'RAIN',
        status: 'PROCESSING',
        totalBookings: 1,
        createdBy: fx.manager.id,
      },
    })
    await Promise.all([app.booking.outage.process(lock2), app.booking.outage.process(lock2)])
    const evs = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'BookingItemCancelled' AND payload->'data'->>'bookingId' = ${h2.id}`
    expect(evs[0].n).toBe(1)
  })

  it('cannot release while players are still being handled, and needs manager rights', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const lockId = newUuidKey()
    await app.prisma.outageLock.create({
      data: {
        id: lockId,
        venueId: fx.venueId,
        courtIds: [fx.courtId],
        windowStart: a.start_at,
        windowEnd: a.end_at,
        reason: 'RAIN',
        status: 'PROCESSING',
        totalBookings: 1,
        createdBy: fx.manager.id,
      },
    })
    const r = await call(app, 'DELETE', `${base()}/outage-lock/${lockId}`, fx.manager.accessToken)
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('OUTAGE_STILL_PROCESSING')
    expect(
      (await call(app, 'DELETE', `${base()}/outage-lock/${lockId}`, fx.frontDesk.accessToken))
        .statusCode,
    ).toBe(403)
    expect(
      (
        await call(
          app,
          'GET',
          `/api/v1/pos/venues/${other.venueId}/outage-lock/${lockId}`,
          other.owner.accessToken,
        )
      ).statusCode,
    ).toBe(404)
  })
})

describe('check-in with the QR pass or the booking code', () => {
  async function confirmedPlayerBooking(startsInMinutes: number) {
    const court = nextTimeCourt() // its own court: moved-to-now bookings must not overlap each other
    const [a] = await pickSlots(app.prisma, court, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const h = (await holdHours(app, p.accessToken, court, [a.id])).json().data
    const c = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
      p.accessToken,
    )
    expect(c.statusCode).toBe(200)
    await moveBookingTime(app.prisma, h.id, new Date(Date.now() + startsInMinutes * 60_000))
    const pass = (await call(app, 'GET', `/api/v1/bookings/${h.id}/pass`, p.accessToken)).json()
      .data
    return {
      id: h.id as string,
      ref: h.ref as string,
      token: pass.token as string,
      player: p,
      total: Number(a.price_minor),
    }
  }

  it('checks in with the QR token, returns the balance to collect, and is idempotent', async () => {
    const b = await confirmedPlayerBooking(20)
    const r = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      token: b.token,
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.replayed).toBe(false)
    expect(r.json().data.booking.status).toBe('CHECKED_IN')
    expect(r.json().data.balanceDueMinor).toBe(b.total)
    const again = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      token: b.token,
    })
    expect(again.statusCode).toBe(200)
    expect(again.json().data.replayed).toBe(true)
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'booking.checked_in' AND payload->'data'->>'bookingId' = ${b.id}`
    expect(ev[0].n).toBe(1)
    // collect the cash on arrival
    const pay = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${b.id}/collect-balance`,
      fx.frontDesk.accessToken,
      { amountMinor: b.total },
    )
    expect(pay.json().data.balanceDueMinor).toBe(0)
    // a checked-in booking can no longer be cancelled by the player
    const cancel = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${b.id}/cancel`,
      b.player.accessToken,
      {},
      newUuidKey(),
    )
    expect(cancel.statusCode).toBe(409)
    expect(cancel.json().code).toBe('BOOKING_NOT_CANCELLABLE')
  })

  it('also works with the short booking code (when the phone has no signal), and by booking id', async () => {
    const b = await confirmedPlayerBooking(10)
    const r = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      ref: b.ref.toLowerCase(),
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.booking.status).toBe('CHECKED_IN')
    const b2 = await confirmedPlayerBooking(10)
    const byId = await call(
      app,
      'POST',
      `${base()}/bookings/${b2.id}/check-in`,
      fx.frontDesk.accessToken,
      { token: b2.token },
    )
    expect(byId.statusCode).toBe(200)
  })

  it('rejects a pass from another venue, a pass for another booking, a tampered pass, and garbage', async () => {
    const b = await confirmedPlayerBooking(10)
    const b2 = await confirmedPlayerBooking(10)
    const otherVenue = await call(
      app,
      'POST',
      `/api/v1/pos/venues/${other.venueId}/check-in`,
      other.frontDesk.accessToken,
      { token: b.token },
    )
    expect(otherVenue.statusCode).toBe(403)
    expect(otherVenue.json().code).toBe('PASS_WRONG_VENUE')
    const mismatch = await call(
      app,
      'POST',
      `${base()}/bookings/${b2.id}/check-in`,
      fx.frontDesk.accessToken,
      { token: b.token },
    )
    expect(mismatch.statusCode).toBe(403)
    expect(mismatch.json().code).toBe('PASS_MISMATCH')
    const parts = b.token.split('.')
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), bid: b2.id })).toString('base64url')}.${parts[2]}`
    for (const bad of [forged, 'garbage', b.token.slice(0, -3) + 'abc']) {
      const r = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
        token: bad,
      })
      expect(r.statusCode).toBe(409)
      expect(r.json().code).toBe('PASS_INVALID')
    }
    expect((await booking(b.id)).status).toBe('CONFIRMED')
    expect(
      (await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {})).statusCode,
    ).toBe(400)
    expect(
      (
        await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
          ref: 'KHI-ZZZZZ',
        })
      ).statusCode,
    ).toBe(404)
  })

  it('opens 2 hours before the start and not earlier', async () => {
    const early = await confirmedPlayerBooking(130)
    const r1 = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      token: early.token,
    })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().code).toBe('PASS_NOT_YET_VALID') // the pass itself is not valid before the window opens
    // the short code has no time limit of its own, so the booking window applies
    const byCode = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      ref: early.ref,
    })
    expect(byCode.statusCode).toBe(409)
    expect(byCode.json().code).toBe('OUTSIDE_CHECKIN_WINDOW')
    const ok = await confirmedPlayerBooking(110)
    expect(
      (await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, { token: ok.token }))
        .statusCode,
    ).toBe(200)
    const tomorrowBooking = await confirmedPlayerBooking(60 * 24)
    expect(
      (
        await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
          ref: tomorrowBooking.ref,
        })
      ).statusCode,
    ).toBe(409)
  })

  it('is for staff, and a cancelled booking cannot be checked in', async () => {
    const b = await confirmedPlayerBooking(10)
    expect(
      (await call(app, 'POST', `${base()}/check-in`, b.player.accessToken, { token: b.token }))
        .statusCode,
    ).toBe(403)
    await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${b.id}/cancel`,
      b.player.accessToken,
      {},
      newUuidKey(),
    )
    const r = await call(app, 'POST', `${base()}/check-in`, fx.frontDesk.accessToken, {
      token: b.token,
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('BOOKING_NOT_CONFIRMED')
  })
})

describe('no-show', () => {
  async function started(minutesAgo: number) {
    const court = nextTimeCourt()
    const [a] = await pickSlots(app.prisma, court, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const h = (await holdHours(app, p.accessToken, court, [a.id])).json().data
    await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken)
    await moveBookingTime(app.prisma, h.id, new Date(Date.now() - minutesAgo * 60_000))
    return { id: h.id as string, player: p }
  }

  it('can be marked 20 minutes after the start, strikes the player, and is idempotent', async () => {
    const early = await started(10)
    const tooSoon = await call(
      app,
      'POST',
      `${base()}/bookings/${early.id}/no-show`,
      fx.frontDesk.accessToken,
    )
    expect(tooSoon.statusCode).toBe(409)
    expect(tooSoon.json().code).toBe('TOO_EARLY_FOR_NO_SHOW')

    const b = await started(25)
    const list = (
      await call(
        app,
        'GET',
        `${base()}/bookings?status=CONFIRMED&limit=100`,
        fx.frontDesk.accessToken,
      )
    ).json().data
    expect(list.find((x: { id: string }) => x.id === b.id).likelyNoShow).toBe(true)
    expect(list.find((x: { id: string }) => x.id === early.id).likelyNoShow).toBe(false)

    const r = await call(
      app,
      'POST',
      `${base()}/bookings/${b.id}/no-show`,
      fx.frontDesk.accessToken,
    )
    expect(r.statusCode).toBe(200)
    expect(r.json().data.booking.status).toBe('NO_SHOW')
    expect((await app.prisma.user.findUnique({ where: { id: b.player.id } }))!.noShowCount).toBe(1)
    const again = await call(
      app,
      'POST',
      `${base()}/bookings/${b.id}/no-show`,
      fx.frontDesk.accessToken,
    )
    expect(again.json().data.replayed).toBe(true)
    expect((await app.prisma.user.findUnique({ where: { id: b.player.id } }))!.noShowCount).toBe(1) // not counted twice
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'booking.no_show' AND payload->'data'->>'bookingId' = ${b.id}`
    expect(ev[0].n).toBe(1)
    // a no-show cannot then be checked in
    const ci = await call(
      app,
      'POST',
      `${base()}/bookings/${b.id}/check-in`,
      fx.frontDesk.accessToken,
      {},
    )
    expect(ci.statusCode).toBe(409)
    expect(ci.json().code).toBe('BOOKING_NOT_CONFIRMED')
  })

  it('only a confirmed booking can be a no-show', async () => {
    const b = await started(30)
    await call(app, 'POST', `${base()}/bookings/${b.id}/check-in`, fx.frontDesk.accessToken, {
      ref: (await app.prisma.booking.findUnique({ where: { id: b.id } }))!.ref,
    })
    const r = await call(
      app,
      'POST',
      `${base()}/bookings/${b.id}/no-show`,
      fx.frontDesk.accessToken,
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('BOOKING_NOT_CONFIRMED')
  })
})

describe('day list and search', () => {
  it('filters by date, status and text, escapes wildcards, and pages', async () => {
    const f = await buildFixture(app)
    const d = nextDay()
    const hs = await pickSlots(app.prisma, f.courtId, 4, { dayOffset: d })
    const date = hs[0].business_date.toISOString().slice(0, 10)
    const wi = (slot: string, name: string, phone: string, key = newKey()) =>
      callKeyed(
        app,
        'POST',
        `/api/v1/pos/venues/${f.venueId}/walkins`,
        f.frontDesk.accessToken,
        { courtId: f.courtId, slotIds: [slot], customerName: name, customerPhone: phone },
        key,
      )
    const a = (await wi(hs[0].id, 'Ali Khan', '03001110001')).json().data
    await wi(hs[1].id, 'Sara Ahmed', '03001110002')
    await wi(hs[2].id, '100% Fan', '03001110003')
    const cancelMe = (await wi(hs[3].id, 'Zed Zafar', '03001110004')).json().data
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${f.venueId}/bookings/${cancelMe.id}/cancel`,
      f.manager.accessToken,
      {},
      newUuidKey(),
    )

    const url = (q: string) => `/api/v1/pos/venues/${f.venueId}/bookings?date=${date}&${q}`
    const names = async (q: string) =>
      (await call(app, 'GET', url(q), f.frontDesk.accessToken))
        .json()
        .data.map((x: { customerName: string }) => x.customerName)
    expect((await names('limit=50')).sort()).toEqual([
      '100% Fan',
      'Ali Khan',
      'Sara Ahmed',
      'Zed Zafar',
    ])
    expect(await names('status=CANCELLED_BY_VENUE')).toEqual(['Zed Zafar'])
    expect(await names('q=sara')).toEqual(['Sara Ahmed'])
    expect(await names('q=1110001')).toEqual(['Ali Khan'])
    expect(await names(`q=${a.ref}`)).toEqual(['Ali Khan'])
    expect(await names('q=%25')).toEqual(['100% Fan']) // a literal percent sign, not "match everything"
    expect(await names('q=_')).toEqual([]) // an underscore is not a wildcard either
    const paged = (await call(app, 'GET', url('limit=2&offset=0'), f.frontDesk.accessToken)).json()
    expect(paged.data).toHaveLength(2)
    expect(paged.meta.total).toBe(4)
    // another venue's staff see nothing of this
    expect((await call(app, 'GET', url(''), fx.frontDesk.accessToken)).statusCode).toBe(403)
  })
})

describe('cancelling from the POS', () => {
  it('a manager can cancel a booking, a front desk cannot, and the hour reopens', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await walkIn([a.id])).json().data
    const key = newUuidKey()
    expect(
      (
        await callKeyed(
          app,
          'POST',
          `${base()}/bookings/${d.id}/cancel`,
          fx.frontDesk.accessToken,
          {},
          key,
        )
      ).statusCode,
    ).toBe(403)
    expect((await slotRow(a.id)).status).toBe('BOOKED_WALKIN')
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/cancel`,
      fx.manager.accessToken,
      { reason: 'customer called' },
      key,
    )
    expect(r.statusCode).toBe(200)
    expect(r.json().data.bookingFullyCancelled).toBe(true)
    expect(r.json().data.booking.status).toBe('CANCELLED_BY_VENUE')
    expect((await slotRow(a.id)).status).toBe('AVAILABLE')
    // another venue's manager cannot touch it
    const hit = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${other.venueId}/bookings/${d.id}/cancel`,
      other.manager.accessToken,
      {},
      newUuidKey(),
    )
    expect(hit.statusCode).toBe(404)
    // a normal (non-UUID) key is refused: cancellations are keyed by UUID
    const badKey = await callKeyed(
      app,
      'POST',
      `${base()}/bookings/${d.id}/cancel`,
      fx.manager.accessToken,
      {},
      'not-a-uuid-key',
    )
    expect(badKey.statusCode).toBe(400)
  })
})

describe('role matrix', () => {
  // every call below is well-formed, so any 403 is the guard talking, not validation
  it('front desk may run the till but not block, lock, cancel or change settings; managers may not change settings; owners can do everything', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const validBlock = {
      courtIds: [fx.courtId],
      from: iso(a.start_at),
      to: iso(a.end_at),
      reason: 'RAIN',
    }
    const anyId = '0198a000-0000-7000-8000-000000000099'
    type Case = {
      name: string
      call: (t: string) => Promise<{ statusCode: number }>
      allow: Array<'frontDesk' | 'manager' | 'owner'>
    }
    const cases: Case[] = [
      {
        name: 'grid',
        call: (t) => call(app, 'GET', `${base()}/grid?date=${tomorrow()}`, t),
        allow: ['frontDesk', 'manager', 'owner'],
      },
      {
        name: 'day list',
        call: (t) => call(app, 'GET', `${base()}/bookings`, t),
        allow: ['frontDesk', 'manager', 'owner'],
      },
      {
        name: 'check-in',
        call: (t) => call(app, 'POST', `${base()}/check-in`, t, { ref: 'KHI-ZZZZZ' }),
        allow: ['frontDesk', 'manager', 'owner'],
      },
      {
        name: 'no-show',
        call: (t) => call(app, 'POST', `${base()}/bookings/${anyId}/no-show`, t),
        allow: ['frontDesk', 'manager', 'owner'],
      },
      {
        name: 'block',
        call: (t) =>
          callKeyed(app, 'POST', `${base()}/blocks`, t, {
            ...validBlock,
            from: iso(new Date(a.start_at.getTime() + 86400000 * 30)),
            to: iso(new Date(a.end_at.getTime() + 86400000 * 30)),
          }),
        allow: ['manager', 'owner'],
      },
      {
        name: 'unblock',
        call: (t) =>
          call(
            app,
            'DELETE',
            `${base()}/blocks?courtIds=${fx.courtId}&from=${encodeURIComponent(iso(a.start_at))}&to=${encodeURIComponent(iso(a.end_at))}`,
            t,
          ),
        allow: ['manager', 'owner'],
      },
      {
        name: 'outage preview',
        call: (t) => callKeyed(app, 'POST', `${base()}/outage-lock/preview`, t, validBlock),
        allow: ['manager', 'owner'],
      },
      {
        name: 'outage list',
        call: (t) => call(app, 'GET', `${base()}/outage-locks`, t),
        allow: ['manager', 'owner'],
      },
      {
        name: 'cancel',
        call: (t) =>
          callKeyed(app, 'POST', `${base()}/bookings/${anyId}/cancel`, t, {}, newUuidKey()),
        allow: ['manager', 'owner'],
      },
      {
        name: 'read settings',
        call: (t) => call(app, 'GET', `${base()}/booking-settings`, t),
        allow: ['manager', 'owner'],
      },
      {
        name: 'change settings',
        call: (t) =>
          call(app, 'PATCH', `${base()}/booking-settings`, t, { payAtVenueEnabled: true }),
        allow: ['owner'],
      },
      {
        name: 'blocklist',
        call: (t) => call(app, 'GET', `${base()}/blocklist`, t),
        allow: ['manager', 'owner'],
      },
    ]
    const tokens = {
      frontDesk: fx.frontDesk.accessToken,
      manager: fx.manager.accessToken,
      owner: fx.owner.accessToken,
    }
    const stranger = await makeUser(app)
    for (const c of cases) {
      for (const role of ['frontDesk', 'manager', 'owner'] as const) {
        const res = await c.call(tokens[role])
        if (c.allow.includes(role)) expect(res.statusCode, `${c.name} as ${role}`).not.toBe(403)
        else expect(res.statusCode, `${c.name} as ${role}`).toBe(403)
        expect(res.statusCode, `${c.name} as ${role}`).not.toBe(401)
      }
      expect((await c.call(stranger.accessToken)).statusCode, `${c.name} as a stranger`).toBe(403)
      expect(
        (await c.call(other.owner.accessToken)).statusCode,
        `${c.name} as another venue's owner`,
      ).toBe(403)
    }
    // anonymous callers get 401 before anything else is looked at
    expect(
      (await app.inject({ method: 'GET', url: `${base()}/grid?date=${tomorrow()}` })).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base()}/outage-lock/preview`,
          payload: validBlock,
        })
      ).statusCode,
    ).toBe(401)
  })
})
