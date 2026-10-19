/**
 * A hold that runs out is released shortly afterwards by an in-process timer, which also tells the
 * connected phones. (Correctness never depends on it; this test is about the live experience.)
 * This file uses a 2 second hold, so the settings are changed before the app is loaded.
 */
import { AddressInfo } from 'net'
import { FastifyInstance } from 'fastify'
import { Socket, io } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as h from './helpers'

// runs before the imports above are evaluated, so the app reads a 2 second hold
vi.hoisted(() => {
  process.env.HOLD_SECONDS = '2'
})

let app: FastifyInstance
let fx: Awaited<ReturnType<typeof h.buildFixture>>
let port: number
const sockets: Socket[] = []

beforeAll(async () => {
  app = await h.makeApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as AddressInfo).port
  fx = await h.buildFixture(app)
}, 60_000)
afterAll(async () => {
  sockets.forEach((s) => s.disconnect())
  await app.booking.idle()
  await h.cleanupTestData(app.prisma)
  await app.close()
})

describe('hold expiry, live', () => {
  it('frees the hour and tells watchers a moment after the 2 second hold ends, with no sweeper running', async () => {
    const [a] = await h.pickSlots(app.prisma, fx.courtId, 1, { dayOffset: 2 })
    const date = a.business_date.toISOString().slice(0, 10)
    const watcher = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      transports: ['websocket'],
      forceNew: true,
    })
    sockets.push(watcher)
    await new Promise<void>((r) => watcher.on('connect', () => r()))
    await new Promise((r) => watcher.emit('join', `venue:${fx.venueId}:date:${date}`, r))
    const events: Array<{ status: string; version: number }> = []
    watcher.on('slot.updated', (e) => events.push(e))

    const p = await h.makeUser(app)
    const r = await h.holdHours(app, p.accessToken, fx.courtId, [a.id])
    expect(r.statusCode).toBe(201)
    expect(r.json().data.secondsRemaining).toBeLessThanOrEqual(2)

    const start = Date.now()
    while (events.length < 2 && Date.now() - start < 6000)
      await new Promise((x) => setTimeout(x, 25))
    expect(events.map((e) => e.status)).toEqual(['HELD', 'AVAILABLE'])
    expect(events[1].version).toBe(events[0].version + 1)
    expect(Date.now() - start).toBeLessThan(4500) // about 2 s hold + a fraction of a second
    const [row] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM slots WHERE id = ${a.id}::uuid`
    expect(row.status).toBe('AVAILABLE')
    const [bk] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM bookings WHERE id = ${r.json().data.id}::uuid`
    expect(bk.status).toBe('EXPIRED')
  })

  it('a hold that is confirmed in time is not released by that timer', async () => {
    await h.call(
      app,
      'PATCH',
      `/api/v1/pos/venues/${fx.venueId}/booking-settings`,
      fx.owner.accessToken,
      { payAtVenueEnabled: true },
    )
    const [a] = await h.pickSlots(app.prisma, fx.courtId, 1, { dayOffset: 3 })
    const p = await h.makeUser(app)
    const hold = (await h.holdHours(app, p.accessToken, fx.courtId, [a.id])).json().data
    const c = await h.callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${hold.id}/confirm-pay-at-venue`,
      p.accessToken,
    )
    expect(c.statusCode).toBe(200)
    await new Promise((x) => setTimeout(x, 2800))
    const [row] = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM slots WHERE id = ${a.id}::uuid`
    expect(row.status).toBe('BOOKED_APP')
  })

  it('two holds expiring in the same instant need only one sweep', async () => {
    const hs = await h.pickSlots(app.prisma, fx.courtId, 2, { dayOffset: 4 })
    const [p1, p2] = await h.makeUsers(app, 2)
    const r = await Promise.all([
      h.holdHours(app, p1.accessToken, fx.courtId, [hs[0].id]),
      h.holdHours(app, p2.accessToken, fx.courtId, [hs[1].id]),
    ])
    expect(r.every((x) => x.statusCode === 201)).toBe(true)
    await new Promise((x) => setTimeout(x, 2800))
    const rows = await app.prisma.$queryRaw<
      { status: string }[]
    >`SELECT status FROM slots WHERE id = ANY(${hs.map((s) => s.id)}::uuid[])`
    expect(rows.every((x) => x.status === 'AVAILABLE')).toBe(true)
  })
})
