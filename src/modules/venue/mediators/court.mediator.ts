import { Prisma } from '@prisma/client'
import { courtEvent, pricingEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { assertEditable, assertHours, planPricingRules } from '../venue.rules'
import { VenueService } from '../venue.service'
import { courtJson, ruleJson } from '../venue.view'

/**
 * Court create and update: venue must be editable; court (with its price bands, when given),
 * audit and events commit together, so a bad price band leaves no half-made court behind.
 */
export const courtMediator = (repo: VenueRepository, svc: VenueService) => ({
  async add(venueId: string, actorId: string, input: any) {
    assertEditable(await svc.requireVenue(venueId))
    if (input.schedule) assertHours(input.schedule)
    const bands = planPricingRules(input.pricing ?? [])
    return repo.transaction(async (q) => {
      const c = await q.createCourt({
        venueId,
        name: input.name.trim(),
        sport: input.sport,
        surface: input.surface,
        environment: input.environment,
        images: input.images ?? [],
        capacity: input.capacity ?? null,
        slotMinutes: input.slotMinutes ?? 60,
        hoursOverride: input.schedule ?? undefined,
        isActive: input.isBookable ?? true,
      })
      const rules = []
      for (const band of bands) rules.push(await q.createRule({ courtId: c.id, ...band }))
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'COURT_CREATED',
        entity: 'court',
        entityId: c.id,
        after: input,
      })
      await q.emit(courtEvent(c))
      if (rules.length) await q.emit(pricingEvent(c.id, venueId, rules))
      return { ...courtJson(c), pricingRules: rules.map(ruleJson) }
    })
  },

  async update(venueId: string, courtId: string, actorId: string, input: any) {
    assertEditable(await svc.requireVenue(venueId))
    await svc.requireCourt(venueId, courtId)
    if (input.schedule) assertHours(input.schedule)
    return repo.transaction(async (q) => {
      const c = await q.updateCourt(courtId, {
        ...(input.name && { name: input.name.trim() }),
        ...(input.sport && { sport: input.sport }),
        ...(input.surface && { surface: input.surface }),
        ...(input.environment && { environment: input.environment }),
        ...(input.images && { images: input.images }),
        ...(input.capacity !== undefined && { capacity: input.capacity }),
        ...(input.slotMinutes && { slotMinutes: input.slotMinutes }),
        // null clears the court's own hours so it follows the venue's again
        ...(input.schedule !== undefined && {
          hoursOverride: input.schedule === null ? Prisma.DbNull : input.schedule,
        }),
        ...(input.isBookable !== undefined && { isActive: input.isBookable }),
        version: { increment: 1 },
      })
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'COURT_UPDATED',
        entity: 'court',
        entityId: courtId,
        after: input,
      })
      await q.emit(courtEvent(c))
      return courtJson(c)
    })
  },
})
