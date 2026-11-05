import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { todayIn } from '../src/lib/time'
import {
  Fixture,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  dayAfter,
  makeApp,
  newKey,
  newUuidKey,
  pickSlots,
  slotsOn,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let day = 2
const nextDay = () => day++

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
  await app.booking.idle()
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
  customerName: 'Drawer Test',
  customerPhone: '0300 7654321',
  ...extra,
})
const walkIn = (
  slotIds: string[],
  extra: object = {},
  token = fx.frontDesk.accessToken,
  key = newKey(),
) => callKeyed(app, 'POST', `${base()}/walkins`, token, walkInBody(slotIds, extra), key)
const manual = (slotIds: string[], extra: object = {}, token = fx.frontDesk.accessToken) =>
  callKeyed(app, 'POST', `${base()}/bookings/manual`, token, walkInBody(slotIds, extra), newKey())
const collectBalance = (bookingId: string, amountMinor: number, token = fx.frontDesk.accessToken) =>
  callKeyed(app, 'POST', `${base()}/bookings/${bookingId}/collect-balance`, token, { amountMinor })
const cancelByVenue = (
  bookingId: string,
  body: object = {},
  token = fx.manager.accessToken,
) => callKeyed(app, 'POST', `${base()}/bookings/${bookingId}/cancel`, token, body, newUuidKey())
const daySummary = (date: string, token = fx.frontDesk.accessToken) =>
  call(app, 'GET', `${base()}/day-summary?date=${date}`, token)
const ledgerRows = async (bookingId: string) =>
  app.prisma.$queryRaw<{ entry_type: string; direction: string; amount_minor: bigint }[]>`
    SELECT entry_type, direction, amount_minor FROM ledger_entries
     WHERE reference_type = 'BOOKING' AND reference_id = ${bookingId}::uuid`

describe('walk-in / manual payment method and the cash ledger', () => {
  it('CASH posts a WALKIN_CASH ledger credit', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const r = await walkIn([a.id], { method: 'CASH' })
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.paymentMethod).toBe('CASH')
    const rows = await ledgerRows(d.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entry_type: 'WALKIN_CASH', direction: 'CREDIT' })
    expect(Number(rows[0].amount_minor)).toBe(d.cashCollectedMinor)
  })

  it('FREE comps the full price, owes nothing and posts no ledger entry', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const r = await walkIn([a.id], { method: 'FREE', cashCollectedMinor: 0 })
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.paymentMethod).toBe('FREE')
    expect(d.cashCollectedMinor).toBe(Number(a.price_minor))
    expect(d.balanceDueMinor).toBe(0)
    expect(d.paymentStatus).toBe('PAID')
    expect(await ledgerRows(d.id)).toHaveLength(0)
  })

  it('BANK_TRANSFER marks paid but never touches the cash drawer', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const r = await walkIn([a.id], { method: 'BANK_TRANSFER' })
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.paymentMethod).toBe('BANK_TRANSFER')
    expect(d.cashCollectedMinor).toBe(Number(a.price_minor)) // still counts as paid...
    expect(await ledgerRows(d.id)).toHaveLength(0) // ...but it is not cash in the drawer
  })

  it('collect-balance posts a CASH_COLLECTED ledger credit', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await manual([a.id], { payLater: true })).json().data
    expect(d.balanceDueMinor).toBe(Number(a.price_minor))
    const r = await collectBalance(d.id, Number(a.price_minor))
    expect(r.statusCode).toBe(200)
    const rows = await ledgerRows(d.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entry_type: 'CASH_COLLECTED', direction: 'CREDIT' })
  })
})

describe('cash refund on a staff cancellation', () => {
  it('a plain cancel with no cashRefundedMinor posts no ledger entry', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data
    const r = await cancelByVenue(d.id, {})
    expect(r.statusCode).toBe(200)
    const refunds = (await ledgerRows(d.id)).filter((x) => x.entry_type === 'REFUND_OUT')
    expect(refunds).toHaveLength(0)
  })

  it('rejects a cash refund larger than what was collected', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data
    const r = await cancelByVenue(d.id, { cashRefundedMinor: d.cashCollectedMinor + 100 })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('CASH_REFUND_EXCEEDS_COLLECTED')
  })

  it('a full cash refund on cancel posts REFUND_OUT with note CASH', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data
    const r = await cancelByVenue(d.id, { cashRefundedMinor: d.cashCollectedMinor })
    expect(r.statusCode).toBe(200)
    const rows = await app.prisma.$queryRaw<
      { entry_type: string; direction: string; amount_minor: bigint; note: string | null }[]
    >`SELECT entry_type, direction, amount_minor, note FROM ledger_entries
       WHERE reference_type = 'BOOKING' AND reference_id = ${d.id}::uuid AND entry_type = 'REFUND_OUT'`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'DEBIT', note: 'CASH' })
    expect(Number(rows[0].amount_minor)).toBe(d.cashCollectedMinor)
  })

  it("the player's own cancel route has no cashRefundedMinor field to begin with", async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data
    // walk-ins have no player (user_id null); this just proves the player schema can't carry the
    // field at all (Ajv removeAdditional strips it), so sending it on /bookings/:id/cancel is a
    // no-op server-side regardless of who calls it.
    const r = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${d.id}/cancel`,
      fx.owner.accessToken,
      { cashRefundedMinor: 999999 },
      newUuidKey(),
    )
    // not the booking's owner, so 404 either way — the point is it never 500s on the extra field
    expect(r.statusCode).toBe(404)
  })
})

describe('day summary', () => {
  it('counts booked vs total hours, still-to-collect and arriving-next for the day', async () => {
    const offset = nextDay()
    const date = dayAfter(offset)
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: offset })
    const total = (await slotsOn(app.prisma, fx.courtId, date)).length

    const paid = (await walkIn([a.id], { method: 'CASH' })).json().data
    const unpaid = (await manual([b.id], { payLater: true })).json().data

    const r = await daySummary(date)
    expect(r.statusCode).toBe(200)
    const s = r.json().data
    expect(s.totalHours).toBe(total)
    expect(s.bookedHours).toBeGreaterThanOrEqual(2)
    expect(s.stillToCollectMinor).toBeGreaterThanOrEqual(unpaid.balanceDueMinor)
    expect(s.stillToCollectBookingCount).toBeGreaterThanOrEqual(1)
    expect(s.bookingsToday.total).toBeGreaterThanOrEqual(2)
    expect(s.bookingsToday.upcoming).toBeGreaterThanOrEqual(2) // both CONFIRMED, not checked in
    const refs = s.arrivingNext.map((x: { ref: string }) => x.ref)
    expect(refs).toContain(paid.ref)
    expect(refs).toContain(unpaid.ref)
    // soonest start first
    const starts = s.arrivingNext.map((x: { startAt: string }) => new Date(x.startAt).getTime())
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
  })

  it("today's cash-in-drawer reflects WALKIN_CASH + CASH_COLLECTED - cash REFUND_OUT", async () => {
    const today = todayIn()
    const before = (await daySummary(today)).json().data.expected.expectedCashMinor

    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    // the slot is dated in the future, but the cash itself lands in TODAY's drawer
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data

    const after = (await daySummary(today)).json().data
    expect(after.expected.walkinCashMinor).toBeGreaterThanOrEqual(d.cashCollectedMinor)
    expect(after.expected.expectedCashMinor).toBe(before + d.cashCollectedMinor)
  })
})

describe('bookings page: date-range tabs and source counts', () => {
  const dayList = (qs: string, token = fx.frontDesk.accessToken) =>
    call(app, 'GET', `${base()}/bookings?${qs}`, token)

  it('range=today / tomorrow / week resolve to the right business dates', async () => {
    const offset = nextDay()
    const date = dayAfter(offset)
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: offset })
    const d = (await walkIn([a.id], { method: 'CASH' })).json().data

    // exact-date query still works unchanged
    const byDate = await dayList(`date=${date}`)
    expect(byDate.json().data.map((b: { id: string }) => b.id)).toContain(d.id)

    // and the same booking is NOT inside a "today"-ranged query, since its slot is days out
    const today = await dayList(`range=today`)
    expect(today.json().data.map((b: { id: string }) => b.id)).not.toContain(d.id)
  })

  it('source filter and the all/online/walk-in counts', async () => {
    const offset = nextDay()
    const date = dayAfter(offset)
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: offset })
    const cash = (await walkIn([a.id], { method: 'CASH' })).json().data
    const phone = (await manual([b.id], { payLater: true })).json().data

    const all = await dayList(`date=${date}`)
    expect(all.json().meta.counts.walkin).toBeGreaterThanOrEqual(2) // WALKIN + MANUAL both count
    expect(all.json().meta.counts.online).toBe(0)

    const onlyWalkin = await dayList(`date=${date}&source=WALKIN,MANUAL`)
    const ids = onlyWalkin.json().data.map((x: { id: string }) => x.id)
    expect(ids).toContain(cash.id)
    expect(ids).toContain(phone.id)
  })
})

describe('occupancy (My Grounds card)', () => {
  it('reports booked vs total hours and a 0-100 percentage over the rolling window', async () => {
    const r = await call(
      app,
      'GET',
      `${base()}/occupancy?days=7`,
      fx.manager.accessToken,
    )
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.totalHours).toBeGreaterThan(0)
    expect(d.bookedHours).toBeGreaterThanOrEqual(0)
    expect(d.pct).toBeGreaterThanOrEqual(0)
    expect(d.pct).toBeLessThanOrEqual(100)
  })

  it('front desk cannot read occupancy (owner/manager only)', async () => {
    const r = await call(
      app,
      'GET',
      `${base()}/occupancy`,
      fx.frontDesk.accessToken,
    )
    expect(r.statusCode).toBe(403)
  })
})

describe('role access to day-summary and closings', () => {
  it('front desk can read the day summary but cannot close the day', async () => {
    const today = todayIn()
    expect((await daySummary(today, fx.frontDesk.accessToken)).statusCode).toBe(200)
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/closings`,
      fx.frontDesk.accessToken,
      { businessDate: today, countedCashMinor: 0 },
      null,
    )
    expect(r.statusCode).toBe(403)
  })
})

describe('closing the day', () => {
  const today = () => todayIn()

  it('a future date cannot be closed', async () => {
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/closings`,
      fx.manager.accessToken,
      { businessDate: dayAfter(1), countedCashMinor: 0 },
      null,
    )
    expect(r.statusCode).toBe(400)
  })

  it('manager closes the day; variance is counted minus expected', async () => {
    const expected = (await daySummary(today())).json().data.expected.expectedCashMinor
    const counted = expected + 500
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/closings`,
      fx.manager.accessToken,
      { businessDate: today(), countedCashMinor: counted, notes: 'gave change from the drawer' },
      null,
    )
    expect(r.statusCode).toBe(201)
    const c = r.json().data
    expect(c.status).toBe('CLOSED')
    expect(c.varianceMinor).toBe(500)

    const summary = (await daySummary(today())).json().data
    expect(summary.alreadyClosed).toBe(true)
  })

  it('a second close on the same day is rejected', async () => {
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/closings`,
      fx.manager.accessToken,
      { businessDate: today(), countedCashMinor: 0 },
      null,
    )
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('ALREADY_CLOSED')
  })

  it('only the owner may reopen a closed day', async () => {
    const byManager = await callKeyed(
      app,
      'POST',
      `${base()}/closings/${today()}/reopen`,
      fx.manager.accessToken,
      { reason: 'need to adjust' },
      null,
    )
    expect(byManager.statusCode).toBe(403)

    const byOwner = await callKeyed(
      app,
      'POST',
      `${base()}/closings/${today()}/reopen`,
      fx.owner.accessToken,
      { reason: 'need to adjust' },
      null,
    )
    expect(byOwner.statusCode).toBe(200)
    expect(byOwner.json().data.status).toBe('REOPENED')
  })

  it('reopening an already-reopened (not closed) day 404s', async () => {
    const r = await callKeyed(
      app,
      'POST',
      `${base()}/closings/${today()}/reopen`,
      fx.owner.accessToken,
      { reason: 'again' },
      null,
    )
    expect(r.statusCode).toBe(404)
  })
})
