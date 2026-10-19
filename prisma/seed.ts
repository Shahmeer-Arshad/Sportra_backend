import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import { uuidv7 } from '../src/lib/id'
import { createHotLane } from '../src/lib/hotlane'
import { createBookingModule } from '../src/modules/booking/booking.module'

/**
 * Dev seed (safe to run again): an admin, areas for Karachi and Lahore, one demo owner and 20
 * verified demo venues with courts and prices, then bookable slots for the whole horizon (Phase 2).
 * Demo venues are skipped if they already exist; slot generation is idempotent.
 */
const prisma = new PrismaClient()

const AREAS = [
  ['Karachi', 'DHA', 24.8138, 67.064, ['Defence']],
  ['Karachi', 'Clifton', 24.813, 67.03, []],
  ['Karachi', 'Gulshan-e-Iqbal', 24.9215, 67.092, ['Gulshan']],
  ['Karachi', 'PECHS', 24.8667, 67.0511, []],
  ['Karachi', 'Scheme 33', 24.9833, 67.1333, []],
  ['Lahore', 'Johar Town', 31.4697, 74.2728, []],
  ['Lahore', 'Gulberg', 31.5204, 74.3587, []],
  ['Lahore', 'Model Town', 31.4833, 74.3167, []],
] as const

const SPORTS = [
  ['FUTSAL_5V5', 'SYNTHETIC_TURF'],
  ['BOX_CRICKET', 'SYNTHETIC_TURF'],
  ['PADEL', 'GLASS_PADEL'],
  ['BADMINTON', 'WOODEN_FLOOR'],
  ['HARDBALL_CRICKET', 'NATURAL_GRASS'],
] as const
const AMENITIES = [
  'PARKING',
  'FLOODLIGHTS',
  'WASHROOMS',
  'CHANGING_ROOMS',
  'CAFE',
  'WIFI',
  'SEATING',
]
const HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
    d,
    [{ open: '06:00', close: '02:00' }],
  ]),
)

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function main() {
  console.log('🌱 Seeding...')
  const adminEmail = (process.env.ADMIN_SEED_EMAIL ?? 'admin@sportra.local').toLowerCase()
  const adminPassword = process.env.ADMIN_SEED_PASSWORD ?? 'Admin@12345'
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      id: uuidv7(),
      email: adminEmail,
      fullName: 'Platform Admin',
      platformRole: 'PLATFORM_ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await bcrypt.hash(adminPassword, 12),
    },
  })
  console.log(
    `✅ Admin: ${adminEmail} (log in, then enter the e-mailed code; dev mail is at http://localhost:58025)`,
  )

  const areaIds: { id: string; city: string; name: string; lat: number; lng: number }[] = []
  for (const [city, name, lat, lng, aliases] of AREAS) {
    const a = await prisma.area.upsert({
      where: { city_slug: { city, slug: slug(name) } },
      update: {},
      create: { id: uuidv7(), city, name, slug: slug(name), lat, lng, aliases: [...aliases] },
    })
    areaIds.push({ id: a.id, city, name, lat, lng })
  }
  console.log(`✅ ${areaIds.length} areas`)

  const ownerEmail = 'demo.owner@sportra.local'
  const owner = await prisma.user.upsert({
    where: { email: ownerEmail },
    update: {},
    create: {
      id: uuidv7(),
      email: ownerEmail,
      fullName: 'Demo Owner',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      signupIntent: 'OWNER',
      passwordHash: await bcrypt.hash('Owner@12345', 12),
    },
  })

  let created = 0
  for (let i = 0; i < 20; i++) {
    const area = areaIds[i % areaIds.length]
    const [sport, surface] = SPORTS[i % SPORTS.length]
    const name = `${area.name} ${sport.split('_')[0][0]}${sport.split('_')[0].slice(1).toLowerCase()} Arena ${i + 1}`
    const exists = await prisma.venue.findFirst({ where: { name } })
    if (exists) continue
    const id = uuidv7()
    // small deterministic offset so venues of one area are not all on the same point
    const lat = area.lat + (((i * 37) % 21) - 10) * 0.002
    const lng = area.lng + (((i * 53) % 21) - 10) * 0.002
    await prisma.$transaction(async (tx) => {
      await tx.venue.create({
        data: {
          id,
          ownerUserId: owner.id,
          name,
          slug: `${slug(name)}-${id.slice(-6)}`,
          city: area.city,
          areaId: area.id,
          address: `Plot ${i + 10}, ${area.name}, ${area.city}`,
          lat,
          lng,
          amenities: AMENITIES.filter((_, k) => (i + k) % 3 !== 0),
          operatingHours: HOURS,
          cancellationCutoffHours: 12 + (i % 3) * 6,
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date(),
          verifiedBy: owner.id,
          contactPhone: '+923001234567',
        },
      })
      await tx.venueMembership.upsert({
        where: { userId_venueId: { userId: owner.id, venueId: id } },
        update: {},
        create: { id: uuidv7(), userId: owner.id, venueId: id, role: 'OWNER' },
      })
      const courtId = uuidv7()
      await tx.court.create({ data: { id: courtId, venueId: id, name: 'Court 1', sport, surface } })
      const base = 150000n + BigInt((i % 5) * 50000)
      await tx.pricingRule.createMany({
        data: [
          {
            id: uuidv7(),
            courtId,
            name: 'Day',
            dayType: 'ANY',
            fromTime: '06:00',
            toTime: '18:00',
            priceMinor: base,
            tag: 'OFF_PEAK',
          },
          {
            id: uuidv7(),
            courtId,
            name: 'Evening',
            dayType: 'ANY',
            fromTime: '18:00',
            toTime: '02:00',
            priceMinor: base + 100000n,
            tag: 'PEAK',
          },
        ],
      })
    })
    created++
  }
  console.log(`✅ ${created} demo venues created (${20 - created} already existed)`)
  // Phase 2: slots for every verified venue (what the nightly worker job does)
  const gen = await createBookingModule(prisma, createHotLane(null)).slots.generateAll()
  console.log(`✅ Slots ready for ${gen.venues} verified venues (${gen.inserted} new hours)`)
  console.log('✅ Seed completed. Demo owner: demo.owner@sportra.local / Owner@12345')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
