import { Court, PricingRule, Venue } from '@prisma/client'

/** What an owner submitted, frozen. Two of them are compared to show the admin what changed. */
export interface Snapshot {
  venue: Record<string, unknown>
  courts: Array<Record<string, unknown> & { id: string; name: string; pricing: any[] }>
}
export interface Change {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
}

const VENUE_FIELDS = [
  'name',
  'city',
  'areaId',
  'address',
  'lat',
  'lng',
  'amenities',
  'photos',
  'whatsappNumber',
  'contactPhone',
  'contactEmail',
  'operatingHours',
  'cancellationCutoffHours',
] as const

export function buildSnapshot(v: Venue, courts: (Court & { pricingRules: PricingRule[] })[]) {
  const snap: Snapshot = {
    venue: Object.fromEntries(VENUE_FIELDS.map((k) => [k, v[k]])),
    courts: courts.map((c) => ({
      id: c.id,
      name: c.name,
      sport: c.sport,
      surface: c.surface,
      environment: c.environment,
      images: c.images,
      capacity: c.capacity,
      slotMinutes: c.slotMinutes,
      schedule: c.hoursOverride,
      isBookable: c.isActive,
      pricing: c.pricingRules
        .map((r) => ({
          name: r.name,
          dayType: r.dayType,
          startDate: r.startDate,
          endDate: r.endDate,
          fromTime: r.fromTime,
          toTime: r.toTime,
          priceMinor: Number(r.priceMinor),
          priority: r.priority,
          tag: r.tag,
        }))
        .sort((a, b) => bandKey(a).localeCompare(bandKey(b))),
    })),
  }
  return snap
}

const bandKey = (b: any) =>
  `${b.dayType}|${b.startDate ?? ''}|${b.endDate ?? ''}|${b.fromTime}|${b.toTime}|${b.priority}`
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Field-by-field difference between two snapshots (pure). `before` is the older submission. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = []
  for (const k of VENUE_FIELDS) {
    const a = before.venue[k]
    const b = after.venue[k]
    if (same(a, b)) continue
    if (Array.isArray(a) && Array.isArray(b)) {
      for (const x of b.filter((x) => !a.some((y) => same(x, y))))
        out.push({ path: `venue.${k}`, kind: 'added', after: x })
      for (const x of a.filter((x) => !b.some((y) => same(x, y))))
        out.push({ path: `venue.${k}`, kind: 'removed', before: x })
    } else out.push({ path: `venue.${k}`, kind: 'changed', before: a, after: b })
  }
  const byId = new Map(before.courts.map((c) => [c.id, c]))
  for (const c of after.courts) {
    const old = byId.get(c.id)
    byId.delete(c.id)
    const label = `court "${c.name}"`
    if (!old) {
      out.push({ path: label, kind: 'added', after: c.name })
      continue
    }
    for (const k of Object.keys(c).filter((k) => k !== 'pricing' && k !== 'id')) {
      if (!same(old[k], c[k])) {
        if (Array.isArray(old[k]) && Array.isArray(c[k])) {
          for (const x of (c[k] as unknown[]).filter(
            (x) => !(old[k] as unknown[]).some((y) => same(x, y)),
          ))
            out.push({ path: `${label}.${k}`, kind: 'added', after: x })
          for (const x of (old[k] as unknown[]).filter(
            (x) => !(c[k] as unknown[]).some((y) => same(x, y)),
          ))
            out.push({ path: `${label}.${k}`, kind: 'removed', before: x })
        } else out.push({ path: `${label}.${k}`, kind: 'changed', before: old[k], after: c[k] })
      }
    }
    const oldBands = new Map(old.pricing.map((b) => [bandKey(b), b]))
    for (const b of c.pricing) {
      const o = oldBands.get(bandKey(b))
      oldBands.delete(bandKey(b))
      const bl = `${label} price "${b.name}" ${b.fromTime}-${b.toTime}`
      if (!o) out.push({ path: bl, kind: 'added', after: b })
      else if (!same(o, b)) out.push({ path: bl, kind: 'changed', before: o, after: b })
    }
    for (const o of oldBands.values())
      out.push({
        path: `${label} price "${o.name}" ${o.fromTime}-${o.toTime}`,
        kind: 'removed',
        before: o,
      })
  }
  for (const c of byId.values())
    out.push({ path: `court "${c.name}"`, kind: 'removed', before: c.name })
  return out
}
