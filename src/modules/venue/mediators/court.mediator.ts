import { courtEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { assertEditable, assertHours } from '../venue.rules'
import { VenueService } from '../venue.service'

/** Court create and update: venue must be editable; court, audit and event commit together. */
export const courtMediator = (repo: VenueRepository, svc: VenueService) => ({
  async add(venueId: string, actorId: string, input: any) {
    assertEditable(await svc.requireVenue(venueId))
    if (input.hoursOverride) assertHours(input.hoursOverride)
    return repo.transaction(async (q) => {
      const c = await q.createCourt({
        venueId,
        name: input.name.trim(),
        sport: input.sport,
        surface: input.surface,
        capacity: input.capacity ?? null,
        slotMinutes: input.slotMinutes ?? 60,
        hoursOverride: input.hoursOverride ?? undefined,
      })
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
      return c
    })
  },

  async update(venueId: string, courtId: string, actorId: string, input: any) {
    assertEditable(await svc.requireVenue(venueId))
    await svc.requireCourt(venueId, courtId)
    if (input.hoursOverride) assertHours(input.hoursOverride)
    return repo.transaction(async (q) => {
      const c = await q.updateCourt(courtId, {
        ...(input.name && { name: input.name.trim() }),
        ...(input.sport && { sport: input.sport }),
        ...(input.surface && { surface: input.surface }),
        ...(input.capacity !== undefined && { capacity: input.capacity }),
        ...(input.slotMinutes && { slotMinutes: input.slotMinutes }),
        ...(input.hoursOverride && { hoursOverride: input.hoursOverride }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
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
      return c
    })
  },
})
