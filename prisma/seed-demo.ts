import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import { uuidv7 } from '../src/lib/id'
import { createHotLane } from '../src/lib/hotlane'
import { addDays, todayIn } from '../src/lib/time'
import { createBookingModule } from '../src/modules/booking/booking.module'
import { buildSnapshot } from '../src/modules/venue/venue.snapshot'
import { roleQueries } from '../src/modules/rbac/rbac.queries'

/**
 * Test showcase (dev only, safe to run again): people for every role, one big approved venue with
 * four courts, venues in every review state for the admin queue, and a few real bookings.
 * `npm run db:seed` runs it after the base seed. Skipped when NODE_ENV=production.
 *
 *   password for all accounts below: Player@12345 / Owner@12345 / Staff@12345 (see PEOPLE)
 *   staff and admin logins ask for an e-mailed code: dev mail is at http://localhost:58025
 */
const PHOTO = 'https://res.cloudinary.com/demo/image/upload/sample.jpg'
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const hours = (open: string, close: string) =>
  Object.fromEntries(DAYS.map((d) => [d, [{ open, close }]]))

type Role = 'USER' | 'GROUND_OWNER' | 'TOURNAMENT_ORGANIZER'
const PEOPLE: Array<{
  email: string
  name: string
  phone: string
  password: string
  roles: Role[]
  intent?: 'GROUND_OWNER' | 'STAFF'
}> = [
  {
    email: 'player1@sportra.local',
    name: 'Ali Player',
    phone: '+923001000001',
    password: 'Player@12345',
    roles: ['USER'],
  },
  {
    email: 'player2@sportra.local',
    name: 'Sara Player',
    phone: '+923001000002',
    password: 'Player@12345',
    roles: ['USER'],
  },
  {
    email: 'player3@sportra.local',
    name: 'Hamza Player',
    phone: '+923001000003',
    password: 'Player@12345',
    roles: ['USER'],
  },
  {
    email: 'owner2@sportra.local',
    name: 'Showcase Owner',
    phone: '+923001000010',
    password: 'Owner@12345',
    roles: ['USER', 'GROUND_OWNER'],
    intent: 'GROUND_OWNER',
  },
  {
    email: 'manager@sportra.local',
    name: 'Mona Manager',
    phone: '+923001000011',
    password: 'Staff@12345',
    roles: ['USER'],
    intent: 'STAFF',
  },
  {
    email: 'frontdesk@sportra.local',
    name: 'Farhan Front Desk',
    phone: '+923001000012',
    password: 'Staff@12345',
    roles: ['USER'],
    intent: 'STAFF',
  },
  {
    email: 'organizer@sportra.local',
    name: 'Omar Organizer',
    phone: '+923001000013',
    password: 'Staff@12345',
    roles: ['USER', 'TOURNAMENT_ORGANIZER'],
  },
]

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

interface CourtSpec {
  name: string
  sport: string
  surface: string
  environment: 'INDOOR' | 'OUTDOOR'
  capacity: number
  base: bigint // off-peak price per hour, in paisa
}
interface VenueSpec {
  name: string
  area: string
  status: 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'VERIFIED' | 'SUSPENDED'
  lat: number
  lng: number
  courts: CourtSpec[]
}

const COMPLEX = 'Sportra Sports Complex DHA'
const VENUES: VenueSpec[] = [
  {
    name: COMPLEX,
    area: 'DHA',
    status: 'VERIFIED',
    lat: 24.8138,
    lng: 67.064,
    courts: [
      {
        name: 'Futsal Pitch',
        sport: 'FUTSAL_5V5',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 10,
        base: 250000n,
      },
      {
        name: 'Padel Court',
        sport: 'PADEL',
        surface: 'GLASS_PADEL',
        environment: 'INDOOR',
        capacity: 4,
        base: 300000n,
      },
      {
        name: 'Badminton Hall',
        sport: 'BADMINTON',
        surface: 'WOODEN_FLOOR',
        environment: 'INDOOR',
        capacity: 4,
        base: 120000n,
      },
      {
        name: 'Box Cricket',
        sport: 'BOX_CRICKET',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 12,
        base: 200000n,
      },
    ],
  },
  {
    name: 'Clifton Beach Futsal',
    area: 'Clifton',
    status: 'VERIFIED',
    lat: 24.8,
    lng: 67.03,
    courts: [
      {
        name: 'Beach Pitch',
        sport: 'FUTSAL_5V5',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 10,
        base: 200000n,
      },
    ],
  },
  {
    name: 'Gulberg Padel Club',
    area: 'Gulberg',
    status: 'VERIFIED',
    lat: 31.5204,
    lng: 74.3587,
    courts: [
      {
        name: 'Court A',
        sport: 'PADEL',
        surface: 'GLASS_PADEL',
        environment: 'INDOOR',
        capacity: 4,
        base: 320000n,
      },
      {
        name: 'Court B',
        sport: 'PADEL',
        surface: 'GLASS_PADEL',
        environment: 'INDOOR',
        capacity: 4,
        base: 320000n,
      },
    ],
  },
  // not live yet: for the owner wizard and the admin review queue
  {
    name: 'Draft Arena (owner still editing)',
    area: 'PECHS',
    status: 'DRAFT',
    lat: 24.8667,
    lng: 67.0511,
    courts: [
      {
        name: 'Court 1',
        sport: 'FUTSAL_5V5',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 10,
        base: 180000n,
      },
    ],
  },
  {
    name: 'Awaiting Review Arena',
    area: 'Gulshan-e-Iqbal',
    status: 'SUBMITTED',
    lat: 24.9215,
    lng: 67.092,
    courts: [
      {
        name: 'Court 1',
        sport: 'BOX_CRICKET',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 12,
        base: 190000n,
      },
    ],
  },
  {
    name: 'Changes Requested Arena',
    area: 'Scheme 33',
    status: 'CHANGES_REQUESTED',
    lat: 24.9833,
    lng: 67.1333,
    courts: [
      {
        name: 'Court 1',
        sport: 'BADMINTON',
        surface: 'WOODEN_FLOOR',
        environment: 'INDOOR',
        capacity: 4,
        base: 110000n,
      },
    ],
  },
  {
    name: 'Rejected Arena',
    area: 'Johar Town',
    status: 'REJECTED',
    lat: 31.4697,
    lng: 74.2728,
    courts: [
      {
        name: 'Court 1',
        sport: 'FUTSAL_5V5',
        surface: 'SYNTHETIC_TURF',
        environment: 'OUTDOOR',
        capacity: 10,
        base: 170000n,
      },
    ],
  },
  {
    name: 'Suspended Arena (online paused)',
    area: 'Model Town',
    status: 'SUSPENDED',
    lat: 31.4833,
    lng: 74.3167,
    courts: [
      {
        name: 'Court 1',
        sport: 'PADEL',
        surface: 'GLASS_PADEL',
        environment: 'INDOOR',
        capacity: 4,
        base: 280000n,
      },
    ],
  },
]

export async function seedShowcase(prisma: PrismaClient, adminId: string) {
  if (process.env.NODE_ENV === 'production') {
    console.log('⏭  Showcase data skipped (NODE_ENV=production)')
    return
  }
  const roles = roleQueries(prisma)

  // ───────── people ─────────
  const people = new Map<string, string>()
  for (const p of PEOPLE) {
    const u = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: {
        id: uuidv7(),
        email: p.email,
        fullName: p.name,
        phone: p.phone,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        signupIntent: p.intent ?? 'USER',
        passwordHash: await bcrypt.hash(p.password, 12),
      },
    })
    for (const r of p.roles) await roles.grantRole(u.id, r)
    people.set(p.email, u.id)
  }
  console.log(`✅ ${PEOPLE.length} test accounts (players, owner2, manager, frontdesk, organizer)`)
  const ownerId = people.get('owner2@sportra.local')!

  // ───────── venues in every state ─────────
  const venueIds = new Map<string, string>()
  for (const spec of VENUES) {
    const found = await prisma.venue.findFirst({ where: { name: spec.name } })
    if (found) {
      venueIds.set(spec.name, found.id)
      continue
    }
    const area = await prisma.area.findFirst({ where: { name: spec.area } })
    const id = uuidv7()
    const live = spec.status === 'VERIFIED' || spec.status === 'SUSPENDED'
    const submitted = spec.status !== 'DRAFT'
    await prisma.$transaction(async (tx) => {
      await tx.venue.create({
        data: {
          id,
          ownerUserId: ownerId,
          name: spec.name,
          slug: `${slug(spec.name)}-${id.slice(-6)}`,
          city: area?.city ?? 'Karachi',
          areaId: area?.id,
          address: `Main Boulevard, ${spec.area}, ${area?.city ?? 'Karachi'}`,
          lat: spec.lat,
          lng: spec.lng,
          amenities: ['PARKING', 'FLOODLIGHTS', 'WASHROOMS', 'CHANGING_ROOMS', 'CAFE'],
          photos: [PHOTO],
          contactPhone: '+923001234567',
          operatingHours: hours('06:00', '02:00'),
          cancellationCutoffHours: 12,
          verificationStatus: spec.status,
          onboardingStep: submitted ? 8 : 4,
          submittedAt: submitted ? new Date() : null,
          verifiedAt: live ? new Date() : null,
          verifiedBy: live ? adminId : null,
          suspensionMode: spec.status === 'SUSPENDED' ? 'PAUSE_ONLINE' : null,
          suspendedAt: spec.status === 'SUSPENDED' ? new Date() : null,
        },
      })
      await tx.venueMembership.create({
        data: { id: uuidv7(), userId: ownerId, venueId: id, role: 'OWNER' },
      })
      for (const c of spec.courts) {
        const courtId = uuidv7()
        await tx.court.create({
          data: {
            id: courtId,
            venueId: id,
            name: c.name,
            sport: c.sport,
            surface: c.surface,
            environment: c.environment,
            capacity: c.capacity,
            images: [PHOTO],
          },
        })
        await tx.pricingRule.createMany({
          data: [
            {
              id: uuidv7(),
              courtId,
              name: 'Day',
              dayType: 'ANY',
              fromTime: '06:00',
              toTime: '18:00',
              priceMinor: c.base,
              tag: 'OFF_PEAK',
            },
            {
              id: uuidv7(),
              courtId,
              name: 'Evening',
              dayType: 'ANY',
              fromTime: '18:00',
              toTime: '02:00',
              priceMinor: c.base + 100000n,
              tag: 'PEAK',
            },
            {
              id: uuidv7(),
              courtId,
              name: 'Weekend',
              dayType: 'WEEKEND',
              fromTime: '06:00',
              toTime: '02:00',
              priceMinor: c.base + 150000n,
              priority: 5,
              tag: 'PEAK',
            },
          ],
        })
      }
      if (submitted) {
        const v = await tx.venue.findUniqueOrThrow({ where: { id } })
        const courts = await tx.court.findMany({
          where: { venueId: id },
          include: { pricingRules: true },
        })
        await tx.venueSubmission.create({
          data: {
            id: uuidv7(),
            venueId: id,
            submissionNo: 1,
            snapshot: buildSnapshot(v, courts) as never,
          },
        })
      }
      if (spec.status === 'CHANGES_REQUESTED' || spec.status === 'REJECTED') {
        await tx.venueReview.create({
          data: {
            id: uuidv7(),
            venueId: id,
            submissionNo: 1,
            reviewerId: adminId,
            decision: spec.status,
            comments:
              spec.status === 'REJECTED'
                ? 'Ownership documents could not be verified.'
                : 'The map pin is far from the address. Please move it and resubmit.',
            fieldFlags:
              spec.status === 'REJECTED'
                ? []
                : [{ field: 'location', note: 'Pin is 3 km from the address' }],
          },
        })
      }
      await tx.bookingSettings.upsert({
        where: { venueId: id },
        update: {},
        create: { venueId: id, payAtVenueEnabled: true, updatedBy: ownerId },
      })
    })
    venueIds.set(spec.name, id)
  }
  console.log(
    `✅ ${VENUES.length} showcase venues (verified, draft, submitted, changes requested, rejected, suspended)`,
  )

  // staff of the big venue
  const complexId = venueIds.get(COMPLEX)!
  for (const [email, role] of [
    ['manager@sportra.local', 'MANAGER'],
    ['frontdesk@sportra.local', 'FRONT_DESK'],
  ] as const) {
    await prisma.venueMembership.upsert({
      where: { userId_venueId: { userId: people.get(email)!, venueId: complexId } },
      update: {},
      create: {
        id: uuidv7(),
        userId: people.get(email)!,
        venueId: complexId,
        role,
        invitedBy: ownerId,
      },
    })
  }

  // ───────── slots, then real bookings through the booking module ─────────
  const booking = createBookingModule(prisma, createHotLane(null))
  await booking.slots.generateAll([...venueIds.values()])

  const player1 = people.get('player1@sportra.local')!
  const already = await prisma.booking.count({ where: { venueId: complexId } })
  if (already > 0) {
    console.log('⏭  Sample bookings already exist')
    return
  }
  const court = await prisma.court.findFirstOrThrow({
    where: { venueId: complexId, sport: 'FUTSAL_5V5' },
  })
  const day = addDays(todayIn('Asia/Karachi'), 1)
  const free = await prisma.$queryRaw<{ id: string; start_at: Date }[]>`
    SELECT id, start_at FROM slots
     WHERE court_id = ${court.id}::uuid AND business_date = ${day}::date AND status = 'AVAILABLE'
       AND start_at > now() + interval '1 hour'
     ORDER BY start_at LIMIT 8`
  if (free.length < 6) {
    console.log('⏭  Not enough free hours for sample bookings')
    return
  }
  // 1) a player books two hours and confirms (pay at venue)
  const hold = (await booking.createHold(
    player1,
    { courtId: court.id, slotIds: [free[0].id, free[1].id] },
    'seed-player1-hold',
  )) as { body: { id: string } }
  await booking.payAtVenue(player1, hold.body.id, 'seed-player1-confirm')
  // 2) front desk records a walk-in who paid cash
  const frontDesk = { id: people.get('frontdesk@sportra.local')!, role: 'FRONT_DESK' as const }
  await booking.staffBooking.walkIn(
    complexId,
    frontDesk,
    {
      courtId: court.id,
      slotIds: [free[3].id],
      customerName: 'Walk-in Bilal',
      customerPhone: '+923001234500',
    },
    'seed-walkin',
  )
  // 3) a phone booking, to be paid later
  await booking.staffBooking.manual(
    complexId,
    frontDesk,
    {
      courtId: court.id,
      slotIds: [free[5].id],
      customerName: 'Phone Zainab',
      customerPhone: '+923001234501',
      payLater: true,
    },
    'seed-manual',
  )
  console.log(
    `✅ 3 sample bookings at ${COMPLEX} on ${day} (player booking, walk-in, phone booking)`,
  )
}
