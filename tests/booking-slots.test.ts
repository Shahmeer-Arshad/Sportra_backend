import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../src/config/env'
import { uuidv7 } from '../src/lib/id'
import { addDays, todayIn } from '../src/lib/time'
import {
  Fixture,
  buildDraftVenue,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  hours,
  makeApp,
  makeUser,
  pickSlots,
  signupVerified,
  slotsOn,
  tomorrow,
  ownerEdit,
  PHOTO,
} from './helpers'

let app: FastifyInstance
let fx: Fixture

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
})
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

describe('slot generation', () => {
  it('approving a venue creates the whole 60-day horizon: 20 hourly slots a day for 06:00-02:00', async () => {
    const [{ n, days }] = await app.prisma.$queryRaw<{ n: number; days: number }[]>`
      SELECT count(*)::int AS n, count(DISTINCT business_date)::int AS days FROM slots WHERE court_id = ${fx.courtId}::uuid`
    expect(days).toBe(env.SLOT_HORIZON_DAYS)
    expect(n).toBe(env.SLOT_HORIZON_DAYS * 20)
    const bad = await app.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM slots WHERE court_id = ${fx.courtId}::uuid AND (status <> 'AVAILABLE' OR version <> 0)`
    expect(bad[0].n).toBe(0)
  })

  it('a slot after midnight belongs to the previous business date; all others to their own day', async () => {
    const [{ wrong }] = await app.prisma.$queryRaw<{ wrong: number }[]>`
      SELECT count(*)::int AS wrong FROM slots
       WHERE court_id = ${fx.courtId}::uuid
         AND business_date <> CASE WHEN EXTRACT(HOUR FROM start_at AT TIME ZONE 'Asia/Karachi') < 6
                                   THEN (start_at AT TIME ZONE 'Asia/Karachi')::date - 1
                                   ELSE (start_at AT TIME ZONE 'Asia/Karachi')::date END`
    expect(wrong).toBe(0)
    const day = await slotsOn(app.prisma, fx.courtId, tomorrow())
    expect(day).toHaveLength(20)
    // the last slot of the business day starts at 01:00 local the next calendar day
    const last = day[day.length - 1].start_at
    expect(last.toISOString()).toBe(
      new Date(Date.parse(`${addDays(tomorrow(), 1)}T01:00:00+05:00`)).toISOString(),
    )
  })

  it('prices follow the rules: day band off-peak, evening band peak', async () => {
    const day = await slotsOn(app.prisma, fx.courtId, tomorrow())
    expect(day[0].price_minor).toBe(200000n) // 06:00
    expect(day[12].price_minor).toBe(300000n) // 18:00
    const tags = await app.prisma.$queryRaw<{ price_tag: string }[]>`
      SELECT price_tag FROM slots WHERE id = ${day[12].id}::uuid`
    expect(tags[0].price_tag).toBe('PEAK')
  })

  it('running generation again changes nothing (idempotent)', async () => {
    const before = await app.prisma.$queryRaw<{ n: number; v: number }[]>`
      SELECT count(*)::int AS n, COALESCE(sum(version), 0)::int AS v FROM slots WHERE court_id = ${fx.courtId}::uuid`
    const r = await app.booking.slots.generateForCourt(fx.courtId)
    expect(r.inserted).toBe(0)
    expect(r.repriced).toBe(0)
    expect(r.deleted).toBe(0)
    const after = await app.prisma.$queryRaw<{ n: number; v: number }[]>`
      SELECT count(*)::int AS n, COALESCE(sum(version), 0)::int AS v FROM slots WHERE court_id = ${fx.courtId}::uuid`
    expect(after[0]).toEqual(before[0])
  })

  it('a draft (unverified) venue gets no slots', async () => {
    const owner = await signupVerified(app)
    const draft = await buildDraftVenue(app, owner)
    const r = await app.booking.slots.generateForCourt(draft.courtId)
    expect(r.planned).toBe(0)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM slots WHERE court_id = ${draft.courtId}::uuid`
    expect(n).toBe(0)
  })

  it('a price change refreshes FUTURE AVAILABLE hours only; held and booked hours keep their price', async () => {
    const f = await buildFixture(app)
    const rules = (
      await call(app, 'GET', `/api/v1/pos/venues/${f.venueId}/pricing-rules`, f.owner.accessToken)
    ).json().data
    const evening = rules.find((r: { name: string }) => r.name === 'Evening')
    const day = await slotsOn(app.prisma, f.courtId, tomorrow())
    const booked = day[12] // 18:00, peak
    const held = day[13]
    const player = await makeUser(app)
    expect((await holdHours(app, player.accessToken, f.courtId, [held.id])).statusCode).toBe(201)
    const w = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${f.venueId}/walkins`,
      f.frontDesk.accessToken,
      {
        courtId: f.courtId,
        slotIds: [booked.id],
        customerName: 'Walk In',
        customerPhone: '03001234567',
      },
    )
    expect(w.statusCode).toBe(201)

    // a price edit is "delete the band, add it again at the new price" (each waits for an admin)
    expect(
      (
        await ownerEdit(
          app,
          f,
          'DELETE',
          `/api/v1/pos/venues/${f.venueId}/pricing-rules/${evening.id}`,
        )
      ).statusCode,
    ).toBe(200)
    const re = await ownerEdit(app, f, 'POST', `/api/v1/pos/venues/${f.venueId}/pricing-rules`, {
      courtId: f.courtId,
      name: 'Evening',
      dayType: 'ANY',
      fromTime: '18:00',
      toTime: '02:00',
      priceMinor: 350000,
      tag: 'PEAK',
    })
    expect(re.statusCode).toBe(201)
    await app.booking.idle()

    const after = await slotsOn(app.prisma, f.courtId, tomorrow())
    expect(after[12].price_minor).toBe(300000n) // booked: unchanged
    expect(after[13].price_minor).toBe(300000n) // held: unchanged
    expect(after[14].price_minor).toBe(350000n) // free: new price
    expect(after).toHaveLength(20) // the free evening hours exist again after the band was re-added
    expect(after[0].price_minor).toBe(200000n) // other band untouched
  })

  it('shrinking opening hours deletes free hours outside them and reports booked ones as conflicts', async () => {
    const f = await buildFixture(app)
    const day = await slotsOn(app.prisma, f.courtId, tomorrow())
    const early = day[0] // 06:00 local
    const w = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${f.venueId}/walkins`,
      f.frontDesk.accessToken,
      {
        courtId: f.courtId,
        slotIds: [early.id],
        customerName: 'Early Bird',
        customerPhone: '03001234567',
      },
    )
    expect(w.statusCode).toBe(201)
    const patch = await ownerEdit(app, f, 'PATCH', `/api/v1/pos/venues/${f.venueId}`, {
      operatingHours: hours('08:00', '22:00'),
    })
    expect(patch.statusCode).toBe(200)
    await app.booking.idle()

    const after = await slotsOn(app.prisma, f.courtId, tomorrow())
    // 08:00..21:00 = 14 free hours, plus the booked 06:00 hour that must never be touched
    expect(after).toHaveLength(15)
    expect(after[0].id).toBe(early.id)
    expect(after[0].status).toBe('BOOKED_WALKIN')
    const report = await app.booking.slots.generateForCourt(f.courtId)
    expect(report.orphaned.map((o) => o.slotId)).toContain(early.id)
    expect(report.deleted).toBe(0)
  })

  it('a deactivated court gets no new slots', async () => {
    const f = await buildFixture(app)
    await app.prisma.court.update({ where: { id: f.courtId }, data: { isActive: false } })
    await app.prisma.$executeRaw`DELETE FROM slots WHERE court_id = ${f.courtId}::uuid`
    const r = await app.booking.slots.generateForCourt(f.courtId)
    expect(r.planned).toBe(0)
  })

  it('a second court added later gets its own slots', async () => {
    const f = await buildFixture(app)
    const second = await ownerEdit(app, f, 'POST', `/api/v1/pos/venues/${f.venueId}/courts`, {
      name: 'Court 2',
      sport: 'PADEL',
      surface: 'GLASS_PADEL',
      environment: 'INDOOR',
      images: [PHOTO],
    })
    expect(second.statusCode).toBe(201)
    const id2 = second.data.id as string
    for (const r of [
      { name: 'Day', fromTime: '06:00', toTime: '18:00', priceMinor: 400000, tag: 'OFF_PEAK' },
      { name: 'Eve', fromTime: '18:00', toTime: '02:00', priceMinor: 500000, tag: 'PEAK' },
    ])
      await ownerEdit(app, f, 'POST', `/api/v1/pos/venues/${f.venueId}/pricing-rules`, {
        courtId: id2,
        dayType: 'ANY',
        ...r,
      })
    await app.booking.idle()
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM slots WHERE court_id = ${id2}::uuid`
    expect(n).toBe(env.SLOT_HORIZON_DAYS * 20)
  })

  it('the nightly job extends the horizon for verified venues without duplicating anything', async () => {
    // pretend the horizon was never filled beyond 15 days
    await app.prisma
      .$executeRaw`DELETE FROM slots WHERE court_id = ${fx.courtId}::uuid AND business_date > ${addDays(todayIn(), 14)}::date`
    const r = await app.booking.slots.generateAll([fx.venueId])
    expect(r.venues).toBe(1)
    const [{ n }] = await app.prisma.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM slots WHERE court_id = ${fx.courtId}::uuid`
    expect(n).toBe(env.SLOT_HORIZON_DAYS * 20)
  })

  it('the unique key makes a duplicate slot row impossible (layer 2)', async () => {
    const [s] = await slotsOn(app.prisma, fx.courtId, tomorrow())
    await expect(
      app.prisma
        .$executeRaw`INSERT INTO slots (id, court_id, venue_id, start_at, end_at, business_date, price_minor, price_tag)
        SELECT ${uuidv7()}::uuid, court_id, venue_id, start_at, end_at, business_date, price_minor, price_tag FROM slots WHERE id = ${s.id}::uuid`,
    ).rejects.toThrow()
  })

  it('rejects an impossible slot state at the database level', async () => {
    const [s] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: 5 })
    // HELD without a hold id / expiry violates slots_hold_check
    await expect(
      app.prisma.$executeRaw`UPDATE slots SET status = 'HELD' WHERE id = ${s.id}::uuid`,
    ).rejects.toThrow()
  })
})
