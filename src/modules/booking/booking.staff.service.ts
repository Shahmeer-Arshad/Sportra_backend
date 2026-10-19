/**
 * Ground POS reads and small writes (staff): day list, booking detail, outage views, settings and
 * blocklist. Role gating is done by the route guards; every call is scoped to the venue in the
 * path, so staff of venue A can never touch venue B's bookings.
 */
import { env } from '../../config/env'
import { NotFoundError } from '../../utils/errors'
import { isLikelyNoShow, normalizePhone } from './booking.domain'
import { BookingQueries } from './booking.repository'
import { assertCourtsOfVenue, namesOf, parseWindow, staffBooking } from './booking.rules'
import { bookingJson, manualCallJson, outageJson } from './booking.view'
import { StaffActor } from './mediators/cancel-booking.mediator'

export function createStaffService(repo: BookingQueries) {
  const noShowFlag = (r: { status: string; start_at: Date }, now: Date) =>
    isLikelyNoShow({ status: r.status, startAt: r.start_at }, now, env.NO_SHOW_AFTER_MINUTES)

  async function getSettings(venueId: string) {
    const s = await repo.bookingSettings(venueId)
    return {
      venueId,
      payAtVenueEnabled: s?.payAtVenueEnabled ?? false,
      holdSeconds: env.HOLD_SECONDS,
      horizonDays: env.SLOT_HORIZON_DAYS,
    }
  }

  return {
    // ───────── bookings ─────────
    async dayList(
      venueId: string,
      q: { date?: string; status?: string; q?: string; limit: number; offset: number },
    ) {
      const { rows, total } = await repo.dayList(venueId, q)
      const now = await repo.clock()
      const cn = new Map((await repo.courtNamesOfVenue(venueId)).map((c) => [c.id, c.name]))
      return {
        items: rows.map((r) => ({
          ...bookingJson(r, { now, courtName: cn.get(r.court_id) }),
          likelyNoShow: noShowFlag(r, now),
        })),
        total,
      }
    },

    async getBooking(venueId: string, bookingId: string) {
      const b = await staffBooking(repo, venueId, bookingId)
      const items = await repo.bookingItems(b.id)
      const now = await repo.clock()
      return {
        ...bookingJson(b, { now, items, ...(await namesOf(repo, venueId, b.court_id)) }),
        likelyNoShow: noShowFlag(b, now),
      }
    },

    // ───────── outage lock reads ─────────
    async outagePreview(venueId: string, input: { courtIds: string[]; from: string; to: string }) {
      const { from, to } = parseWindow(input)
      await assertCourtsOfVenue(repo, venueId, input.courtIds)
      const window = { venueId, courtIds: input.courtIds, from, to }
      const app = await repo.affectedAppBookings(window)
      const manual = (await repo.manualToCall(window)).map(manualCallJson)
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        freeHoursToBlock: await repo.freeHourCount(window),
        appBookings: app.length,
        players: new Set(app.map((a) => a.user_id).filter(Boolean)).size,
        bookings: app.map((a) => ({
          bookingId: a.booking_id,
          ref: a.ref,
          customerName: a.customer_name,
          hours: a.item_ids.length,
        })),
        manualToCall: manual,
        message: `${app.length} booking(s) will be cancelled with a full refund. ${manual.length} walk-in/manual booking(s) need a phone call.`,
      }
    },

    async getOutage(venueId: string, id: string) {
      const l = await repo.outageOfVenue(venueId, id)
      if (!l) throw new NotFoundError('Outage lock not found', 'OUTAGE_NOT_FOUND')
      return outageJson(l)
    },
    async listOutages(venueId: string) {
      return (await repo.outagesOfVenue(venueId)).map(outageJson)
    },

    // ───────── settings and blocklist ─────────
    getSettings,
    async updateSettings(
      venueId: string,
      actor: StaffActor,
      input: { payAtVenueEnabled: boolean },
    ) {
      const before = await repo.bookingSettings(venueId)
      await repo.upsertSettings(venueId, input.payAtVenueEnabled, actor.id)
      await repo.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'BOOKING_SETTINGS_CHANGED',
        entity: 'booking_settings',
        entityId: venueId,
        before: { payAtVenueEnabled: before?.payAtVenueEnabled ?? false },
        after: input,
        ip: actor.ip,
      })
      return getSettings(venueId)
    },

    async addToBlocklist(
      venueId: string,
      actor: StaffActor,
      input: { phone: string; reason?: string },
    ) {
      const phone = normalizePhone(input.phone)
      await repo.addBlock(venueId, phone, input.reason ?? null, actor.id)
      await repo.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'BLOCKLIST_ADDED',
        entity: 'venue_blocklist',
        entityId: phone,
        after: input,
        ip: actor.ip,
      })
      return { phone, reason: input.reason ?? null }
    },
    async listBlocklist(venueId: string) {
      return (await repo.blocklist(venueId)).map((r) => ({
        phone: r.phone,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      }))
    },
    async removeFromBlocklist(venueId: string, actor: StaffActor, phoneRaw: string) {
      const phone = normalizePhone(phoneRaw)
      if ((await repo.removeBlock(venueId, phone)) === 0)
        throw new NotFoundError('That number is not on the blocklist', 'NOT_FOUND')
      await repo.audit({
        actorId: actor.id,
        actorType: 'STAFF',
        venueId,
        action: 'BLOCKLIST_REMOVED',
        entity: 'venue_blocklist',
        entityId: phone,
        ip: actor.ip,
      })
      return { phone, removed: true }
    },
  }
}
