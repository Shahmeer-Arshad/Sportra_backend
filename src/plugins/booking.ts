import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import {
  createAdminBookingService,
  AdminBookingService,
  RealtimeStats,
} from '../modules/booking/booking.admin'
import {
  createAvailabilityService,
  AvailabilityService,
} from '../modules/booking/booking.availability'
import { createPosService, PosService } from '../modules/booking/booking.pos'
import { createBookingService, BookingService } from '../modules/booking/booking.service'
import { createSlotService, SlotService } from '../modules/booking/booking.slots'

export interface BookingServices {
  slots: SlotService
  bookings: BookingService
  pos: PosService
  availability: AvailabilityService
  admin: AdminBookingService
  /** Waits for slot syncs and outage jobs started in the background (tests, graceful shutdown). */
  idle(): Promise<void>
  /** Set by the realtime plugin so the admin health tile can report socket numbers. */
  realtimeStats: () => RealtimeStats
}

declare module 'fastify' {
  interface FastifyInstance {
    booking: BookingServices
  }
}

// Requests that change what a venue sells: courts, prices, hours, or its verified state.
const CATALOG_URL =
  /^\/api\/v1\/(pos\/venues\/:venueId(\/|\/courts(\/:courtId)?|\/pricing-rules(\/:ruleId)?)?|admin\/venues\/:id\/(review|suspend|reinstate))$/

/**
 * Builds the booking services and keeps slots in step with the venue catalogue: after a request
 * that changes courts, prices, hours or verification, the venue's slots are regenerated in the
 * background (idempotent). The nightly job in the worker covers anything missed.
 */
const bookingPlugin = fp(async (app: FastifyInstance) => {
  const slots = createSlotService(app.prisma, app.hotLane, app.log)
  const bookings = createBookingService(app.prisma, app.hotLane, slots)
  const pos = createPosService(app.prisma, app.hotLane)
  const availability = createAvailabilityService(app.prisma)
  let stats: () => RealtimeStats = () => ({ connections: 0, emitted: 0, p95LatencyMs: null })
  const admin = createAdminBookingService(app.prisma, app.hotLane, () => stats())

  const pending = new Set<Promise<void>>()
  const state = new Map<string, { running: boolean; dirty: boolean }>()
  function syncVenue(venueId: string) {
    const s = state.get(venueId) ?? { running: false, dirty: false }
    state.set(venueId, s)
    if (s.running) {
      s.dirty = true
      return
    }
    s.running = true
    const p: Promise<void> = (async () => {
      do {
        s.dirty = false
        try {
          await slots.generateForVenue(venueId)
        } catch (err) {
          app.log.warn({ err, venueId }, 'Slot sync failed; the nightly job will retry')
        }
      } while (s.dirty)
    })().finally(() => {
      s.running = false
      pending.delete(p)
    })
    pending.add(p)
  }

  // onSend runs before the response leaves, so the sync is registered by the time the caller sees it
  app.addHook('onSend', async (req, reply, payload) => {
    if (
      req.method !== 'GET' &&
      reply.statusCode < 300 &&
      CATALOG_URL.test(req.routeOptions.url ?? '')
    ) {
      const p = req.params as { venueId?: string; id?: string }
      const venueId = p.venueId ?? p.id
      if (venueId) syncVenue(venueId)
    }
    return payload
  })

  const services: BookingServices = {
    slots,
    bookings,
    pos,
    availability,
    admin,
    async idle() {
      for (;;) {
        await Promise.allSettled([...pending])
        await pos.idle()
        if (pending.size === 0) return
      }
    },
    get realtimeStats() {
      return stats
    },
    set realtimeStats(fn) {
      stats = fn
    },
  } as BookingServices
  app.decorate('booking', services)
  app.addHook('onClose', async () => {
    await services.idle()
    bookings.stop()
  })
})

export default bookingPlugin
