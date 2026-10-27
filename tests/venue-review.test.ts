import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FastifyInstance } from 'fastify'
import { testMailbox } from '../src/lib/mailer'
import {
  Fixture,
  PHOTO,
  buildDraftVenue,
  buildFixture,
  call,
  callKeyed,
  cleanupTestData,
  createAdmin,
  hours,
  holdHours,
  loginAdmin,
  makeApp,
  makeUser,
  ownerEdit,
  pickSlots,
  signupVerified,
} from './helpers'

let app: FastifyInstance
beforeAll(async () => {
  app = await makeApp()
  await cleanupTestData(app.prisma)
}, 60_000)
afterAll(async () => {
  await app.booking.idle()
  await cleanupTestData(app.prisma)
  await app.close()
})

const P = (id: string) => `/api/v1/pos/venues/${id}`
const A = (id: string) => `/api/v1/admin/venues/${id}`
const mailsTo = (email: string) => testMailbox.filter((m) => m.to === email).map((m) => m.subject)

/** A player books one free hour of the fixture's court (pay at venue). */
async function reserve(f: Fixture, offset: number) {
  await call(app, 'PATCH', `${P(f.venueId)}/booking-settings`, f.owner.accessToken, {
    payAtVenueEnabled: true,
  })
  const [slot] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: offset })
  const p = await makeUser(app)
  const h = (await holdHours(app, p.accessToken, f.courtId, [slot.id])).json().data
  const ok = await callKeyed(
    app,
    'POST',
    `/api/v1/bookings/${h.id}/confirm-pay-at-venue`,
    p.accessToken,
  )
  expect(ok.statusCode).toBe(200)
  return { id: h.id as string, player: p, slot }
}
const bookingStatus = async (b: { id: string; player: { accessToken: string } }) =>
  (await call(app, 'GET', `/api/v1/bookings/${b.id}`, b.player.accessToken)).json().data.status

describe('suspend: pause or stop', () => {
  it('PAUSE_ONLINE hides the venue from players but the venue keeps working', async () => {
    const f = await buildFixture(app)
    const booked = await reserve(f, 3)
    const res = await call(app, 'POST', `${A(f.venueId)}/suspend`, f.admin.accessToken, {
      reason: 'Documents under check',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      verificationStatus: 'SUSPENDED',
      suspensionMode: 'PAUSE_ONLINE',
    })
    expect(mailsTo(f.owner.email).some((s) => /paused|suspended/.test(s))).toBe(true)

    // players cannot see or book it
    const pub = await app.inject({
      method: 'GET',
      url: `/api/v1/public/venues/${f.venueId}/availability?date=2030-01-01`,
    })
    expect(pub.statusCode).toBe(404)
    const [slot] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: 5 })
    const player = await makeUser(app)
    expect((await holdHours(app, player.accessToken, f.courtId, [slot.id])).statusCode).toBe(404)
    // the booking that existed stays, and front desk can still sell a walk-in
    expect(await bookingStatus(booked)).toBe('CONFIRMED')
    const walk = await callKeyed(app, 'POST', `${P(f.venueId)}/walkins`, f.frontDesk.accessToken, {
      courtId: f.courtId,
      slotIds: [slot.id],
      customerName: 'Walk In',
      customerPhone: '03001234567',
    })
    expect(walk.statusCode).toBe(201)
    // the owner sees why
    const v = await call(app, 'GET', `${P(f.venueId)}/verification`, f.owner.accessToken)
    expect(v.json().data.suspension.mode).toBe('PAUSE_ONLINE')

    const back = await call(app, 'POST', `${A(f.venueId)}/reinstate`, f.admin.accessToken, {
      reason: 'All good',
    })
    expect(back.json().data).toMatchObject({ verificationStatus: 'VERIFIED', suspensionMode: null })
  })

  it('STOP_ALL asks for a preview count, cancels future bookings and locks the point of sale', async () => {
    const f = await buildFixture(app)
    const b1 = await reserve(f, 3)
    const b2 = await reserve(f, 4)
    const pre = await call(app, 'POST', `${A(f.venueId)}/suspend/preview`, f.admin.accessToken)
    expect(pre.json().data).toMatchObject({ futureBookings: 2, players: 2, confirmCount: 2 })

    const stop = (extra: object) =>
      call(app, 'POST', `${A(f.venueId)}/suspend`, f.admin.accessToken, {
        reason: 'Fake venue',
        mode: 'STOP_ALL',
        ...extra,
      })
    const none = await stop({})
    expect(none.statusCode).toBe(400)
    expect(none.json().code).toBe('CONFIRM_COUNT_REQUIRED')
    const stale = await stop({ confirmCount: 1 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('PREVIEW_STALE')
    expect(await bookingStatus(b1)).toBe('CONFIRMED') // nothing happened yet

    const ok = await stop({ confirmCount: 2 })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.stopAll.lockId).toBeTruthy()
    await app.booking.idle()
    expect(await bookingStatus(b1)).toBe('CANCELLED_BY_VENUE')
    expect(await bookingStatus(b2)).toBe('CANCELLED_BY_VENUE')

    // POS is locked for new sales and blocks; reads still work
    const [slot] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: 6 })
    const walk = await callKeyed(app, 'POST', `${P(f.venueId)}/walkins`, f.frontDesk.accessToken, {
      courtId: f.courtId,
      slotIds: [slot.id],
      customerName: 'Walk In',
      customerPhone: '03001234567',
    })
    expect(walk.statusCode).toBe(409)
    expect(walk.json().code).toBe('VENUE_SUSPENDED')
    const block = await call(app, 'POST', `${P(f.venueId)}/blocks`, f.manager.accessToken, {
      courtIds: [f.courtId],
      from: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      to: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(),
      reason: 'OTHER',
    })
    expect(block.json().code).toBe('VENUE_SUSPENDED')
    expect((await call(app, 'GET', P(f.venueId), f.owner.accessToken)).statusCode).toBe(200)

    // suspending again is refused; reinstating releases the lock and reopens the hours
    expect((await stop({ confirmCount: 0 })).statusCode).toBe(409)
    const back = await call(app, 'POST', `${A(f.venueId)}/reinstate`, f.admin.accessToken, {
      reason: 'Cleared',
    })
    expect(back.statusCode).toBe(200)
    await app.booking.idle()
    const player = await makeUser(app)
    const [again] = await pickSlots(app.prisma, f.courtId, 1, { dayOffset: 3 })
    expect((await holdHours(app, player.accessToken, f.courtId, [again.id])).statusCode).toBe(201)
  })

  it('only a verified venue can be suspended', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const admin = await createAdmin(app.prisma)
    const token = await loginAdmin(app, admin.email)
    expect(
      (await call(app, 'POST', `${A(v.venueId)}/suspend`, token, { reason: 'No way' })).statusCode,
    ).toBe(409)
    expect((await call(app, 'POST', `${A(v.venueId)}/suspend/preview`, token)).statusCode).toBe(409)
  })
})

describe('review: photos, claim, emails and diff', () => {
  it('submit needs a venue photo and a photo per court', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    await call(app, 'PATCH', P(v.venueId), owner.accessToken, { photos: [] })
    await call(app, 'PATCH', `${P(v.venueId)}/courts/${v.courtId}`, owner.accessToken, {
      images: [],
    })
    const sub = await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    expect(sub.statusCode).toBe(400)
    const problems: string[] = sub.json().details.problems
    expect(problems).toContain('Add at least one venue photo')
    expect(problems.some((p) => /add at least one photo/.test(p))).toBe(true)
    await call(app, 'PATCH', P(v.venueId), owner.accessToken, { photos: [PHOTO] })
    await call(app, 'PATCH', `${P(v.venueId)}/courts/${v.courtId}`, owner.accessToken, {
      images: [PHOTO],
    })
    expect((await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)).statusCode).toBe(
      200,
    )
  })

  it('one admin holds a review; others cannot take, decide or release it', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    const a1 = await loginAdmin(app, (await createAdmin(app.prisma)).email)
    const a2 = await loginAdmin(app, (await createAdmin(app.prisma)).email)
    expect((await call(app, 'POST', `${A(v.venueId)}/open-review`, a1)).statusCode).toBe(200)

    const take = await call(app, 'POST', `${A(v.venueId)}/open-review`, a2)
    expect(take.statusCode).toBe(409)
    expect(take.json().code).toBe('REVIEW_CLAIMED')
    const decide = await call(app, 'POST', `${A(v.venueId)}/review`, a2, { decision: 'APPROVED' })
    expect(decide.json().code).toBe('REVIEW_NOT_YOURS')
    const rel2 = await call(app, 'POST', `${A(v.venueId)}/release-review`, a2)
    expect(rel2.json().code).toBe('REVIEW_NOT_YOURS')

    const mine = await call(app, 'GET', '/api/v1/admin/venues?status=UNDER_REVIEW&claimed=mine', a1)
    expect(mine.json().data.items.map((x: { id: string }) => x.id)).toContain(v.venueId)
    const theirs = await call(
      app,
      'GET',
      '/api/v1/admin/venues?status=UNDER_REVIEW&claimed=mine',
      a2,
    )
    expect(theirs.json().data.items.map((x: { id: string }) => x.id)).not.toContain(v.venueId)

    const rel = await call(app, 'POST', `${A(v.venueId)}/release-review`, a1)
    expect(rel.json().data.verificationStatus).toBe('SUBMITTED')
    expect((await call(app, 'POST', `${A(v.venueId)}/open-review`, a2)).statusCode).toBe(200)
  })

  it('emails the owner on every decision and shows the admin a diff on resubmission', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const admin = await loginAdmin(app, (await createAdmin(app.prisma)).email)
    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    expect(mailsTo(owner.email).some((s) => /received/.test(s))).toBe(true)

    const first = await call(app, 'GET', `${A(v.venueId)}/diff`, admin)
    expect(first.json().data).toMatchObject({ firstSubmission: true, changes: [] })

    await call(app, 'POST', `${A(v.venueId)}/open-review`, admin)
    const ask = await call(app, 'POST', `${A(v.venueId)}/review`, admin, {
      decision: 'CHANGES_REQUESTED',
      comments: 'Evening price looks wrong',
    })
    expect(ask.statusCode).toBe(200)
    const mail = testMailbox.find((m) => m.to === owner.email && /Changes needed/.test(m.subject))
    expect(mail?.text).toContain('Evening price looks wrong')

    // the owner fixes it: a second photo and a new evening price
    const photo2 = 'https://res.cloudinary.com/test/image/upload/second.jpg'
    await call(app, 'PATCH', P(v.venueId), owner.accessToken, { photos: [PHOTO, photo2] })
    const rules = (
      await call(app, 'GET', `${P(v.venueId)}/pricing-rules`, owner.accessToken)
    ).json().data
    const evening = rules.find((r: { name: string }) => r.name === 'Evening')
    await call(app, 'DELETE', `${P(v.venueId)}/pricing-rules/${evening.id}`, owner.accessToken)
    const re = await call(app, 'POST', `${P(v.venueId)}/pricing-rules`, owner.accessToken, {
      courtId: v.courtId,
      name: 'Evening',
      dayType: 'ANY',
      fromTime: '18:00',
      toTime: '02:00',
      priceMinor: 250000,
      tag: 'PEAK',
    })
    expect(re.statusCode).toBe(201)
    expect((await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)).statusCode).toBe(
      200,
    )

    const diff = (await call(app, 'GET', `${A(v.venueId)}/diff`, admin)).json().data
    expect(diff.firstSubmission).toBe(false)
    expect(diff.previousRequest).toMatchObject({
      decision: 'CHANGES_REQUESTED',
      comments: 'Evening price looks wrong',
    })
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'venue.photos', kind: 'added', after: photo2 }),
        expect.objectContaining({
          kind: 'changed',
          before: expect.objectContaining({ priceMinor: 300000 }),
          after: expect.objectContaining({ priceMinor: 250000 }),
        }),
      ]),
    )

    await call(app, 'POST', `${A(v.venueId)}/open-review`, admin)
    await call(app, 'POST', `${A(v.venueId)}/review`, admin, { decision: 'APPROVED' })
    expect(mailsTo(owner.email).some((s) => /is approved/.test(s))).toBe(true)
  })
})

describe('changes to a live venue wait for an admin', () => {
  it('a new court is queued, then approved and gets slots', async () => {
    const f = await buildFixture(app)
    const body = {
      name: 'Court 2',
      sport: 'PADEL',
      surface: 'GLASS_PADEL',
      environment: 'INDOOR',
      images: [PHOTO],
    }
    const res = await call(app, 'POST', `${P(f.venueId)}/courts`, f.owner.accessToken, body)
    expect(res.statusCode).toBe(202)
    const change = res.json().data
    expect(change).toMatchObject({ status: 'PENDING', op: 'court.add' })
    const courts = () => call(app, 'GET', `${P(f.venueId)}/courts`, f.owner.accessToken)
    expect((await courts()).json().data).toHaveLength(1) // nothing changed yet

    const mine = await call(app, 'GET', `${P(f.venueId)}/change-requests`, f.owner.accessToken)
    expect(mine.json().data.map((c: { id: string }) => c.id)).toContain(change.id)
    const queue = await call(
      app,
      'GET',
      '/api/v1/admin/venue-changes?status=PENDING',
      f.admin.accessToken,
    )
    expect(queue.json().data.items.map((c: { id: string }) => c.id)).toContain(change.id)

    const ok = await call(
      app,
      'POST',
      `/api/v1/admin/venue-changes/${change.id}/approve`,
      f.admin.accessToken,
      {
        note: 'Fine',
      },
    )
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.status).toBe('APPROVED')
    expect((await courts()).json().data).toHaveLength(2)
    expect(mailsTo(f.owner.email).some((s) => /is live/.test(s))).toBe(true)
    const again = await call(
      app,
      'POST',
      `/api/v1/admin/venue-changes/${change.id}/approve`,
      f.admin.accessToken,
      {},
    )
    expect(again.json().code).toBe('CHANGE_NOT_PENDING')
  })

  it('price bands and opening hours are queued; photos and contacts are instant', async () => {
    const f = await buildFixture(app)
    const band = await call(app, 'POST', `${P(f.venueId)}/pricing-rules`, f.owner.accessToken, {
      courtId: f.courtId,
      name: 'Night',
      dayType: 'WEEKEND',
      fromTime: '20:00',
      toTime: '23:00',
      priceMinor: 450000,
      tag: 'PEAK',
      priority: 5,
    })
    expect(band.statusCode).toBe(202)
    const hrs = await call(app, 'PATCH', P(f.venueId), f.owner.accessToken, {
      operatingHours: hours('08:00', '22:00'),
    })
    expect(hrs.statusCode).toBe(202)
    const before = (await call(app, 'GET', P(f.venueId), f.owner.accessToken)).json().data
    expect(before.operatingHours.mon[0].open).toBe('06:00')

    // photos and contacts apply at once; mixed with hours, only the hours wait
    const mixed = await call(app, 'PATCH', P(f.venueId), f.owner.accessToken, {
      contactPhone: '+923001112233',
      operatingHours: hours('09:00', '23:00'),
    })
    expect(mixed.statusCode).toBe(200)
    expect(mixed.json().data.contactPhone).toBe('+923001112233')
    expect(mixed.json().data.pendingChange.op).toBe('venue.update_hours')
    const photo = await call(
      app,
      'PATCH',
      `${P(f.venueId)}/courts/${f.courtId}`,
      f.owner.accessToken,
      {
        images: [PHOTO, 'https://res.cloudinary.com/test/image/upload/other.jpg'],
      },
    )
    expect(photo.statusCode).toBe(200)

    const pending = (
      await call(app, 'GET', '/api/v1/admin/venue-changes?status=PENDING', f.admin.accessToken)
    )
      .json()
      .data.items.filter((c: { venueId: string }) => c.venueId === f.venueId)
    expect(pending).toHaveLength(3)
    for (const c of pending)
      expect(
        (
          await call(
            app,
            'POST',
            `/api/v1/admin/venue-changes/${c.id}/approve`,
            f.admin.accessToken,
            {},
          )
        ).statusCode,
      ).toBe(200)
    await app.booking.idle()
    const after = (await call(app, 'GET', P(f.venueId), f.owner.accessToken)).json().data
    expect(after.operatingHours.mon[0].open).toBe('09:00')
  })

  it('reject needs a note, changes nothing and can be withdrawn by the owner before', async () => {
    const f = await buildFixture(app)
    const mk = async (name: string) =>
      (
        await call(app, 'POST', `${P(f.venueId)}/courts`, f.owner.accessToken, {
          name,
          sport: 'PADEL',
          surface: 'GLASS_PADEL',
          environment: 'INDOOR',
        })
      ).json().data.id as string
    const c1 = await mk('Court A')
    const c2 = await mk('Court B')
    const noNote = await call(
      app,
      'POST',
      `/api/v1/admin/venue-changes/${c1}/reject`,
      f.admin.accessToken,
      {},
    )
    expect(noNote.statusCode).toBe(400)
    const rej = await call(
      app,
      'POST',
      `/api/v1/admin/venue-changes/${c1}/reject`,
      f.admin.accessToken,
      {
        note: 'Not allowed here',
      },
    )
    expect(rej.json().data).toMatchObject({ status: 'REJECTED', decisionNote: 'Not allowed here' })
    expect(mailsTo(f.owner.email).some((s) => /was not approved/.test(s))).toBe(true)

    const stranger = await signupVerified(app)
    const denied = await call(
      app,
      'DELETE',
      `${P(f.venueId)}/change-requests/${c2}`,
      stranger.accessToken,
    )
    expect(denied.statusCode).toBe(403)
    const wd = await call(
      app,
      'DELETE',
      `${P(f.venueId)}/change-requests/${c2}`,
      f.owner.accessToken,
    )
    expect(wd.json().data.status).toBe('WITHDRAWN')
    expect(
      (await call(app, 'GET', `${P(f.venueId)}/courts`, f.owner.accessToken)).json().data,
    ).toHaveLength(1)
  })

  it('an edit that no longer fits at approval time ends as FAILED with the reason', async () => {
    const f = await buildFixture(app)
    const band = (name: string) =>
      call(app, 'POST', `${P(f.venueId)}/pricing-rules`, f.owner.accessToken, {
        courtId: f.courtId,
        name,
        dayType: 'WEEKEND',
        fromTime: '10:00',
        toTime: '12:00',
        priceMinor: 400000,
        tag: 'PEAK',
        priority: 3,
      })
    const a = (await band('One')).json().data.id
    const b = (await band('Two')).json().data.id // does not overlap anything that exists yet
    const approve = (id: string) =>
      call(app, 'POST', `/api/v1/admin/venue-changes/${id}/approve`, f.admin.accessToken, {})
    expect((await approve(a)).statusCode).toBe(200)
    const second = await approve(b)
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('PRICING_OVERLAP')
    const row = await call(app, 'GET', `/api/v1/admin/venue-changes/${b}`, f.admin.accessToken)
    expect(row.json().data.status).toBe('FAILED')
    expect(row.json().data.failureReason).toMatch(/Overlaps/)
  })

  it('ownerEdit helper: still applies edits end to end', async () => {
    const f = await buildFixture(app)
    const r = await ownerEdit(app, f, 'POST', `${P(f.venueId)}/courts`, {
      name: 'Court Z',
      sport: 'PADEL',
      surface: 'GLASS_PADEL',
      environment: 'INDOOR',
    })
    expect(r.statusCode).toBe(201)
    expect(r.data.id).toBeTruthy()
  })
})

describe('copy a rejected venue', () => {
  it('copies details, photos, courts and prices into a new draft; limited to 3 a day', async () => {
    const owner = await signupVerified(app)
    const v = await buildDraftVenue(app, owner)
    const admin = await loginAdmin(app, (await createAdmin(app.prisma)).email)
    const copyUrl = `${P(v.venueId)}/copy`
    expect((await call(app, 'POST', copyUrl, owner.accessToken)).statusCode).toBe(409) // not rejected yet

    await call(app, 'POST', `${P(v.venueId)}/submit`, owner.accessToken)
    await call(app, 'POST', `${A(v.venueId)}/open-review`, admin)
    const rej = await call(app, 'POST', `${A(v.venueId)}/review`, admin, {
      decision: 'REJECTED',
      comments: 'Photos are not of this ground',
    })
    expect(rej.statusCode).toBe(200)
    expect(mailsTo(owner.email).some((s) => /was not approved/.test(s))).toBe(true)

    const copy = await call(app, 'POST', copyUrl, owner.accessToken)
    expect(copy.statusCode).toBe(201)
    const n = copy.json().data
    expect(n.id).not.toBe(v.venueId)
    expect(n).toMatchObject({ verificationStatus: 'DRAFT', copiedFrom: v.venueId, photos: [PHOTO] })
    const full = (await call(app, 'GET', P(n.id), owner.accessToken)).json().data
    expect(full.courts).toHaveLength(1)
    expect(full.courts[0].pricingRules).toHaveLength(2)
    // the copy can be submitted again
    expect((await call(app, 'POST', `${P(n.id)}/submit`, owner.accessToken)).statusCode).toBe(200)

    expect((await call(app, 'POST', copyUrl, owner.accessToken)).statusCode).toBe(201)
    expect((await call(app, 'POST', copyUrl, owner.accessToken)).statusCode).toBe(201)
    const fourth = await call(app, 'POST', copyUrl, owner.accessToken)
    expect(fourth.statusCode).toBe(429)
    expect(fourth.json().code).toBe('COPY_LIMIT')
    // staff who are not the owner cannot copy
    const stranger = await signupVerified(app)
    expect((await call(app, 'POST', copyUrl, stranger.accessToken)).statusCode).toBe(403)
  })
})
