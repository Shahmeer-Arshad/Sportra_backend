import { Court, PricingRule, Venue, VenueChangeRequest } from '@prisma/client'
import {
  OperatingHours,
  PriceRule,
  resolvePriceLocal,
  slotStarts,
  weekdayKey,
} from './venue.domain'
import { VenueQueries } from './venue.repository'
import { directionsUrl } from './venue.search'

export const toRule = (r: PricingRule): PriceRule => ({
  id: r.id,
  dayType: r.dayType as PriceRule['dayType'],
  startDate: r.startDate,
  endDate: r.endDate,
  fromTime: r.fromTime,
  toTime: r.toTime,
  priceMinor: r.priceMinor,
  priority: r.priority,
  tag: r.tag as PriceRule['tag'],
})

/** BigInt is not JSON-safe; paisa fits easily inside a JS number (max Rs 1,000,000 per slot). */
export const ruleJson = (r: PricingRule) => ({ ...r, priceMinor: Number(r.priceMinor) })
export const changeJson = (c: VenueChangeRequest, extra: object = {}) => ({
  id: c.id,
  venueId: c.venueId,
  op: c.op,
  summary: c.summary,
  status: c.status,
  payload: c.payload,
  params: c.params,
  requestedBy: c.requestedBy,
  decidedBy: c.decidedBy,
  decisionNote: c.decisionNote,
  failureReason: c.failureReason,
  createdAt: c.createdAt,
  decidedAt: c.decidedAt,
  ...extra,
})
export const venueJson = (v: Venue) => ({ ...v, location: undefined })

/** A court as the API shows it: `schedule` is its own opening hours, `isBookable` the on/off switch. */
export const courtJson = <C extends Court>(c: C) => {
  const { hoursOverride, isActive, ...rest } = c
  return { ...rest, schedule: hoursOverride, isBookable: isActive }
}

const fmt = (m: number) =>
  `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** Price preview grid for one court and day (what slots will cost). */
export function buildPricingPreview(v: Venue, court: Court, rules: PriceRule[], date: string) {
  const hours = (court.hoursOverride ?? v.operatingHours) as unknown as OperatingHours
  const slots: { start: string; end: string; priceMinor: number | null; tag: string | null }[] = []
  for (const w of hours[weekdayKey(date)] ?? []) {
    for (const start of slotStarts(w, court.slotMinutes)) {
      let day = date
      if (start >= 1440) {
        const d = new Date(`${date}T00:00:00Z`)
        d.setUTCDate(d.getUTCDate() + 1)
        day = d.toISOString().slice(0, 10)
      }
      const p = resolvePriceLocal(rules, day, start % 1440)
      slots.push({
        start: fmt(start),
        end: fmt(start + court.slotMinutes),
        priceMinor: p ? Number(p.priceMinor) : null,
        tag: p?.tag ?? null,
      })
    }
  }
  return { courtId: court.id, date, slotMinutes: court.slotMinutes, slots }
}

export const publicVenueJson = (
  v: NonNullable<Awaited<ReturnType<VenueQueries['findPublicVenue']>>>,
) => ({
  id: v.id,
  name: v.name,
  slug: v.slug,
  city: v.city,
  address: v.address,
  area: v.area && { id: v.area.id, name: v.area.name },
  lat: v.lat,
  lng: v.lng,
  directionsUrl: directionsUrl(v.lat, v.lng),
  amenities: v.amenities,
  photos: v.photos,
  contactPhone: v.contactPhone,
  operatingHours: v.operatingHours,
  cancellationPolicy: {
    cutoffHours: v.cancellationCutoffHours,
    summary: `Free cancellation until ${v.cancellationCutoffHours} hours before the slot. After that the 20% advance is not refunded.`,
  },
  courts: v.courts.map((c) => ({
    id: c.id,
    name: c.name,
    sport: c.sport,
    surface: c.surface,
    environment: c.environment,
    images: c.images,
    capacity: c.capacity,
    slotMinutes: c.slotMinutes,
    priceBands: c.pricingRules.map((r) => {
      const j = ruleJson(r)
      return {
        name: j.name,
        dayType: j.dayType,
        fromTime: j.fromTime,
        toTime: j.toTime,
        priceMinor: j.priceMinor,
        tag: j.tag,
      }
    }),
  })),
})
