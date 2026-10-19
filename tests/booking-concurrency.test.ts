/**
 * The heart of Phase 2: a court-hour can never be sold twice. Every test here races real HTTP
 * requests against a real Postgres, then checks the outcome in the database itself.
 */
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '../src/lib/id'
import {
  Fixture,
  assertInventoryInvariants,
  buildFixture,
  callKeyed,
  cleanupTestData,
  deadlockCount,
  holdHours,
  makeApp,
  makeUser,
  makeUsers,
  newKey,
  pickSlots,
  slotsOn,
  dayAfter,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let day = 2
/** A fresh day of the calendar for each test, so tests never fight over the same hours. */
const nextDay = () => day++

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
}, 60_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const walkIn = (token: string, slotIds: string[], extra: object = {}) =>
  callKeyed(app, 'POST', `/api/v1/pos/venues/${fx.venueId}/walkins`, token, {
    courtId: fx.courtId,
    slotIds,
    customerName: 'Walk In',
    customerPhone: '03001234567',
    ...extra,
  })
const block = (token: string, from: Date, to: Date) =>
  callKeyed(app, 'POST', `/api/v1/pos/venues/${fx.venueId}/blocks`, token, {
    courtIds: [fx.courtId],
    from: from.toISOString(),
    to: to.toISOString(),
    reason: 'MAINTENANCE',
  })
const slotRow = async (id: string) =>
  (
    await app.prisma.$queryRaw<
      { status: string; version: number }[]
    >`SELECT status, version FROM slots WHERE id = ${id}::uuid`
  )[0]

describe('500 players race for one hour', () => {
  it('exactly one wins, 499 get a clean 409, and the hour changed exactly once', async () => {
    const [slot] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const players = await makeUsers(app, 500)
    const deadlocksBefore = await deadlockCount(app.prisma)

    const res = await Promise.all(
      players.map((p) => holdHours(app, p.accessToken, fx.courtId, [slot.id])),
    )

    const codes = res.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 201)).toHaveLength(1)
    expect(codes.filter((c) => c === 409)).toHaveLength(499)
    expect(codes.filter((c) => c >= 500)).toHaveLength(0) // a race must never surface as a server error
    for (const r of res.filter((x) => x.statusCode === 409))
      expect(r.json().code).toBe('SLOT_UNAVAILABLE')

    const after = await slotRow(slot.id)
    expect(after.status).toBe('HELD')
    expect(after.version).toBe(slot.version + 1)
    const [{ n }] = await app.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM bookings WHERE ${slot.id}::uuid = ANY(slot_ids) AND status = 'PENDING_PAYMENT'`
    expect(n).toBe(1)
    expect(await deadlockCount(app.prisma)).toBe(deadlocksBefore)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)

  it('500 walk-ins for one hour: one winner as well', async () => {
    const [slot] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const res = await Promise.all(
      Array.from({ length: 500 }, () => walkIn(fx.frontDesk.accessToken, [slot.id])),
    )
    const codes = res.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 201)).toHaveLength(1)
    expect(codes.filter((c) => c === 409)).toHaveLength(499)
    expect(codes.filter((c) => c >= 500)).toHaveLength(0)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM booking_items WHERE slot_id = ${slot.id}::uuid AND status = 'CONFIRMED'`
    expect(n).toBe(1)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)
})

describe('different kinds of sale race each other', () => {
  it('a walk-in and an online hold on the same hour: exactly one wins, 40 times', async () => {
    const slots = await pickSlots(app.prisma, fx.courtId, 12, { dayOffset: nextDay() })
    const players = await makeUsers(app, 40)
    const todo = Array.from({ length: 40 }, (_, i) => slots[i % 12])
    // each round uses its own hour once, then reuses it only after it was freed; so run 12 rounds of 1 pair, then reuse by new hours
    const rounds = 12
    const outcomes: Array<{ hold: number; walk: number; status: string }> = []
    for (let i = 0; i < rounds; i++) {
      const s = todo[i]
      const [h, w] = await Promise.all([
        holdHours(app, players[i].accessToken, fx.courtId, [s.id]),
        walkIn(fx.frontDesk.accessToken, [s.id]),
      ])
      const st = await slotRow(s.id)
      outcomes.push({ hold: h.statusCode, walk: w.statusCode, status: st.status })
      expect([h.statusCode, w.statusCode].filter((c) => c === 201 || c === 200)).toHaveLength(1)
      const loser = h.statusCode === 201 ? w : h
      expect(loser.statusCode).toBe(409)
      expect(['SLOT_HELD', 'SLOT_UNAVAILABLE']).toContain(loser.json().code)
      expect(st.status).toBe(h.statusCode === 201 ? 'HELD' : 'BOOKED_WALKIN')
      expect(st.version).toBe(s.version + 1)
    }
    // both orders happened at least sometimes would be luck; what matters is the invariant above
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)

  it('a walk-in meeting a live hold is told how long it has left', async () => {
    const [slot] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    expect((await holdHours(app, p.accessToken, fx.courtId, [slot.id])).statusCode).toBe(201)
    const r = await walkIn(fx.frontDesk.accessToken, [slot.id])
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('SLOT_HELD')
    expect(r.json().details.secondsRemaining).toBeGreaterThan(290)
    expect(r.json().details.secondsRemaining).toBeLessThanOrEqual(300)
  })

  it('a block and an online hold on the same hour: the block never overrides a booking', async () => {
    const slots = await pickSlots(app.prisma, fx.courtId, 10, { dayOffset: nextDay() })
    const players = await makeUsers(app, 10)
    for (let i = 0; i < 10; i++) {
      const s = slots[i]
      const [h, b] = await Promise.all([
        holdHours(app, players[i].accessToken, fx.courtId, [s.id]),
        block(fx.manager.accessToken, s.start_at, s.end_at),
      ])
      expect(b.statusCode).toBe(200) // a block request itself always answers
      const st = await slotRow(s.id)
      if (h.statusCode === 201) {
        // the hold won: the block must have skipped it and said so
        expect(st.status).toBe('HELD')
        expect(b.json().data.blockedCount).toBe(0)
        expect(b.json().data.heldSkipped).toHaveLength(1)
      } else {
        expect(h.statusCode).toBe(409)
        expect(st.status).toBe('BLOCKED')
        expect(b.json().data.blockedCount).toBe(1)
      }
    }
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)
})

describe('multi-hour holds are all-or-nothing and deadlock free', () => {
  it('overlapping 3-hour holds: one wins, the loser changes nothing at all', async () => {
    for (let round = 0; round < 15; round++) {
      const hs = await pickSlots(app.prisma, fx.courtId, 6, { dayOffset: nextDay() })
      const [p1, p2] = await makeUsers(app, 2)
      const mine = hs.slice(0, 3) // h0 h1 h2
      const theirs = hs.slice(2, 5) // h2 h3 h4 (shares h2)
      const [a, b] = await Promise.all([
        holdHours(
          app,
          p1.accessToken,
          fx.courtId,
          mine.map((s) => s.id),
        ),
        holdHours(
          app,
          p2.accessToken,
          fx.courtId,
          theirs.map((s) => s.id),
        ),
      ])
      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
      const winner = a.statusCode === 201 ? mine : theirs
      const loser = a.statusCode === 201 ? theirs : mine
      for (const s of winner) expect((await slotRow(s.id)).status).toBe('HELD')
      // the loser's hours that were NOT shared are untouched: no partial hold
      for (const s of loser.filter((x) => !winner.some((w) => w.id === x.id))) {
        const r = await slotRow(s.id)
        expect(r.status).toBe('AVAILABLE')
        expect(r.version).toBe(s.version)
      }
    }
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)

  it('the same four hours requested in opposite orders never deadlock', async () => {
    const deadlocksBefore = await deadlockCount(app.prisma)
    for (let round = 0; round < 15; round++) {
      const hs = await pickSlots(app.prisma, fx.courtId, 4, { dayOffset: nextDay() })
      const ps = await makeUsers(app, 8)
      const asc = hs.map((s) => s.id)
      const desc = [...asc].reverse()
      const res = await Promise.all(
        ps.map((p, i) => holdHours(app, p.accessToken, fx.courtId, i % 2 ? desc : asc)),
      )
      expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1)
      expect(res.filter((r) => r.statusCode >= 500)).toHaveLength(0)
    }
    expect(await deadlockCount(app.prisma)).toBe(deadlocksBefore)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)

  it('staggered windows over the same day (1-2-3-4, 2-3-4-5, 3-4-5-6 ...) never deadlock and never double-sell', async () => {
    const deadlocksBefore = await deadlockCount(app.prisma)
    const hs = await pickSlots(app.prisma, fx.courtId, 10, { dayOffset: nextDay() })
    const ps = await makeUsers(app, 70)
    const reqs: Array<Promise<{ statusCode: number }>> = []
    const windows: string[][] = []
    for (let i = 0; i < 70; i++) {
      const start = i % 7
      const w = hs.slice(start, start + 4).map((s) => s.id)
      windows.push(w)
      reqs.push(holdHours(app, ps[i].accessToken, fx.courtId, i % 3 === 0 ? [...w].reverse() : w))
    }
    const res = await Promise.all(reqs)
    expect(res.filter((r) => r.statusCode >= 500)).toHaveLength(0)
    // winners never share an hour: every hour belongs to at most one live hold
    const held = await app.prisma.$queryRaw<{ id: string; booking_id: string }[]>`
      SELECT id, booking_id FROM slots WHERE id = ANY(${hs.map((s) => s.id)}::uuid[]) AND status = 'HELD'`
    expect(new Set(held.map((h) => h.id)).size).toBe(held.length)
    // and the number of held hours equals 4 per winning hold
    expect(held.length).toBe(res.filter((r) => r.statusCode === 201).length * 4)
    expect(await deadlockCount(app.prisma)).toBe(deadlocksBefore)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 120_000)

  it('a request for hours where one is already taken fails whole', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 4, { dayOffset: nextDay() })
    const [p1, p2] = await makeUsers(app, 2)
    expect((await holdHours(app, p1.accessToken, fx.courtId, [hs[2].id])).statusCode).toBe(201)
    const r = await holdHours(
      app,
      p2.accessToken,
      fx.courtId,
      hs.map((s) => s.id),
    )
    expect(r.statusCode).toBe(409)
    for (const s of [hs[0], hs[1], hs[3]]) expect((await slotRow(s.id)).status).toBe('AVAILABLE')
  })
})

describe('the database refuses a double sale even if the code were wrong', () => {
  it('layer 3: two active items on overlapping time of one court are rejected by the exclusion constraint', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    const w = await walkIn(fx.frontDesk.accessToken, [a.id])
    expect(w.statusCode).toBe(201)
    const bookingId = w.json().data.id as string
    // pretend a buggy code path tries to add a second active item that overlaps hour a
    await expect(
      app.prisma.$executeRaw`
        INSERT INTO booking_items (id, booking_id, slot_id, court_id, venue_id, start_at, end_at, price_minor)
        VALUES (${uuidv7()}::uuid, ${bookingId}::uuid, ${b.id}::uuid, ${fx.courtId}::uuid, ${fx.venueId}::uuid,
                ${new Date(a.start_at.getTime() + 30 * 60_000)}, ${new Date(a.end_at.getTime() + 30 * 60_000)}, 100)`,
    ).rejects.toThrow(/23P01|conflicting key|no_overlap|exclusion/i)
  })

  it('layer 3: a second active item for the same hour is rejected by the unique index', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const w = await walkIn(fx.frontDesk.accessToken, [a.id])
    const other = await walkIn(fx.frontDesk.accessToken, [
      (await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() }))[0].id,
    ])
    await expect(
      app.prisma.$executeRaw`
        INSERT INTO booking_items (id, booking_id, slot_id, court_id, venue_id, start_at, end_at, price_minor)
        VALUES (${uuidv7()}::uuid, ${other.json().data.id}::uuid, ${a.id}::uuid, ${fx.courtId}::uuid, ${fx.venueId}::uuid,
                ${new Date(a.start_at.getTime() + 3_600_000 * 24 * 30)}, ${new Date(a.end_at.getTime() + 3_600_000 * 24 * 30)}, 100)`,
    ).rejects.toThrow(/23505|already exists/i)
    expect(w.statusCode).toBe(201)
  })

  it('a cancelled item leaves the constraint, so the freed hour can be sold again (finding F1)', async () => {
    const [a, b, c] = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    const w = await walkIn(fx.frontDesk.accessToken, [a.id, b.id, c.id])
    expect(w.statusCode).toBe(201)
    const booking = w.json().data
    const middle = booking.items.find((i: { slotId: string }) => i.slotId === b.id)
    // cancel ONLY the middle hour
    const cancel = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/bookings/${booking.id}/cancel`,
      fx.manager.accessToken,
      { itemIds: [middle.id] },
      newCancelKey(),
    )
    expect(cancel.statusCode).toBe(200)
    expect((await slotRow(b.id)).status).toBe('AVAILABLE')
    expect((await slotRow(a.id)).status).toBe('BOOKED_WALKIN')
    expect((await slotRow(c.id)).status).toBe('BOOKED_WALKIN')
    // the freed middle hour is sold to somebody else at once
    const again = await walkIn(fx.frontDesk.accessToken, [b.id])
    expect(again.statusCode).toBe(201)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  })
})

describe('contention is a clean answer, not an error', () => {
  it('a hold that waits too long on a locked hour gets 409 SLOT_UNAVAILABLE (lock timeout), not a 500', async () => {
    const [slot] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    // someone else holds the row lock for 1.5 seconds
    const blocker = app.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM slots WHERE id = ${slot.id}::uuid FOR UPDATE`
        locked()
        await gate
      },
      { timeout: 10_000 },
    )
    await isLocked
    const started = Date.now()
    const r = await holdHours(app, p.accessToken, fx.courtId, [slot.id])
    const took = Date.now() - started
    release()
    await blocker
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('SLOT_UNAVAILABLE')
    expect(r.json().details.reason).toBe('CONTENTION')
    expect(took).toBeLessThan(3000) // lock_timeout is 500 ms: it does not queue forever
    expect((await slotRow(slot.id)).status).toBe('AVAILABLE')
  })
})

describe('mixed soak: holds, walk-ins and blocks hammering 40 hours', () => {
  it('3,000 attempts end with every hour owned by exactly one successful request', async () => {
    const hs = await pickSlots(app.prisma, fx.courtId, 20, { dayOffset: nextDay() })
    const hs2 = await pickSlots(app.prisma, fx.courtId, 20, { dayOffset: nextDay() })
    const pool = [...hs, ...hs2]
    const players = await makeUsers(app, 1500)
    const ownedBy = new Map<string, number>() // slot id -> how many successful requests claimed it
    const claim = (ids: string[]) =>
      ids.forEach((id) => ownedBy.set(id, (ownedBy.get(id) ?? 0) + 1))

    const rnd = (n: number) => Math.floor(Math.random() * n)
    const jobs: Array<() => Promise<void>> = []
    for (let i = 0; i < 3000; i++) {
      const kind = i % 10 // 70% holds, 20% walk-ins, 10% blocks
      const group = rnd(2) ? hs : hs2
      const start = rnd(group.length)
      const len = 1 + rnd(3)
      const ids = group.slice(start, start + len)
      if (kind < 7) {
        const p = players[i % players.length]
        jobs.push(async () => {
          const r = await holdHours(
            app,
            p.accessToken,
            fx.courtId,
            ids.map((s) => s.id),
          )
          if (r.statusCode === 201) claim(ids.map((s) => s.id))
          else expect([400, 409]).toContain(r.statusCode)
        })
      } else if (kind < 9) {
        jobs.push(async () => {
          const r = await walkIn(
            fx.frontDesk.accessToken,
            ids.map((s) => s.id),
          )
          if (r.statusCode === 201) claim(ids.map((s) => s.id))
          else expect([400, 409]).toContain(r.statusCode)
        })
      } else {
        jobs.push(async () => {
          const r = await block(fx.manager.accessToken, ids[0].start_at, ids[ids.length - 1].end_at)
          expect(r.statusCode).toBe(200)
          claim(r.json().data.blockedSlotIds)
        })
      }
    }
    const deadlocksBefore = await deadlockCount(app.prisma)
    // run in waves of 150 so the HTTP layer is busy but the process stays healthy
    for (let i = 0; i < jobs.length; i += 150)
      await Promise.all(jobs.slice(i, i + 150).map((j) => j()))

    // every hour was claimed by AT MOST one successful request, ever
    for (const [id, n] of ownedBy) expect(n, `hour ${id} was sold ${n} times`).toBe(1)
    const rows = await app.prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM slots WHERE id = ANY(${pool.map((s) => s.id)}::uuid[])`
    const notFree = rows.filter((r) => r.status !== 'AVAILABLE')
    // ... and every hour that is not free was claimed by exactly one request
    expect(notFree.length).toBe(ownedBy.size)
    for (const r of notFree) expect(ownedBy.get(r.id)).toBe(1)
    expect(await deadlockCount(app.prisma)).toBe(deadlocksBefore)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
  }, 300_000)
})

let cancelKeyCounter = 0
function newCancelKey() {
  return uuidv7() + String(cancelKeyCounter++).slice(0, 0)
}
void dayAfter
void slotsOn
void newKey
