import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REF_PATTERN } from '../src/modules/booking/booking.domain'
import {
  Fixture,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  newKey,
  newUuidKey,
  pickSlots,
  slotsOn,
  tomorrow,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let nextSkip = 0
/** A fresh pair of untouched hours for every test (tomorrow, then later days). */
const fresh = (n = 1) => {
  const skip = nextSkip
  nextSkip += n + 1
  return pickSlots(app.prisma, fx.courtId, n, {
    dayOffset: 2 + Math.floor(skip / 12),
    skip: skip % 12,
  })
}

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
})
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const slotRow = async (id: string) =>
  (
    await app.prisma.$queryRaw<
      {
        status: string
        version: number
        hold_id: string | null
        hold_expires_at: Date | null
        booking_id: string | null
      }[]
    >`SELECT status, version, hold_id, hold_expires_at, booking_id FROM slots WHERE id = ${id}::uuid`
  )[0]

describe('holding hours', () => {
  it('holds two consecutive hours for 5 minutes and prices them on the server', async () => {
    const player = await makeUser(app)
    const [a, b] = await fresh(2)
    const res = await holdHours(app, player.accessToken, fx.courtId, [b.id, a.id]) // order does not matter
    expect(res.statusCode).toBe(201)
    const d = res.json().data
    expect(d.status).toBe('PENDING_PAYMENT')
    expect(d.ref).toMatch(REF_PATTERN)
    expect(d.totalMinor).toBe(Number(a.price_minor + b.price_minor))
    expect(d.secondsRemaining).toBeGreaterThan(295)
    expect(d.secondsRemaining).toBeLessThanOrEqual(300)
    expect(Date.parse(d.holdExpiresAt)).toBeGreaterThan(Date.parse(d.serverNow))
    expect(d.slots.map((s: { slotId: string }) => s.slotId)).toEqual([a.id, b.id])

    for (const s of [a, b]) {
      const r = await slotRow(s.id)
      expect(r.status).toBe('HELD')
      expect(r.version).toBe(s.version + 1)
      expect(r.hold_id).toBeTruthy()
      expect(r.booking_id).toBe(d.id)
    }
    // finding F2: no items at hold time. Finding F3: the intended hours are remembered on the booking
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM booking_items WHERE booking_id = ${d.id}::uuid`
    expect(n).toBe(0)
    const [bk] = await app.prisma.$queryRaw<{ slot_ids: string[]; original_total_minor: bigint }[]>`
      SELECT slot_ids, original_total_minor FROM bookings WHERE id = ${d.id}::uuid`
    expect(bk.slot_ids).toEqual([a.id, b.id])
    expect(bk.original_total_minor).toBe(a.price_minor + b.price_minor)
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'booking.hold_created' AND payload->'data'->>'bookingId' = ${d.id}`
    expect(ev[0].n).toBe(1)
  })

  it('shows a held hour to other players as unavailable and a second player cannot take it', async () => {
    const p1 = await makeUser(app)
    const p2 = await makeUser(app)
    const [a] = await fresh(1)
    expect((await holdHours(app, p1.accessToken, fx.courtId, [a.id])).statusCode).toBe(201)

    const taken = await holdHours(app, p2.accessToken, fx.courtId, [a.id])
    expect(taken.statusCode).toBe(409)
    expect(taken.json().code).toBe('SLOT_UNAVAILABLE')
    // recovery: nearest alternatives of the same length, never the hour that was just taken
    const alts = taken.json().details.alternatives
    expect(alts.length).toBeGreaterThan(0)
    expect(alts.length).toBeLessThanOrEqual(5)
    expect(alts.every((x: { slotIds: string[] }) => !x.slotIds.includes(a.id))).toBe(true)
    expect(alts[0].slotIds).toHaveLength(1)

    const grid = await app.inject({
      method: 'GET',
      url: `/api/v1/public/venues/${fx.venueId}/availability?date=${a.business_date.toISOString().slice(0, 10)}`,
    })
    const s = grid.json().data.slots.find((x: { id: string }) => x.id === a.id)
    expect(s.status).toBe('HELD')
    expect(JSON.stringify(s)).not.toMatch(/bookingId|customer|phone/i)
  })

  it('answers a repeated request (same Idempotency-Key) with the original hold, without holding twice', async () => {
    const p = await makeUser(app)
    const [a] = await fresh(1)
    const key = newKey()
    const first = await holdHours(app, p.accessToken, fx.courtId, [a.id], key)
    const again = await holdHours(app, p.accessToken, fx.courtId, [a.id], key)
    expect(first.statusCode).toBe(201)
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(first.headers['idempotent-replayed']).toBe('false')
    expect(again.json().data.id).toBe(first.json().data.id)
    expect((await slotRow(a.id)).version).toBe(a.version + 1) // changed once, not twice
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM bookings WHERE user_id = ${p.id}::uuid`
    expect(n).toBe(1)
  })

  it('refuses the same key for a different request', async () => {
    const p = await makeUser(app)
    const [a, b] = await fresh(2)
    const key = newKey()
    expect((await holdHours(app, p.accessToken, fx.courtId, [a.id], key)).statusCode).toBe(201)
    const other = await holdHours(app, p.accessToken, fx.courtId, [b.id], key)
    expect(other.statusCode).toBe(409)
    expect(other.json().code).toBe('IDEMPOTENCY_CONFLICT')
    expect((await slotRow(b.id)).status).toBe('AVAILABLE')
  })

  it('20 identical retries in parallel create exactly one hold', async () => {
    const p = await makeUser(app)
    const [a] = await fresh(1)
    const key = newKey()
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => holdHours(app, p.accessToken, fx.courtId, [a.id], key)),
    )
    expect(rs.every((r) => r.statusCode === 201)).toBe(true)
    expect(new Set(rs.map((r) => r.json().data.id)).size).toBe(1)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM bookings WHERE user_id = ${p.id}::uuid`
    expect(n).toBe(1)
    expect((await slotRow(a.id)).version).toBe(a.version + 1)
  })

  it('validates the request', async () => {
    const p = await makeUser(app)
    const [a, b, c] = await fresh(3)
    // not consecutive
    let r = await holdHours(app, p.accessToken, fx.courtId, [a.id, c.id])
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('INVALID_SLOT_SELECTION')
    expect(r.json().details.reason).toBe('NOT_CONSECUTIVE')
    // more than 4 hours
    const day = await slotsOn(app.prisma, fx.courtId, tomorrow())
    r = await holdHours(
      app,
      p.accessToken,
      fx.courtId,
      day.slice(0, 5).map((s) => s.id),
    )
    expect(r.statusCode).toBe(400)
    // no Idempotency-Key
    r = await callKeyed(
      app,
      'POST',
      '/api/v1/bookings/holds',
      p.accessToken,
      { courtId: fx.courtId, slotIds: [a.id] },
      null,
    )
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    // not logged in
    r = await callKeyed(app, 'POST', '/api/v1/bookings/holds', undefined, {
      courtId: fx.courtId,
      slotIds: [a.id],
    })
    expect(r.statusCode).toBe(401)
    // hour that does not exist
    r = await holdHours(app, p.accessToken, fx.courtId, ['0198a000-0000-7000-8000-00000000dead'])
    expect(r.statusCode).toBe(404)
    // wrong court for the hours
    r = await holdHours(app, p.accessToken, '0198a000-0000-7000-8000-00000000beef', [b.id])
    expect(r.statusCode).toBe(400)
    expect(r.json().details.reason).toBe('WRONG_COURT')
    // malformed ids
    r = await holdHours(app, p.accessToken, fx.courtId, ['nope'])
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('VALIDATION_ERROR')
    // an hour in the past
    const [past] = await app.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM slots WHERE court_id = ${fx.courtId}::uuid AND start_at < now() - interval '1 hour' ORDER BY start_at DESC LIMIT 1`
    if (past) {
      r = await holdHours(app, p.accessToken, fx.courtId, [past.id])
      expect(r.statusCode).toBe(400)
      expect(r.json().code).toBe('SLOT_IN_PAST')
    }
    // nothing was held by all those failures
    expect((await slotRow(a.id)).status).toBe('AVAILABLE')
  })

  it('needs a phone number the venue can call', async () => {
    const p = await makeUser(app, { phone: null })
    const [a] = await fresh(1)
    let r = await holdHours(app, p.accessToken, fx.courtId, [a.id])
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('PHONE_REQUIRED')
    r = await callKeyed(app, 'POST', '/api/v1/bookings/holds', p.accessToken, {
      courtId: fx.courtId,
      slotIds: [a.id],
      customerPhone: '+923001112233',
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().data.customerPhone).toBe('+923001112233')
  })

  it('limits a player to 2 pending holds, and a freed hold makes room', async () => {
    const p = await makeUser(app)
    const [a, b, c] = await fresh(3)
    const h1 = await holdHours(app, p.accessToken, fx.courtId, [a.id])
    expect((await holdHours(app, p.accessToken, fx.courtId, [b.id])).statusCode).toBe(201)
    const third = await holdHours(app, p.accessToken, fx.courtId, [c.id])
    expect(third.statusCode).toBe(409)
    expect(third.json().code).toBe('TOO_MANY_HOLDS')
    expect((await slotRow(c.id)).status).toBe('AVAILABLE')
    await call(app, 'DELETE', `/api/v1/bookings/${h1.json().data.id}/hold`, p.accessToken)
    expect((await holdHours(app, p.accessToken, fx.courtId, [c.id])).statusCode).toBe(201)
  })

  it('parallel requests from one player cannot get past the 2-hold limit', async () => {
    const p = await makeUser(app)
    const hs = await fresh(5)
    const rs = await Promise.all(hs.map((h) => holdHours(app, p.accessToken, fx.courtId, [h.id])))
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(2)
    expect(
      rs.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'TOO_MANY_HOLDS'),
    ).toBe(true)
  })

  it('a venue can block a phone number from booking', async () => {
    const p = await makeUser(app, { phone: '+923005550001' })
    const [a] = await fresh(1)
    const add = await call(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/blocklist`,
      fx.manager.accessToken,
      { phone: '0300 5550001', reason: 'no-shows' },
    )
    expect(add.statusCode).toBe(201)
    const r = await holdHours(app, p.accessToken, fx.courtId, [a.id])
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('BLOCKED_BY_VENUE')
    expect((await slotRow(a.id)).status).toBe('AVAILABLE')
    const del = await call(
      app,
      'DELETE',
      `/api/v1/pos/venues/${fx.venueId}/blocklist/${encodeURIComponent('+923005550001')}`,
      fx.manager.accessToken,
    )
    expect(del.statusCode).toBe(200)
    expect((await holdHours(app, p.accessToken, fx.courtId, [a.id])).statusCode).toBe(201)
  })
})

describe('API documentation', () => {
  it('shows the Idempotency-Key header on the endpoints that need it, without changing validation', async () => {
    const doc = (await app.inject({ method: 'GET', url: '/docs/json' })).json()
    const holds = doc.paths['/api/v1/bookings/holds'].post
    const header = holds.parameters.find(
      (p: { in: string; name: string }) => p.in === 'header' && p.name === 'Idempotency-Key',
    )
    expect(header).toMatchObject({ required: true })
    const cancel = doc.paths['/api/v1/bookings/{id}/cancel'].post
    expect(
      cancel.parameters.some(
        (p: { name: string; description: string }) =>
          p.name === 'Idempotency-Key' && /UUID/.test(p.description),
      ),
    ).toBe(true)
    expect(
      doc.paths['/api/v1/pos/venues/{venueId}/walkins'].post.parameters.some(
        (p: { name: string }) => p.name === 'Idempotency-Key',
      ),
    ).toBe(true)
    // endpoints that do not take a key are untouched
    const grid = doc.paths['/api/v1/pos/venues/{venueId}/grid'].get
    expect(
      (grid.parameters ?? []).some((p: { name: string }) => p.name === 'Idempotency-Key'),
    ).toBe(false)
  })
})

describe('releasing and expiry', () => {
  it('releasing a hold frees the hours at once and bumps their version', async () => {
    const p = await makeUser(app)
    const [a, b] = await fresh(2)
    const h = (await holdHours(app, p.accessToken, fx.courtId, [a.id, b.id])).json().data
    const del = await call(app, 'DELETE', `/api/v1/bookings/${h.id}/hold`, p.accessToken)
    expect(del.statusCode).toBe(200)
    expect(del.json().data.status).toBe('EXPIRED')
    for (const s of [a, b]) {
      const r = await slotRow(s.id)
      expect(r.status).toBe('AVAILABLE')
      expect(r.version).toBe(s.version + 2) // held, then freed: every transition counts
      expect(r.hold_id).toBeNull()
    }
    // releasing again changes nothing
    const again = await call(app, 'DELETE', `/api/v1/bookings/${h.id}/hold`, p.accessToken)
    expect(again.statusCode).toBe(200)
    expect((await slotRow(a.id)).version).toBe(a.version + 2)
    // and someone else can have them now
    const p2 = await makeUser(app)
    expect((await holdHours(app, p2.accessToken, fx.courtId, [a.id, b.id])).statusCode).toBe(201)
  })

  it("nobody can release another player's hold", async () => {
    const p1 = await makeUser(app)
    const p2 = await makeUser(app)
    const [a] = await fresh(1)
    const h = (await holdHours(app, p1.accessToken, fx.courtId, [a.id])).json().data
    const del = await call(app, 'DELETE', `/api/v1/bookings/${h.id}/hold`, p2.accessToken)
    expect(del.statusCode).toBe(404)
    expect((await slotRow(a.id)).status).toBe('HELD')
  })

  it('an expired hold is free immediately, with the sweeper switched off (lazy reclaim)', async () => {
    const p1 = await makeUser(app)
    const p2 = await makeUser(app)
    const [a, b] = await fresh(2)
    const h = (await holdHours(app, p1.accessToken, fx.courtId, [a.id, b.id])).json().data
    // time passes: the hold runs out. No job, no sweeper, nothing else runs.
    await app.prisma
      .$executeRaw`UPDATE slots SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE booking_id = ${h.id}::uuid`
    await app.prisma
      .$executeRaw`UPDATE bookings SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h.id}::uuid`
    expect((await slotRow(a.id)).status).toBe('HELD') // the row still says HELD

    // reads already treat it as free
    const date = a.business_date.toISOString().slice(0, 10)
    const grid = await app.inject({
      method: 'GET',
      url: `/api/v1/public/venues/${fx.venueId}/availability?date=${date}`,
    })
    expect(grid.json().data.slots.find((x: { id: string }) => x.id === a.id).status).toBe(
      'AVAILABLE',
    )
    // the owner's view of the booking says expired
    const mine = await call(app, 'GET', `/api/v1/bookings/${h.id}`, p1.accessToken)
    expect(mine.json().data.status).toBe('EXPIRED')
    expect(mine.json().data.holdExpiresAt).toBeNull()
    const upcoming = await call(app, 'GET', '/api/v1/me/bookings?tab=upcoming', p1.accessToken)
    expect(upcoming.json().data).toHaveLength(0)
    const cancelled = await call(app, 'GET', '/api/v1/me/bookings?tab=cancelled', p1.accessToken)
    expect(cancelled.json().data.map((x: { id: string }) => x.id)).toContain(h.id)

    // and another player can take them straight away
    const take = await holdHours(app, p2.accessToken, fx.courtId, [a.id, b.id])
    expect(take.statusCode).toBe(201)
    // the old booking was closed in the same transaction
    const [old] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM bookings WHERE id = ${h.id}::uuid`
    expect(old.status).toBe('EXPIRED')
    // the first player cannot confirm any more
    const confirm = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
      p1.accessToken,
    )
    expect([403, 409]).toContain(confirm.statusCode)
  })

  it('the sweeper frees expired hours, closes the pending bookings and announces it', async () => {
    const p = await makeUser(app)
    const [a] = await fresh(1)
    const h = (await holdHours(app, p.accessToken, fx.courtId, [a.id])).json().data
    await app.prisma
      .$executeRaw`UPDATE slots SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE booking_id = ${h.id}::uuid`
    await app.prisma
      .$executeRaw`UPDATE bookings SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h.id}::uuid`
    const r = await app.booking.slots.sweep()
    expect(r.released).toBeGreaterThanOrEqual(1)
    expect(r.expiredBookings).toBeGreaterThanOrEqual(1)
    const s = await slotRow(a.id)
    expect(s.status).toBe('AVAILABLE')
    expect(s.hold_id).toBeNull()
    expect(s.version).toBe(a.version + 2)
    const [bk] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM bookings WHERE id = ${h.id}::uuid`
    expect(bk.status).toBe('EXPIRED')
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'booking.hold_expired' AND payload->'data'->>'bookingId' = ${h.id}`
    expect(ev[0].n).toBe(1)
    // running it again is harmless
    const again = await app.booking.slots.sweep()
    expect(again.expiredBookings).toBe(0)
  })

  it('a live hold is not touched by the sweeper', async () => {
    const p = await makeUser(app)
    const [a] = await fresh(1)
    await holdHours(app, p.accessToken, fx.courtId, [a.id])
    await app.booking.slots.sweep()
    expect((await slotRow(a.id)).status).toBe('HELD')
  })
})

describe('pilot mode: reserve and pay at venue', () => {
  it('is off by default', async () => {
    const f = await buildFixture(app)
    const p = await makeUser(app)
    const [a] = await pickSlots(app.prisma, f.courtId, 1)
    const h = (await holdHours(app, p.accessToken, f.courtId, [a.id])).json().data
    const r = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
      p.accessToken,
    )
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('PAY_AT_VENUE_DISABLED')
    expect((await slotRow(a.id)).status).toBe('HELD')
  })

  it('only the owner can switch it on, and the change is audited', async () => {
    const f = await buildFixture(app)
    const url = `/api/v1/pos/venues/${f.venueId}/booking-settings`
    expect(
      (await call(app, 'PATCH', url, f.manager.accessToken, { payAtVenueEnabled: true }))
        .statusCode,
    ).toBe(403)
    expect(
      (await call(app, 'PATCH', url, f.frontDesk.accessToken, { payAtVenueEnabled: true }))
        .statusCode,
    ).toBe(403)
    const ok = await call(app, 'PATCH', url, f.owner.accessToken, { payAtVenueEnabled: true })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.payAtVenueEnabled).toBe(true)
    expect((await call(app, 'GET', url, f.manager.accessToken)).json().data.payAtVenueEnabled).toBe(
      true,
    )
    const a = await app.prisma.auditLog.findMany({
      where: { venueId: f.venueId, action: 'BOOKING_SETTINGS_CHANGED' },
    })
    expect(a).toHaveLength(1)
  })

  describe('with the flag on', () => {
    let f: Fixture
    beforeAll(async () => {
      f = await buildFixture(app)
      await call(
        app,
        'PATCH',
        `/api/v1/pos/venues/${f.venueId}/booking-settings`,
        f.owner.accessToken,
        { payAtVenueEnabled: true },
      )
    })

    it('turns a hold into a confirmed booking: hours booked, items created, balance due = total', async () => {
      const p = await makeUser(app)
      const [a, b] = await pickSlots(app.prisma, f.courtId, 2)
      const h = (await holdHours(app, p.accessToken, f.courtId, [a.id, b.id])).json().data
      const key = newKey()
      const r = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p.accessToken,
        undefined,
        key,
      )
      expect(r.statusCode).toBe(200)
      const d = r.json().data
      expect(d.status).toBe('CONFIRMED')
      expect(d.paymentMode).toBe('CASH_ONLY')
      expect(d.balanceDueMinor).toBe(d.totalMinor)
      expect(d.holdExpiresAt).toBeNull()
      expect(d.items).toHaveLength(2)
      expect(d.items.reduce((s: number, i: { priceMinor: number }) => s + i.priceMinor, 0)).toBe(
        d.totalMinor,
      )
      for (const s of [a, b]) {
        const row = await slotRow(s.id)
        expect(row.status).toBe('BOOKED_APP')
        expect(row.hold_id).toBeNull()
        expect(row.booking_id).toBe(h.id)
      }
      // repeating the confirmation is a no-op that returns the same booking and emits one event
      const again = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p.accessToken,
        undefined,
        key,
      )
      expect(again.statusCode).toBe(200)
      expect(again.headers['idempotent-replayed']).toBe('true')
      const ev = await app.prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'booking.confirmed' AND payload->'data'->>'bookingId' = ${h.id}`
      expect(ev[0].n).toBe(1)
      // a different key after it is confirmed: not pending any more
      const third = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(third.statusCode).toBe(409)
      expect(third.json().code).toBe('BOOKING_NOT_PENDING')
    })

    it('allows only one unpaid booking per player; paying at the venue lifts the limit', async () => {
      const p = await makeUser(app)
      const [a, b] = await pickSlots(app.prisma, f.courtId, 2, { dayOffset: 3 })
      const h1 = (await holdHours(app, p.accessToken, f.courtId, [a.id])).json().data
      const h2 = (await holdHours(app, p.accessToken, f.courtId, [b.id])).json().data
      const c1 = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h1.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(c1.statusCode).toBe(200)
      const c2 = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h2.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(c2.statusCode).toBe(409)
      expect(c2.json().code).toBe('UNPAID_LIMIT_REACHED')
      expect((await slotRow(b.id)).status).toBe('HELD') // still held, can be confirmed once the first is paid
      // staff collect the whole balance
      const collect = await callKeyed(
        app,
        'POST',
        `/api/v1/pos/venues/${f.venueId}/bookings/${h1.id}/collect-balance`,
        f.frontDesk.accessToken,
        {
          amountMinor: c1.json().data.totalMinor,
        },
      )
      expect(collect.statusCode).toBe(200)
      expect(collect.json().data.balanceDueMinor).toBe(0)
      expect(collect.json().data.paymentStatus).toBe('PAID')
      const c3 = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h2.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(c3.statusCode).toBe(200)
    })

    it('the unpaid limit also holds under parallel confirmations', async () => {
      const p = await makeUser(app)
      const slots = await pickSlots(app.prisma, f.courtId, 2, { dayOffset: 4 })
      const hs = await Promise.all(
        slots.map(
          async (s) => (await holdHours(app, p.accessToken, f.courtId, [s.id])).json().data,
        ),
      )
      const rs = await Promise.all(
        hs.map((h) =>
          callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, p.accessToken),
        ),
      )
      expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1)
      expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(1)
    })

    it('refuses a confirmation after the hold ran out', async () => {
      const p = await makeUser(app)
      const [a] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: 5 })
      const h = (await holdHours(app, p.accessToken, f.courtId, [a.id])).json().data
      await app.prisma
        .$executeRaw`UPDATE slots SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE booking_id = ${h.id}::uuid`
      await app.prisma
        .$executeRaw`UPDATE bookings SET hold_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h.id}::uuid`
      const r = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p.accessToken,
      )
      expect(r.statusCode).toBe(409)
      expect(r.json().code).toBe('HOLD_EXPIRED')
      expect((await slotRow(a.id)).status).toBe('HELD') // untouched until reclaimed
    })

    it("cannot confirm somebody else's hold", async () => {
      const p1 = await makeUser(app)
      const p2 = await makeUser(app)
      const [a] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: 6 })
      const h = (await holdHours(app, p1.accessToken, f.courtId, [a.id])).json().data
      const r = await callKeyed(
        app,
        'POST',
        `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
        p2.accessToken,
      )
      expect(r.statusCode).toBe(404)
    })
  })
})

describe('my bookings', () => {
  it('lists upcoming, past and cancelled bookings and hides other players', async () => {
    const f = await buildFixture(app)
    await call(
      app,
      'PATCH',
      `/api/v1/pos/venues/${f.venueId}/booking-settings`,
      f.owner.accessToken,
      { payAtVenueEnabled: true },
    )
    const p = await makeUser(app)
    const other = await makeUser(app)
    const [a, b] = await pickSlots(app.prisma, f.courtId, 2, { dayOffset: 2 })
    const h1 = (await holdHours(app, p.accessToken, f.courtId, [a.id])).json().data
    const h2 = (await holdHours(app, p.accessToken, f.courtId, [b.id])).json().data
    expect(
      (
        await callKeyed(
          app,
          'POST',
          `/api/v1/bookings/${h1.id}/confirm-pay-at-venue`,
          p.accessToken,
        )
      ).statusCode,
    ).toBe(200)
    expect(
      (await call(app, 'DELETE', `/api/v1/bookings/${h2.id}/hold`, p.accessToken)).statusCode,
    ).toBe(200)

    const up = (await call(app, 'GET', '/api/v1/me/bookings', p.accessToken)).json()
    expect(up.data.map((x: { id: string }) => x.id)).toEqual([h1.id])
    expect(up.data[0].venueName).toBe('Booking Arena')
    expect(up.meta.total).toBe(1)
    const cancelled = (
      await call(app, 'GET', '/api/v1/me/bookings?tab=cancelled', p.accessToken)
    ).json()
    expect(cancelled.data.map((x: { id: string }) => x.id)).toEqual([h2.id])
    const past = (await call(app, 'GET', '/api/v1/me/bookings?tab=past', p.accessToken)).json()
    expect(past.data).toHaveLength(0)

    const detail = await call(app, 'GET', `/api/v1/bookings/${h1.id}`, p.accessToken)
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data.venue.directionsUrl).toMatch(/google\.com\/maps\/dir/)
    expect(detail.json().data.policy.cancellationCutoffHours).toBe(12)
    expect(detail.json().data.items).toHaveLength(1)

    // another player sees nothing and cannot tell the booking exists
    expect(
      (await call(app, 'GET', `/api/v1/bookings/${h1.id}`, other.accessToken)).statusCode,
    ).toBe(404)
    expect(
      (await call(app, 'GET', '/api/v1/me/bookings', other.accessToken)).json().data,
    ).toHaveLength(0)
    expect((await call(app, 'GET', `/api/v1/bookings/${h1.id}`)).statusCode).toBe(401)
  })
})

void newUuidKey
