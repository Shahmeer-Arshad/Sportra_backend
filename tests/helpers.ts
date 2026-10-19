import { FastifyInstance } from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import { buildApp } from '../src/app'
import { testMailbox } from '../src/lib/mailer'
import { uuidv7 } from '../src/lib/id'
import { addDays, todayIn } from '../src/lib/time'

export const TEST_DOMAIN = '@t.sportra.test'
export const PASSWORD = 'Passw0rdTest1'

let ipCounter = 1
/** Every request gets its own fake IP so the per-IP rate limit never interferes with a test. */
export const nextIp = () =>
  `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`

let emailCounter = 0
export const uniqueEmail = (tag = 'u') => `${tag}${Date.now()}${emailCounter++}${TEST_DOMAIN}`
let phoneCounter = Math.floor(Math.random() * 1e6)
export const uniquePhone = () => `+92300${String(1000000 + phoneCounter++).slice(-7)}`

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp()
  await app.ready()
  return app
}

export async function post(
  app: FastifyInstance,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  cookies?: Record<string, string>,
) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as any,
    headers,
    cookies,
    remoteAddress: nextIp(),
  })
}
export async function call(
  app: FastifyInstance,
  method: 'GET' | 'PATCH' | 'DELETE' | 'PUT' | 'POST',
  url: string,
  token?: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    payload: payload as any,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: nextIp(),
  })
}

/** Latest code e-mailed to an address (tests capture mail in memory). */
export function lastCode(email: string): string {
  const mail = [...testMailbox].reverse().find((m) => m.to === email)
  if (!mail) throw new Error(`no mail sent to ${email}`)
  const m = mail.text.match(/code is (\d{6})/)
  if (!m) throw new Error('no code in mail: ' + mail.text)
  return m[1]
}
export const mailCount = (email: string) => testMailbox.filter((m) => m.to === email).length
export function lastToken(email: string): string {
  const mail = [...testMailbox].reverse().find((m) => m.to === email)
  const m = mail?.text.match(/token is: (\S+)/)
  if (!m) throw new Error('no invitation token')
  return m[1]
}

/** Register + verify an account. Returns tokens and user. */
export async function signupVerified(
  app: FastifyInstance,
  opts: { email?: string; phone?: string; fullName?: string } = {},
) {
  const email = opts.email ?? uniqueEmail()
  const reg = await post(app, '/api/v1/public/auth/register', {
    email,
    password: PASSWORD,
    fullName: opts.fullName ?? 'Test User',
    ...(opts.phone && { phone: opts.phone }),
  })
  if (reg.statusCode !== 202) throw new Error('register failed: ' + reg.body)
  const ver = await post(app, '/api/v1/public/auth/verify-email', { email, code: lastCode(email) })
  if (ver.statusCode !== 200) throw new Error('verify failed: ' + ver.body)
  const body = ver.json()
  return {
    email,
    accessToken: body.accessToken as string,
    userId: body.data.user.id as string,
    refreshCookie: ver.cookies.find((c) => c.name === 'refreshToken')!.value,
  }
}

/** Create an admin straight in the database (admins cannot self-register). */
export async function createAdmin(prisma: PrismaClient, email = uniqueEmail('admin')) {
  const id = uuidv7()
  await prisma.user.create({
    data: {
      id,
      email,
      fullName: 'Test Admin',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      platformRole: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  })
  return { id, email }
}

/** Log in an admin through the real flow (password + emailed code). */
export async function loginAdmin(app: FastifyInstance, email: string) {
  const l = await post(app, '/api/v1/public/auth/login', { email, password: PASSWORD })
  if (!l.json().mfaRequired) throw new Error('admin login should require a code')
  const v = await post(app, '/api/v1/public/auth/login/verify-otp', {
    email,
    code: lastCode(email),
  })
  return v.json().accessToken as string
}

/** Remove everything created by tests (all use the @t.sportra.test domain). */
export async function cleanupTestData(prisma: PrismaClient) {
  const like = `%${TEST_DOMAIN}`
  // venues made by test users, or bulk-inserted by the search-plan test
  const venueIds = Prisma.sql`SELECT id FROM venues WHERE name LIKE 'PLANTEST%' OR owner_user_id IN (SELECT id FROM users WHERE email LIKE ${like})`
  const userIds = Prisma.sql`SELECT id FROM users WHERE email LIKE ${like}`
  const myBookings = Prisma.sql`SELECT id FROM bookings WHERE venue_id IN (${venueIds}) OR user_id IN (${userIds})`
  await prisma.$executeRaw`DELETE FROM invite_rsvps WHERE invite_id IN (SELECT id FROM invites WHERE booking_id IN (${myBookings}))`
  await prisma.$executeRaw`DELETE FROM invites WHERE booking_id IN (${myBookings})`
  await prisma.$executeRaw`DELETE FROM booking_items WHERE booking_id IN (${myBookings})`
  await prisma.$executeRaw`DELETE FROM booking_cancellations WHERE booking_id IN (${myBookings})`
  await prisma.$executeRaw`DELETE FROM bookings WHERE id IN (${myBookings})`
  await prisma.$executeRaw`DELETE FROM slots WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM outage_locks WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM booking_settings WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM venue_blocklist WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM idempotency_keys WHERE split_part(scope, ':', 2) IN (SELECT id::text FROM users WHERE email LIKE ${like} UNION SELECT id::text FROM venues WHERE id IN (${venueIds}))`
  await prisma.$executeRaw`DELETE FROM venue_reviews WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM pricing_rules WHERE court_id IN (SELECT id FROM courts WHERE venue_id IN (${venueIds}))`
  await prisma.$executeRaw`DELETE FROM courts WHERE venue_id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM venues WHERE id IN (${venueIds})`
  await prisma.$executeRaw`DELETE FROM staff_invitations WHERE email LIKE ${like}`
  await prisma.$executeRaw`DELETE FROM venue_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`
  await prisma.$executeRaw`DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`
  await prisma.$executeRaw`DELETE FROM whatsapp_consents WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${like})`
  await prisma.$executeRaw`DELETE FROM otp_challenges WHERE email LIKE ${like}`
  await prisma.$executeRaw`DELETE FROM users WHERE email LIKE ${like}`
  await prisma.$executeRaw`DELETE FROM areas WHERE city = 'Testville'`
}

export const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const hours = (open = '06:00', close = '02:00') =>
  Object.fromEntries(ALL_DAYS.map((d) => [d, [{ open, close }]]))

export interface VenueOpts {
  name?: string
  lat?: number
  lng?: number
  city?: string
  areaId?: string
  sport?: string
  surface?: string
  amenities?: string[]
}

/** Owner builds a complete venue through the API (draft: court + prices). Not yet submitted. */
export async function buildDraftVenue(
  app: FastifyInstance,
  owner: { accessToken: string },
  o: VenueOpts = {},
) {
  const create = await call(app, 'POST', '/api/v1/venues', owner.accessToken, {
    name: o.name ?? 'Test Arena',
    city: o.city ?? 'Testville',
    address: '12 Test Road, Testville',
    lat: o.lat ?? 24.8607,
    lng: o.lng ?? 67.0011,
    amenities: o.amenities ?? ['PARKING'],
    operatingHours: hours(),
    ...(o.areaId && { areaId: o.areaId }),
  })
  if (create.statusCode !== 201) throw new Error('create venue failed: ' + create.body)
  const venueId = create.json().data.id as string
  const court = await call(app, 'POST', `/api/v1/pos/venues/${venueId}/courts`, owner.accessToken, {
    name: 'Court 1',
    sport: o.sport ?? 'FUTSAL_5V5',
    surface: o.surface ?? 'SYNTHETIC_TURF',
  })
  if (court.statusCode !== 201) throw new Error('add court failed: ' + court.body)
  const courtId = court.json().data.id as string
  for (const r of [
    { name: 'Day', fromTime: '06:00', toTime: '18:00', priceMinor: 200000, tag: 'OFF_PEAK' },
    { name: 'Evening', fromTime: '18:00', toTime: '02:00', priceMinor: 300000, tag: 'PEAK' },
  ]) {
    const res = await call(
      app,
      'POST',
      `/api/v1/pos/venues/${venueId}/pricing-rules`,
      owner.accessToken,
      { courtId, dayType: 'ANY', ...r },
    )
    if (res.statusCode !== 201) throw new Error('add rule failed: ' + res.body)
  }
  return { venueId, courtId }
}

/** Draft -> submitted -> approved by an admin. Returns the venue ids. */
export async function buildVerifiedVenue(
  app: FastifyInstance,
  owner: { accessToken: string },
  adminToken: string,
  o: VenueOpts = {},
) {
  const v = await buildDraftVenue(app, owner, o)
  const sub = await call(app, 'POST', `/api/v1/pos/venues/${v.venueId}/submit`, owner.accessToken)
  if (sub.statusCode !== 200) throw new Error('submit failed: ' + sub.body)
  await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/open-review`, adminToken)
  const ok = await call(app, 'POST', `/api/v1/admin/venues/${v.venueId}/review`, adminToken, {
    decision: 'APPROVED',
  })
  if (ok.statusCode !== 200) throw new Error('approve failed: ' + ok.body)
  await app.booking.idle() // slots are generated in the background after approval
  return v
}

// ───────────── Phase 2 helpers ─────────────
let userCounter = 0
/** A ready-to-use active player, created straight in the database (fast; no e-mail round trip). */
export async function makeUser(
  app: FastifyInstance,
  opts: { phone?: string | null; name?: string; email?: string } = {},
) {
  const id = uuidv7()
  const email = opts.email ?? uniqueEmail(`p${userCounter++}`)
  await app.prisma.user.create({
    data: {
      id,
      email,
      fullName: opts.name ?? 'Player One',
      phone: opts.phone === null ? null : (opts.phone ?? uniquePhone()),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  })
  const accessToken = app.jwt.sign({ sub: id, email, role: 'USER' })
  return { id, email, accessToken }
}

/** Give a user a staff role at a venue (OWNER, MANAGER, FRONT_DESK, SCORER). */
export async function addStaff(
  prisma: PrismaClient,
  venueId: string,
  userId: string,
  role: string,
) {
  await prisma.venueMembership.create({ data: { id: uuidv7(), venueId, userId, role } })
}

export interface Fixture {
  admin: { id: string; email: string; accessToken: string }
  owner: Awaited<ReturnType<typeof signupVerified>>
  venueId: string
  courtId: string
  manager: { id: string; accessToken: string }
  frontDesk: { id: string; accessToken: string }
}

/** A verified venue with one court (slots generated), an owner, a manager, a front desk and an admin. */
export async function buildFixture(app: FastifyInstance, opts: VenueOpts = {}): Promise<Fixture> {
  const adminRow = await createAdmin(app.prisma)
  const adminToken = await loginAdmin(app, adminRow.email)
  const owner = await signupVerified(app)
  const v = await buildVerifiedVenue(app, owner, adminToken, { name: 'Booking Arena', ...opts })
  const manager = await makeUser(app)
  const frontDesk = await makeUser(app)
  await addStaff(app.prisma, v.venueId, manager.id, 'MANAGER')
  await addStaff(app.prisma, v.venueId, frontDesk.id, 'FRONT_DESK')
  return {
    admin: { ...adminRow, accessToken: adminToken },
    owner,
    venueId: v.venueId,
    courtId: v.courtId,
    manager,
    frontDesk,
  }
}

export const tomorrow = () => addDays(todayIn(), 1)
export const dayAfter = (n: number) => addDays(todayIn(), n)

export interface SlotInfo {
  id: string
  court_id: string
  start_at: Date
  end_at: Date
  business_date: Date
  price_minor: bigint
  status: string
  version: number
}

/** Slots of a court on a business date, in time order. */
export async function slotsOn(
  prisma: PrismaClient,
  courtId: string,
  date: string,
): Promise<SlotInfo[]> {
  return prisma.$queryRaw<SlotInfo[]>`
    SELECT id, court_id, start_at, end_at, business_date, price_minor, status, version FROM slots
     WHERE court_id = ${courtId}::uuid AND business_date = ${date}::date ORDER BY start_at`
}

/** The first n consecutive hours on a later day (offset in days from today, default tomorrow). */
export async function pickSlots(
  prisma: PrismaClient,
  courtId: string,
  n: number,
  opts: { dayOffset?: number; skip?: number } = {},
): Promise<SlotInfo[]> {
  const rows = await slotsOn(prisma, courtId, dayAfter(opts.dayOffset ?? 1))
  const from = opts.skip ?? 0
  const picked = rows.slice(from, from + n)
  if (picked.length < n) throw new Error('not enough slots to pick')
  return picked
}

let keyCounter = 0
export const newKey = () =>
  `test-key-${Date.now()}-${keyCounter++}-${Math.random().toString(36).slice(2, 8)}`
export const newUuidKey = () => uuidv7()

/** POST/DELETE/PATCH/GET with a bearer token and an Idempotency-Key. */
export async function callKeyed(
  app: FastifyInstance,
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'GET',
  url: string,
  token: string | undefined,
  payload?: unknown,
  key: string | null = newKey(),
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    payload: payload as never,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...extraHeaders,
    },
    remoteAddress: nextIp(),
  })
}

/** Player holds hours. Returns the raw response. */
export function holdHours(
  app: FastifyInstance,
  token: string,
  courtId: string,
  slotIds: string[],
  key = newKey(),
) {
  return callKeyed(app, 'POST', '/api/v1/bookings/holds', token, { courtId, slotIds }, key)
}

/** Move a booking (and its hours) to start at the given instant, one hour per hour. For time-dependent tests. */
export async function moveBookingTime(prisma: PrismaClient, bookingId: string, startAt: Date) {
  const items = await prisma.$queryRaw<{ id: string; slot_id: string }[]>`
    SELECT id, slot_id FROM booking_items WHERE booking_id = ${bookingId}::uuid ORDER BY start_at`
  // Step 1: park the hours far away, so no half-moved hour overlaps the booking's own other hours
  // (the database refuses overlapping active items at every single statement).
  for (const it of items) {
    await prisma.$executeRaw`UPDATE booking_items SET start_at = start_at + interval '100 years', end_at = end_at + interval '100 years' WHERE id = ${it.id}::uuid`
    await prisma.$executeRaw`UPDATE slots SET start_at = start_at + interval '100 years', end_at = end_at + interval '100 years' WHERE id = ${it.slot_id}::uuid`
  }
  // Step 2: put them in place, one hour after the other
  let i = 0
  for (const it of items) {
    const s = new Date(startAt.getTime() + i * 3600_000)
    const e = new Date(s.getTime() + 3600_000)
    await prisma.$executeRaw`UPDATE slots SET start_at = ${s}, end_at = ${e} WHERE id = ${it.slot_id}::uuid`
    await prisma.$executeRaw`UPDATE booking_items SET start_at = ${s}, end_at = ${e} WHERE id = ${it.id}::uuid`
    i++
  }
  const last = new Date(startAt.getTime() + items.length * 3600_000)
  await prisma.$executeRaw`UPDATE bookings SET start_at = ${startAt}, end_at = ${last} WHERE id = ${bookingId}::uuid`
}

/** Many players at once (bulk insert), each with a token. For load and race tests. */
export async function makeUsers(app: FastifyInstance, n: number) {
  const rows = Array.from({ length: n }, (_, i) => {
    const id = uuidv7()
    return { id, email: uniqueEmail(`bulk${i}x`), phone: uniquePhone() }
  })
  await app.prisma.user.createMany({
    data: rows.map((r) => ({
      id: r.id,
      email: r.email,
      phone: r.phone,
      fullName: 'Bulk Player',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    })),
  })
  return rows.map((r) => ({
    ...r,
    accessToken: app.jwt.sign({ sub: r.id, email: r.email, role: 'USER' }),
  }))
}

/** Postgres deadlocks since the database was created. A deadlock is a bug in lock ordering. */
export async function deadlockCount(prisma: PrismaClient): Promise<number> {
  const r = await prisma.$queryRaw<
    { d: bigint }[]
  >`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`
  return Number(r[0].d)
}

/**
 * The promises Phase 2 must keep, checked straight in the database for the given courts:
 *  - a booked hour has exactly one active item, and the other way round
 *  - a live hold belongs to exactly one pending booking
 *  - free hours carry no booking or hold
 *  - no two active items overlap on a court
 *  - an active booking's total is the sum of its active items
 */
export async function assertInventoryInvariants(prisma: PrismaClient, courtIds: string[]) {
  const problems: string[] = []
  const q = async (label: string, rows: Promise<unknown[]>) => {
    const r = await rows
    if (r.length) problems.push(`${label}: ${JSON.stringify(r.slice(0, 3))}`)
  }
  await q(
    'booked hour without exactly one active item',
    prisma.$queryRaw`SELECT s.id FROM slots s WHERE s.court_id = ANY(${courtIds}::uuid[]) AND s.status IN ('BOOKED_APP','BOOKED_WALKIN')
       AND (SELECT count(*) FROM booking_items i WHERE i.slot_id = s.id AND i.status = 'CONFIRMED') <> 1`,
  )
  await q(
    'active item on an hour that is not booked by that booking',
    prisma.$queryRaw`SELECT i.id FROM booking_items i JOIN slots s ON s.id = i.slot_id
       WHERE i.court_id = ANY(${courtIds}::uuid[]) AND i.status = 'CONFIRMED'
         AND (s.status NOT IN ('BOOKED_APP','BOOKED_WALKIN') OR s.booking_id IS DISTINCT FROM i.booking_id)`,
  )
  await q(
    'live hold without exactly one pending booking',
    prisma.$queryRaw`SELECT s.id FROM slots s WHERE s.court_id = ANY(${courtIds}::uuid[]) AND s.status = 'HELD' AND s.hold_expires_at > clock_timestamp()
       AND (SELECT count(*) FROM bookings b WHERE b.hold_id = s.hold_id AND b.status = 'PENDING_PAYMENT' AND s.id = ANY(b.slot_ids)) <> 1`,
  )
  await q(
    'free hour still carrying a booking or hold',
    prisma.$queryRaw`SELECT id FROM slots WHERE court_id = ANY(${courtIds}::uuid[]) AND status = 'AVAILABLE'
       AND (booking_id IS NOT NULL OR hold_id IS NOT NULL OR hold_expires_at IS NOT NULL OR block_reason IS NOT NULL)`,
  )
  await q(
    'overlapping active items',
    prisma.$queryRaw`SELECT a.id FROM booking_items a JOIN booking_items b ON a.court_id = b.court_id AND a.id < b.id
       AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED' AND tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)
       WHERE a.court_id = ANY(${courtIds}::uuid[])`,
  )
  await q(
    'booking total differs from its active items',
    prisma.$queryRaw`SELECT b.id FROM bookings b WHERE b.court_id = ANY(${courtIds}::uuid[]) AND b.status IN ('CONFIRMED','CHECKED_IN')
       AND b.total_minor <> COALESCE((SELECT sum(price_minor) FROM booking_items i WHERE i.booking_id = b.id AND i.status = 'CONFIRMED'), 0)`,
  )
  if (problems.length) throw new Error('Inventory invariants broken:\n' + problems.join('\n'))
}

/** Another court for an existing venue fixture (own slots), for tests that move bookings to "now". */
export async function addCourt(
  app: FastifyInstance,
  f: Fixture,
  name = 'Extra Court',
  wait = true,
) {
  const res = await call(
    app,
    'POST',
    `/api/v1/pos/venues/${f.venueId}/courts`,
    f.owner.accessToken,
    {
      name,
      sport: 'FUTSAL_5V5',
      surface: 'SYNTHETIC_TURF',
    },
  )
  if (res.statusCode !== 201) throw new Error('add court failed: ' + res.body)
  const courtId = res.json().data.id as string
  for (const r of [
    { name: 'Day', fromTime: '06:00', toTime: '18:00', priceMinor: 200000, tag: 'OFF_PEAK' },
    { name: 'Evening', fromTime: '18:00', toTime: '02:00', priceMinor: 300000, tag: 'PEAK' },
  ]) {
    const p = await call(
      app,
      'POST',
      `/api/v1/pos/venues/${f.venueId}/pricing-rules`,
      f.owner.accessToken,
      { courtId, dayType: 'ANY', ...r },
    )
    if (p.statusCode !== 201) throw new Error('add rule failed: ' + p.body)
  }
  if (wait) await app.booking.idle()
  return courtId
}
