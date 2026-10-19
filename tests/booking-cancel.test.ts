/**
 * Partial and full cancellation: exact money per hour, the preview matches what really happens,
 * retries are harmless, and a freed middle hour can be sold again.
 *
 * Phase 3 will bring real online payments. Until then the paid / deposit amounts are written
 * straight into the booking (through the real SQL function create_confirmed_items), so the money
 * rules are tested now, exactly as the cancel function will see them later.
 */
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { depositFor } from '../src/lib/money'
import { computeCancelPreview } from '../src/modules/booking/booking.domain'
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
} from './helpers'

let app: FastifyInstance
let fx: Fixture
const courts: string[] = []

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
  for (let i = 0; i < 6; i++) courts.push(await addCourt(app, fx, `Lane ${i}`, false))
  await app.booking.idle()
  await call(
    app,
    'PATCH',
    `/api/v1/pos/venues/${fx.venueId}/booking-settings`,
    fx.owner.accessToken,
    {
      payAtVenueEnabled: true,
    },
  )
}, 90_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const H = 3_600_000
let seq = 0
const money = (n: bigint | number) => Number(n)

/**
 * n consecutive untouched hours on a court. Hours that an earlier test moved to "now" are skipped
 * (they are off the whole-hour grid), so every booking starts from clean inventory.
 */
async function findRun(court: string, n: number) {
  for (let d = 1; d < 58; d++) {
    const rows = await app.prisma.$queryRaw<
      {
        id: string
        start_at: Date
        end_at: Date
        price_minor: bigint
        version: number
        business_date: Date
      }[]
    >`
      SELECT s.id, s.start_at, s.end_at, s.price_minor, s.version, s.business_date FROM slots s
       WHERE s.court_id = ${court}::uuid AND s.business_date = (current_date + ${d}::int) AND s.status = 'AVAILABLE'
         AND EXTRACT(MINUTE FROM s.start_at) = 0 AND EXTRACT(SECOND FROM s.start_at) = 0
         -- a slot that an earlier test moved "to now" would overlap its natural neighbour: skip those
         AND NOT EXISTS (SELECT 1 FROM slots m WHERE m.court_id = s.court_id AND m.id <> s.id
                          AND tstzrange(m.start_at, m.end_at) && tstzrange(s.start_at, s.end_at))
       ORDER BY s.start_at`
    for (let i = 0; i + n <= rows.length; i++) {
      const run = rows.slice(i, i + n)
      if (run.every((r, k) => k === 0 || r.start_at.getTime() === run[k - 1].end_at.getTime()))
        return run
    }
  }
  throw new Error('no clean hours left on court')
}

/** A court with no active booking overlapping the given window (moved-to-now bookings must not clash). */
async function freeCourt(startAt: Date, hours: number): Promise<string> {
  const end = new Date(startAt.getTime() + hours * H)
  for (const c of courts) {
    const [{ n }] = await app.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM booking_items
       WHERE court_id = ${c}::uuid AND status = 'CONFIRMED'
         AND tstzrange(start_at, end_at) && tstzrange(${new Date(startAt.getTime() - H)}, ${new Date(end.getTime() + H)})`
    if (n === 0) return c
  }
  throw new Error('no free court for that time')
}

interface Made {
  id: string
  ref: string
  player: { id: string; accessToken: string }
  itemIds: string[]
  slotIds: string[]
  court: string
  startAt: Date
}

/**
 * A confirmed player booking of `n` hours that starts `startInMin` minutes from now.
 * `prices` sets each hour's price, `paid` / `deposit` (paisa) are what was paid online in total.
 */
async function makeBooking(o: {
  n?: number
  startInMin?: number
  prices?: number[]
  paid?: number
  deposit?: number
  court?: string
  user?: { id: string; accessToken: string }
}): Promise<Made> {
  const n = o.n ?? 1
  // by default every booking gets its own far-future window (well outside the 12 h cutoff), 5 h apart
  const startAt = new Date(Date.now() + (o.startInMin ?? 60 * 30 + seq++ * 5 * 60) * 60_000)
  const court = o.court ?? (await freeCourt(startAt, n))
  const slots = await findRun(court, n)
  if (o.prices)
    for (let i = 0; i < n; i++)
      await app.prisma
        .$executeRaw`UPDATE slots SET price_minor = ${BigInt(o.prices[i])} WHERE id = ${slots[i].id}::uuid`
  const player = o.user ?? (await makeUser(app))
  const h = (
    await holdHours(
      app,
      player.accessToken,
      court,
      slots.map((s) => s.id),
    )
  ).json().data
  const c = await callKeyed(
    app,
    'POST',
    `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
    player.accessToken,
  )
  if (c.statusCode !== 200) throw new Error('confirm failed: ' + c.body)
  if (o.paid !== undefined) {
    await app.prisma.$executeRaw`DELETE FROM booking_items WHERE booking_id = ${h.id}::uuid`
    await app.prisma.$executeRaw`
      UPDATE bookings SET online_paid_minor = ${BigInt(o.paid)}, deposit_minor = ${BigInt(o.deposit ?? 0)},
             payment_mode = ${o.paid > 0 && o.deposit !== undefined && o.paid === o.deposit ? 'DEPOSIT_20' : 'FULL_ONLINE'},
             payment_status = 'PAID' WHERE id = ${h.id}::uuid`
    await app.prisma
      .$queryRaw`SELECT create_confirmed_items(${h.id}::uuid, ${BigInt(o.paid)}::bigint, ${BigInt(o.deposit ?? 0)}::bigint)`
  }
  await moveBookingTime(app.prisma, h.id, startAt)
  const items = await app.prisma.$queryRaw<{ id: string; slot_id: string }[]>`
    SELECT id, slot_id FROM booking_items WHERE booking_id = ${h.id}::uuid ORDER BY start_at`
  return {
    id: h.id,
    ref: h.ref,
    player,
    itemIds: items.map((i) => i.id),
    slotIds: items.map((i) => i.slot_id),
    court,
    startAt,
  }
}

const cancel = (b: Made, body: object = {}, key = newUuidKey(), token = b.player.accessToken) =>
  callKeyed(app, 'POST', `/api/v1/bookings/${b.id}/cancel`, token, body, key)
const preview = (b: Made, itemIds?: string[], token = b.player.accessToken) =>
  call(
    app,
    'GET',
    `/api/v1/bookings/${b.id}/cancel-preview${itemIds ? '?' + itemIds.map((i) => 'itemIds=' + i).join('&') : ''}`,
    token,
  )
const slotRow = async (id: string) =>
  (
    await app.prisma.$queryRaw<{ status: string; version: number; booking_id: string | null }[]>`
    SELECT status, version, booking_id FROM slots WHERE id = ${id}::uuid`
  )[0]
const bookingRow = async (id: string) =>
  (
    await app.prisma.$queryRaw<
      {
        status: string
        total_minor: bigint
        deposit_minor: bigint
        refund_pending_minor: bigint
        forfeited_minor: bigint
        balance_due_minor: bigint
        start_at: Date
        end_at: Date
        slot_ids: string[]
      }[]
    >`SELECT status, total_minor, deposit_minor, refund_pending_minor, forfeited_minor, balance_due_minor, start_at, end_at, slot_ids
      FROM bookings WHERE id = ${id}::uuid`
  )[0]

describe('splitting a payment across hours (allocation)', () => {
  it('item amounts always add up exactly to the booking amounts, for random prices and payments', async () => {
    for (let i = 0; i < 60; i++) {
      const n = 1 + Math.floor(Math.random() * 4)
      const prices = Array.from(
        { length: n },
        () => Math.floor(Math.random() * 900_000) + (i % 7 === 0 ? 0 : 100),
      )
      const total = prices.reduce((a, b) => a + b, 0)
      const paid = total === 0 ? 0 : Math.floor(Math.random() * (total + 1))
      const deposit = Math.floor(Math.random() * (paid + 1))
      const b = await makeBooking({ n, prices, paid, deposit, startInMin: 60 * 30 + i * 5 * 60 })
      const items = await app.prisma.$queryRaw<{ price: bigint; paid: bigint; dep: bigint }[]>`
        SELECT price_minor AS price, online_paid_minor AS paid, deposit_share_minor AS dep FROM booking_items WHERE booking_id = ${b.id}::uuid`
      expect(items).toHaveLength(n)
      expect(
        items.reduce((a, x) => a + money(x.paid), 0),
        `paid, prices ${prices}`,
      ).toBe(paid)
      expect(
        items.reduce((a, x) => a + money(x.dep), 0),
        `deposit, prices ${prices}`,
      ).toBe(deposit)
      for (const x of items) {
        expect(x.dep).toBeLessThanOrEqual(x.paid) // a deposit share can never exceed what was paid for the hour
        expect(x.paid).toBeLessThanOrEqual(x.price)
      }
    }
  }, 180_000)

  it('the 20% deposit rule rounds up to a whole rupee and splits by price', async () => {
    const total = 200000 + 300000 // Rs 2,000 + Rs 3,000
    const deposit = Number(depositFor(BigInt(total)))
    expect(deposit).toBe(100000) // exactly 20%
    const b = await makeBooking({ n: 2, prices: [200000, 300000], paid: deposit, deposit })
    const items = await app.prisma.$queryRaw<
      { paid: bigint }[]
    >`SELECT online_paid_minor AS paid FROM booking_items WHERE booking_id = ${b.id}::uuid ORDER BY start_at`
    expect(items.map((i) => money(i.paid))).toEqual([40000, 60000])
  })

  it('creates item ids that are UUID v7', async () => {
    const b = await makeBooking({})
    for (const id of b.itemIds) expect(id[14]).toBe('7')
  })
})

describe('cancelling hours: refund and forfeit, per hour', () => {
  it('20% prepaid, long before the cutoff: the deposit for that hour is refunded', async () => {
    const b = await makeBooking({
      n: 2,
      prices: [200000, 200000],
      paid: 80000,
      deposit: 80000,
      startInMin: 60 * 48,
    })
    const r = await cancel(b, { itemIds: [b.itemIds[0]] })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.refundDueMinor).toBe(40000)
    expect(d.forfeitMinor).toBe(0)
    expect(d.bookingFullyCancelled).toBe(false)
    expect(d.booking).toMatchObject({
      status: 'CONFIRMED',
      totalMinor: 200000,
      depositMinor: 40000,
      activeItemCount: 1,
    })
    // balance due = total - (paid - refunded - refund in flight - forfeited) = 200000 - (80000 - 0 - 40000 - 0)
    expect(d.booking.balanceDueMinor).toBe(160000)
    const row = await bookingRow(b.id)
    expect(money(row.refund_pending_minor)).toBe(40000)
    expect(money(row.forfeited_minor)).toBe(0)
    expect(money(row.balance_due_minor)).toBe(160000)
  })

  it('20% prepaid, inside the cutoff: the deposit for that hour is forfeited', async () => {
    const b = await makeBooking({
      n: 2,
      prices: [200000, 200000],
      paid: 80000,
      deposit: 80000,
      startInMin: 60 * 5,
    })
    const r = await cancel(b, { itemIds: [b.itemIds[1]] })
    expect(r.json().data.refundDueMinor).toBe(0)
    expect(r.json().data.forfeitMinor).toBe(40000)
    const row = await bookingRow(b.id)
    expect(money(row.forfeited_minor)).toBe(40000)
    expect(money(row.refund_pending_minor)).toBe(0)
  })

  it('100% prepaid, inside the cutoff: the deposit share is kept, the rest is refunded', async () => {
    const b = await makeBooking({
      n: 1,
      prices: [200000],
      paid: 200000,
      deposit: 40000,
      startInMin: 60 * 5,
    })
    const r = await cancel(b)
    expect(r.json().data.refundDueMinor).toBe(160000)
    expect(r.json().data.forfeitMinor).toBe(40000)
    expect(r.json().data.bookingFullyCancelled).toBe(true)
  })

  it('judges every hour on its own start time against the cutoff', async () => {
    // hour 1 starts in 11.5 h (inside the 12 h cutoff), hour 2 in 12.5 h (outside)
    const b = await makeBooking({
      n: 2,
      prices: [200000, 200000],
      paid: 80000,
      deposit: 80000,
      startInMin: 11 * 60 + 30,
    })
    const p = (await preview(b)).json().data
    expect(p.items.map((i: { fullRefund: boolean }) => i.fullRefund)).toEqual([false, true])
    const r = await cancel(b)
    expect(r.json().data.forfeitMinor).toBe(40000)
    expect(r.json().data.refundDueMinor).toBe(40000)
    const items = r.json().data.items
    expect(items.map((i: { forfeitMinor: number }) => i.forfeitMinor)).toEqual([40000, 0])
  })

  it('a pay-at-venue booking refunds and forfeits nothing, at any time', async () => {
    const b = await makeBooking({ n: 1, startInMin: 30 })
    const r = await cancel(b)
    expect(r.statusCode).toBe(200)
    expect(r.json().data.refundDueMinor).toBe(0)
    expect(r.json().data.forfeitMinor).toBe(0)
  })

  it('the venue cancelling is always a full refund, even after the cutoff', async () => {
    const b = await makeBooking({
      n: 1,
      prices: [200000],
      paid: 40000,
      deposit: 40000,
      startInMin: 120,
    })
    const r = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/bookings/${b.id}/cancel`,
      fx.manager.accessToken,
      { reason: 'pitch flooded' },
      newUuidKey(),
    )
    expect(r.statusCode).toBe(200)
    expect(r.json().data.refundDueMinor).toBe(40000)
    expect(r.json().data.forfeitMinor).toBe(0)
    expect(r.json().data.booking.status).toBe('CANCELLED_BY_VENUE')
    expect(r.json().data.reason).toBe('pitch flooded')
  })
})

describe('the preview shows exactly what the cancellation will do', () => {
  it('matches the real cancellation for 40 random bookings (money parity with the SQL function)', async () => {
    for (let i = 0; i < 40; i++) {
      const n = 1 + Math.floor(Math.random() * 3)
      const prices = Array.from({ length: n }, () => (1 + Math.floor(Math.random() * 20)) * 10000)
      const total = prices.reduce((a, b) => a + b, 0)
      const fullyPaid = Math.random() < 0.4
      const paid = fullyPaid ? total : Math.floor(Math.random() * (total + 1))
      const deposit = fullyPaid ? Math.min(total, Number(depositFor(BigInt(total)))) : paid
      // random start between 1 h and 30 h from now (so both sides of the 12 h cutoff are covered);
      // try again if that window is taken on every court
      let b!: Made
      for (let attempt = 0; attempt < 30 && !b; attempt++) {
        const startInMin = 60 + Math.floor(Math.random() * 60 * 29)
        try {
          b = await makeBooking({ n, prices, paid, deposit, startInMin })
        } catch (e) {
          if (!/no free court/.test((e as Error).message)) throw e
        }
      }
      const pick = b.itemIds.filter(() => Math.random() < 0.6)
      const ids = pick.length ? pick : [b.itemIds[0]]

      const pv = (await preview(b, ids)).json().data
      const real = (await cancel(b, { itemIds: ids })).json().data

      expect(pv.refundDueMinor, `refund, case ${i}`).toBe(real.refundDueMinor)
      expect(pv.forfeitMinor, `forfeit, case ${i}`).toBe(real.forfeitMinor)
      const byItem = new Map<string, { refundDueMinor: number; forfeitMinor: number }>(
        real.items.map((x: { itemId: string; refundDueMinor: number; forfeitMinor: number }) => [
          x.itemId,
          x,
        ]),
      )
      for (const line of pv.items) {
        expect(line.refundDueMinor).toBe(byItem.get(line.itemId)!.refundDueMinor)
        expect(line.forfeitMinor).toBe(byItem.get(line.itemId)!.forfeitMinor)
      }
    }
  }, 240_000)

  it('the pure TypeScript calculation agrees with the database function', async () => {
    const b = await makeBooking({
      n: 3,
      prices: [100000, 150000, 250000],
      paid: 500000,
      deposit: 100000,
      startInMin: 60 * 11,
    })
    const items = await app.prisma.$queryRaw<
      {
        id: string
        start_at: Date
        price_minor: bigint
        online_paid_minor: bigint
        deposit_share_minor: bigint
      }[]
    >`
      SELECT id, start_at, price_minor, online_paid_minor, deposit_share_minor FROM booking_items WHERE booking_id = ${b.id}::uuid ORDER BY start_at`
    const ts = computeCancelPreview(
      items.map((i) => ({
        id: i.id,
        startAt: i.start_at,
        priceMinor: i.price_minor,
        onlinePaidMinor: i.online_paid_minor,
        depositShareMinor: i.deposit_share_minor,
      })),
      { cancelledBy: 'USER', cutoffHours: 12, now: new Date() },
    )
    const sql = (await cancel(b)).json().data
    expect(money(ts.refundDueMinor)).toBe(sql.refundDueMinor)
    expect(money(ts.forfeitMinor)).toBe(sql.forfeitMinor)
  })

  it('writes nothing', async () => {
    const b = await makeBooking({ n: 2 })
    const before = await Promise.all(b.slotIds.map(slotRow))
    expect((await preview(b)).statusCode).toBe(200)
    const after = await Promise.all(b.slotIds.map(slotRow))
    expect(after).toEqual(before)
    expect((await bookingRow(b.id)).status).toBe('CONFIRMED')
  })

  it('says so when an hour can no longer be cancelled by the player, and refuses other people', async () => {
    const started = await makeBooking({ n: 1, startInMin: -10 })
    const p = (await preview(started)).json().data
    expect(p.allCancellable).toBe(false)
    expect(p.items[0].cancellable).toBe(false)
    const other = await makeUser(app)
    expect((await preview(started, undefined, other.accessToken)).statusCode).toBe(404)
  })
})

describe('what a cancellation changes', () => {
  it('cancelling the middle hour frees exactly that hour; the rest stays booked; the booking is recalculated', async () => {
    const b = await makeBooking({ n: 3, prices: [100000, 200000, 300000] })
    const before = await Promise.all(b.slotIds.map(slotRow))
    const r = await cancel(b, { itemIds: [b.itemIds[1]] })
    expect(r.statusCode).toBe(200)
    const after = await Promise.all(b.slotIds.map(slotRow))
    expect(after[0].status).toBe('BOOKED_APP')
    expect(after[1].status).toBe('AVAILABLE')
    expect(after[1].booking_id).toBeNull()
    expect(after[1].version).toBe(before[1].version + 1)
    expect(after[2].status).toBe('BOOKED_APP')
    expect(after[0].version).toBe(before[0].version)
    const row = await bookingRow(b.id)
    expect(row.status).toBe('CONFIRMED')
    expect(money(row.total_minor)).toBe(400000)
    expect(row.slot_ids).toEqual([b.slotIds[0], b.slotIds[2]])
    expect(r.json().data.freedSlotIds).toEqual([b.slotIds[1]])
    await assertInventoryInvariants(app.prisma, [b.court])
  })

  it('the freed hour can be booked by another player straight away (finding F1)', async () => {
    const b = await makeBooking({ n: 3 })
    await cancel(b, { itemIds: [b.itemIds[1]] })
    const other = await makeUser(app)
    const h = await holdHours(app, other.accessToken, b.court, [b.slotIds[1]])
    expect(h.statusCode).toBe(201)
    const c = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${h.json().data.id}/confirm-pay-at-venue`,
      other.accessToken,
    )
    expect(c.statusCode).toBe(200)
    // two bookings now cover one court's evening, with no overlap between their active items
    await assertInventoryInvariants(app.prisma, [b.court])
  })

  it('cancelling every hour cancels the booking', async () => {
    const b = await makeBooking({ n: 2 })
    const r = await cancel(b) // no itemIds = the whole booking
    expect(r.json().data.bookingFullyCancelled).toBe(true)
    expect(r.json().data.booking.status).toBe('CANCELLED_BY_USER')
    expect((await bookingRow(b.id)).status).toBe('CANCELLED_BY_USER')
    for (const id of b.slotIds) expect((await slotRow(id)).status).toBe('AVAILABLE')
    const mine = (
      await call(app, 'GET', '/api/v1/me/bookings?tab=cancelled', b.player.accessToken)
    ).json().data
    expect(mine.map((x: { id: string }) => x.id)).toContain(b.id)
  })

  it('cancelling the hours one by one ends with a cancelled booking', async () => {
    const b = await makeBooking({ n: 2 })
    const r1 = await cancel(b, { itemIds: [b.itemIds[0]] })
    expect(r1.json().data.bookingFullyCancelled).toBe(false)
    const r2 = await cancel(b, { itemIds: [b.itemIds[1]] })
    expect(r2.json().data.bookingFullyCancelled).toBe(true)
    expect((await bookingRow(b.id)).status).toBe('CANCELLED_BY_USER')
  })

  it('narrows the booking window to the hours that are left', async () => {
    const b = await makeBooking({ n: 3 })
    await cancel(b, { itemIds: [b.itemIds[0]] })
    const row = await bookingRow(b.id)
    expect(row.start_at.getTime()).toBe(b.startAt.getTime() + H)
    expect(row.end_at.getTime()).toBe(b.startAt.getTime() + 3 * H)
  })

  it('emits ONE BookingItemCancelled event per request with item amounts, and writes an audit row', async () => {
    const b = await makeBooking({ n: 2, prices: [200000, 200000], paid: 80000, deposit: 80000 })
    const key = newUuidKey()
    await cancel(b, { itemIds: b.itemIds, reason: 'Team dropped out' }, key)
    const evs = await app.prisma.$queryRaw<{ payload: any }[]>`
      SELECT payload FROM outbox WHERE event_type = 'BookingItemCancelled' AND payload->'data'->>'bookingId' = ${b.id}`
    expect(evs).toHaveLength(1)
    const e = evs[0].payload
    expect(e).toMatchObject({ type: 'BookingItemCancelled', version: 1, producer: 'booking' })
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(e.data).toMatchObject({
      cancellationId: key,
      bookingId: b.id,
      bookingRef: b.ref,
      cancelledBy: 'USER',
      reason: 'Team dropped out',
      refundDueMinor: 80000,
      forfeitMinor: 0,
      bookingFullyCancelled: true,
    })
    expect(e.data.items).toHaveLength(2)
    expect(e.data.items[0]).toHaveProperty('refundDueMinor')
    expect(e.data).not.toHaveProperty('slots') // internal: used for the live grid, not for other services
    const au = await app.prisma.auditLog.findMany({
      where: { entity: 'booking', entityId: b.id, action: 'BOOKING_ITEMS_CANCELLED' },
    })
    expect(au).toHaveLength(1)
    expect(au[0].actorId).toBe(b.player.id)
  })

  it('does not reopen an hour that has already been played when the venue cancels', async () => {
    const b = await makeBooking({ n: 1, startInMin: -180 })
    const r = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/bookings/${b.id}/cancel`,
      fx.manager.accessToken,
      { reason: 'record correction' },
      newUuidKey(),
    )
    expect(r.statusCode).toBe(200)
    expect(r.json().data.freedSlotIds).toEqual([])
    expect((await slotRow(b.slotIds[0])).status).toBe('BOOKED_APP') // never resold
  })
})

describe('retries and mistakes', () => {
  it('the same request 20 times (sequentially) cancels once and returns the same answer', async () => {
    const b = await makeBooking({ n: 2, prices: [200000, 200000], paid: 80000, deposit: 80000 })
    const key = newUuidKey()
    const first = await cancel(b, { itemIds: [b.itemIds[0]] }, key)
    const versionAfter = (await slotRow(b.slotIds[0])).version
    for (let i = 0; i < 20; i++) {
      const r = await cancel(b, { itemIds: [b.itemIds[0]] }, key)
      expect(r.statusCode).toBe(200)
      expect(r.json().data.replayed).toBe(true)
      expect(r.json().data.refundDueMinor).toBe(first.json().data.refundDueMinor)
    }
    expect((await slotRow(b.slotIds[0])).version).toBe(versionAfter)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM booking_cancellations WHERE booking_id = ${b.id}::uuid`
    expect(n).toBe(1)
    const ev = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM outbox WHERE event_type = 'BookingItemCancelled' AND payload->'data'->>'bookingId' = ${b.id}`
    expect(ev[0].n).toBe(1)
    expect(money((await bookingRow(b.id)).refund_pending_minor)).toBe(40000) // refunded once, not 21 times
  })

  it('the same request 20 times in parallel also cancels once', async () => {
    const b = await makeBooking({ n: 2, prices: [200000, 200000], paid: 80000, deposit: 80000 })
    const key = newUuidKey()
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => cancel(b, { itemIds: [b.itemIds[0]] }, key)),
    )
    expect(rs.every((r) => r.statusCode === 200)).toBe(true)
    expect(rs.filter((r) => r.json().data.replayed === false)).toHaveLength(1)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM booking_cancellations WHERE booking_id = ${b.id}::uuid`
    expect(n).toBe(1)
    expect(money((await bookingRow(b.id)).refund_pending_minor)).toBe(40000)
  })

  it('a replay of a whole-booking cancellation still answers (nothing is left to cancel)', async () => {
    const b = await makeBooking({ n: 1 })
    const key = newUuidKey()
    expect((await cancel(b, {}, key)).statusCode).toBe(200)
    const again = await cancel(b, {}, key)
    expect(again.statusCode).toBe(200)
    expect(again.json().data.replayed).toBe(true)
  })

  it('a different request for an hour that is already cancelled is refused', async () => {
    const b = await makeBooking({ n: 2 })
    await cancel(b, { itemIds: [b.itemIds[0]] })
    const r = await cancel(b, { itemIds: [b.itemIds[0]] }, newUuidKey())
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('ITEM_NOT_CANCELLABLE')
  })

  it('refuses an hour that belongs to another booking, and an unknown hour', async () => {
    const a = await makeBooking({ n: 1 })
    const b = await makeBooking({ n: 1 })
    const foreign = await cancel(a, { itemIds: [b.itemIds[0]] })
    expect(foreign.statusCode).toBe(409)
    expect(foreign.json().code).toBe('ITEM_NOT_CANCELLABLE')
    const unknown = await cancel(a, { itemIds: ['0198a000-0000-7000-8000-00000000dead'] })
    expect(unknown.statusCode).toBe(409)
    expect((await bookingRow(b.id)).status).toBe('CONFIRMED')
    expect((await bookingRow(a.id)).status).toBe('CONFIRMED')
  })

  it('a player cannot cancel an hour that has already started', async () => {
    const b = await makeBooking({ n: 1, startInMin: -10 })
    const r = await cancel(b)
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('ITEM_ALREADY_STARTED')
    expect((await slotRow(b.slotIds[0])).status).toBe('BOOKED_APP')
  })

  it("nobody can cancel another player's booking, and it looks like it does not exist", async () => {
    const b = await makeBooking({ n: 1 })
    const stranger = await makeUser(app)
    const r = await cancel(b, {}, newUuidKey(), stranger.accessToken)
    expect(r.statusCode).toBe(404)
    expect((await bookingRow(b.id)).status).toBe('CONFIRMED')
  })

  it('only a confirmed booking can be cancelled: not a hold, not a checked-in booking', async () => {
    const court = courts[0]
    const [a] = await findRun(court, 1)
    const p = await makeUser(app)
    const hold = (await holdHours(app, p.accessToken, court, [a.id])).json().data
    const r1 = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${hold.id}/cancel`,
      p.accessToken,
      {},
      newUuidKey(),
    )
    expect(r1.statusCode).toBe(409)
    expect(r1.json().code).toBe('BOOKING_NOT_CANCELLABLE')
    expect(r1.json().details.status).toBe('PENDING_PAYMENT')
    const done = await makeBooking({ n: 1, startInMin: 10 })
    await app.prisma
      .$executeRaw`UPDATE bookings SET status = 'CHECKED_IN' WHERE id = ${done.id}::uuid`
    const r2 = await cancel(done)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().details.status).toBe('CHECKED_IN')
  })

  it('needs a UUID Idempotency-Key, and the same key cannot be reused for another booking', async () => {
    const a = await makeBooking({ n: 1 })
    const b = await makeBooking({ n: 1 })
    expect((await cancel(a, {}, 'plain-key-12345')).statusCode).toBe(400)
    expect(
      (
        await callKeyed(
          app,
          'POST',
          `/api/v1/bookings/${a.id}/cancel`,
          a.player.accessToken,
          {},
          null,
        )
      ).statusCode,
    ).toBe(400)
    const key = newUuidKey()
    expect((await cancel(a, {}, key)).statusCode).toBe(200)
    const reuse = await cancel(b, {}, key)
    expect(reuse.statusCode).toBe(409)
    expect(reuse.json().code).toBe('IDEMPOTENCY_CONFLICT')
    expect((await bookingRow(b.id)).status).toBe('CONFIRMED')
  })

  it('cancelling one hour in several parallel requests with different keys cancels it once', async () => {
    const b = await makeBooking({ n: 2, prices: [200000, 200000], paid: 80000, deposit: 80000 })
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => cancel(b, { itemIds: [b.itemIds[0]] }, newUuidKey())),
    )
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(9)
    expect(money((await bookingRow(b.id)).refund_pending_minor)).toBe(40000)
  })
})

describe('admin emergency cancel', () => {
  it('needs a reason, cancels on behalf of the venue and is audited', async () => {
    const b = await makeBooking({
      n: 1,
      prices: [200000],
      paid: 40000,
      deposit: 40000,
      startInMin: 60,
    })
    const url = `/api/v1/admin/bookings/${b.id}/cancel`
    const no = await callKeyed(
      app,
      'POST',
      url,
      fx.admin.accessToken,
      { reason: 'x' },
      newUuidKey(),
    )
    expect(no.statusCode).toBe(400)
    const staff = await callKeyed(
      app,
      'POST',
      url,
      fx.owner.accessToken,
      { reason: 'owner trying admin route' },
      newUuidKey(),
    )
    expect(staff.statusCode).toBe(403)
    const ok = await callKeyed(
      app,
      'POST',
      url,
      fx.admin.accessToken,
      { reason: 'venue closed unexpectedly' },
      newUuidKey(),
    )
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.refundDueMinor).toBe(40000) // venue-side: full refund
    expect(ok.json().data.booking.status).toBe('CANCELLED_BY_VENUE')
    const au = await app.prisma.auditLog.findMany({
      where: { entity: 'booking', entityId: b.id, action: 'ADMIN_BOOKING_CANCELLED' },
    })
    expect(au).toHaveLength(1)
    expect((au[0].after as { reason: string }).reason).toBe('venue closed unexpectedly')
    void newKey
  })
})
