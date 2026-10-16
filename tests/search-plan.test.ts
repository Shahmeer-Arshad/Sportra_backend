import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { searchVenues } from '../src/modules/venue/venue.search'
import { cleanupTestData } from './helpers'

const prisma = new PrismaClient({ log: ['error'] })
const N = 10_000

beforeAll(async () => {
  await cleanupTestData(prisma)
  // 10k verified venues scattered across Pakistan, with one court and one price each
  await prisma.$executeRaw`
    INSERT INTO venues (id, owner_user_id, name, slug, city, address, lat, lng, operating_hours, verification_status, updated_at)
    SELECT gen_random_uuid(), gen_random_uuid(), 'PLANTEST bulk ' || g, 'plantest-bulk-' || g, 'Bulkville', 'addr ' || g,
           24 + random() * 10, 66 + random() * 9, '{}'::jsonb, 'VERIFIED', now()
    FROM generate_series(1, ${N}) g`
  await prisma.$executeRaw`
    INSERT INTO courts (id, venue_id, name, sport, surface, updated_at)
    SELECT gen_random_uuid(), id, 'C1', 'FUTSAL_5V5', 'SYNTHETIC_TURF', now() FROM venues WHERE name LIKE 'PLANTEST bulk%'`
  await prisma.$executeRaw`ANALYZE venues`
  await prisma.$executeRaw`ANALYZE courts`
}, 120000)
afterAll(async () => {
  await cleanupTestData(prisma)
  await prisma.$disconnect()
})

describe('search at 10k venues', () => {
  it('the radius query uses the PostGIS GiST index', async () => {
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT id FROM venues v WHERE v.verification_status = 'VERIFIED' AND v.is_active
       AND ST_DWithin(v.location, ST_SetSRID(ST_MakePoint(67.06, 24.81), 4326)::geography, 5000)`,
    )
    const text = plan.map((r) => r['QUERY PLAN']).join('\n')
    expect(text).toMatch(/venues_location_gix/)
    expect(text).not.toMatch(/Seq Scan on venues/)
  })

  it('p95 search time stays under 500 ms', async () => {
    const times: number[] = []
    for (let i = 0; i < 30; i++) {
      const lat = 24 + Math.random() * 10
      const lng = 66 + Math.random() * 9
      const t = performance.now()
      await searchVenues(prisma, { lat, lng, radiusKm: 20, sport: ['FUTSAL_5V5'], limit: 20 })
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.floor(times.length * 0.95) - 1]
    expect(p95).toBeLessThan(500)
  })

  it('returns correct counts: every result is truly inside the radius', async () => {
    const res = await searchVenues(prisma, { lat: 30, lng: 70, radiusKm: 20, limit: 50 })
    expect(res.items.every((i) => i.distanceM! <= 20_000)).toBe(true)
    const exact = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM venues WHERE name LIKE 'PLANTEST bulk%'
      AND ST_Distance(location, ST_SetSRID(ST_MakePoint(70, 30), 4326)::geography) <= 20000`
    expect(res.items.length).toBe(Math.min(50, Number(exact[0].n)))
  })
})
