import type { BookingModule } from '../booking/booking.module'
import { StopAllPort } from './mediators/suspend-venue.mediator'

/** Adapts the booking module to what STOP_ALL needs: preview, start and release an outage lock. */
export const stopAllPort = (b: Pick<BookingModule, 'staff' | 'outage'>): StopAllPort => ({
  async preview(venueId, courtIds, from, to) {
    const r = await b.staff.outagePreview(venueId, {
      courtIds,
      from: from.toISOString(),
      to: to.toISOString(),
    })
    return {
      appBookings: r.appBookings,
      players: r.players,
      manualToCall: r.manualToCall.length,
      freeHoursToBlock: r.freeHoursToBlock,
    }
  },
  async start(venueId, adminId, courtIds, from, to, key, note) {
    const r = await b.outage.start(
      venueId,
      { id: adminId, role: 'ADMIN' },
      { courtIds, from: from.toISOString(), to: to.toISOString(), reason: 'OTHER', note },
      key,
    )
    return { id: (r.body as { id: string }).id }
  },
  async release(venueId, adminId, lockId) {
    await b.outage.release(venueId, { id: adminId, role: 'ADMIN' }, lockId)
  },
})
