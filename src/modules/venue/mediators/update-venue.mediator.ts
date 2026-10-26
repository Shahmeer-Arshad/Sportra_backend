import { venueEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { assertVenueEdit } from '../venue.rules'
import { VenueService } from '../venue.service'

/** Owner or manager edits venue details; the rules decide who may change what. */
export const updateVenueMediator =
  (repo: VenueRepository, svc: VenueService) =>
  async (venueId: string, role: string, actorId: string, input: any) => {
    const v = await svc.requireVenue(venueId)
    assertVenueEdit(v, role, input)
    if (input.areaId) await svc.assertArea(input.areaId)
    const updated = await repo.transaction(async (q) => {
      const n = await q.updateVenue(venueId, {
        ...(input.name && { name: input.name.trim() }),
        ...(input.city && { city: input.city.trim() }),
        ...(input.areaId !== undefined && { areaId: input.areaId }),
        ...(input.address && { address: input.address.trim() }),
        ...(input.lat !== undefined && { lat: input.lat }),
        ...(input.lng !== undefined && { lng: input.lng }),
        ...(input.amenities && { amenities: input.amenities }),
        ...(input.photos && { photos: input.photos }),
        ...(input.whatsappNumber && { whatsappNumber: input.whatsappNumber }),
        ...(input.contactPhone && { contactPhone: input.contactPhone }),
        ...(input.contactEmail && { contactEmail: input.contactEmail.toLowerCase() }),
        ...(input.operatingHours && { operatingHours: input.operatingHours }),
        ...(input.cancellationCutoffHours && {
          cancellationCutoffHours: input.cancellationCutoffHours,
        }),
        ...(input.onboardingStep && { onboardingStep: input.onboardingStep }),
        version: { increment: 1 },
      })
      await q.audit({
        actorId,
        actorType: 'STAFF',
        venueId,
        action: 'VENUE_UPDATED',
        entity: 'venue',
        entityId: venueId,
        after: input,
      })
      await q.emit(venueEvent(n))
      return n
    })
    return venueJson(updated)
  }
