/**
 * Player-facing booking operations: hold, release, reserve (pay at venue), my bookings, QR pass,
 * cancel (whole or per hour), match invites.
 */
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { env } from '../../config/env'
import { audit } from '../../lib/audit'
import { HotLane } from '../../lib/hotlane'
import { uuidv7 } from '../../lib/id'
import { hashRequest, runIdempotent } from '../../lib/idempotency'
import { addOutbox } from '../../lib/outbox'
import { isLockContention, isTxTimeout } from '../../lib/pgerror'
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
} from '../../utils/errors'
import { computeCancelPreview, signPass } from './booking.domain'
import {
  acquireSlots,
  confirmHold,
  isoDate,
  publishBookingUpdate,
  publishSlotUpdates,
  releaseHold,
} from './booking.inventory'
import { SlotService } from './booking.slots'
import {
  BOOKING_COLS,
  BookingRowRaw,
  CancelResult,
  bookingJson,
  cancelBookingItems,
  cancelResponse,
  createItems,
  dbNowOf,
  insertBooking,
  isBlocklisted,
  loadBooking,
  loadItems,
  lockBooking,
  num,
  qrSecret,
  resolveRequestedSlots,
} from './booking.shared'

const PRODUCER = 'booking'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const advisory = (tx: Prisma.TransactionClient, name: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`

/** A lost lock race or an exhausted pool is a clean 409 for the caller, never a 500. */
function mapContention(e: unknown): never {
  if (isLockContention(e) || isTxTimeout(e))
    throw new ConflictError(
      'Those hours are being booked by someone else, try again',
      'SLOT_UNAVAILABLE',
      {
        reason: 'CONTENTION',
      },
    )
  throw e
}

export function createBookingService(prisma: PrismaClient, hotLane: HotLane, slotSvc: SlotService) {
  // one timer per quarter-second bucket, so thousands of holds expiring together cost a single sweep
  const timers = new Map<number, NodeJS.Timeout>()

  /** Best effort: free the hours (and tell clients) shortly after a hold runs out. Not needed for correctness. */
  function scheduleHoldSweep(expiresAt: Date) {
    const bucket = Math.ceil((expiresAt.getTime() + 150) / 250) * 250
    if (timers.has(bucket)) return
    const t = setTimeout(
      () => {
        timers.delete(bucket)
        slotSvc.sweep().catch(() => undefined)
      },
      Math.max(0, bucket - Date.now()),
    )
    t.unref()
    timers.set(bucket, t)
  }

  /** Nearest free windows of the same length, offered when the requested hours were just taken. */
  async function alternativesFor(venueId: string, slotIds: string[], courtId: string) {
    const req = await prisma.$queryRaw<{ start_at: Date; end_at: Date }[]>`
      SELECT start_at, end_at FROM slots WHERE id = ANY(${slotIds}::uuid[]) ORDER BY start_at`
    if (req.length === 0) return []
    const from = new Date(req[0].start_at.getTime() - 4 * 3_600_000)
    const to = new Date(req[req.length - 1].end_at.getTime() + 4 * 3_600_000)
    const free = await prisma.$queryRaw<
      { id: string; court_id: string; start_at: Date; end_at: Date; price_minor: bigint }[]
    >`SELECT id, court_id, start_at, end_at, price_minor FROM slots
       WHERE venue_id = ${venueId}::uuid AND start_at > clock_timestamp() AND start_at >= ${from} AND start_at < ${to}
         AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))
       ORDER BY court_id, start_at`
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
    void courtId
    return out
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 5)
      .map(({ gap: _gap, ...w }) => w)
  }

  async function ownedBooking(userId: string, bookingId: string): Promise<BookingRowRaw> {
    const b = await loadBooking(prisma, bookingId)
    // somebody else's booking looks exactly like a missing one
    if (!b || b.user_id !== userId)
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
    return b
  }

  async function names(
    db: PrismaClient | Prisma.TransactionClient,
    venueId: string,
    courtId: string,
  ) {
    const [v, c] = await Promise.all([
      db.venue.findUnique({ where: { id: venueId }, select: { name: true } }),
      db.court.findUnique({ where: { id: courtId }, select: { name: true } }),
    ])
    return { venueName: v?.name, courtName: c?.name }
  }

  return {
    /** Stop pending timers (called when the app closes). */
    stop() {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },

    // ───────────────────────── hold ─────────────────────────
    async createHold(
      userId: string,
      input: { courtId: string; slotIds: string[]; customerPhone?: string },
      key: string,
    ) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, email: true, phone: true },
      })
      if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND')
      const phone = input.customerPhone ?? user.phone
      if (!phone)
        throw new BadRequestError('Add a phone number so the venue can reach you', 'PHONE_REQUIRED')

      const { slots, venue } = await resolveRequestedSlots(prisma, {
        slotIds: input.slotIds,
        courtId: input.courtId,
        maxSlots: 4,
        pastRule: 'START_IN_FUTURE',
      })
      if (!venue.verified || !venue.isActive)
        throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
      if (
        (await isBlocklisted(prisma, venue.id, phone)) ||
        (await isBlocklisted(prisma, venue.id, user.phone))
      )
        throw new ForbiddenError('This venue cannot take your booking', 'BLOCKED_BY_VENUE')

      let out
      try {
        out = await runIdempotent(
          prisma,
          {
            scope: `hold:${userId}`,
            key,
            hash: hashRequest({ c: input.courtId, s: [...input.slotIds].sort(), p: phone }),
          },
          async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`)
            // one user cannot race past the pending-hold cap with parallel requests
            await advisory(tx, `user-holds:${userId}`)
            const pending = (
              await tx.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM bookings
                 WHERE user_id = ${userId}::uuid AND status = 'PENDING_PAYMENT' AND hold_expires_at > clock_timestamp()`
            )[0].n
            if (pending >= env.MAX_PENDING_HOLDS)
              throw new ConflictError(
                `You can hold at most ${env.MAX_PENDING_HOLDS} bookings at a time`,
                'TOO_MANY_HOLDS',
              )

            const bookingId = uuidv7()
            const holdId = uuidv7()
            const { rows, updates } = await acquireSlots(tx, {
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
            await insertBooking(tx, {
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
            await addOutbox(tx, {
              type: 'booking.hold_created',
              routingKey: 'booking.hold_created',
              producer: PRODUCER,
              data: {
                bookingId,
                venueId: venue.id,
                userId,
                slotIds: ordered.map((r) => r.id),
                holdExpiresAt,
              },
            })
            const b = (await loadBooking(tx, bookingId))!
            // the countdown must be measured AFTER the hold was stamped, or it could read 301 s
            const view = bookingJson(b, {
              now: await dbNowOf(tx),
              ...(await names(tx, venue.id, input.courtId)),
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
                scheduleHoldSweep(holdExpiresAt)
              },
            }
          },
        )
      } catch (e) {
        if (e instanceof ConflictError && e.code === 'SLOT_UNAVAILABLE') {
          const alternatives = await alternativesFor(venue.id, input.slotIds, input.courtId).catch(
            () => [],
          )
          throw new ConflictError(e.message, 'SLOT_UNAVAILABLE', {
            ...((e.details as object) ?? {}),
            alternatives,
          })
        }
        return mapContention(e)
      }
      void slots
      return out
    },

    /** The player gives the hours back. Idempotent. */
    async releaseHold(userId: string, bookingId: string) {
      const b0 = await ownedBooking(userId, bookingId)
      if (b0.status !== 'PENDING_PAYMENT' && b0.status !== 'EXPIRED')
        throw new ConflictError('This booking is not a hold', 'NOT_A_HOLD', { status: b0.status })
      const out = await prisma.$transaction(async (tx) => {
        const b = (await lockBooking(tx, bookingId))!
        if (b.status !== 'PENDING_PAYMENT') return { updates: [], b }
        const updates = await releaseHold(tx, b.hold_id as string)
        await tx.$executeRaw`
          UPDATE bookings SET status = 'EXPIRED', hold_id = NULL, hold_expires_at = NULL,
                 version = version + 1, updated_at = clock_timestamp() WHERE id = ${bookingId}::uuid`
        await addOutbox(tx, {
          type: 'booking.hold_released',
          routingKey: 'booking.hold_released',
          producer: PRODUCER,
          data: { bookingId, venueId: b.venue_id, userId },
        })
        return { updates, b }
      })
      publishSlotUpdates(hotLane, out.updates)
      if (out.updates.length)
        publishBookingUpdate(hotLane, {
          bookingId,
          ref: out.b.ref,
          venueId: out.b.venue_id,
          userId,
          status: 'EXPIRED',
        })
      const fresh = (await loadBooking(prisma, bookingId))!
      return bookingJson(fresh, { now: await dbNowOf(prisma) })
    },

    // ───────────────────────── pilot: reserve, pay at venue ─────────────────────────
    async confirmPayAtVenue(userId: string, bookingId: string, key: string) {
      const b0 = await ownedBooking(userId, bookingId)
      const settings = await prisma.bookingSettings.findUnique({ where: { venueId: b0.venue_id } })
      if (!settings?.payAtVenueEnabled)
        throw new ForbiddenError(
          'This venue does not take pay-at-venue bookings',
          'PAY_AT_VENUE_DISABLED',
        )
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } })
      if (
        (await isBlocklisted(prisma, b0.venue_id, b0.customer_phone)) ||
        (await isBlocklisted(prisma, b0.venue_id, user?.phone))
      )
        throw new ForbiddenError('This venue cannot take your booking', 'BLOCKED_BY_VENUE')

      try {
        return await runIdempotent(
          prisma,
          { scope: `reserve:${userId}`, key, hash: hashRequest({ b: bookingId }) },
          async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`)
            await advisory(tx, `user-unpaid:${userId}`)
            const b = await lockBooking(tx, bookingId)
            if (!b || b.user_id !== userId)
              throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
            if (b.status !== 'PENDING_PAYMENT')
              throw new ConflictError(
                b.status === 'EXPIRED'
                  ? 'Your hold has expired'
                  : 'This booking is not waiting for confirmation',
                b.status === 'EXPIRED' ? 'HOLD_EXPIRED' : 'BOOKING_NOT_PENDING',
                { status: b.status },
              )
            const unpaid = (
              await tx.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM bookings
                 WHERE user_id = ${userId}::uuid AND status IN ('CONFIRMED','CHECKED_IN') AND source = 'APP'
                   AND balance_due_minor > 0 AND end_at > clock_timestamp()`
            )[0].n
            if (unpaid >= env.MAX_UNPAID_BOOKINGS)
              throw new ConflictError(
                `You can have ${env.MAX_UNPAID_BOOKINGS} unpaid booking at a time. Pay or cancel it first.`,
                'UNPAID_LIMIT_REACHED',
              )
            const { updates } = await confirmHold(tx, {
              id: b.id,
              hold_id: b.hold_id as string,
              slot_ids: b.slot_ids,
            })
            await createItems(tx, b.id, b.slot_ids.length)
            await tx.$executeRaw`
              UPDATE bookings SET status = 'CONFIRMED', payment_mode = 'CASH_ONLY', payment_status = 'UNPAID',
                     hold_id = NULL, hold_expires_at = NULL, version = version + 1, updated_at = clock_timestamp()
               WHERE id = ${b.id}::uuid`
            await addOutbox(tx, {
              type: 'booking.confirmed',
              routingKey: 'booking.confirmed',
              producer: PRODUCER,
              data: {
                bookingId: b.id,
                ref: b.ref,
                venueId: b.venue_id,
                userId,
                source: 'APP',
                payAtVenue: true,
                totalMinor: num(b.total_minor),
                balanceDueMinor: num(b.total_minor),
                startAt: b.start_at,
                endAt: b.end_at,
              },
            })
            await audit(tx, {
              actorId: userId,
              actorType: 'USER',
              venueId: b.venue_id,
              action: 'BOOKING_RESERVED_PAY_AT_VENUE',
              entity: 'booking',
              entityId: b.id,
              after: { ref: b.ref, totalMinor: num(b.total_minor) },
            })
            const fresh = (await loadBooking(tx, b.id))!
            const items = await loadItems(tx, b.id)
            return {
              status: 200,
              body: bookingJson(fresh, {
                now: await dbNowOf(tx),
                items,
                ...(await names(tx, b.venue_id, b.court_id)),
              }),
              after: () => {
                publishSlotUpdates(hotLane, updates)
                publishBookingUpdate(hotLane, {
                  bookingId: b.id,
                  ref: b.ref,
                  venueId: b.venue_id,
                  userId,
                  status: 'CONFIRMED',
                })
              },
            }
          },
        )
      } catch (e) {
        return mapContention(e)
      }
    },

    // ───────────────────────── reading ─────────────────────────
    async listMine(
      userId: string,
      tab: 'upcoming' | 'past' | 'cancelled',
      limit: number,
      offset: number,
    ) {
      const where =
        tab === 'upcoming'
          ? Prisma.sql`((status IN ('CONFIRMED','CHECKED_IN') AND end_at > clock_timestamp())
                        OR (status = 'PENDING_PAYMENT' AND hold_expires_at > clock_timestamp()))`
          : tab === 'past'
            ? Prisma.sql`status IN ('CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW') AND end_at <= clock_timestamp()`
            : Prisma.sql`(status IN ('CANCELLED_BY_USER','CANCELLED_BY_VENUE','EXPIRED')
                          OR (status = 'PENDING_PAYMENT' AND hold_expires_at <= clock_timestamp()))`
      const order = tab === 'upcoming' ? Prisma.sql`start_at ASC` : Prisma.sql`start_at DESC`
      const rows = await prisma.$queryRaw<BookingRowRaw[]>`
        SELECT ${BOOKING_COLS} FROM bookings WHERE user_id = ${userId}::uuid AND ${where}
        ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
      const total = (
        await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM bookings WHERE user_id = ${userId}::uuid AND ${where}`
      )[0].n
      const now = await dbNowOf(prisma)
      const venueIds = [...new Set(rows.map((r) => r.venue_id))]
      const courtIds = [...new Set(rows.map((r) => r.court_id))]
      const [venues, courts] = await Promise.all([
        prisma.venue.findMany({
          where: { id: { in: venueIds } },
          select: { id: true, name: true },
        }),
        prisma.court.findMany({
          where: { id: { in: courtIds } },
          select: { id: true, name: true },
        }),
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
      const b = await ownedBooking(userId, bookingId)
      const items = await loadItems(prisma, b.id)
      const venue = await prisma.venue.findUnique({ where: { id: b.venue_id } })
      const court = await prisma.court.findUnique({
        where: { id: b.court_id },
        select: { name: true },
      })
      const view = bookingJson(b, {
        now: await dbNowOf(prisma),
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
      const b = await ownedBooking(userId, bookingId)
      if (!['CONFIRMED', 'CHECKED_IN'].includes(b.status))
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

    // ───────────────────────── cancellation ─────────────────────────
    async cancelPreview(userId: string, bookingId: string, itemIds?: string[]) {
      const b = await ownedBooking(userId, bookingId)
      const items = (await loadItems(prisma, b.id)).filter(
        (i) => i.status === 'CONFIRMED' && (!itemIds?.length || itemIds.includes(i.id)),
      )
      if (b.status !== 'CONFIRMED')
        throw new ConflictError(
          'This booking cannot be cancelled in its current state',
          'BOOKING_NOT_CANCELLABLE',
          {
            status: b.status,
          },
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
        {
          cancelledBy: 'USER',
          cutoffHours: b.cancellation_cutoff_hours,
          now: await dbNowOf(prisma),
        },
      )
      return {
        bookingId: b.id,
        cutoffHours: b.cancellation_cutoff_hours,
        refundDueMinor: num(p.refundDueMinor),
        forfeitMinor: num(p.forfeitMinor),
        allCancellable: p.allCancellable,
        wholeBooking:
          items.length ===
          (await loadItems(prisma, b.id)).filter((i) => i.status === 'CONFIRMED').length,
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

    async cancel(
      userId: string,
      bookingId: string,
      itemIds: string[] | undefined,
      cancellationId: string,
      reason?: string,
    ) {
      await ownedBooking(userId, bookingId)
      const r: CancelResult = await cancelBookingItems(prisma, hotLane, {
        bookingId,
        itemIds,
        cancelledBy: 'USER',
        reason: reason ?? null,
        actorId: userId,
        cancellationId,
      })
      return cancelResponse(r)
    },

    // ───────────────────────── match invites ─────────────────────────
    async createInvite(userId: string, bookingId: string) {
      const b = await ownedBooking(userId, bookingId)
      if (!['CONFIRMED', 'CHECKED_IN'].includes(b.status) || b.end_at.getTime() <= Date.now())
        throw new ConflictError(
          'Invites need an upcoming confirmed booking',
          'BOOKING_NOT_CONFIRMED',
          {
            status: b.status,
          },
        )
      const active = await prisma.invite.count({
        where: { bookingId, revokedAt: null, expiresAt: { gt: new Date() } },
      })
      if (active >= 5)
        throw new TooManyRequestsError('At most 5 invite links per booking', 'TOO_MANY_INVITES')
      const token = randomBytes(24).toString('base64url')
      const inv = await prisma.invite.create({
        data: {
          id: uuidv7(),
          bookingId,
          tokenHash: sha(token),
          createdBy: userId,
          expiresAt: b.end_at,
        },
      })
      return {
        id: inv.id,
        token,
        path: `/invite/${token}`,
        expiresAt: inv.expiresAt.toISOString(),
      }
    },

    async listInvites(userId: string, bookingId: string) {
      await ownedBooking(userId, bookingId)
      const invs = await prisma.invite.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'desc' },
        include: { rsvps: { orderBy: { createdAt: 'asc' } } },
      })
      return invs.map((i) => ({
        id: i.id,
        expiresAt: i.expiresAt.toISOString(),
        revokedAt: i.revokedAt?.toISOString() ?? null,
        rsvps: i.rsvps.map((r) => ({ name: r.name, phone: r.phone, status: r.status })),
      }))
    },

    async revokeInvite(userId: string, bookingId: string, inviteId: string) {
      await ownedBooking(userId, bookingId)
      const n = await prisma.invite.updateMany({
        where: { id: inviteId, bookingId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (n.count === 0) throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
      return { id: inviteId, revoked: true }
    },

    async publicInvite(token: string) {
      const inv = await prisma.invite.findUnique({
        where: { tokenHash: sha(token) },
        include: { rsvps: true },
      })
      if (!inv) throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
      const b = await loadBooking(prisma, inv.bookingId)
      if (
        !b ||
        inv.revokedAt ||
        inv.expiresAt.getTime() <= Date.now() ||
        !['CONFIRMED', 'CHECKED_IN'].includes(b.status)
      )
        throw new AppGone()
      const n = await names(prisma, b.venue_id, b.court_id)
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

    async rsvp(
      token: string,
      input: { name: string; phone?: string; status: 'GOING' | 'NOT_GOING' },
    ) {
      const inv = await prisma.invite.findUnique({ where: { tokenHash: sha(token) } })
      if (!inv) throw new NotFoundError('Invite not found', 'INVITE_NOT_FOUND')
      const name = input.name.trim()
      if (!name) throw new BadRequestError('Please enter your name', 'VALIDATION_ERROR')
      const key = input.phone ? input.phone.replace(/[^0-9+]/g, '') : name.toLowerCase()
      return prisma.$transaction(async (tx) => {
        const b = await lockBooking(tx, inv.bookingId)
        if (
          !b ||
          inv.revokedAt ||
          inv.expiresAt.getTime() <= Date.now() ||
          !['CONFIRMED', 'CHECKED_IN'].includes(b.status)
        )
          throw new AppGone()
        const count = await tx.inviteRsvp.count({ where: { inviteId: inv.id } })
        const existing = await tx.inviteRsvp.findUnique({
          where: { inviteId_rsvpKey: { inviteId: inv.id, rsvpKey: key } },
        })
        if (!existing && count >= 200)
          throw new TooManyRequestsError('This invite is full', 'INVITE_FULL')
        await tx.inviteRsvp.upsert({
          where: { inviteId_rsvpKey: { inviteId: inv.id, rsvpKey: key } },
          create: {
            id: uuidv7(),
            inviteId: inv.id,
            name,
            phone: input.phone ?? null,
            rsvpKey: key,
            status: input.status,
          },
          update: { name, status: input.status, updatedAt: new Date() },
        })
        // headcount = the captain + everyone across this booking's invites who is going
        const going = (
          await tx.$queryRaw<{ n: number }[]>`
            SELECT count(DISTINCT r.rsvp_key)::int AS n FROM invite_rsvps r JOIN invites i ON i.id = r.invite_id
             WHERE i.booking_id = ${b.id}::uuid AND r.status = 'GOING'`
        )[0].n
        const headcount = Math.min(100, 1 + going)
        await tx.$executeRaw`
          UPDATE bookings SET headcount = ${headcount}, version = version + 1, updated_at = clock_timestamp()
           WHERE id = ${b.id}::uuid`
        return { status: input.status, going, headcount }
      })
    },

    async setHeadcount(userId: string, bookingId: string, headcount: number) {
      const b = await ownedBooking(userId, bookingId)
      if (!['CONFIRMED', 'CHECKED_IN'].includes(b.status))
        throw new ConflictError('Only a confirmed booking has a headcount', 'BOOKING_NOT_CONFIRMED')
      await prisma.$executeRaw`
        UPDATE bookings SET headcount = ${headcount}, version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${bookingId}::uuid`
      return { bookingId, headcount }
    },
  }
}

/** 410: the invite existed but is no longer open (revoked, expired, or the booking was cancelled). */
class AppGone extends AppError {
  constructor() {
    super('This invite is no longer open', 410, true, 'INVITE_CLOSED')
  }
}

export type BookingService = ReturnType<typeof createBookingService>
