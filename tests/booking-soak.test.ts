/**
 * Optional long soak: hammer the inventory with holds, walk-ins and blocks, then prove that every
 * hour was sold at most once. Skipped unless you ask for it:
 *
 *   SOAK=100000 npx vitest run tests/booking-soak.test.ts
 *
 * SOAK is the number of attempts. 20,000 takes about a minute on a laptop; the design target is a
 * 1,000,000-attempt run before launch (Backend_Docs/03 section 10).
 */
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Fixture,
  assertInventoryInvariants,
  buildFixture,
  callKeyed,
  cleanupTestData,
  deadlockCount,
  holdHours,
  makeApp,
  makeUsers,
  slotsOn,
  dayAfter,
} from './helpers'

const ATTEMPTS = Number(process.env.SOAK ?? 0)
const run = ATTEMPTS > 0 ? describe : describe.skip

let app: FastifyInstance
let fx: Fixture

beforeAll(async () => {
  if (!ATTEMPTS) return
  app = await makeApp()
  fx = await buildFixture(app, { name: 'Soak Arena' })
}, 90_000)
afterAll(async () => {
  if (!ATTEMPTS) return
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

run(`soak: ${ATTEMPTS} attempts`, () => {
  it('no hour is ever sold twice', async () => {
    const days = Math.min(55, Math.max(12, Math.ceil(ATTEMPTS / 2000))) // 20 hours a day on one court
    const pool = (
      await Promise.all(
        Array.from({ length: days }, (_, i) => slotsOn(app.prisma, fx.courtId, dayAfter(2 + i))),
      )
    ).flat()
    const players = await makeUsers(app, Math.min(5000, Math.max(200, Math.floor(ATTEMPTS / 4))))
    const claimed = new Map<string, number>()
    const claim = (ids: string[]) =>
      ids.forEach((id) => claimed.set(id, (claimed.get(id) ?? 0) + 1))
    const rnd = (n: number) => Math.floor(Math.random() * n)
    const deadlocksBefore = await deadlockCount(app.prisma)
    let ok = 0
    let refused = 0

    const attempt = async (i: number) => {
      // a window of 1-3 consecutive hours inside one business day
      const start = rnd(pool.length - 3)
      const day = pool[start].business_date.getTime()
      const win = pool
        .slice(start, start + 1 + rnd(3))
        .filter((s) => s.business_date.getTime() === day)
      const ids = win.map((s) => s.id)
      const kind = i % 10
      if (kind < 7) {
        const r = await holdHours(app, players[i % players.length].accessToken, fx.courtId, ids)
        if (r.statusCode === 201) {
          claim(ids)
          ok++
        } else {
          expect([400, 409]).toContain(r.statusCode)
          refused++
        }
      } else if (kind < 9) {
        const r = await callKeyed(
          app,
          'POST',
          `/api/v1/pos/venues/${fx.venueId}/walkins`,
          fx.frontDesk.accessToken,
          {
            courtId: fx.courtId,
            slotIds: ids,
            customerName: 'Soak',
            customerPhone: '03001234567',
          },
        )
        if (r.statusCode === 201) {
          claim(ids)
          ok++
        } else {
          expect([400, 409]).toContain(r.statusCode)
          refused++
        }
      } else {
        const r = await callKeyed(
          app,
          'POST',
          `/api/v1/pos/venues/${fx.venueId}/blocks`,
          fx.manager.accessToken,
          {
            courtIds: [fx.courtId],
            from: win[0].start_at.toISOString(),
            to: win[win.length - 1].end_at.toISOString(),
            reason: 'OTHER',
          },
        )
        expect(r.statusCode).toBe(200)
        claim(r.json().data.blockedSlotIds)
        ok++
      }
    }

    for (let i = 0; i < ATTEMPTS; i += 200) {
      await Promise.all(
        Array.from({ length: Math.min(200, ATTEMPTS - i) }, (_, k) => attempt(i + k)),
      )
    }

    for (const [id, n] of claimed) expect(n, `hour ${id} was sold ${n} times`).toBe(1)
    const rows = await app.prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM slots WHERE id = ANY(${pool.map((s) => s.id)}::uuid[])`
    const notFree = rows.filter((r) => r.status !== 'AVAILABLE')
    expect(notFree.length).toBe(claimed.size)
    expect(await deadlockCount(app.prisma)).toBe(deadlocksBefore)
    await assertInventoryInvariants(app.prisma, [fx.courtId])
    console.log(
      `soak: ${ATTEMPTS} attempts, ${ok} accepted, ${refused} refused, ${claimed.size} hours owned, 0 double sales`,
    )
  }, 3_600_000)
})
