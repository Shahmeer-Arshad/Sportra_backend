import { FastifyInstance } from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import { buildApp } from '../src/app'
import { testMailbox } from '../src/lib/mailer'
import { uuidv7 } from '../src/lib/id'

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
  return v
}
