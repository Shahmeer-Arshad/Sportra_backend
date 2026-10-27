import { uuidv7 } from '../../../lib/id'
import { ConflictError, TooManyRequestsError } from '../../../utils/errors'
import { venueEvent } from '../venue.events'
import { VenueRepository } from '../venue.repository'
import { venueJson } from '../venue.view'
import { slugify } from '../venue.rules'
import { VenueService } from '../venue.service'

const MAX_COPIES_PER_DAY = 3

/** The owner of a REJECTED venue starts again from a copy: details, photos, courts and prices. */
export const copyVenueMediator = (repo: VenueRepository, svc: VenueService) => ({
  async copy(venueId: string, ownerId: string) {
    const old = await svc.requireVenue(venueId)
    if (old.verificationStatus !== 'REJECTED') {
      throw new ConflictError('Only a rejected venue can be copied', 'VENUE_NOT_REJECTED')
    }
    const since = new Date(Date.now() - 86_400_000)
    if ((await repo.countCopiesSince(ownerId, since)) >= MAX_COPIES_PER_DAY) {
      throw new TooManyRequestsError('You can copy at most 3 venues per day', 'COPY_LIMIT')
    }
    const id = uuidv7()
    const created = await repo.transaction(async (q) => {
      const v = await q.createVenue({
        id,
        ownerUserId: ownerId,
        name: old.name,
        slug: `${slugify(old.name)}-${id.slice(-6)}`,
        city: old.city,
        areaId: old.areaId,
        address: old.address,
        lat: old.lat,
        lng: old.lng,
        amenities: old.amenities,
        photos: old.photos,
        whatsappNumber: old.whatsappNumber,
        contactPhone: old.contactPhone,
        contactEmail: old.contactEmail,
        operatingHours: old.operatingHours as object,
        cancellationCutoffHours: old.cancellationCutoffHours,
        copiedFrom: old.id,
      })
      await q.addOwner(ownerId, id)
      for (const c of await q.courtsWithRules(old.id)) {
        const court = await q.createCourt({
          venueId: id,
          name: c.name,
          sport: c.sport,
          surface: c.surface,
          environment: c.environment,
          images: c.images,
          capacity: c.capacity,
          slotMinutes: c.slotMinutes,
          hoursOverride: (c.hoursOverride as object | null) ?? undefined,
          isActive: c.isActive,
        })
        for (const r of c.pricingRules) {
          await q.createRule({
            courtId: court.id,
            name: r.name,
            dayType: r.dayType,
            startDate: r.startDate,
            endDate: r.endDate,
            fromTime: r.fromTime,
            toTime: r.toTime,
            priceMinor: r.priceMinor,
            priority: r.priority,
            tag: r.tag,
          })
        }
      }
      await q.audit({
        actorId: ownerId,
        actorType: 'STAFF',
        venueId: id,
        action: 'VENUE_COPIED',
        entity: 'venue',
        entityId: id,
        after: { copiedFrom: old.id },
      })
      await q.emit(venueEvent(v, 'venue.created'))
      return v
    })
    return venueJson(created)
  },
})
