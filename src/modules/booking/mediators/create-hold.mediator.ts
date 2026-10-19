import { env } from '../../../config/env'
import { HotLane } from '../../../lib/hotlane'
import { uuidv7 } from '../../../lib/id'
import { hashRequest } from '../../../lib/idempotency'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../utils/errors'
import { isoDate } from '../booking.inventory'
import { publishBookingUpdate, publishSlotUpdates } from '../booking.realtime'
import { BookingRepository } from '../booking.repository'
import {
  allocateBooking,
  isBlocklisted,
  mapContention,
  namesOf,
  resolveRequestedSlots,
} from '../booking.rules'
import { bookingJson, num } from '../booking.view'
import { HoldSweeper } from './hold-sweeper'

/** Nearest free windows of the same length, offered when the requested hours were just taken. */
async function alternativesFor(repo: BookingRepository, venueId: string, slotIds: string[]) {
  const req = await repo.slotTimes(slotIds)
  if (req.length === 0) return []
  const from = new Date(req[0].start_at.getTime() - 4 * 3_600_000)
  const to = new Date(req[req.length - 1].end_at.getTime() + 4 * 3_600_000)
  const free = await repo.freeSlotsBetween(venueId, from, to)
  const n = req.length
  const target = req[0].start_at.getTime()
  const out: Array<{
    courtId: string
    slotIds: string[]
    startAt: string
    endAt: string
    totalMinor: number
    gap: number
  }> = []
  const byCourt = new Map<string, typeof free>()
  for (const f of free) byCourt.set(f.court_id, [...(byCourt.get(f.court_id) ?? []), f])
  for (const [cid, list] of byCourt) {
    for (let i = 0; i + n <= list.length; i++) {
      const win = list.slice(i, i + n)
      const consecutive = win.every(
        (w, k) => k === 0 || w.start_at.getTime() === win[k - 1].end_at.getTime(),
      )
      if (!consecutive) continue
      out.push({
        courtId: cid,
        slotIds: win.map((w) => w.id),
        startAt: win[0].start_at.toISOString(),
        endAt: win[n - 1].end_at.toISOString(),
        totalMinor: win.reduce((a, w) => a + num(w.price_minor), 0),
        gap: Math.abs(win[0].start_at.getTime() - target),
      })
    }
  }
  return out
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 5)
    .map(({ gap: _gap, ...w }) => w)
}

/** A player holds 1 to 4 consecutive hours for the hold time (5 minutes by default). */
export const createHoldMediator =
  (repo: BookingRepository, hotLane: HotLane, sweeper: HoldSweeper) =>
  async (
    userId: string,
    input: { courtId: string; slotIds: string[]; customerPhone?: string },
    key: string,
  ) => {
    const user = await repo.userContact(userId)
    if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
    const phone = input.customerPhone ?? user.phone
    if (!phone)
      throw new BadRequestError('Add a phone number so the venue can reach you', 'PHONE_REQUIRED')

    const { venue } = await resolveRequestedSlots(repo, {
      slotIds: input.slotIds,
      courtId: input.courtId,
      maxSlots: 4,
      pastRule: 'START_IN_FUTURE',
    })
    if (!venue.verified || !venue.isActive)
      throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
    if (
      (await isBlocklisted(repo, venue.id, phone)) ||
      (await isBlocklisted(repo, venue.id, user.phone))
    )
      throw new ForbiddenError('This venue cannot take your booking', 'BLOCKED_BY_VENUE')

    try {
      return await repo.idempotent(
        {
          scope: `hold:${userId}`,
          key,
          hash: hashRequest({ c: input.courtId, s: [...input.slotIds].sort(), p: phone }),
        },
        async (q) => {
          await q.setLockTimeout('500ms')
          // one user cannot race past the pending-hold cap with parallel requests
          await q.advisoryLock(`user-holds:${userId}`)
          if ((await q.pendingHolds(userId)) >= env.MAX_PENDING_HOLDS)
            throw new ConflictError(
              `You can hold at most ${env.MAX_PENDING_HOLDS} bookings at a time`,
              'TOO_MANY_HOLDS',
            )

          const bookingId = uuidv7()
          const holdId = uuidv7()
          const { rows, updates } = await q.acquire({
            target: 'HELD',
            slotIds: input.slotIds,
            bookingId,
            holdId,
            holdSeconds: env.HOLD_SECONDS,
            heldCode: 'SLOT_UNAVAILABLE',
          })
          const ordered = [...rows].sort((a, b) => a.start_at.getTime() - b.start_at.getTime())
          const total = ordered.reduce((a, r) => a + r.price_minor, 0n)
          const holdExpiresAt = ordered[0].hold_expires_at as Date
          await allocateBooking(q, {
            id: bookingId,
            venueId: venue.id,
            city: venue.city,
            courtId: input.courtId,
            userId,
            source: 'APP',
            customerName: user.fullName,
            customerPhone: phone,
            customerEmail: user.email,
            status: 'PENDING_PAYMENT',
            paymentMode: 'CASH_ONLY',
            startAt: ordered[0].start_at,
            endAt: ordered[ordered.length - 1].end_at,
            businessDate: isoDate(ordered[0].business_date),
            totalMinor: total,
            cutoffHours: venue.cancellationCutoffHours,
            slotIds: ordered.map((r) => r.id),
            holdId,
            holdExpiresAt,
            createdBy: userId,
          })
          await q.emit({
            type: 'booking.hold_created',
            routingKey: 'booking.hold_created',
            producer: 'booking',
            data: {
              bookingId,
              venueId: venue.id,
              userId,
              slotIds: ordered.map((r) => r.id),
              holdExpiresAt,
            },
          })
          const b = (await q.bookingById(bookingId))!
          // the countdown must be measured AFTER the hold was stamped, or it could read 301 s
          const view = bookingJson(b, {
            now: await q.clock(),
            ...(await namesOf(q, venue.id, input.courtId)),
          })
          return {
            status: 201,
            body: {
              ...view,
              slots: ordered.map((r) => ({
                slotId: r.id,
                startAt: r.start_at.toISOString(),
                endAt: r.end_at.toISOString(),
                priceMinor: num(r.price_minor),
              })),
            },
            after: () => {
              publishSlotUpdates(hotLane, updates)
              publishBookingUpdate(hotLane, {
                bookingId,
                ref: b.ref,
                venueId: venue.id,
                userId,
                status: 'PENDING_PAYMENT',
              })
              sweeper.schedule(holdExpiresAt)
            },
          }
        },
      )
    } catch (e) {
      if (e instanceof ConflictError && e.code === 'SLOT_UNAVAILABLE') {
        const alternatives = await alternativesFor(repo, venue.id, input.slotIds).catch(() => [])
        throw new ConflictError(e.message, 'SLOT_UNAVAILABLE', {
          ...((e.details as object) ?? {}),
          alternatives,
        })
      }
      return mapContention(e)
    }
  }
