import { PrismaClient } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { HotLane } from '../../lib/hotlane'
import { createAdminService, RealtimeStats } from './booking.admin.service'
import { createAvailabilityService } from './booking.availability.service'
import { createBookingRepository } from './booking.repository'
import { createBookingService } from './booking.service'
import { createSlotService } from './booking.slot.service'
import { createStaffService } from './booking.staff.service'
import { adminOverrideMediator } from './mediators/admin-override.mediator'
import { blockSlotsMediator } from './mediators/block-slots.mediator'
import { cancelBookingMediator } from './mediators/cancel-booking.mediator'
import { checkInMediator } from './mediators/check-in.mediator'
import { collectBalanceMediator } from './mediators/collect-balance.mediator'
import { createHoldMediator } from './mediators/create-hold.mediator'
import { createHoldSweeper } from './mediators/hold-sweeper'
import { noShowMediator } from './mediators/no-show.mediator'
import { outageMediator } from './mediators/outage.mediator'
import { payAtVenueMediator } from './mediators/pay-at-venue.mediator'
import { releaseHoldMediator } from './mediators/release-hold.mediator'
import { rsvpMediator } from './mediators/rsvp.mediator'
import { staffBookingMediator } from './mediators/staff-booking.mediator'

/**
 * Composition root of the booking module: builds the repository, the services and the mediators
 * once. The plugin exposes the result as `app.booking`; the worker and tests build their own.
 */
export function createBookingModule(
  prisma: PrismaClient,
  hotLane: HotLane,
  opts: {
    log?: Pick<FastifyBaseLogger, 'warn' | 'info'>
    realtimeStats?: () => RealtimeStats
  } = {},
) {
  const repo = createBookingRepository(prisma)
  const slots = createSlotService(repo, hotLane, opts.log)
  const sweeper = createHoldSweeper(() => slots.sweep())
  const cancel = cancelBookingMediator(repo, hotLane)
  const outage = outageMediator(repo, hotLane, cancel)
  let stats: () => RealtimeStats =
    opts.realtimeStats ?? (() => ({ connections: 0, emitted: 0, p95LatencyMs: null }))

  return {
    slots,
    bookings: createBookingService(repo),
    staff: createStaffService(repo),
    availability: createAvailabilityService(repo),
    admin: createAdminService(repo, () => stats()),

    // player use-cases
    createHold: createHoldMediator(repo, hotLane, sweeper),
    releaseHold: releaseHoldMediator(repo, hotLane),
    payAtVenue: payAtVenueMediator(repo, hotLane),
    cancel,
    rsvp: rsvpMediator(repo),

    // staff use-cases
    staffBooking: staffBookingMediator(repo, hotLane),
    blocks: blockSlotsMediator(repo, hotLane),
    outage,
    checkIn: checkInMediator(repo, hotLane),
    collectBalance: collectBalanceMediator(repo, hotLane),
    noShow: noShowMediator(repo, hotLane),

    // admin use-cases
    override: adminOverrideMediator(repo, hotLane, cancel),

    /** Outage locks a crashed process left half done (the worker resumes them). */
    stuckOutageIds: (olderThan: Date) => repo.stuckOutageIds(olderThan),

    set realtimeStats(fn: () => RealtimeStats) {
      stats = fn
    },
    get realtimeStats() {
      return stats
    },
    stop: () => sweeper.stop(),
  }
}
export type BookingModule = ReturnType<typeof createBookingModule>
