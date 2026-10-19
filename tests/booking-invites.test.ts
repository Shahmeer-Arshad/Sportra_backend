import { createHash } from 'crypto'
import { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uuidv7 } from '../src/lib/id'
import {
  Fixture,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  holdHours,
  makeApp,
  makeUser,
  newUuidKey,
  nextIp,
  pickSlots,
  uniquePhone,
} from './helpers'

let app: FastifyInstance
let fx: Fixture
let day = 2
const nextDay = () => day++

beforeAll(async () => {
  app = await makeApp()
  fx = await buildFixture(app)
  await call(
    app,
    'PATCH',
    `/api/v1/pos/venues/${fx.venueId}/booking-settings`,
    fx.owner.accessToken,
    {
      payAtVenueEnabled: true,
    },
  )
}, 60_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

async function confirmed(name = 'Captain Hamza Ali') {
  const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
  const phone = uniquePhone()
  const captain = await makeUser(app, { name, phone })
  const h = (await holdHours(app, captain.accessToken, fx.courtId, [a.id])).json().data
  const c = await callKeyed(
    app,
    'POST',
    `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
    captain.accessToken,
  )
  expect(c.statusCode).toBe(200)
  return { captain, phone, id: h.id as string, ref: h.ref as string, slot: a }
}
const invite = async (b: { captain: { accessToken: string }; id: string }) =>
  call(app, 'POST', `/api/v1/bookings/${b.id}/invites`, b.captain.accessToken)
const rsvp = (token: string, body: object, ip = nextIp()) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/public/invites/${token}/rsvp`,
    payload: body as never,
    remoteAddress: ip,
  })
const open = (token: string) =>
  app.inject({ method: 'GET', url: `/api/v1/public/invites/${token}`, remoteAddress: nextIp() })

describe('creating invites', () => {
  it('gives the captain of a confirmed booking an unguessable link that expires when the match ends', async () => {
    const b = await confirmed()
    const r = await invite(b)
    expect(r.statusCode).toBe(201)
    const d = r.json().data
    expect(d.token).toMatch(/^[A-Za-z0-9_-]{30,}$/)
    expect(d.path).toBe(`/invite/${d.token}`)
    expect(Date.parse(d.expiresAt)).toBe(b.slot.end_at.getTime())
    // only a hash is stored, never the token
    const row = await app.prisma.$queryRaw<
      { token_hash: string }[]
    >`SELECT token_hash FROM invites WHERE id = ${d.id}::uuid`
    expect(row[0].token_hash).toBe(createHash('sha256').update(d.token).digest('hex'))
    expect(row[0].token_hash).not.toContain(d.token)
    const second = (await invite(b)).json().data
    expect(second.token).not.toBe(d.token)
  })

  it('needs a confirmed booking of your own', async () => {
    const [a] = await pickSlots(app.prisma, fx.courtId, 1, { dayOffset: nextDay() })
    const p = await makeUser(app)
    const hold = (await holdHours(app, p.accessToken, fx.courtId, [a.id])).json().data
    const r = await call(app, 'POST', `/api/v1/bookings/${hold.id}/invites`, p.accessToken)
    expect(r.statusCode).toBe(409)
    const b = await confirmed()
    const stranger = await makeUser(app)
    expect(
      (await call(app, 'POST', `/api/v1/bookings/${b.id}/invites`, stranger.accessToken))
        .statusCode,
    ).toBe(404)
    expect((await call(app, 'POST', `/api/v1/bookings/${b.id}/invites`)).statusCode).toBe(401)
  })

  it('allows at most 5 open links per booking', async () => {
    const b = await confirmed()
    for (let i = 0; i < 5; i++) expect((await invite(b)).statusCode).toBe(201)
    const sixth = await invite(b)
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json().code).toBe('TOO_MANY_INVITES')
  })
})

describe('the public invite page', () => {
  it('shows what a friend needs and nothing private', async () => {
    const b = await confirmed('Hamza Ali')
    const { token } = (await invite(b)).json().data
    const r = await open(token)
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.venueName).toBe('Booking Arena')
    expect(d.courtName).toBe('Court 1')
    expect(d.captainName).toBe('Hamza') // first name only
    expect(d.going).toBe(0)
    expect(d.preview.title).toContain('Hamza invited you')
    const raw = r.body
    expect(raw).not.toContain(b.phone) // the captain's phone
    expect(raw).not.toContain(b.ref) // the booking code is the entry key
    expect(raw).not.toMatch(/priceMinor|totalMinor|balance|email|Ali/)
  })

  it('answers 404 for an unknown link', async () => {
    expect((await open('definitely-not-a-real-token-0123456789')).statusCode).toBe(404)
    expect(
      (await rsvp('definitely-not-a-real-token-0123456789', { name: 'A', status: 'GOING' }))
        .statusCode,
    ).toBe(404)
  })
})

describe('answering without an account', () => {
  it('counts who is going and keeps the headcount up to date', async () => {
    const b = await confirmed()
    const { token } = (await invite(b)).json().data
    const a = await rsvp(token, { name: 'Bilal', status: 'GOING' })
    expect(a.statusCode).toBe(200)
    expect(a.json().data).toMatchObject({ going: 1, headcount: 2 }) // the captain plus Bilal
    await rsvp(token, { name: 'Sara', phone: '0300 5551111', status: 'GOING' })
    const c = await rsvp(token, { name: 'Danish', status: 'NOT_GOING' })
    expect(c.json().data).toMatchObject({ going: 2, headcount: 3 })
    const page = (await open(token)).json().data
    expect(page.going).toBe(2)
    const mine = (await call(app, 'GET', `/api/v1/bookings/${b.id}`, b.captain.accessToken)).json()
      .data
    expect(mine.headcount).toBe(3)
  })

  it('a person who changes their mind updates their answer instead of adding another', async () => {
    const b = await confirmed()
    const { token } = (await invite(b)).json().data
    await rsvp(token, { name: 'Bilal', status: 'GOING' })
    await rsvp(token, { name: 'bilal', status: 'GOING' }) // same name, different case
    const gone = await rsvp(token, { name: 'BILAL', status: 'NOT_GOING' })
    expect(gone.json().data).toMatchObject({ going: 0, headcount: 1 })
    const list = (
      await call(app, 'GET', `/api/v1/bookings/${b.id}/invites`, b.captain.accessToken)
    ).json().data
    expect(list[0].rsvps).toHaveLength(1)
    // with a phone number, the phone identifies the person even if the name changes
    await rsvp(token, { name: 'Sara', phone: '03005551111', status: 'GOING' })
    const again = await rsvp(token, { name: 'Sara K', phone: '03005551111', status: 'GOING' })
    expect(again.json().data.going).toBe(1)
  })

  it('the headcount counts a person once across several links', async () => {
    const b = await confirmed()
    const t1 = (await invite(b)).json().data.token
    const t2 = (await invite(b)).json().data.token
    await rsvp(t1, { name: 'Bilal', phone: '03001112222', status: 'GOING' })
    const r = await rsvp(t2, { name: 'Bilal', phone: '03001112222', status: 'GOING' })
    expect(r.json().data.headcount).toBe(2)
    const other = await rsvp(t2, { name: 'Omar', status: 'GOING' })
    expect(other.json().data.headcount).toBe(3)
  })

  it('lets the captain set the headcount by hand, until the next answer arrives', async () => {
    const b = await confirmed()
    const { token } = (await invite(b)).json().data
    const set = await call(
      app,
      'PATCH',
      `/api/v1/bookings/${b.id}/headcount`,
      b.captain.accessToken,
      { headcount: 10 },
    )
    expect(set.statusCode).toBe(200)
    expect(set.json().data.headcount).toBe(10)
    const stranger = await makeUser(app)
    expect(
      (
        await call(app, 'PATCH', `/api/v1/bookings/${b.id}/headcount`, stranger.accessToken, {
          headcount: 5,
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await call(app, 'PATCH', `/api/v1/bookings/${b.id}/headcount`, b.captain.accessToken, {
          headcount: 0,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (
        await call(app, 'PATCH', `/api/v1/bookings/${b.id}/headcount`, b.captain.accessToken, {
          headcount: 500,
        })
      ).statusCode,
    ).toBe(400)
    const r = await rsvp(token, { name: 'Bilal', status: 'GOING' })
    expect(r.json().data.headcount).toBe(2) // answers recompute it
  })

  it('validates the answer', async () => {
    const b = await confirmed()
    const { token } = (await invite(b)).json().data
    for (const bad of [
      { status: 'GOING' },
      { name: '', status: 'GOING' },
      { name: 'A', status: 'MAYBE' },
      { name: 'A'.repeat(61), status: 'GOING' },
      { name: 'A', phone: 'abc', status: 'GOING' },
    ]) {
      const r = await rsvp(token, bad)
      expect(r.statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await rsvp(token, { name: '   ', status: 'GOING' })).statusCode).toBe(400)
  })

  it('stops a flood from one address (rate limit) and caps the answers per link', async () => {
    const b = await confirmed()
    const { token, id } = (await invite(b)).json().data
    const ip = '10.99.99.99'
    const codes: number[] = []
    for (let i = 0; i < 25; i++)
      codes.push((await rsvp(token, { name: `Guest ${i}`, status: 'GOING' }, ip)).statusCode)
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true)
    expect(codes.slice(20).every((c) => c === 429)).toBe(true)
    // the cap: fill the link to 200 answers directly, then a new person is refused but an existing one can still update
    const b2 = await confirmed()
    const inv2 = (await invite(b2)).json().data
    await app.prisma.$executeRaw`
      INSERT INTO invite_rsvps (id, invite_id, name, rsvp_key, status)
      SELECT gen_random_uuid(), ${inv2.id}::uuid, 'g' || g, 'g' || g, 'NOT_GOING' FROM generate_series(1, 200) g`
    const full = await rsvp(inv2.token, { name: 'One too many', status: 'GOING' })
    expect(full.statusCode).toBe(429)
    expect(full.json().code).toBe('INVITE_FULL')
    const existing = await rsvp(inv2.token, { name: 'g1', status: 'GOING' })
    expect(existing.statusCode).toBe(200)
    void id
  })
})

describe('closing an invite', () => {
  it('the captain can revoke a link: it stops working at once', async () => {
    const b = await confirmed()
    const inv = (await invite(b)).json().data
    expect((await open(inv.token)).statusCode).toBe(200)
    const rev = await call(
      app,
      'DELETE',
      `/api/v1/bookings/${b.id}/invites/${inv.id}`,
      b.captain.accessToken,
    )
    expect(rev.statusCode).toBe(200)
    const page = await open(inv.token)
    expect(page.statusCode).toBe(410)
    expect(page.json().code).toBe('INVITE_CLOSED')
    expect((await rsvp(inv.token, { name: 'Late', status: 'GOING' })).statusCode).toBe(410)
    expect(
      (
        await call(
          app,
          'DELETE',
          `/api/v1/bookings/${b.id}/invites/${inv.id}`,
          b.captain.accessToken,
        )
      ).statusCode,
    ).toBe(404) // already revoked
    const stranger = await makeUser(app)
    const other = (await invite(b)).json().data
    expect(
      (
        await call(
          app,
          'DELETE',
          `/api/v1/bookings/${b.id}/invites/${other.id}`,
          stranger.accessToken,
        )
      ).statusCode,
    ).toBe(404)
  })

  it('an invite is closed once the match is over', async () => {
    const b = await confirmed()
    const inv = (await invite(b)).json().data
    await app.prisma
      .$executeRaw`UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = ${inv.id}::uuid`
    expect((await open(inv.token)).statusCode).toBe(410)
    expect((await rsvp(inv.token, { name: 'Late', status: 'GOING' })).statusCode).toBe(410)
  })

  it('cancelling the booking closes its invites', async () => {
    const b = await confirmed()
    const inv = (await invite(b)).json().data
    const c = await callKeyed(
      app,
      'POST',
      `/api/v1/bookings/${b.id}/cancel`,
      b.captain.accessToken,
      {},
      newUuidKey(),
    )
    expect(c.statusCode).toBe(200)
    expect((await open(inv.token)).statusCode).toBe(410)
    expect((await rsvp(inv.token, { name: 'Late', status: 'GOING' })).statusCode).toBe(410)
    // and no new link can be made for a cancelled booking
    expect((await invite(b)).statusCode).toBe(409)
  })

  it('lists the answers for the captain only', async () => {
    const b = await confirmed()
    const inv = (await invite(b)).json().data
    await rsvp(inv.token, { name: 'Bilal', phone: '03001112222', status: 'GOING' })
    const list = await call(app, 'GET', `/api/v1/bookings/${b.id}/invites`, b.captain.accessToken)
    expect(list.json().data[0].rsvps).toEqual([
      { name: 'Bilal', phone: '03001112222', status: 'GOING' },
    ])
    const stranger = await makeUser(app)
    expect(
      (await call(app, 'GET', `/api/v1/bookings/${b.id}/invites`, stranger.accessToken)).statusCode,
    ).toBe(404)
  })
})

void uuidv7
