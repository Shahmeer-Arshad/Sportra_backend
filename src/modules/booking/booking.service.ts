/** Player-facing reads and single-step rules: my bookings, QR pass, cancel preview, invites, headcount. */
import { randomBytes, randomUUID } from 'crypto'
import { ConflictError, NotFoundError, TooManyRequestsError } from '../../utils/errors'
import { computeCancelPreview, signPass } from './booking.domain'
import { inviteClosed, isInviteOpen, sha } from './booking.invites'
import { BookingQueries } from './booking.repository'
import { namesOf, ownedBooking } from './booking.rules'
import { bookingJson, num, qrSecret } from './booking.view'
import { MyTab } from './repositories/booking.queries'

const CONFIRMED = ['CONFIRMED', 'CHECKED_IN']

export function createBookingService(repo: BookingQueries) {
  return {
    async listMine(userId: string, tab: MyTab, limit: number, offset: number) {
      const { rows, total } = await repo.listMine(userId, tab, limit, offset)
      const now = await repo.clock()
      const [venues, courts] = await Promise.all([
        repo.venueNames([...new Set(rows.map((r) => r.venue_id))]),
        repo.courtNames([...new Set(rows.map((r) => r.court_id))]),
      ])
      const vn = new Map(venues.map((v) => [v.id, v.name]))
      const cn = new Map(courts.map((c) => [c.id, c.name]))
      return {
        items: rows.map((r) =>
          bookingJson(r, { now, venueName: vn.get(r.venue_id), courtName: cn.get(r.court_id) }),
        ),
        total,
      }
    },

    async getMine(userId: string, bookingId: string) {
      const b = await ownedBooking(repo, userId, bookingId)
      const items = await repo.bookingItems(b.id)
      const venue = await repo.venueById(b.venue_id)
      const court = await repo.courtName(b.court_id)
      const view = bookingJson(b, {
        now: await repo.clock(),
        items,
        venueName: venue?.name,
        courtName: court?.name,
      })
      return {
        ...view,
        venue: venue && {
          id: venue.id,
          name: venue.name,
          address: venue.address,
          lat: venue.lat,
          lng: venue.lng,
          directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}`,
        },
        policy: {
          cancellationCutoffHours: b.cancellation_cutoff_hours,
          summary: `Cancel at least ${b.cancellation_cutoff_hours} hours before an hour starts to get a full refund of what you paid for it. Later than that, the deposit for that hour is kept by the venue.`,
        },
      }
    },

    /** QR entry pass. The token holds only ids and a time window; the booking ref is the manual fallback. */
    async getPass(userId: string, bookingId: string) {
      const b = await ownedBooking(repo, userId, bookingId)
      if (!CONFIRMED.includes(b.status))
        throw new ConflictError(
          'Only a confirmed booking has an entry pass',
          'BOOKING_NOT_CONFIRMED',
          {
            status: b.status,
          },
        )
      const nbf = Math.floor(b.start_at.getTime() / 1000) - 2 * 3600
      const exp = Math.floor(b.end_at.getTime() / 1000) + 2 * 3600
      return {
        token: signPass(
          { bid: b.id, vid: b.venue_id, ref: b.ref, nbf, exp, jti: randomUUID() },
          qrSecret(),
        ),
        ref: b.ref,
        validFrom: new Date(nbf * 1000).toISOString(),
        validUntil: new Date(exp * 1000).toISOString(),
      }
    },

    async cancelPreview(userId: string, bookingId: string, itemIds?: string[]) {
      const b = await ownedBooking(repo, userId, bookingId)
      const all = await repo.bookingItems(b.id)
      const items = all.filter(
        (i) => i.status === 'CONFIRMED' && (!itemIds?.length || itemIds.includes(i.id)),
      )
      if (b.status !== 'CONFIRMED')
        throw new ConflictError(
          'This booking cannot be cancelled in its current state',
          'BOOKING_NOT_CANCELLABLE',
          { status: b.status },
        )
      if (items.length === 0 || (itemIds?.length && items.length !== new Set(itemIds).size))
        throw new ConflictError('One or more hours cannot be cancelled', 'ITEM_NOT_CANCELLABLE')
      const p = computeCancelPreview(
        items.map((i) => ({
          id: i.id,
          startAt: i.start_at,
          priceMinor: i.price_minor,
          onlinePaidMinor: i.online_paid_minor,
          depositShareMinor: i.deposit_share_minor,
        })),
        { cancelledBy: 'USER', cutoffHours: b.cancellation_cutoff_hours, now: await repo.clock() },
      )
      return {
        bookingId: b.id,
        cutoffHours: b.cancellation_cutoff_hours,
        refundDueMinor: num(p.refundDueMinor),
        forfeitMinor: num(p.forfeitMinor),
        allCancellable: p.allCancellable,
        wholeBooking: items.length === all.filter((i) => i.status === 'CONFIRMED').length,
        items: p.lines.map((l) => ({
          itemId: l.itemId,
          startAt: l.startAt.toISOString(),
          priceMinor: num(l.priceMinor),
          refundDueMinor: num(l.refundDueMinor),
          forfeitMinor: num(l.forfeitMinor),
          cancellable: l.cancellable,
          fullRefund: l.fullRefund,
        })),
      }
    },

    // ───────── match invites ─────────
    async createInvite(userId: string, bookingId: string) {
      const b = await ownedBooking(repo, userId, bookingId)
      if (!CONFIRMED.includes(b.status) || b.end_at.getTime() <= Date.now())
        throw new ConflictError(
          'Invites need an upcoming confirmed booking',
          'BOOKING_NOT_CONFIRMED',
          {
            status: b.status,
          },
        )
      if ((await repo.activeInvites(bookingId)) >= 5)
        throw new TooManyRequestsError('At most 5 invite links per booking', 'TOO_MANY_INVITES')
      const token = randomBytes(24).toString('base64url')
      const inv = await repo.createInvite({
        bookingId,
        tokenHash: sha(token),
        createdBy: userId,
        expiresAt: b.end_at,
      })
      return {
        id: inv.id,
        token,
        path: `/invite/${token}`,
        expiresAt: inv.expiresAt.toISOString(),
      }
    },

    async listInvites(userId: string, bookingId: string) {
      await ownedBooking(repo, userId, bookingId)
      const invs = await repo.invitesWithRsvps(bookingId)
      return invs.map((i) => ({
        id: i.id,
        expiresAt: i.expiresAt.toISOString(),
        revokedAt: i.revokedAt?.toISOString() ?? null,
        rsvps: i.rsvps.map((r) => ({ name: r.name, phone: r.phone, status: r.status })),
      }))
    },

    async revokeInvite(userId: string, bookingId: string, inviteId: string) {
      await ownedBooking(repo, userId, bookingId)
      if ((await repo.revokeInvite(inviteId, bookingId)) === 0)
        throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
      return { id: inviteId, revoked: true }
    },

    async publicInvite(token: string) {
      const inv = await repo.inviteWithRsvps(sha(token))
      if (!inv) throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
      const b = await repo.bookingById(inv.bookingId)
      if (!b || !isInviteOpen(inv, b)) throw inviteClosed()
      const n = await namesOf(repo, b.venue_id, b.court_id)
      const captain = (b.customer_name || 'Your friend').split(' ')[0]
      const going = inv.rsvps.filter((r) => r.status === 'GOING').length
      const when = b.start_at.toISOString()
      return {
        // public: no phone numbers, no ref, no money
        venueName: n.venueName,
        courtName: n.courtName,
        startAt: when,
        endAt: b.end_at.toISOString(),
        captainName: captain,
        going,
        headcount: b.headcount ?? 1 + going,
        preview: {
          title: `${captain} invited you to play at ${n.venueName}`,
          description: `${n.courtName}, ${when}. ${going} going so far.`,
        },
      }
    },

    async setHeadcount(userId: string, bookingId: string, headcount: number) {
      const b = await ownedBooking(repo, userId, bookingId)
      if (!CONFIRMED.includes(b.status))
        throw new ConflictError('Only a confirmed booking has a headcount', 'BOOKING_NOT_CONFIRMED')
      await repo.setHeadcount(bookingId, headcount)
      return { bookingId, headcount }
    },
  }
}
