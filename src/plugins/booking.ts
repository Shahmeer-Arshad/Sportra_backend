import { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { BookingModule, createBookingModule } from '../modules/booking/booking.module'

/** The booking module plus `idle()`: waits for slot syncs and outage jobs started in the background (tests, shutdown). */
export type BookingServices = BookingModule & { idle(): Promise<void> }

declare module 'fastify' {
  interface FastifyInstance {
    booking: BookingServices
  }
}

// Requests that change what a venue sells: courts, prices, hours, or its verified state.
const CATALOG_URL =
  /^\/api\/v1\/(pos\/venues\/:venueId(\/|\/courts(\/:courtId)?|\/pricing-rules(\/:ruleId)?)?|admin\/venues\/:id\/(review|suspend|reinstate)|admin\/venue-changes\/:id\/approve)$/

/**
 * Builds the booking services and keeps slots in step with the venue catalogue: after a request
 * that changes courts, prices, hours or verification, the venue's slots are regenerated in the
 * background (idempotent). The nightly job in the worker covers anything missed.
 */
const bookingPlugin = fp(async (app: FastifyInstance) => {
  const booking = createBookingModule(app.prisma, app.hotLane, { log: app.log })
  const slots = booking.slots

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
      // approving a change request: the route id is the request, the controller names the venue
      const venueId = (req as { syncVenueId?: string }).syncVenueId ?? p.venueId ?? p.id
      if (venueId) syncVenue(venueId)
    }
    return payload
  })

  const services: BookingServices = Object.assign(booking, {
    async idle() {
      for (;;) {
        await Promise.allSettled([...pending])
        await booking.outage.idle()
        if (pending.size === 0) return
      }
    },
  })
  app.decorate('booking', services)
  app.addHook('onClose', async () => {
    await services.idle()
    booking.stop()
  })
})

export default bookingPlugin
