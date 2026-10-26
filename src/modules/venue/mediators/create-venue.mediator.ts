import { uuidv7 } from '../../../lib/id'
import { venueEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { assertHours, slugify } from '../venue.rules'
import { VenueService } from '../venue.service'

/** Owner starts a venue: the venue, the owner membership, audit and event commit together. */
export const createVenueMediator =
  (repo: VenueRepository, svc: VenueService) => async (userId: string, input: any) => {
    assertHours(input.operatingHours)
    if (input.areaId) await svc.assertArea(input.areaId)
    const id = uuidv7()
    const venue = await repo.transaction(async (q) => {
      const v = await q.createVenue({
        id,
        ownerUserId: userId,
        name: input.name.trim(),
        slug: `${slugify(input.name)}-${id.slice(-6)}`,
        city: input.city.trim(),
        areaId: input.areaId ?? null,
        address: input.address.trim(),
        lat: input.lat,
        lng: input.lng,
        amenities: input.amenities ?? [],
        photos: input.photos ?? [],
        whatsappNumber: input.whatsappNumber ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail?.toLowerCase() ?? null,
        operatingHours: input.operatingHours,
        cancellationCutoffHours: input.cancellationCutoffHours ?? 12,
      })
      await q.addOwner(userId, id)
      await q.audit({
        actorId: userId,
        actorType: 'STAFF',
        venueId: id,
        action: 'VENUE_CREATED',
        entity: 'venue',
        entityId: id,
      })
      await q.emit(venueEvent(v, 'venue.created'))
      return v
    })
    return venueJson(venue)
  }
