import { Court, PricingRule, Venue } from '@prisma/client'
import { ruleJson } from './venue.view'

const producer = 'venue'

/** Outbox payloads for the venue module. Pass the result to `repo.emit(...)`. */
export const venueEvent = (v: Venue, type = 'venue.upserted') => ({
  type,
  routingKey: type,
  producer,
  version: v.version,
  data: {
    venueId: v.id,
    version: v.version,
    name: v.name,
    city: v.city,
    areaId: v.areaId,
    timezone: v.timezone,
    cancellationCutoffHours: v.cancellationCutoffHours,
    commissionBps: v.commissionBps,
    status: v.verificationStatus,
    isActive: v.isActive,
  },
})

export const courtEvent = (c: Court) => ({
  type: 'court.upserted',
  routingKey: 'court.upserted',
  producer,
  version: c.version,
  data: {
    courtId: c.id,
    venueId: c.venueId,
    version: c.version,
    name: c.name,
    sport: c.sport,
    slotMinutes: c.slotMinutes,
    isActive: c.isActive,
    hoursOverride: c.hoursOverride,
  },
})

export const pricingEvent = (courtId: string, venueId: string, rules: PricingRule[]) => ({
  type: 'pricing.updated',
  routingKey: 'pricing.updated',
  producer,
  data: { courtId, venueId, rules: rules.map(ruleJson) },
})
