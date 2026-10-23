import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import {
  makeApp,
  post,
  call,
  signupVerified,
  createAdmin,
  loginAdmin,
  cleanupTestData,
  buildDraftVenue,
  buildVerifiedVenue,
  hours,
  lastToken,
  lastCode,
  uniqueEmail,
  PASSWORD,
} from './helpers'

let app: FastifyInstance
let adminToken: string
const P = (id: string) => `/api/v1/pos/venues/${id}`

beforeAll(async () => {
  app = await makeApp()
  await cleanupTestData(app.prisma)
  const admin = await createAdmin(app.prisma)
  adminToken = await loginAdmin(app, admin.email)
})
afterAll(async () => {
  await cleanupTestData(app.prisma)
  await app.close()
})

describe('owner onboarding', () => {
  it('creates a draft venue and becomes its OWNER', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const mine = await call(app, 'GET', '/api/v1/me/venues', owner.accessToken)
    expect(mine.json().data).toEqual([
      expect.objectContaining({ id: v.venueId, verificationStatus: 'DRAFT', myRole: 'OWNER' }),
    ])
    const me = await call(app, 'GET', '/api/v1/me', owner.accessToken)
    expect(me.json().data.memberships).toEqual([{ venueId: v.venueId, role: 'OWNER' }])
    expect(v.venueId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/) // UUID v7
  })

  it('needs a login and valid input', async () => {
    expect((await call(app, 'POST', '/api/v1/venues', undefined, {})).statusCode).toBe(401)
    const owner = await signupVerified(app, { groundOwner: true })
    const bad = (extra: object) =>
      call(app, 'POST', '/api/v1/venues', owner.accessToken, {
        name: 'Test Arena',
        city: 'Testville',
        address: '12 Test Road',
        lat: 24.8,
        lng: 67,
        operatingHours: hours(),
        ...extra,
      })
    expect((await bad({ lat: 120 })).statusCode).toBe(400)
    expect((await bad({ cancellationCutoffHours: 6 })).statusCode).toBe(400) // policy must be 12-24
    expect((await bad({ amenities: ['JETPACK'] })).statusCode).toBe(400)
    const hrs = await bad({ operatingHours: { mon: [{ open: '9', close: '10' }] } })
    expect(hrs.statusCode).toBe(400)
  })

  it('unknown area is rejected', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const r = await call(app, 'POST', '/api/v1/venues', owner.accessToken, {
      name: 'Test Arena',
      city: 'Testville',
      address: '12 Test Road',
      lat: 24.8,
      lng: 67,
      operatingHours: hours(),
      areaId: '0194c8a0-0000-7000-8000-000000000999',
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('AREA_NOT_FOUND')
  })

  it('court validation: sport and surface enums, slot minutes', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const c = (b: object) =>
      call(app, 'POST', `${P(v.venueId)}/courts`, owner.accessToken, {
        name: 'C2',
        sport: 'PADEL',
        surface: 'GLASS_PADEL',
        environment: 'INDOOR',
        ...b,
      })
    expect((await c({})).statusCode).toBe(201)
    expect((await c({ sport: 'CHESS' })).statusCode).toBe(400)
    expect((await c({ slotMinutes: 45 })).statusCode).toBe(400)
  })

  it('pricing: overlapping band at the same priority is refused, a different priority is fine', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const rule = (b: object) =>
      call(app, 'POST', `${P(v.venueId)}/pricing-rules`, owner.accessToken, {
        courtId: v.courtId,
        name: 'X',
        dayType: 'ANY',
        fromTime: '10:00',
        toTime: '12:00',
        priceMinor: 100,
        tag: 'PEAK',
        ...b,
      })
    const clash = await rule({})
    expect(clash.statusCode).toBe(409)
    expect(clash.json().code).toBe('PRICING_OVERLAP')
    expect((await rule({ priority: 5 })).statusCode).toBe(201)
    expect(
      (
        await rule({
          priority: 6,
          dayType: 'DATE_RANGE',
          startDate: '2026-12-31',
          endDate: '2026-12-01',
        })
      ).statusCode,
    ).toBe(400)
    expect((await rule({ priority: 7, priceMinor: 12.5 })).statusCode).toBe(400) // paisa are whole numbers
    expect((await rule({ priority: 8, priceMinor: -5 })).statusCode).toBe(400)
  })

  it('price preview shows each slot of the day, with peak and off-peak prices', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const r = await call(
      app,
      'GET',
      `${P(v.venueId)}/pricing-preview?courtId=${v.courtId}&date=2026-10-12`,
      owner.accessToken,
    )
    expect(r.statusCode).toBe(200)
    const slots = r.json().data.slots
    expect(slots).toHaveLength(20) // 06:00 to 02:00 = 20 one-hour slots
    expect(slots[0]).toMatchObject({
      start: '06:00',
      end: '07:00',
      priceMinor: 200000,
      tag: 'OFF_PEAK',
    })
    expect(slots[12]).toMatchObject({ start: '18:00', priceMinor: 300000, tag: 'PEAK' })
    expect(slots[19]).toMatchObject({
      start: '01:00',
      end: '02:00',
      priceMinor: 300000,
      tag: 'PEAK',
    })
  })

  it('submit is blocked until the venue is complete, and says what is missing', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const create = await call(app, 'POST', '/api/v1/venues', owner.accessToken, {
      name: 'Empty Arena',
      city: 'Testville',
      address: '1 Nowhere Rd',
      lat: 24.8,
      lng: 67,
      operatingHours: hours(),
    })
    const id = create.json().data.id
    const r = await call(app, 'POST', `${P(id)}/submit`, owner.accessToken)
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('SUBMIT_PREREQUISITES')
    expect(r.json().details.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/active court/)]),
    )

    // a court without prices for all hours is also refused
    await call(app, 'POST', `${P(id)}/courts`, owner.accessToken, {
      name: 'C1',
      sport: 'PADEL',
      surface: 'GLASS_PADEL',
      environment: 'INDOOR',
    })
    const r2 = await call(app, 'POST', `${P(id)}/submit`, owner.accessToken)
    expect(r2.statusCode).toBe(400)
    expect(r2.json().details.problems.join(' ')).toMatch(/No price for/)
  })
})

describe('review workflow', () => {
  it('draft -> submitted -> under review -> verified, with audit rows and events', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const sub = await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    expect(sub.json().data.verificationStatus).toBe('SUBMITTED')

    // while waiting, the owner cannot edit
    const edit = await call(app, 'PATCH', P(v.venueId), owner.accessToken, { name: 'Changed Name' })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().code).toBe('VENUE_LOCKED')

    // a decision needs the review to be opened first
    const early = await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
      decision: 'APPROVED',
    })
    expect(early.statusCode).toBe(409)
    expect(early.json().code).toBe('INVALID_VENUE_TRANSITION')

    expect(
      (await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)).json()
        .data.verificationStatus,
    ).toBe('UNDER_REVIEW')
    const ok = await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
      decision: 'APPROVED',
    })
    expect(ok.json().data.verificationStatus).toBe('VERIFIED')

    const logs = await call(
      app,
      'GET',
      `/api/v1/admin/audit-logs?entityId=${v.venueId}&entity=venue`,
      adminToken,
    )
    const actions = logs.json().data.map((l: any) => l.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'VENUE_CREATED',
        'VENUE_SUBMIT',
        'VENUE_OPEN_REVIEW',
        'VENUE_APPROVE',
      ]),
    )

    const ev = await app.prisma.$queryRaw<
      { event_type: string }[]
    >`SELECT event_type FROM outbox WHERE payload->'data'->>'venueId' = ${v.venueId}`
    expect(ev.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'venue.created',
        'venue.upserted',
        'venue.verified',
        'court.upserted',
        'pricing.updated',
      ]),
    )
  })

  it('request changes needs comments, shows them to the owner, and allows re-submit', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)

    const noComment = await call(
      app,
      'POST',
      `/api/v1/admin/venues/${v.venueId}/review`,
      adminToken,
      { decision: 'CHANGES_REQUESTED' },
    )
    expect(noComment.statusCode).toBe(400)
    expect(noComment.json().code).toBe('COMMENTS_REQUIRED')

    const ch = await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
      decision: 'CHANGES_REQUESTED',
      comments: 'Pin looks wrong',
      fieldFlags: [{ field: 'location', note: 'pin is 3 km from the address' }],
    })
    expect(ch.json().data.verificationStatus).toBe('CHANGES_REQUESTED')

    const status = await call(app, 'GET', `${P(v.venueId)}/verification`, owner.accessToken)
    expect(status.json().data.status).toBe('CHANGES_REQUESTED')
    expect(status.json().data.reviews[0]).toMatchObject({
      comments: 'Pin looks wrong',
      fieldFlags: [{ field: 'location', note: 'pin is 3 km from the address' }],
    })

    expect(
      (await call(app, 'PATCH', P(v.venueId), owner.accessToken, { lat: 24.9 })).statusCode,
    ).toBe(200)
    expect(
      (await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)).json().data
        .verificationStatus,
    ).toBe('SUBMITTED')
  })

  it('rejected is final', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)
    const rej = await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
      decision: 'REJECTED',
      comments: 'Fake venue',
    })
    expect(rej.json().data.verificationStatus).toBe('REJECTED')
    const again = await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    expect(again.statusCode).toBe(409)
    expect(
      (await call(app, 'PATCH', P(v.venueId), owner.accessToken, { name: 'Another Try' }))
        .statusCode,
    ).toBe(409)
  })

  it('suspend hides the venue from the public and reinstate brings it back', async () => {
    const owner = await signupVerified(app)
    const v = await buildVerifiedVenue(app, owner, adminToken, { name: 'PLANTEST Suspend Arena' })
    const detail = () => call(app, 'GET', `/api/v1/public/venues/${v.venueId}`)
    expect((await detail()).statusCode).toBe(200)
    expect(
      (
        await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/suspend`, adminToken, {
          reason: 'complaints',
        })
      ).json().data.verificationStatus,
    ).toBe('SUSPENDED')
    expect((await detail()).statusCode).toBe(404)
    expect(
      (
        await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/reinstate`, adminToken, {
          reason: 'resolved',
        })
      ).json().data.verificationStatus,
    ).toBe('VERIFIED')
    expect((await detail()).statusCode).toBe(200)
    // cannot suspend twice / reinstate a verified venue
    expect(
      (
        await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/reinstate`, adminToken, {
          reason: 'again',
        })
      ).statusCode,
    ).toBe(409)
  })

  it('two admins deciding at once: exactly one decision wins', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)
    const results = await Promise.all([
      call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
        decision: 'APPROVED',
      }),
      call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
        decision: 'REJECTED',
        comments: 'no',
      }),
      call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
        decision: 'APPROVED',
      }),
    ])
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2)
  })

  it('verified venue: normal edits apply, location and policy need admin review', async () => {
    const owner = await signupVerified(app)
    const v = await buildVerifiedVenue(app, owner, adminToken, { name: 'PLANTEST Edit Arena' })
    expect(
      (
        await call(app, 'PATCH', P(v.venueId), owner.accessToken, {
          amenities: ['PARKING', 'CAFE'],
        })
      ).statusCode,
    ).toBe(200)
    const mat = await call(app, 'PATCH', P(v.venueId), owner.accessToken, { lat: 25.1 })
    expect(mat.statusCode).toBe(409)
    expect(mat.json().code).toBe('MATERIAL_EDIT_REQUIRES_REVIEW')
    expect(
      (await call(app, 'PATCH', P(v.venueId), owner.accessToken, { cancellationCutoffHours: 24 }))
        .statusCode,
    ).toBe(409)
  })
})

describe('authorization: who can touch which venue', () => {
  it('another owner cannot read or change my venue (no cross-venue access)', async () => {
    const a = await signupVerified(app)
    const b = await signupVerified(app)
    const va = await buildDraftVenue(app, a)
    await buildDraftVenue(app, b)
    for (const [method, url, body] of [
      ['GET', P(va.venueId), undefined],
      ['PATCH', P(va.venueId), { name: 'Hijacked Name' }],
      [
        'POST',
        `${P(va.venueId)}/courts`,
        { name: 'x', sport: 'PADEL', surface: 'GLASS_PADEL', environment: 'INDOOR' },
      ],
      ['GET', `${P(va.venueId)}/pricing-rules`, undefined],
      ['POST', `${P(va.venueId)}/submit`, undefined],
      ['GET', `${P(va.venueId)}/staff`, undefined],
      ['POST', `${P(va.venueId)}/staff/invitations`, { email: uniqueEmail(), role: 'MANAGER' }],
    ] as const) {
      const r = await call(app, method as any, url, b.accessToken, body)
      expect(r.statusCode, `${method} ${url}`).toBe(403)
      expect(r.json().code).toBe('VENUE_ACCESS_DENIED')
    }
  })

  it('anonymous callers get 401 on every owner and admin route', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    for (const url of [
      P(v.venueId),
      `${P(v.venueId)}/courts`,
      '/api/v1/me/venues',
      '/api/v1/admin/venues',
    ]) {
      expect((await call(app, 'GET', url)).statusCode, url).toBe(401)
    }
  })

  it('normal users cannot use admin venue routes', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    for (const [m, url] of [
      ['GET', '/api/v1/admin/venues'],
      ['GET', `/api/v1/admin/venues/${v.venueId}`],
      ['POST', `/api/v1/admin/venues/${v.venueId}/open-review`],
      ['POST', '/api/v1/admin/areas'],
    ] as const) {
      expect((await call(app, m, url, owner.accessToken, {})).statusCode, url).toBe(403)
    }
  })

  it('managers may edit hours but not the pin or name; front desk has no access to setup', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const mgr = await signupVerified(app)
    const desk = await signupVerified(app)
    for (const [u, role] of [
      [mgr, 'MANAGER'],
      [desk, 'FRONT_DESK'],
    ] as const) {
      await app.prisma.venueMembership.create({
        data: { id: crypto.randomUUID(), userId: u.userId, venueId: v.venueId, role },
      })
    }
    // staff must now use step-up login; mint a token directly through the API login flow
    const login = async (u: { email: string }) => {
      await post(app, '/api/v1/public/auth/login', { email: u.email, password: PASSWORD })
      const r = await post(app, '/api/v1/public/auth/login/verify-otp', {
        email: u.email,
        code: lastCode(u.email),
      })
      return r.json().accessToken as string
    }
    const mt = await login(mgr)
    const dt = await login(desk)

    expect(
      (await call(app, 'PATCH', P(v.venueId), mt, { operatingHours: hours('07:00', '23:00') }))
        .statusCode,
    ).toBe(200)
    const name = await call(app, 'PATCH', P(v.venueId), mt, { name: 'Manager Rename' })
    expect(name.statusCode).toBe(403)
    expect(name.json().code).toBe('OWNER_ONLY_FIELD')
    expect((await call(app, 'POST', `${P(v.venueId)}/submit`, mt)).statusCode).toBe(403) // owner only
    expect((await call(app, 'GET', `${P(v.venueId)}/courts`, mt)).statusCode).toBe(200)
    expect((await call(app, 'GET', `${P(v.venueId)}/courts`, dt)).statusCode).toBe(403)
    expect((await call(app, 'GET', P(v.venueId), dt)).statusCode).toBe(403)
  })
})

describe('staff invitations', () => {
  async function setup() {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    return { owner, v }
  }
  const accept = (token: string, body: object = {}) =>
    post(app, '/api/v1/public/auth/staff-invitations/accept', { token, ...body })

  it('owner invites by e-mail; invitee creates an account and gets a membership', async () => {
    const { owner, v } = await setup()
    const email = uniqueEmail('staff')
    const inv = await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'FRONT_DESK',
    })
    expect(inv.statusCode).toBe(201)
    const token = lastToken(email)

    expect((await accept(token)).statusCode).toBe(400) // new account needs name + password
    const ok = await accept(token, { fullName: 'Front Desk Person', password: PASSWORD })
    expect(ok.statusCode).toBe(201)

    const staff = await call(app, 'GET', `${P(v.venueId)}/staff`, owner.accessToken)
    expect(staff.json().data.map((s: any) => [s.email, s.role, s.isActive])).toEqual(
      expect.arrayContaining([[email, 'FRONT_DESK', true]]),
    )

    // staff always log in with a code as well
    const l = await post(app, '/api/v1/public/auth/login', { email, password: PASSWORD })
    expect(l.json().mfaRequired).toBe(true)
  })

  it('an invitation can be used once only', async () => {
    const { owner, v } = await setup()
    const email = uniqueEmail('staff')
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'SCORER',
    })
    const token = lastToken(email)
    const results = await Promise.all([
      accept(token, { fullName: 'Scorer One', password: PASSWORD }),
      accept(token, { fullName: 'Scorer Two', password: PASSWORD }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400])
  })

  it('re-sending revokes the previous invitation; garbage tokens fail', async () => {
    const { owner, v } = await setup()
    const email = uniqueEmail('staff')
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'MANAGER',
    })
    const first = lastToken(email)
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'MANAGER',
    })
    expect((await accept(first, { fullName: 'Old Link', password: PASSWORD })).statusCode).toBe(400)
    expect(
      (await accept(lastToken(email), { fullName: 'New Link', password: PASSWORD })).statusCode,
    ).toBe(201)
    expect(
      (await accept('x'.repeat(40), { fullName: 'Nobody', password: PASSWORD })).statusCode,
    ).toBe(400)
  })

  it('an expired invitation is refused', async () => {
    const { owner, v } = await setup()
    const email = uniqueEmail('staff')
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'MANAGER',
    })
    await app.prisma.staffInvitation.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(
      (await accept(lastToken(email), { fullName: 'Too Late', password: PASSWORD })).statusCode,
    ).toBe(400)
  })

  it('an existing account must be logged in as the invited address', async () => {
    const { owner, v } = await setup()
    const existing = await signupVerified(app)
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email: existing.email,
      role: 'SCORER',
    })
    const token = lastToken(existing.email)
    const anon = await accept(token)
    expect(anon.statusCode).toBe(401)
    expect(anon.json().code).toBe('LOGIN_REQUIRED')
    const other = await signupVerified(app)
    const wrong = await post(
      app,
      '/api/v1/public/auth/staff-invitations/accept',
      { token },
      { authorization: `Bearer ${other.accessToken}` },
    )
    expect(wrong.statusCode).toBe(401)
    const right = await post(
      app,
      '/api/v1/public/auth/staff-invitations/accept',
      { token },
      { authorization: `Bearer ${existing.accessToken}` },
    )
    expect(right.statusCode).toBe(201)
  })

  it('only the owner invites; a deactivated member loses access immediately; the owner cannot be removed', async () => {
    const { owner, v } = await setup()
    const email = uniqueEmail('staff')
    await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
      email,
      role: 'MANAGER',
    })
    await accept(lastToken(email), { fullName: 'Manager Person', password: PASSWORD })
    await post(app, '/api/v1/public/auth/login', { email, password: PASSWORD })
    const tok = (
      await post(app, '/api/v1/public/auth/login/verify-otp', { email, code: lastCode(email) })
    ).json().accessToken

    // manager cannot invite
    expect(
      (
        await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, tok, {
          email: uniqueEmail(),
          role: 'SCORER',
        })
      ).statusCode,
    ).toBe(403)
    expect((await call(app, 'GET', `${P(v.venueId)}/courts`, tok)).statusCode).toBe(200)

    const staff = (await call(app, 'GET', `${P(v.venueId)}/staff`, owner.accessToken)).json().data
    const mgr = staff.find((s: any) => s.email === email)
    const own = staff.find((s: any) => s.role === 'OWNER')
    expect(
      (await call(app, 'DELETE', `${P(v.venueId)}/staff/${own.membershipId}`, owner.accessToken))
        .statusCode,
    ).toBe(403)
    expect(
      (await call(app, 'DELETE', `${P(v.venueId)}/staff/${mgr.membershipId}`, owner.accessToken))
        .statusCode,
    ).toBe(200)
    // same access token, but access is gone at once
    expect((await call(app, 'GET', `${P(v.venueId)}/courts`, tok)).statusCode).toBe(403)
  })

  it('rejects invalid roles (OWNER cannot be invited)', async () => {
    const { owner, v } = await setup()
    expect(
      (
        await call(app, 'POST', `${P(v.venueId)}/staff/invitations`, owner.accessToken, {
          email: uniqueEmail(),
          role: 'OWNER',
        })
      ).statusCode,
    ).toBe(400)
  })
})

describe('admin: queue, detail, areas', () => {
  it('queue lists submitted venues; detail has courts, prices and review history', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner, { name: 'PLANTEST Queue Arena' })
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    const q = await call(app, 'GET', '/api/v1/admin/venues?status=SUBMITTED&limit=100', adminToken)
    expect(q.json().data.items.map((i: any) => i.id)).toContain(v.venueId)
    const d = await call(app, 'GET', `/api/v1/admin/venues/${v.venueId}`, adminToken)
    expect(d.json().data.courts).toHaveLength(1)
    expect(d.json().data.courts[0].pricingRules).toHaveLength(2)
  })

  it('area CRUD, duplicates, and the pin-vs-area sanity check', async () => {
    const mk = (name: string, lat?: number, lng?: number) =>
      call(app, 'POST', '/api/v1/admin/areas', adminToken, { city: 'Testville', name, lat, lng })
    const area = await mk('Alpha Zone', 24.86, 67.0)
    expect(area.statusCode).toBe(201)
    expect((await mk('Alpha Zone')).statusCode).toBe(409)
    const areaId = area.json().data.id

    const owner = await signupVerified(app)
    // pin ~60 km away from the area centre
    const far = await buildDraftVenue(app, owner, {
      name: 'PLANTEST Far Pin',
      areaId,
      lat: 25.4,
      lng: 67.0,
    })
    const d = await call(app, 'GET', `/api/v1/admin/venues/${far.venueId}`, adminToken)
    expect(d.json().data.pinDistanceKm).toBeGreaterThan(50)
    expect(d.json().data.pinWarning).toMatch(/km from the claimed area/)

    // cannot delete an area in use; can after
    expect(
      (await call(app, 'DELETE', `/api/v1/admin/areas/${areaId}`, adminToken)).statusCode,
    ).toBe(409)
    expect(
      (
        await call(app, 'PATCH', `/api/v1/admin/areas/${areaId}`, adminToken, {
          aliases: ['Alpha'],
        })
      ).json().data.aliases,
    ).toEqual(['Alpha'])
  })
})

describe('malformed ids', () => {
  it('answers 400 INVALID_ID instead of 500 when an id in the path is not a UUID', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const created = await call(app, 'POST', '/api/v1/venues', owner.accessToken, {
      name: 'Id Test Arena',
      city: 'Testville',
      address: '12 Test Road, Testville',
      lat: 24.86,
      lng: 67.0,
      operatingHours: { mon: [{ open: '09:00', close: '11:00' }] },
    })
    const venueId = created.json().data.id as string
    const staffRes = await call(app, 'DELETE', `${P(venueId)}/staff/not-a-uuid`, owner.accessToken)
    expect(staffRes.statusCode).toBe(400)
    expect(staffRes.json().code).toBe('INVALID_ID')
    const adminRes = await call(app, 'GET', '/api/v1/admin/venues/not-a-uuid', adminToken)
    expect(adminRes.statusCode).toBe(400)
  })
})

describe('court details', () => {
  const full = {
    name: 'Padel Court 1',
    sport: 'PADEL',
    surface: 'GLASS_PADEL',
    environment: 'INDOOR',
    capacity: 4,
    images: ['https://cdn.example.com/c1.jpg', 'https://cdn.example.com/c2.jpg'],
    schedule: {
      mon: [{ open: '09:00', close: '23:00' }],
      tue: [{ open: '09:00', close: '23:00' }],
    },
    pricing: [
      {
        name: 'Day',
        dayType: 'ANY',
        fromTime: '09:00',
        toTime: '18:00',
        priceMinor: 200000,
        tag: 'OFF_PEAK',
      },
      {
        name: 'Evening',
        dayType: 'ANY',
        fromTime: '18:00',
        toTime: '23:00',
        priceMinor: 300000,
        tag: 'PEAK',
      },
    ],
  }
  const courtsUrl = (venueId: string) => `${P(venueId)}/courts`

  it('creates a court with images, own schedule and price bands in one call', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const v = await buildDraftVenue(app, owner)
    const r = await call(app, 'POST', courtsUrl(v.venueId), owner.accessToken, full)
    expect(r.statusCode).toBe(201)
    const c = r.json().data
    expect(c).toMatchObject({
      environment: 'INDOOR',
      images: full.images,
      schedule: full.schedule,
      isBookable: true,
    })
    expect(c.pricingRules).toHaveLength(2)
    expect(c.hoursOverride).toBeUndefined()
    expect(c.isActive).toBeUndefined()

    const list = (await call(app, 'GET', courtsUrl(v.venueId), owner.accessToken)).json().data
    expect(list.find((x: any) => x.id === c.id)).toMatchObject({
      isBookable: true,
      environment: 'INDOOR',
    })
    const rules = (
      await call(app, 'GET', `${P(v.venueId)}/pricing-rules?courtId=${c.id}`, owner.accessToken)
    ).json().data
    expect(rules).toHaveLength(2)
  })

  it('a bad price band leaves no half-made court behind', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const v = await buildDraftVenue(app, owner)
    const before = (await call(app, 'GET', courtsUrl(v.venueId), owner.accessToken)).json().data
      .length
    const clash = [
      ...full.pricing,
      {
        name: 'Clash',
        dayType: 'ANY',
        fromTime: '10:00',
        toTime: '12:00',
        priceMinor: 1,
        tag: 'PEAK',
      },
    ]
    const r = await call(app, 'POST', courtsUrl(v.venueId), owner.accessToken, {
      ...full,
      pricing: clash,
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('PRICING_OVERLAP')
    const after = (await call(app, 'GET', courtsUrl(v.venueId), owner.accessToken)).json().data
      .length
    expect(after).toBe(before)
  })

  it('validates environment, images and schedule', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const v = await buildDraftVenue(app, owner)
    const post = (extra: object) =>
      call(app, 'POST', courtsUrl(v.venueId), owner.accessToken, {
        ...full,
        pricing: undefined,
        ...extra,
      })
    const noEnv = { ...full, environment: undefined }
    expect(
      (await call(app, 'POST', courtsUrl(v.venueId), owner.accessToken, noEnv)).statusCode,
    ).toBe(400)
    expect((await post({ environment: 'ROOFTOP' })).statusCode).toBe(400)
    expect((await post({ images: ['not a url'] })).statusCode).toBe(400)
    const eleven = Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/${i}.jpg`)
    expect((await post({ images: eleven })).statusCode).toBe(400)
    expect(
      (await post({ schedule: { funday: [{ open: '09:00', close: '10:00' }] } })).statusCode,
    ).toBe(400)
    expect((await post({ isBookable: false })).json().data.isBookable).toBe(false)
  })

  it('the owner can switch a court off and on, change images, and go back to the venue hours', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const v = await buildDraftVenue(app, owner)
    const patch = (body: object) =>
      call(app, 'PATCH', `${courtsUrl(v.venueId)}/${v.courtId}`, owner.accessToken, body)
    expect((await patch({ isBookable: false })).json().data.isBookable).toBe(false)
    expect((await patch({ isBookable: true, environment: 'INDOOR' })).json().data).toMatchObject({
      isBookable: true,
      environment: 'INDOOR',
    })
    expect(
      (await patch({ images: ['https://cdn.example.com/new.jpg'] })).json().data.images,
    ).toEqual(['https://cdn.example.com/new.jpg'])
    expect((await patch({ schedule: full.schedule })).json().data.schedule).toEqual(full.schedule)
    expect((await patch({ schedule: null })).json().data.schedule).toBeNull()
  })

  it('the public venue page shows environment and images', async () => {
    const owner = await signupVerified(app, { groundOwner: true })
    const v = await buildDraftVenue(app, owner)
    await call(app, 'PATCH', `${courtsUrl(v.venueId)}/${v.courtId}`, owner.accessToken, {
      environment: 'INDOOR',
      images: ['https://cdn.example.com/pub.jpg'],
    })
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)
    await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
      decision: 'APPROVED',
    })
    const page = (await call(app, 'GET', `/api/v1/public/venues/${v.venueId}`)).json().data
    expect(page.courts[0]).toMatchObject({
      environment: 'INDOOR',
      images: ['https://cdn.example.com/pub.jpg'],
    })
  })
})
