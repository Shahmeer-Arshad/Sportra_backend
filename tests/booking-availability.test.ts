import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../src/config/env'
import { addDays, todayIn } from '../src/lib/time'
import {
  Fixture,
  addCourt,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  nextIp,
  pickSlots,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let day = 2
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

const get = (path: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: path, headers, remoteAddress: nextIp() })
const url = (date: string, extra = '') =>
  `/api/v1/public/venues/${fx.venueId}/availability?date=${date}${extra}`
const dateOf = (d: Date) => d.toISOString().slice(0, 10)

describe('public availability grid', () => {
  it('lists the day for every active court with price, tag and status, and nothing private', async () => {
    const [a, b, c] = await pickSlots(app.prisma, fx.courtId, 3, { dayOffset: nextDay() })
    const date = dateOf(a.business_date)
    const player = await makeUser(app)
    await holdHours(app, player.accessToken, fx.courtId, [a.id])
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/walkins`,
      fx.frontDesk.accessToken,
      {
        courtId: fx.courtId,
        slotIds: [b.id],
        customerName: 'Secret Customer',
        customerPhone: '03009998888',
      },
    )
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/blocks`,
      fx.manager.accessToken,
      {
        courtIds: [fx.courtId],
        from: c.start_at.toISOString(),
        to: c.end_at.toISOString(),
        reason: 'RAIN',
        note: 'wet pitch',
      },
    )

    const r = await get(url(date))
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.venueId).toBe(fx.venueId)
    expect(d.timezone).toBe('Asia/Karachi')
    expect(d.courts).toEqual([
      { id: fx.courtId, name: 'Court 1', sport: 'FUTSAL_5V5', surface: 'SYNTHETIC_TURF' },
    ])
    expect(d.slots).toHaveLength(20)
    const slot = (id: string) => d.slots.find((s: { id: string }) => s.id === id)
    expect(slot(a.id).status).toBe('HELD') // held by someone else: shown as unavailable
    expect(slot(b.id).status).toBe('BOOKED') // walk-in and app bookings look the same to players
    expect(slot(c.id).status).toBe('BLOCKED')
    expect(slot(a.id)).toMatchObject({
      courtId: fx.courtId,
      priceMinor: 200000,
      priceTag: 'OFF_PEAK',
    })
    expect(Object.keys(slot(a.id)).sort()).toEqual([
      'courtId',
      'endAt',
      'id',
      'priceMinor',
      'priceTag',
      'startAt',
      'status',
      'version',
    ])
    expect(d.slots.filter((s: { status: string }) => s.status === 'AVAILABLE')).toHaveLength(17)
    expect(r.body).not.toMatch(/Secret|03009998888|customer|wet pitch|RAIN|bookingId|holdExpires/i)
  })

  it('is compact enough for a budget phone', async () => {
    const r = await get(
      url(
        dateOf(
          (await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() }))[0].business_date,
        ),
      ),
    )
    expect(r.body.length).toBeLessThan(6000) // one court, one day
  })

  it('answers 304 when nothing changed and gives a new tag when something did', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const date = dateOf(a.business_date)
    const first = await get(url(date))
    const etag = first.headers.etag as string
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    expect(first.headers['cache-control']).toContain('max-age=2')
    const same = await get(url(date), { 'if-none-match': etag })
    expect(same.statusCode).toBe(304)
    expect(same.body).toBe('')
    const player = await makeUser(app)
    await holdHours(app, player.accessToken, fx.courtId, [a.id])
    const changed = await get(url(date), { 'if-none-match': etag })
    expect(changed.statusCode).toBe(200)
    expect(changed.headers.etag).not.toBe(etag)
  })

  it('can be narrowed to one court, and works with the venue slug', async () => {
    const date = dateOf(
      (await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() }))[0].business_date,
    )
    const slug = (await app.prisma.venue.findUnique({ where: { id: fx.venueId } }))!.slug
    const bySlug = await get(`/api/v1/public/venues/${slug}/availability?date=${date}`)
    expect(bySlug.statusCode).toBe(200)
    expect(bySlug.json().data.venueId).toBe(fx.venueId)
    const none = await get(url(date, '&courtId=0198a000-0000-7000-8000-000000000001'))
    expect(none.json().data.slots).toHaveLength(0)
    const one = await get(url(date, `&courtId=${fx.courtId}`))
    expect(one.json().data.slots).toHaveLength(20)
  })

  it('refuses dates outside today..horizon and malformed dates', async () => {
    const today = todayIn()
    expect((await get(url(addDays(today, 1)))).statusCode).toBe(200)
    expect((await get(url(today))).statusCode).toBe(200)
    expect((await get(url(addDays(today, env.SLOT_HORIZON_DAYS)))).statusCode).toBe(200)
    const far = await get(url(addDays(today, env.SLOT_HORIZON_DAYS + 1)))
    expect(far.statusCode).toBe(400)
    expect(far.json().code).toBe('DATE_OUT_OF_RANGE')
    expect((await get(url(addDays(today, -30)))).statusCode).toBe(400)
    for (const bad of ['tomorrow', '2026-13-45', '20261018', ''])
      expect((await get(url(bad))).statusCode, bad).toBe(400)
    expect((await get(`/api/v1/public/venues/${fx.venueId}/availability`)).statusCode).toBe(400)
  })

  it('does not exist for a venue that is not live', async () => {
    const unknown = await get(
      '/api/v1/public/venues/0198a000-0000-7000-8000-000000000001/availability?date=' + todayIn(),
    )
    expect(unknown.statusCode).toBe(404)
    const f = await buildFixture(app)
    const date = dateOf((await pickSlots(app.prisma, f.courtId, 1)).at(0)!.business_date)
    const u = `/api/v1/public/venues/${f.venueId}/availability?date=${date}`
    expect((await get(u)).statusCode).toBe(200)
    const sus = await call(
      app,
      'POST',
      `/api/v1/admin/venues/${f.venueId}/suspend`,
      f.admin.accessToken,
      { reason: 'investigating a complaint' },
    )
    expect(sus.statusCode).toBe(200)
    expect((await get(u)).statusCode).toBe(404)
    // a suspended venue cannot be booked either
    const [slot] = await pickSlots(app.prisma, f.courtId, 1)
    const p = await makeUser(app)
    const hold = await holdHours(app, p.accessToken, f.courtId, [slot.id])
    expect(hold.statusCode).toBe(404)
    await call(app, 'POST', `/api/v1/admin/venues/${f.venueId}/reinstate`, f.admin.accessToken, {
      reason: 'all clear',
    })
    expect((await get(u)).statusCode).toBe(200)
    expect((await holdHours(app, p.accessToken, f.courtId, [slot.id])).statusCode).toBe(201)
  })

  it('hides a court the owner switched off, and it cannot be held', async () => {
    const f = await buildFixture(app)
    const second = await addCourt(app, f, 'Court 2')
    const [a] = await pickSlots(app.prisma, second, 1, { dayOffset: 2 })
    const date = dateOf(a.business_date)
    const u = `/api/v1/public/venues/${f.venueId}/availability?date=${date}`
    expect((await get(u)).json().data.slots).toHaveLength(40)
    const off = await call(
      app,
      'PATCH',
      `/api/v1/pos/venues/${f.venueId}/courts/${second}`,
      f.owner.accessToken,
      { isBookable: false },
    )
    expect(off.statusCode).toBe(200)
    await app.booking.idle()
    const g = (await get(u)).json().data
    expect(g.courts).toHaveLength(1)
    expect(g.slots).toHaveLength(20)
    expect(g.slots.every((s: { courtId: string }) => s.courtId !== second)).toBe(true)
    const p = await makeUser(app)
    expect((await holdHours(app, p.accessToken, second, [a.id])).statusCode).toBe(404)
  })

  it('reads quickly: p95 of 60 requests stays under the 400 ms budget', async () => {
    const date = dateOf(
      (await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() }))[0].business_date,
    )
    const times: number[] = []
    for (let i = 0; i < 60; i++) {
      const t = Date.now()
      const r = await get(url(date))
      times.push(Date.now() - t)
      expect(r.statusCode).toBe(200)
    }
    times.sort((x, y) => x - y)
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(400)
    // and 100 at once
    const burst = await Promise.all(Array.from({ length: 100 }, () => get(url(date))))
    expect(burst.every((r) => r.statusCode === 200)).toBe(true)
  })
})

describe('the staff grid is a different thing', () => {
  it('is never cached and tells staff what players may not know', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/walkins`,
      fx.frontDesk.accessToken,
      {
        courtId: fx.courtId,
        slotIds: [a.id],
        customerName: 'Visible To Staff',
        customerPhone: '03009998888',
      },
    )
    const r = await call(
      app,
      'GET',
      `/api/v1/pos/venues/${fx.venueId}/grid?date=${dateOf(a.business_date)}&courtId=${fx.courtId}`,
      fx.frontDesk.accessToken,
    )
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.headers.etag).toBeUndefined()
    expect(r.body).toContain('Visible To Staff')
  })
})
