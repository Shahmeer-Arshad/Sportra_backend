import { Prisma, PrismaClient } from '@prisma/client'

export interface SearchParams {
  lat?: number
  lng?: number
  radiusKm?: number
  city?: string
  areaId?: string
  sport?: string[]
  surface?: string[]
  amenities?: string[]
  q?: string
  sort?: 'distance' | 'price' | 'name'
  limit?: number
  cursor?: string
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
export const directionsUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url')
function decodeCursor(c?: string): number {
  if (!c) return 0
  const n = Number(Buffer.from(c, 'base64url').toString())
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * Radius + filter search. Only VERIFIED and active venues. Every value is bound as a parameter
 * (Prisma.sql), never concatenated. With lat/lng it filters by radius using the PostGIS GiST
 * index (ST_DWithin) and sorts by distance; without them it works in "area mode".
 */
export async function searchVenues(prisma: PrismaClient, p: SearchParams) {
  const limit = Math.min(p.limit ?? 20, 50)
  const offset = decodeCursor(p.cursor)
  const geo = p.lat !== undefined && p.lng !== undefined
  const point = geo
    ? Prisma.sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`
    : null

  const where: Prisma.Sql[] = [Prisma.sql`v.verification_status = 'VERIFIED' AND v.is_active`]
  if (geo) where.push(Prisma.sql`ST_DWithin(v.location, ${point}, ${(p.radiusKm ?? 10) * 1000})`)
  if (p.city) where.push(Prisma.sql`lower(v.city) = lower(${p.city})`)
  if (p.areaId) where.push(Prisma.sql`v.area_id = ${p.areaId}::uuid`)
  if (p.amenities?.length) where.push(Prisma.sql`v.amenities @> ${p.amenities}::text[]`)
  if (p.sport?.length || p.surface?.length) {
    where.push(Prisma.sql`EXISTS (
      SELECT 1 FROM courts c WHERE c.venue_id = v.id AND c.is_active
        ${p.sport?.length ? Prisma.sql`AND c.sport = ANY(${p.sport}::text[])` : Prisma.empty}
        ${p.surface?.length ? Prisma.sql`AND c.surface = ANY(${p.surface}::text[])` : Prisma.empty})`)
  }
  if (p.q) {
    where.push(Prisma.sql`(v.name ILIKE ${'%' + escapeLike(p.q) + '%'} OR v.name % ${p.q}
      OR EXISTS (SELECT 1 FROM areas a WHERE a.id = v.area_id AND (a.name ILIKE ${'%' + escapeLike(p.q) + '%'} OR ${p.q} ILIKE ANY(a.aliases))))`)
  }

  const sort = p.sort ?? (geo ? 'distance' : 'name')
  const orderBy =
    sort === 'distance' && geo
      ? Prisma.sql`distance_m, v.id`
      : sort === 'price'
        ? Prisma.sql`price_from_minor NULLS LAST, v.id`
        : Prisma.sql`v.name, v.id`

  const rows = await prisma.$queryRaw<any[]>`
    SELECT v.id, v.name, v.slug, v.city, v.address, v.area_id, a.name AS area_name, v.lat, v.lng, v.amenities,
           ${geo ? Prisma.sql`ST_Distance(v.location, ${point})` : Prisma.sql`NULL::float8`} AS distance_m,
           (SELECT min(pr.price_minor) FROM pricing_rules pr JOIN courts c ON c.id = pr.court_id
             WHERE c.venue_id = v.id AND c.is_active)::float8 AS price_from_minor,
           (SELECT array_agg(DISTINCT c.sport) FROM courts c WHERE c.venue_id = v.id AND c.is_active) AS sports
    FROM venues v LEFT JOIN areas a ON a.id = v.area_id
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1} OFFSET ${offset}`

  const hasMore = rows.length > limit
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    city: r.city,
    address: r.address,
    areaId: r.area_id,
    areaName: r.area_name,
    lat: r.lat,
    lng: r.lng,
    distanceM: r.distance_m === null ? null : Math.round(r.distance_m),
    amenities: r.amenities,
    sports: r.sports ?? [],
    priceFromMinor: r.price_from_minor === null ? null : Number(r.price_from_minor),
    directionsUrl: directionsUrl(r.lat, r.lng),
  }))
  return { items, nextCursor: hasMore ? encodeCursor(offset + limit) : null }
}
