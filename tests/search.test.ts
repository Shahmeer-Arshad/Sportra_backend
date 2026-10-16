import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FastifyInstance } from 'fastify'
import {
  makeApp,
  call,
  signupVerified,
  createAdmin,
  loginAdmin,
  cleanupTestData,
  buildDraftVenue,
  buildVerifiedVenue,
} from './helpers'

let app: FastifyInstance
let adminToken: string
const ids: Record<string, string> = {}
const DHA = { lat: 24.8138, lng: 67.064 }
const S = '/api/v1/public/venues/search'
const search = (qs: string) => call(app, 'GET', `${S}?q=GeoT&${qs}`)
const names = (r: any) => r.json().data.items.map((i: any) => i.name)

beforeAll(async () => {
  app = await makeApp()
  await cleanupTestData(app.prisma)
  const admin = await createAdmin(app.prisma)
  adminToken = await loginAdmin(app, admin.email)
  const owner = await signupVerified(app)
  const mk = async (key: string, o: any) => {
    const v = await buildVerifiedVenue(app, owner, adminToken, {
      name: `PLANTEST GeoT ${key}`,
      ...o,
    })
    ids[key] = v.venueId
  }
  const area = (
    await call(app, 'POST', '/api/v1/admin/areas', adminToken, {
      city: 'Testville',
      name: 'GeoT Zone',
      aliases: ['Gee Tee'],
      lat: 24.81,
      lng: 67.06,
    })
  ).json().data
  ids.area = area.id
  await mk('DHA Futsal', {
    lat: DHA.lat,
    lng: DHA.lng,
    sport: 'FUTSAL_5V5',
    surface: 'SYNTHETIC_TURF',
    amenities: ['PARKING', 'FLOODLIGHTS'],
    areaId: area.id,
  })
  await mk('Clifton Padel', {
    lat: 24.813,
    lng: 67.03,
    sport: 'PADEL',
    surface: 'GLASS_PADEL',
    amenities: ['CAFE', 'PARKING'],
  })
  await mk('Gulshan Cricket', {
    lat: 24.9215,
    lng: 67.092,
    sport: 'BOX_CRICKET',
    surface: 'SYNTHETIC_TURF',
    amenities: ['FLOODLIGHTS'],
  })
  await mk('Lahore Badminton', {
    lat: 31.5204,
    lng: 74.3587,
    sport: 'BADMINTON',
    surface: 'WOODEN_FLOOR',
    amenities: ['AC'],
    city: 'Lahore',
  })
  // a draft and a suspended venue right next to DHA: must never be returned
  const draft = await buildDraftVenue(app, owner, {
    name: 'PLANTEST GeoT Draft Near',
    lat: DHA.lat,
    lng: DHA.lng,
  })
  ids.draft = draft.venueId
  const susp = await buildVerifiedVenue(app, owner, adminToken, {
    name: 'PLANTEST GeoT Suspended Near',
    lat: DHA.lat,
    lng: DHA.lng,
  })
  await call(app, 'POST', `/api/v1/admin/venues/${susp.venueId}/suspend`, adminToken, {
    reason: 'test',
  })
  ids.suspended = susp.venueId
}, 60000)
afterAll(async () => {
  await cleanupTestData(app.prisma)
  await app.close()
})

describe('radius search (PostGIS)', () => {
  it('only returns venues inside the radius, nearest first, with distance', async () => {
    const r3 = await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=3`)
    expect(names(r3)).toEqual(['PLANTEST GeoT DHA Futsal'])
    const r5 = await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=5`)
    expect(names(r5)).toEqual(['PLANTEST GeoT DHA Futsal', 'PLANTEST GeoT Clifton Padel'])
    const r20 = await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=20`)
    expect(names(r20)).toEqual([
      'PLANTEST GeoT DHA Futsal',
      'PLANTEST GeoT Clifton Padel',
      'PLANTEST GeoT Gulshan Cricket',
    ])
    const d = r20.json().data.items.map((i: any) => i.distanceM)
    expect(d[0]).toBeLessThan(5)
    expect(d[1]).toBeGreaterThan(3000)
    expect(d[1]).toBeLessThan(4000)
    expect(d).toEqual([...d].sort((a, b) => a - b))
  })

  it('defaults to 10 km and never returns Lahore for a Karachi search', async () => {
    const r = await search(`lat=${DHA.lat}&lng=${DHA.lng}`)
    expect(names(r)).not.toContain('PLANTEST GeoT Lahore Badminton')
    expect(names(r)).not.toContain('PLANTEST GeoT Gulshan Cricket') // ~12 km
  })

  it('only the allowed radii are accepted; lat and lng must come together', async () => {
    expect((await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=7`)).statusCode).toBe(400)
    expect((await search(`lat=${DHA.lat}`)).statusCode).toBe(400)
    expect((await search(`lat=999&lng=1`)).statusCode).toBe(400)
  })

  it('draft and suspended venues are never returned, even right next door', async () => {
    const r = await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=20`)
    expect(names(r).join()).not.toMatch(/Draft|Suspended/)
    expect(
      await call(app, 'GET', `/api/v1/public/venues/${ids.draft}`).then((x) => x.statusCode),
    ).toBe(404)
  })
})

describe('filters', () => {
  const all = `lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=20`
  it('by sport and surface', async () => {
    expect(names(await search(`${all}&sport=PADEL`))).toEqual(['PLANTEST GeoT Clifton Padel'])
    expect(names(await search(`${all}&surface=SYNTHETIC_TURF`))).toHaveLength(2)
    expect(names(await search(`${all}&sport=PADEL&sport=BOX_CRICKET`))).toHaveLength(2)
    expect(names(await search(`${all}&sport=PADEL&surface=SYNTHETIC_TURF`))).toHaveLength(0)
  })
  it('amenities must ALL be present', async () => {
    expect(names(await search(`${all}&amenities=PARKING`))).toHaveLength(2)
    expect(names(await search(`${all}&amenities=PARKING&amenities=FLOODLIGHTS`))).toEqual([
      'PLANTEST GeoT DHA Futsal',
    ])
    expect(names(await search(`${all}&amenities=PARKING&amenities=AC`))).toHaveLength(0)
  })
  it('unknown filter values are rejected', async () => {
    expect((await search(`${all}&sport=CHESS`)).statusCode).toBe(400)
    expect((await search(`${all}&amenities=JETPACK`)).statusCode).toBe(400)
  })
  it('area mode works without location: by area, by city', async () => {
    expect(names(await search(`areaId=${ids.area}`))).toEqual(['PLANTEST GeoT DHA Futsal'])
    const lahore = await search('city=Lahore')
    expect(names(lahore)).toEqual(['PLANTEST GeoT Lahore Badminton'])
    expect(lahore.json().data.items[0].distanceM).toBeNull()
  })
  it('name search: partial, case-insensitive, area name and alias', async () => {
    // demo seed data may also match, so look only at our own PLANTEST venues
    const q = async (x: string) =>
      names(await call(app, 'GET', `${S}?q=${encodeURIComponent(x)}&limit=50`)).filter(
        (n: string) => n.startsWith('PLANTEST'),
      )
    expect(await q('geot dha')).toEqual(['PLANTEST GeoT DHA Futsal'])
    expect(await q('GeoT Clifton Pad')).toEqual(['PLANTEST GeoT Clifton Padel'])
    expect(await q('GeoT Zone')).toContain('PLANTEST GeoT DHA Futsal') // matches area name
    expect(await q('Gee Tee')).toContain('PLANTEST GeoT DHA Futsal') // matches area alias
    expect((await call(app, 'GET', `${S}?q=x`)).statusCode).toBe(400) // minimum 2 characters
  })
})

describe('safety', () => {
  it('SQL injection attempts are harmless', async () => {
    for (const evil of ["'; DROP TABLE venues; --", "' OR '1'='1", '" OR 1=1 --', '%', '_', '\\']) {
      const r = await call(app, 'GET', `${S}?q=${encodeURIComponent(evil + 'xx')}`)
      expect(r.statusCode, evil).toBe(200)
      expect(r.json().data.items).toEqual([]) // wildcards in q are literal characters
    }
    const still = await app.prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM venues`
    expect(Number(still[0].n)).toBeGreaterThan(0)
    const injected = await call(app, 'GET', `${S}?city=${encodeURIComponent("x' OR 1=1 --")}`)
    expect(injected.json().data.items).toEqual([])
  })
  it('wildcard characters in q do not match everything', async () => {
    const r = await call(app, 'GET', `${S}?q=${encodeURIComponent('GeoT%')}`)
    expect(r.json().data.items).toEqual([])
  })
  it('is public (no token needed) and rate limited per IP', async () => {
    expect((await call(app, 'GET', `${S}?q=GeoT`)).statusCode).toBe(200)
    const limited = await makeApp()
    let last = 200
    for (let i = 0; i < 65; i++)
      last = (
        await limited.inject({ method: 'GET', url: `${S}?q=GeoT`, remoteAddress: '10.8.8.8' })
      ).statusCode
    await limited.close()
    expect(last).toBe(429)
  })
})

describe('result shape, sorting, paging', () => {
  it('cards carry price-from (paisa), sports, amenities and a directions link', async () => {
    const r = await search(`lat=${DHA.lat}&lng=${DHA.lng}&radiusKm=3`)
    const v = r.json().data.items[0]
    expect(v).toMatchObject({
      priceFromMinor: 200000,
      sports: ['FUTSAL_5V5'],
      amenities: ['PARKING', 'FLOODLIGHTS'],
    })
    expect(v.directionsUrl).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${DHA.lat},${DHA.lng}`,
    )
    expect(JSON.stringify(v)).not.toMatch(/owner|whatsapp|verified_by/i)
  })
  it('sorts by name and by price', async () => {
    const byName = names(await search('sort=name'))
    expect(byName).toEqual([...byName].sort())
    expect((await search('sort=price')).statusCode).toBe(200)
  })
  it('pages with a cursor and never repeats a venue', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const r: any = await search(`sort=name&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      seen.push(...names(r))
      cursor = r.json().data.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(4)
    expect(new Set(seen).size).toBe(4)
    expect((await search('limit=51')).statusCode).toBe(400)
  })
  it('a garbage cursor falls back to the first page', async () => {
    const r = await search('sort=name&limit=2&cursor=!!!')
    expect(r.statusCode).toBe(200)
    expect(names(r)).toHaveLength(2)
  })
})

describe('venue detail, areas, filters metadata', () => {
  it('detail by id and by slug shows price bands and the cancellation policy', async () => {
    const byId = await call(app, 'GET', `/api/v1/public/venues/${ids['DHA Futsal']}`)
    expect(byId.statusCode).toBe(200)
    const d = byId.json().data
    expect(d.courts[0].priceBands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: 'PEAK', priceMinor: 300000 }),
        expect.objectContaining({ tag: 'OFF_PEAK', priceMinor: 200000 }),
      ]),
    )
    expect(d.cancellationPolicy.cutoffHours).toBe(12)
    expect(d.area.name).toBe('GeoT Zone')
    const bySlug = await call(app, 'GET', `/api/v1/public/venues/${d.slug}`)
    expect(bySlug.json().data.id).toBe(d.id)
    expect(byId.body).not.toMatch(/ownerUserId|verifiedBy|whatsappNumber|commissionBps/)
  })
  it('unknown venue is 404', async () => {
    expect((await call(app, 'GET', '/api/v1/public/venues/nope-nope')).statusCode).toBe(404)
    expect(
      (await call(app, 'GET', '/api/v1/public/venues/0194c8a0-0000-7000-8000-000000000999'))
        .statusCode,
    ).toBe(404)
  })
  it('areas and meta filters', async () => {
    const a = await call(app, 'GET', '/api/v1/public/areas?city=testville')
    expect(a.json().data.map((x: any) => x.name)).toContain('GeoT Zone')
    const m = (await call(app, 'GET', '/api/v1/public/meta/filters')).json().data
    expect(m.radiiKm).toEqual([3, 5, 10, 20])
    expect(m.sports).toContain('PADEL')
    expect(m.amenities).toContain('FLOODLIGHTS')
  })
})
