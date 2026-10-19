import { AddressInfo } from 'net'
import { FastifyInstance } from 'fastify'
import Redis from 'ioredis'
import { Socket, io } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../src/config/env'
import { createHotLane } from '../src/lib/hotlane'
import {
  Fixture,
  addStaff,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  newUuidKey,
  pickSlots,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let other: Fixture
let port: number
let day = 2
const nextDay = () => day++
const sockets: Socket[] = []

beforeAll(async () => {
  app = await makeApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as AddressInfo).port
  fx = await buildFixture(app)
  other = await buildFixture(app, { name: 'Other Arena' })
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
afterEach(() => {
  while (sockets.length) sockets.pop()!.disconnect()
})
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const connect = (token?: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = io(`http://127.0.0.1:${port}`, {
      path: '/realtime',
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    sockets.push(s)
    s.on('connect', () => resolve(s))
    s.on('connect_error', reject)
  })
const join = (s: Socket, room: string) =>
  new Promise<{ ok: boolean; code?: string }>((resolve) => s.emit('join', room, resolve))
const listen = <T = Record<string, unknown>>(s: Socket, event: string) => {
  const got: T[] = []
  s.on(event, (e: T) => got.push(e))
  return got
}
const until = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for the event')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const dateOf = (d: Date) => d.toISOString().slice(0, 10)
const room = (venueId: string, date: string) => `venue:${venueId}:date:${date}`

describe('slot changes reach everyone watching, in the right shape', () => {
  it('an anonymous player in the day room gets a reduced update; staff in the POS room get the full one', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const date = dateOf(a.business_date)
    const watcher = await connect()
    const staff = await connect(fx.frontDesk.accessToken)
    expect((await join(watcher, room(fx.venueId, date))).ok).toBe(true)
    expect((await join(staff, `pos:${fx.venueId}`)).ok).toBe(true)
    const pub = listen(watcher, 'slot.updated')
    const pos = listen(staff, 'slot.updated')

    const player = await makeUser(app)
    const h = (await holdHours(app, player.accessToken, fx.courtId, [a.id])).json().data
    await until(() => pub.length >= 1 && pos.length >= 1)

    expect(pub[0]).toMatchObject({
      type: 'slot.updated',
      slotId: a.id,
      courtId: fx.courtId,
      status: 'HELD',
      version: a.version + 1,
    })
    expect(JSON.stringify(pub[0])).not.toMatch(/bookingId|blockReason|holdExpiresAt/)
    expect(pos[0]).toMatchObject({
      slotId: a.id,
      status: 'HELD',
      version: a.version + 1,
      bookingId: h.id,
    })
    expect(pos[0].holdExpiresAt).toBeTruthy()
  })

  it('a walk-in shows as BOOKED to players and BOOKED_WALKIN to staff, and versions only go up', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const watcher = await connect()
    const staff = await connect(fx.manager.accessToken)
    await join(watcher, room(fx.venueId, dateOf(a.business_date)))
    await join(staff, `pos:${fx.venueId}`)
    const pub = listen<{ slotId: string; status: string; version: number }>(watcher, 'slot.updated')
    const pos = listen<{ slotId: string; status: string; version: number }>(staff, 'slot.updated')

    const w = await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/walkins`,
      fx.frontDesk.accessToken,
      {
        courtId: fx.courtId,
        slotIds: [a.id],
        customerName: 'Walk In',
        customerPhone: '03001234567',
      },
    )
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/bookings/${w.json().data.id}/cancel`,
      fx.manager.accessToken,
      {},
      newUuidKey(),
    )
    await until(() => pub.length >= 2 && pos.length >= 2)
    expect(pub.map((e) => e.status)).toEqual(['BOOKED', 'AVAILABLE'])
    expect(pos.map((e) => e.status)).toEqual(['BOOKED_WALKIN', 'AVAILABLE'])
    expect(pos.map((e) => e.version)).toEqual([a.version + 1, a.version + 2])
  })

  it('hold, release and a second hold give strictly increasing versions so clients can ignore stale events', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const watcher = await connect()
    await join(watcher, room(fx.venueId, dateOf(a.business_date)))
    const got = listen<{ slotId: string; status: string; version: number }>(watcher, 'slot.updated')
    const p1 = await makeUser(app)
    const p2 = await makeUser(app)
    const h1 = (await holdHours(app, p1.accessToken, fx.courtId, [a.id])).json().data
    await call(app, 'DELETE', `/api/v1/bookings/${h1.id}/hold`, p1.accessToken)
    await holdHours(app, p2.accessToken, fx.courtId, [a.id])
    await until(() => got.length >= 3)
    expect(got.map((e) => e.status)).toEqual(['HELD', 'AVAILABLE', 'HELD'])
    expect(got.map((e) => e.version)).toEqual([a.version + 1, a.version + 2, a.version + 3])
  })

  it('the client rule "apply only a newer version" gives the right state whatever order events arrive in', () => {
    type Cell = { status: string; version: number }
    const apply = (cur: Cell, e: Cell) => (e.version > cur.version ? e : cur)
    const events = [
      { status: 'HELD', version: 3 },
      { status: 'AVAILABLE', version: 2 }, // late
      { status: 'HELD', version: 1 }, // very late
    ]
    expect(events.reduce(apply, { status: 'AVAILABLE', version: 0 })).toEqual({
      status: 'HELD',
      version: 3,
    })
    const sorted = [...events]
      .sort((x, y) => x.version - y.version)
      .reduce(apply, { status: 'AVAILABLE', version: 0 })
    expect(sorted).toEqual({ status: 'HELD', version: 3 })
  })

  it('players hear about their own booking and nobody else does', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const me = await makeUser(app)
    const someone = await makeUser(app)
    const mine = await connect(me.accessToken)
    const theirs = await connect(someone.accessToken)
    expect((await join(mine, `user:${me.id}`)).ok).toBe(true)
    expect((await join(theirs, `user:${someone.id}`)).ok).toBe(true)
    const myEvents = listen<{ bookingId: string; status: string }>(mine, 'booking.updated')
    const theirEvents = listen(theirs, 'booking.updated')
    const h = (await holdHours(app, me.accessToken, fx.courtId, [a.id])).json().data
    await callKeyed(app, 'POST', `/api/v1/bookings/${h.id}/confirm-pay-at-venue`, me.accessToken)
    await until(() => myEvents.length >= 2)
    expect(myEvents.map((e) => e.status)).toEqual(['PENDING_PAYMENT', 'CONFIRMED'])
    expect(myEvents.every((e) => e.bookingId === h.id)).toBe(true)
    await quiet()
    expect(theirEvents).toHaveLength(0)
  })

  it('grid.changed tells watchers to re-fetch when the venue changes its hours or prices', async () => {
    const watcher = await connect()
    await join(watcher, `venue:${fx.venueId}`)
    const got = listen(watcher, 'grid.changed')
    app.hotLane.publish({ type: 'grid.changed', venueId: fx.venueId })
    await until(() => got.length >= 1)
    expect(got[0]).toMatchObject({ type: 'grid.changed', venueId: fx.venueId })
  })
})

describe('who may listen to what', () => {
  it('staff of venue A cannot join the POS room of venue B, and neither can players or anonymous visitors', async () => {
    const staffA = await connect(fx.frontDesk.accessToken)
    expect((await join(staffA, `pos:${fx.venueId}`)).ok).toBe(true)
    const denied = await join(staffA, `pos:${other.venueId}`)
    expect(denied).toEqual({ ok: false, code: 'FORBIDDEN' })
    const ownerA = await connect(fx.owner.accessToken)
    expect((await join(ownerA, `pos:${other.venueId}`)).ok).toBe(false)
    const player = await connect((await makeUser(app)).accessToken)
    expect((await join(player, `pos:${fx.venueId}`)).ok).toBe(false)
    const anon = await connect()
    expect((await join(anon, `pos:${fx.venueId}`)).ok).toBe(false)
    // a denied socket receives nothing from that venue
    const got = listen(staffA, 'slot.updated')
    const [a] = await pickSlots(app.prisma, other.courtId, 1, { dayOffset: nextDay() })
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${other.venueId}/walkins`,
      other.frontDesk.accessToken,
      {
        courtId: other.courtId,
        slotIds: [a.id],
        customerName: 'x',
        customerPhone: '03001234567',
      },
    )
    await quiet()
    expect(got).toHaveLength(0)
  })

  it('a scorer or a deactivated staff member cannot watch the POS grid; an admin can (support)', async () => {
    const scorer = await makeUser(app)
    await addStaff(app.prisma, fx.venueId, scorer.id, 'SCORER')
    expect((await join(await connect(scorer.accessToken), `pos:${fx.venueId}`)).ok).toBe(false)
    const gone = await makeUser(app)
    await addStaff(app.prisma, fx.venueId, gone.id, 'FRONT_DESK')
    await app.prisma.venueMembership.updateMany({
      where: { userId: gone.id },
      data: { isActive: false },
    })
    expect((await join(await connect(gone.accessToken), `pos:${fx.venueId}`)).ok).toBe(false)
    expect((await join(await connect(fx.admin.accessToken), `pos:${fx.venueId}`)).ok).toBe(true)
  })

  it('a player can only join their own user room', async () => {
    const me = await makeUser(app)
    const you = await makeUser(app)
    const s = await connect(me.accessToken)
    expect((await join(s, `user:${me.id}`)).ok).toBe(true)
    expect(await join(s, `user:${you.id}`)).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect((await join(await connect(), `user:${me.id}`)).ok).toBe(false)
  })

  it('refuses room names that are not part of the protocol', async () => {
    const s = await connect(fx.admin.accessToken)
    for (const bad of [
      '*',
      'admin',
      'pos:',
      'pos:../x',
      `pos:${fx.venueId}:extra`,
      'venue:abc',
      `venue:${fx.venueId}:date:tomorrow`,
      '',
      'user:1',
    ]) {
      const r = await join(s, bad)
      expect(r.ok, bad).toBe(false)
      expect(r.code, bad).toBe('INVALID_ROOM')
    }
    const r = await new Promise<{ ok: boolean; code?: string }>((resolve) =>
      s.emit('join', { room: 'pos' }, resolve),
    )
    expect(r.code).toBe('INVALID_ROOM')
  })

  it('one client cannot join an unlimited number of rooms', async () => {
    const s = await connect()
    let refused = 0
    for (let i = 0; i < 40; i++) {
      const r = await join(
        s,
        `venue:${fx.venueId}:date:2032-01-${String((i % 28) + 1).padStart(2, '0')}`,
      )
      if (!r.ok && r.code === 'TOO_MANY_ROOMS') refused++
    }
    expect(refused).toBeGreaterThan(0)
    expect(s.connected).toBe(true)
  })

  it('a bad or revoked token cannot connect at all', async () => {
    await expect(connect('not-a-token')).rejects.toBeTruthy()
    const u = await makeUser(app)
    await app.prisma.user.update({
      where: { id: u.id },
      data: { tokenValidAfter: new Date(Date.now() + 60_000) },
    })
    await expect(connect(u.accessToken)).rejects.toBeTruthy()
    const suspended = await makeUser(app)
    await app.prisma.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } })
    await expect(connect(suspended.accessToken)).rejects.toBeTruthy()
  })
})

describe('long-lived sockets stay authorised', () => {
  it('staff removed from a venue stop receiving its live grid at once', async () => {
    const temp = await makeUser(app)
    await addStaff(app.prisma, fx.venueId, temp.id, 'FRONT_DESK')
    const s = await connect(temp.accessToken)
    expect((await join(s, `pos:${fx.venueId}`)).ok).toBe(true)
    const removed = listen(s, 'room.removed')
    const got = listen(s, 'slot.updated')
    await app.prisma.venueMembership.updateMany({
      where: { userId: temp.id },
      data: { isActive: false },
    })
    await app.realtime.revalidate()
    await until(() => removed.length === 1)
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/walkins`,
      fx.frontDesk.accessToken,
      {
        courtId: fx.courtId,
        slotIds: [a.id],
        customerName: 'x',
        customerPhone: '03001234567',
      },
    )
    await quiet()
    expect(got).toHaveLength(0)
  })

  it('an expired token is dropped; a refreshed one keeps the socket', async () => {
    const u = await makeUser(app)
    const shortLived = () =>
      app.jwt.sign({ sub: u.id, email: u.email, role: 'USER' }, { expiresIn: '2s' })
    const dying = await connect(shortLived())
    const kept = await connect(shortLived())
    const expired = new Promise<void>((resolve) => dying.on('auth.expired', () => resolve()))
    const fresh = await new Promise<{ ok: boolean }>((resolve) =>
      kept.emit('reauth', app.jwt.sign({ sub: u.id, email: u.email, role: 'USER' }), resolve),
    )
    expect(fresh.ok).toBe(true)
    await quiet(2300)
    const dropped = await app.realtime.revalidate()
    expect(dropped).toBe(1)
    await expired
    await until(() => dying.disconnected)
    expect(kept.connected).toBe(true)
    // somebody else's token cannot be swapped in
    const other = await makeUser(app)
    const bad = await new Promise<{ ok: boolean }>((resolve) =>
      kept.emit(
        'reauth',
        app.jwt.sign({ sub: other.id, email: other.email, role: 'USER' }),
        resolve,
      ),
    )
    expect(bad.ok).toBe(false)
  })

  it('a user suspended while connected is dropped on the next check', async () => {
    const u = await makeUser(app)
    const s = await connect(u.accessToken)
    await app.prisma.user.update({ where: { id: u.id }, data: { status: 'SUSPENDED' } })
    await app.realtime.revalidate()
    await until(() => s.disconnected)
  })
})

describe('after a reconnect the client re-fetches the grid and is consistent', () => {
  it('everything missed while offline is in the grid, with versions at least as new as any event seen', async () => {
    const [a, b] = await pickSlots(app.prisma, fx.courtId, 2, { dayOffset: nextDay() })
    const date = dateOf(a.business_date)
    let s = await connect()
    await join(s, room(fx.venueId, date))
    const seen = listen<{ slotId: string; version: number }>(s, 'slot.updated')
    const p1 = await makeUser(app)
    await holdHours(app, p1.accessToken, fx.courtId, [a.id])
    await until(() => seen.length >= 1)
    s.disconnect() // the phone loses signal
    const p2 = await makeUser(app)
    await holdHours(app, p2.accessToken, fx.courtId, [b.id])
    await callKeyed(
      app,
      'POST',
      `/api/v1/pos/venues/${fx.venueId}/blocks`,
      fx.manager.accessToken,
      {
        courtIds: [fx.courtId],
        from: a.end_at.toISOString(),
        to: b.start_at.toISOString(),
        reason: 'RAIN',
      },
    )
    // signal returns: reconnect, join again, re-fetch the grid
    s = await connect()
    await join(s, room(fx.venueId, date))
    const grid = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/public/venues/${fx.venueId}/availability?date=${date}`,
      })
    ).json().data
    const cell = (id: string) => grid.slots.find((x: { id: string }) => x.id === id)
    expect(cell(a.id).status).toBe('HELD')
    expect(cell(b.id).status).toBe('HELD')
    expect(cell(a.id).version).toBeGreaterThanOrEqual(seen[0].version)
  })
})

describe('the hot lane works across processes and survives Redis trouble', () => {
  it('an update published by another process (the worker) reaches connected clients through Redis', async () => {
    if (!app.hotLane.viaRedis) return // Redis not configured in this environment
    const redis = new Redis(env.REDIS_URL!)
    const workerLane = createHotLane(redis)
    const watcher = await connect()
    await join(watcher, room(fx.venueId, '2030-01-01'))
    const got = listen<{ slotId: string; status: string }>(watcher, 'slot.updated')
    workerLane.publish({
      type: 'slot.updated',
      venueId: fx.venueId,
      courtId: fx.courtId,
      slotId: 'swept-slot',
      businessDate: '2030-01-01',
      status: 'AVAILABLE',
      version: 9,
    })
    await until(() => got.length >= 1)
    expect(got[0]).toMatchObject({ slotId: 'swept-slot', status: 'AVAILABLE' })
    await workerLane.close()
    redis.disconnect()
  })

  it('if Redis is unreachable, a process still tells its own clients (correctness never depended on it)', async () => {
    const broken = {
      publish: () => Promise.reject(new Error('redis is down')),
      duplicate: () => ({
        on: () => undefined,
        subscribe: () => Promise.resolve(),
        disconnect: () => undefined,
      }),
    } as unknown as Redis
    const errors: string[] = []
    const lane = createHotLane(broken, (e) => errors.push(e.message))
    const seen: unknown[] = []
    lane.subscribe((m) => seen.push(m))
    lane.publish({ type: 'slot.updated', slotId: 's' })
    await until(() => seen.length === 1)
    expect(errors).toContain('redis is down')
    await lane.close()
  })

  it('without Redis at all, messages are delivered in-process', async () => {
    const lane = createHotLane(null)
    const seen: unknown[] = []
    lane.subscribe((m) => seen.push(m))
    lane.publish({ type: 'x' })
    expect(seen).toHaveLength(1)
    expect(lane.viaRedis).toBe(false)
  })

  it('a listener that throws does not stop the others', () => {
    const lane = createHotLane(null)
    const seen: unknown[] = []
    lane.subscribe(() => {
      throw new Error('bad listener')
    })
    lane.subscribe((m) => seen.push(m))
    lane.publish({ type: 'x' })
    expect(seen).toHaveLength(1)
  })
})

describe('speed', () => {
  it('commit to emit stays under 100 ms (p95) with 100 sockets and 300 updates', async () => {
    const date = '2031-02-02'
    const clients = await Promise.all(Array.from({ length: 100 }, () => connect()))
    await Promise.all(clients.map((c) => join(c, room(fx.venueId, date))))
    let received = 0
    for (const c of clients) c.on('slot.updated', () => received++)
    for (let i = 0; i < 300; i++) {
      app.hotLane.publish({
        type: 'slot.updated',
        venueId: fx.venueId,
        courtId: fx.courtId,
        slotId: `s${i}`,
        businessDate: date,
        status: 'HELD',
        version: i,
      })
      if (i % 30 === 0) await quiet(5)
    }
    await until(() => received >= 100 * 300, 15_000)
    const st = app.realtime.stats()
    expect(st.connections).toBeGreaterThanOrEqual(100)
    expect(st.p95LatencyMs).not.toBeNull()
    expect(st.p95LatencyMs!).toBeLessThan(100)
  }, 60_000)
})

describe('server-sent events fallback', () => {
  async function readUntil(url: string, headers: Record<string, string>, want: RegExp) {
    const ctl = new AbortController()
    const res = await fetch(url, { headers, signal: ctl.signal })
    return {
      res,
      ctl,
      text: async () => {
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ''
        const start = Date.now()
        while (!want.test(buf) && Date.now() - start < 5000) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value)
        }
        ctl.abort()
        return buf
      },
    }
  }

  it('streams the public day room to a client that cannot use WebSockets', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const stream = await readUntil(
      `http://127.0.0.1:${port}/api/v1/realtime/stream?venueId=${fx.venueId}&date=${dateOf(a.business_date)}`,
      {},
      /event: slot\.updated[\s\S]*\n\n/,
    )
    expect(stream.res.status).toBe(200)
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream')
    const p = await makeUser(app)
    setTimeout(() => void holdHours(app, p.accessToken, fx.courtId, [a.id]), 300)
    const text = await stream.text()
    expect(text).toContain('event: hello')
    expect(text).toContain('event: slot.updated')
    expect(text).toContain(`"slotId":"${a.id}"`)
    expect(text).toContain('"status":"HELD"')
    expect(text).not.toMatch(/bookingId/)
  })

  it('the POS stream needs a staff login for that venue', async () => {
    const url = `http://127.0.0.1:${port}/api/v1/realtime/stream?pos=${fx.venueId}`
    expect((await fetch(url)).status).toBe(401)
    expect(
      (await fetch(url, { headers: { authorization: `Bearer ${other.frontDesk.accessToken}` } }))
        .status,
    ).toBe(403)
    const ok = new AbortController()
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${fx.frontDesk.accessToken}` },
      signal: ok.signal,
    })
    expect(res.status).toBe(200)
    ok.abort()
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/realtime/stream`)).status).toBe(403)
  })
})
