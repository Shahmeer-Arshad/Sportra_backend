/**
 * Ground POS commands (staff): walk-in, manual booking, blocks, outage lock, check-in, balance
 * collection, no-show, day list, cancellation, settings, blocklist.
 * Role gating is done by the route guards (requireVenueRole); every command here is also scoped to
 * the venue in the path, so staff of venue A can never touch venue B's bookings.
 */
import { createHash } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { env } from '../../config/env'
import { audit } from '../../lib/audit'
import { HotLane } from '../../lib/hotlane'
import { uuidv7 } from '../../lib/id'
import { hashRequest, runIdempotent } from '../../lib/idempotency'
import { addOutbox } from '../../lib/outbox'
import { isLockContention, isTxTimeout } from '../../lib/pgerror'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors'
import {
  PassVerificationError,
  checkInWindow,
  isLikelyNoShow,
  normalizePhone,
  verifyPass,
} from './booking.domain'
import {
  acquireSlots,
  blockWindow,
  inventoryTx,
  isoDate,
  publishBookingUpdate,
  publishSlotUpdates,
  releaseBlocks,
} from './booking.inventory'
import {
  BOOKING_COLS,
  BookingRowRaw,
  bookingJson,
  cancelBookingItems,
  cancelResponse,
  createItems,
  dbNowOf,
  insertBooking,
  loadBooking,
  loadItems,
  lockBooking,
  num,
  qrSecret,
  resolveRequestedSlots,
} from './booking.shared'

const PRODUCER = 'booking'
export type StaffRole = 'OWNER' | 'MANAGER' | 'FRONT_DESK'
export interface Actor {
  id: string
  role: StaffRole | 'ADMIN'
  ip?: string | null
}

/** Stable UUID derived from a string, so a retried job reuses the same cancellation id. */
const derivedUuid = (s: string) => {
  const h = createHash('sha256').update(s).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

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

type BlockReason = 'RAIN' | 'POWER_OUTAGE' | 'MAINTENANCE' | 'PRIVATE_EVENT' | 'OTHER'

export function createPosService(prisma: PrismaClient, hotLane: HotLane) {
  const running = new Set<Promise<unknown>>()

  async function assertCourts(venueId: string, courtIds: string[]) {
    const n = await prisma.court.count({ where: { venueId, id: { in: courtIds } } })
    if (n !== new Set(courtIds).size)
      throw new NotFoundError('One or more courts do not belong to this venue', 'COURT_NOT_FOUND')
  }

  async function staffBooking(venueId: string, bookingId: string): Promise<BookingRowRaw> {
    const b = await loadBooking(prisma, bookingId)
    // a booking of another venue looks exactly like a missing one
    if (!b || b.venue_id !== venueId)
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

  // ───────────────────────── walk-in and manual booking ─────────────────────────
  async function createStaffBooking(
    kind: 'WALKIN' | 'MANUAL',
    venueId: string,
    actor: Actor,
    input: {
      courtId: string
      slotIds: string[]
      customerName: string
      customerPhone: string
      cashCollectedMinor?: number
      payLater?: boolean
      headcount?: number
    },
    key: string,
  ) {
    const { slots, venue } = await resolveRequestedSlots(prisma, {
      slotIds: input.slotIds,
      courtId: input.courtId,
      venueId,
      maxSlots: 12,
      pastRule: 'END_IN_FUTURE',
    })
    const total = slots.reduce((a, s) => a + s.priceMinor, 0n)
    // walk-in: cash collected defaults to the full price. manual: pay later keeps the balance open
    const cash =
      kind === 'MANUAL' && input.payLater
        ? 0n
        : input.cashCollectedMinor !== undefined
          ? BigInt(input.cashCollectedMinor)
          : kind === 'WALKIN'
            ? total
            : 0n
    if (cash > total)
      throw new BadRequestError('Cash collected cannot exceed the price', 'CASH_EXCEEDS_TOTAL', {
        totalMinor: num(total),
      })
    const name = input.customerName.trim()
    if (!name) throw new BadRequestError('Customer name is required', 'VALIDATION_ERROR')

    try {
      return await runIdempotent(
        prisma,
        {
          scope: `${kind.toLowerCase()}:${venueId}`,
          key,
          hash: hashRequest({
            c: input.courtId,
            s: [...input.slotIds].sort(),
            n: name,
            p: input.customerPhone,
            cash: String(cash),
            l: !!input.payLater,
          }),
        },
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`)
          const bookingId = uuidv7()
          // same acquire as an online hold: an active hold gives 409 SLOT_HELD with seconds left
          const { rows, updates, now } = await acquireSlots(tx, {
            target: 'BOOKED_WALKIN',
            slotIds: input.slotIds,
            bookingId,
            heldCode: 'SLOT_HELD',
          })
          const ordered = [...rows].sort((a, b) => a.start_at.getTime() - b.start_at.getTime())
          const totalMinor = ordered.reduce((a, r) => a + r.price_minor, 0n)
          const ref = await insertBooking(tx, {
            id: bookingId,
            venueId,
            city: venue.city,
            courtId: input.courtId,
            userId: null,
            source: kind,
            customerName: name,
            customerPhone: normalizePhone(input.customerPhone),
            headcount: input.headcount ?? null,
            status: 'CONFIRMED',
            paymentMode: 'CASH_ONLY',
            paymentStatus: cash >= totalMinor ? 'PAID' : 'UNPAID',
            startAt: ordered[0].start_at,
            endAt: ordered[ordered.length - 1].end_at,
            businessDate: isoDate(ordered[0].business_date),
            totalMinor,
            cutoffHours: venue.cancellationCutoffHours,
            slotIds: ordered.map((r) => r.id),
            cashCollectedMinor: cash,
            createdBy: actor.id,
          })
          await createItems(tx, bookingId, ordered.length)
          const data = {
            bookingId,
            ref,
            venueId,
            courtId: input.courtId,
            source: kind,
            customerName: name,
            totalMinor: num(totalMinor),
            cashCollectedMinor: num(cash),
            balanceDueMinor: num(totalMinor - cash),
            startAt: ordered[0].start_at,
            endAt: ordered[ordered.length - 1].end_at,
          }
          // ledger writes WALKIN_CASH from walkin.recorded (Phase 3)
          await addOutbox(tx, {
            type: kind === 'WALKIN' ? 'walkin.recorded' : 'booking.confirmed',
            routingKey: kind === 'WALKIN' ? 'walkin.recorded' : 'booking.confirmed',
            producer: PRODUCER,
            data,
          })
          await audit(tx, {
            actorId: actor.id,
            actorType: 'STAFF',
            venueId,
            action: kind === 'WALKIN' ? 'WALKIN_RECORDED' : 'MANUAL_BOOKING_CREATED',
            entity: 'booking',
            entityId: bookingId,
            after: data,
            ip: actor.ip,
          })
          const b = (await loadBooking(tx, bookingId))!
          const items = await loadItems(tx, bookingId)
          return {
            status: 201,
            body: bookingJson(b, { now, items, ...(await names(tx, venueId, input.courtId)) }),
            after: () => {
              publishSlotUpdates(hotLane, updates)
              publishBookingUpdate(hotLane, {
                bookingId,
                ref,
                venueId,
                userId: null,
                status: 'CONFIRMED',
              })
            },
          }
        },
      )
    } catch (e) {
      return mapContention(e)
    }
  }

  // ───────────────────────── outage lock ─────────────────────────
  async function affectedAppBookings(
    db: PrismaClient | Prisma.TransactionClient,
    venueId: string,
    courtIds: string[],
    from: Date,
    to: Date,
  ) {
    return db.$queryRaw<
      {
        booking_id: string
        user_id: string | null
        ref: string
        customer_name: string
        item_ids: string[]
      }[]
    >`
      SELECT b.id AS booking_id, b.user_id, b.ref, b.customer_name, array_agg(i.id ORDER BY i.start_at) AS item_ids
        FROM booking_items i JOIN bookings b ON b.id = i.booking_id
       WHERE i.venue_id = ${venueId}::uuid AND i.court_id = ANY(${courtIds}::uuid[]) AND i.status = 'CONFIRMED'
         AND i.start_at >= ${from} AND i.start_at < ${to} AND b.source = 'APP' AND b.status = 'CONFIRMED'
       GROUP BY b.id, b.user_id, b.ref, b.customer_name
       ORDER BY min(i.start_at)`
  }

  async function manualToCall(
    db: PrismaClient | Prisma.TransactionClient,
    venueId: string,
    courtIds: string[],
    from: Date,
    to: Date,
  ) {
    const rows = await db.$queryRaw<
      {
        id: string
        ref: string
        source: string
        customer_name: string
        customer_phone: string
        start_at: Date
      }[]
    >`
      SELECT DISTINCT b.id, b.ref, b.source, b.customer_name, b.customer_phone, b.start_at
        FROM booking_items i JOIN bookings b ON b.id = i.booking_id
       WHERE i.venue_id = ${venueId}::uuid AND i.court_id = ANY(${courtIds}::uuid[]) AND i.status = 'CONFIRMED'
         AND i.start_at >= ${from} AND i.start_at < ${to} AND b.source IN ('WALKIN','MANUAL')
         AND b.status IN ('CONFIRMED','CHECKED_IN')
       ORDER BY b.start_at`
    return rows.map((r) => ({
      bookingId: r.id,
      ref: r.ref,
      source: r.source,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      startAt: r.start_at.toISOString(),
    }))
  }

  /** Cancel the app bookings of an outage lock, one by one, each in its own transaction. Resumable and idempotent. */
  async function processOutage(lockId: string): Promise<void> {
    const lock = await prisma.outageLock.findUnique({ where: { id: lockId } })
    if (!lock || lock.status !== 'PROCESSING') return
    const attempted = new Set<string>()
    for (;;) {
      const todo = (
        await affectedAppBookings(
          prisma,
          lock.venueId,
          lock.courtIds,
          lock.windowStart,
          lock.windowEnd,
        )
      ).filter((b) => !attempted.has(b.booking_id))
      if (todo.length === 0) break
      for (const b of todo) {
        attempted.add(b.booking_id)
        try {
          await cancelBookingItems(prisma, hotLane, {
            bookingId: b.booking_id,
            itemIds: b.item_ids,
            cancelledBy: 'VENUE',
            reason: `Venue closed: ${lock.reason.toLowerCase().replace('_', ' ')}`,
            actorId: lock.createdBy,
            // the same job + booking always yields the same id, so a retry never refunds twice
            cancellationId: derivedUuid(`outage:${lockId}:${b.booking_id}`),
            releaseTo: 'BLOCKED',
            blockReason: lock.reason,
            blockRef: lock.id,
          })
        } catch {
          // stays in "remaining"; reported as failed when the loop ends
        }
        const remaining = (
          await affectedAppBookings(
            prisma,
            lock.venueId,
            lock.courtIds,
            lock.windowStart,
            lock.windowEnd,
          )
        ).length
        await prisma.outageLock.update({
          where: { id: lockId },
          data: { processed: Math.max(0, lock.totalBookings - remaining) },
        })
        hotLane.publish({
          type: 'outage.progress',
          venueId: lock.venueId,
          lockId,
          total: lock.totalBookings,
          processed: Math.max(0, lock.totalBookings - remaining),
        })
      }
    }
    const remaining = await affectedAppBookings(
      prisma,
      lock.venueId,
      lock.courtIds,
      lock.windowStart,
      lock.windowEnd,
    )
    await prisma.outageLock.updateMany({
      where: { id: lockId, status: 'PROCESSING' },
      data: {
        status: 'ACTIVE',
        failed: remaining.length,
        processed: Math.max(0, lock.totalBookings - remaining.length),
      },
    })
    hotLane.publish({ type: 'outage.progress', venueId: lock.venueId, lockId, done: true })
  }

  function kick(lockId: string) {
    const p = processOutage(lockId)
      .catch(() => undefined)
      .finally(() => running.delete(p))
    running.add(p)
  }

  const outageJson = (l: {
    id: string
    venueId: string
    courtIds: string[]
    windowStart: Date
    windowEnd: Date
    reason: string
    note: string | null
    status: string
    totalBookings: number
    processed: number
    failed: number
    manualToCall: unknown
    createdAt: Date
    releasedAt: Date | null
  }) => ({
    id: l.id,
    venueId: l.venueId,
    courtIds: l.courtIds,
    from: l.windowStart.toISOString(),
    to: l.windowEnd.toISOString(),
    reason: l.reason,
    note: l.note,
    status: l.status,
    totalBookings: l.totalBookings,
    processed: l.processed,
    failed: l.failed,
    progress: `${l.processed} of ${l.totalBookings} players handled`,
    manualToCall: l.manualToCall,
    createdAt: l.createdAt.toISOString(),
    releasedAt: l.releasedAt?.toISOString() ?? null,
  })

  return {
    /** Wait for background outage jobs (tests, graceful shutdown). */
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running])
    },

    walkIn: (
      venueId: string,
      actor: Actor,
      input: Parameters<typeof createStaffBooking>[3],
      key: string,
    ) => createStaffBooking('WALKIN', venueId, actor, input, key),
    manualBooking: (
      venueId: string,
      actor: Actor,
      input: Parameters<typeof createStaffBooking>[3],
      key: string,
    ) => createStaffBooking('MANUAL', venueId, actor, input, key),

    // ───────────────────────── blocks ─────────────────────────
    async block(
      venueId: string,
      actor: Actor,
      input: { courtIds: string[]; from: string; to: string; reason: BlockReason; note?: string },
    ) {
      const from = new Date(input.from)
      const to = new Date(input.to)
      if (!(to > from)) throw new BadRequestError('"to" must be after "from"', 'VALIDATION_ERROR')
      if (to.getTime() - from.getTime() > 62 * 86_400_000)
        throw new BadRequestError('A block can cover at most 62 days', 'VALIDATION_ERROR')
      await assertCourts(venueId, input.courtIds)
      let res
      try {
        res = await inventoryTx(prisma, async (tx) => {
          const r = await blockWindow(tx, {
            venueId,
            courtIds: input.courtIds,
            from,
            to,
            reason: input.reason,
            note: input.note,
          })
          if (r.blocked.length > 0) {
            await addOutbox(tx, {
              type: 'slot.blocked',
              routingKey: 'slot.blocked',
              producer: PRODUCER,
              data: {
                venueId,
                courtIds: input.courtIds,
                from,
                to,
                reason: input.reason,
                slotIds: r.blocked.map((b) => b.slotId),
              },
            })
          }
          await audit(tx, {
            actorId: actor.id,
            actorType: 'STAFF',
            venueId,
            action: 'SLOTS_BLOCKED',
            entity: 'slots',
            entityId: venueId,
            after: {
              courtIds: input.courtIds,
              from,
              to,
              reason: input.reason,
              note: input.note,
              blocked: r.blocked.length,
              conflicts: r.conflicts.length,
            },
            ip: actor.ip,
          })
          return r
        })
      } catch (e) {
        return mapContention(e)
      }
      publishSlotUpdates(hotLane, res.blocked)
      return {
        blockedCount: res.blocked.length,
        blockedSlotIds: res.blocked.map((b) => b.slotId),
        heldSkipped: res.heldSkipped,
        conflicts: res.conflicts,
        alreadyBlocked: res.alreadyBlocked,
      }
    },

    async unblock(
      venueId: string,
      actor: Actor,
      input: { courtIds: string[]; from: string; to: string },
    ) {
      const from = new Date(input.from)
      const to = new Date(input.to)
      if (!(to > from)) throw new BadRequestError('"to" must be after "from"', 'VALIDATION_ERROR')
      await assertCourts(venueId, input.courtIds)
      const updates = await prisma.$transaction(async (tx) => {
        const u = await releaseBlocks(tx, {
          kind: 'window',
          venueId,
          courtIds: input.courtIds,
          from,
          to,
        })
        if (u.length)
          await audit(tx, {
            actorId: actor.id,
            actorType: 'STAFF',
            venueId,
            action: 'SLOTS_UNBLOCKED',
            entity: 'slots',
            entityId: venueId,
            after: { courtIds: input.courtIds, from, to, released: u.length },
            ip: actor.ip,
          })
        return u
      })
      publishSlotUpdates(hotLane, updates)
      return { releasedCount: updates.length, releasedSlotIds: updates.map((u) => u.slotId) }
    },

    // ───────────────────────── outage lock ─────────────────────────
    async outagePreview(venueId: string, input: { courtIds: string[]; from: string; to: string }) {
      const from = new Date(input.from)
      const to = new Date(input.to)
      if (!(to > from)) throw new BadRequestError('"to" must be after "from"', 'VALIDATION_ERROR')
      await assertCourts(venueId, input.courtIds)
      const app = await affectedAppBookings(prisma, venueId, input.courtIds, from, to)
      const manual = await manualToCall(prisma, venueId, input.courtIds, from, to)
      const free = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM slots
         WHERE venue_id = ${venueId}::uuid AND court_id = ANY(${input.courtIds}::uuid[]) AND start_at >= ${from} AND start_at < ${to}
           AND (status = 'AVAILABLE' OR (status = 'HELD' AND hold_expires_at <= clock_timestamp()))`
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        freeHoursToBlock: free[0].n,
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

    async startOutage(
      venueId: string,
      actor: Actor,
      input: {
        courtIds: string[]
        from: string
        to: string
        reason: 'RAIN' | 'POWER_OUTAGE' | 'MAINTENANCE' | 'OTHER'
        note?: string
      },
      key: string,
    ) {
      const from = new Date(input.from)
      const to = new Date(input.to)
      if (!(to > from)) throw new BadRequestError('"to" must be after "from"', 'VALIDATION_ERROR')
      if (to.getTime() <= Date.now())
        throw new BadRequestError('The window is in the past', 'SLOT_IN_PAST')
      await assertCourts(venueId, input.courtIds)
      let out
      try {
        out = await runIdempotent(
          prisma,
          { scope: `outage:${venueId}`, key, hash: hashRequest(input) },
          async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`)
            const lockId = uuidv7()
            // 1) block every free hour in the window (new bookings are paused: nothing is bookable)
            const r = await blockWindow(tx, {
              venueId,
              courtIds: input.courtIds,
              from,
              to,
              reason: input.reason,
              note: input.note,
              ref: lockId,
            })
            // 2) who is affected
            const app = await affectedAppBookings(tx, venueId, input.courtIds, from, to)
            const manual = await manualToCall(tx, venueId, input.courtIds, from, to)
            await tx.outageLock.create({
              data: {
                id: lockId,
                venueId,
                courtIds: input.courtIds,
                windowStart: from,
                windowEnd: to,
                reason: input.reason,
                note: input.note ?? null,
                status: app.length === 0 ? 'ACTIVE' : 'PROCESSING',
                totalBookings: app.length,
                manualToCall: manual,
                createdBy: actor.id,
              },
            })
            await addOutbox(tx, {
              type: 'outage_lock.activated',
              routingKey: 'outage_lock.activated',
              producer: PRODUCER,
              data: {
                lockId,
                venueId,
                courtIds: input.courtIds,
                from,
                to,
                reason: input.reason,
                affectedBookings: app.length,
              },
            })
            await audit(tx, {
              actorId: actor.id,
              actorType: 'STAFF',
              venueId,
              action: 'OUTAGE_LOCK_STARTED',
              entity: 'outage_lock',
              entityId: lockId,
              after: { ...input, affectedBookings: app.length, blocked: r.blocked.length },
              ip: actor.ip,
            })
            const lock = await tx.outageLock.findUniqueOrThrow({ where: { id: lockId } })
            return {
              status: 202,
              body: {
                ...outageJson(lock),
                blockedFreeHours: r.blocked.length,
                heldSkipped: r.heldSkipped,
              },
              after: () => {
                publishSlotUpdates(hotLane, r.blocked)
                if (app.length > 0) kick(lockId)
              },
            }
          },
        )
      } catch (e) {
        return mapContention(e)
      }
      return out
    },

    processOutage,

    async getOutage(venueId: string, id: string) {
      const l = await prisma.outageLock.findFirst({ where: { id, venueId } })
      if (!l) throw new NotFoundError('Outage lock not found', 'OUTAGE_NOT_FOUND')
      return outageJson(l)
    },
    async listOutages(venueId: string) {
      const rows = await prisma.outageLock.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      return rows.map(outageJson)
    },

    async releaseOutage(venueId: string, actor: Actor, id: string) {
      const l = await prisma.outageLock.findFirst({ where: { id, venueId } })
      if (!l) throw new NotFoundError('Outage lock not found', 'OUTAGE_NOT_FOUND')
      if (l.status === 'RELEASED') return outageJson(l)
      if (l.status === 'PROCESSING')
        throw new ConflictError(
          'Players are still being handled, release when it finishes',
          'OUTAGE_STILL_PROCESSING',
        )
      const updates = await prisma.$transaction(async (tx) => {
        const u = await releaseBlocks(tx, { kind: 'ref', venueId, ref: id })
        await tx.outageLock.update({
          where: { id },
          data: { status: 'RELEASED', releasedAt: new Date(), releasedBy: actor.id },
        })
        await audit(tx, {
          actorId: actor.id,
          actorType: actor.role === 'ADMIN' ? 'ADMIN' : 'STAFF',
          venueId,
          action: 'OUTAGE_LOCK_RELEASED',
          entity: 'outage_lock',
          entityId: id,
          after: { released: u.length },
          ip: actor.ip,
        })
        return u
      })
      publishSlotUpdates(hotLane, updates)
      return outageJson(await prisma.outageLock.findUniqueOrThrow({ where: { id } }))
    },

    // ───────────────────────── check-in, balance, no-show ─────────────────────────
    async checkIn(
      venueId: string,
      actor: Actor,
      input: { bookingId?: string; token?: string; ref?: string },
    ) {
      let bookingId = input.bookingId
      let claims
      if (input.token) {
        try {
          claims = verifyPass(input.token, qrSecret())
        } catch (e) {
          if (e instanceof PassVerificationError)
            throw new ConflictError(
              e.code === 'PASS_INVALID'
                ? 'This QR pass is not valid'
                : e.code === 'PASS_EXPIRED'
                  ? 'This QR pass has expired'
                  : 'This QR pass is not valid yet',
              e.code,
            )
          throw e
        }
        if (claims.vid !== venueId)
          throw new ForbiddenError('This pass is for another venue', 'PASS_WRONG_VENUE')
        if (bookingId && bookingId !== claims.bid)
          throw new ForbiddenError('This pass belongs to another booking', 'PASS_MISMATCH')
        bookingId = claims.bid
      } else if (input.ref) {
        const r = await prisma.booking.findUnique({
          where: { ref: input.ref.trim().toUpperCase() },
        })
        if (!r || r.venueId !== venueId)
          throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
        bookingId = r.id
      }
      if (!bookingId)
        throw new BadRequestError('Provide a QR token or the booking code', 'VALIDATION_ERROR')
      const pre = await staffBooking(venueId, bookingId)

      const win = checkInWindow(pre.start_at, pre.end_at)
      const out = await prisma.$transaction(async (tx) => {
        const b = (await lockBooking(tx, bookingId!))!
        if (b.status === 'CHECKED_IN') return { replayed: true, b }
        if (b.status !== 'CONFIRMED')
          throw new ConflictError(
            'Only a confirmed booking can be checked in',
            'BOOKING_NOT_CONFIRMED',
            {
              status: b.status,
            },
          )
        const now = await dbNowOf(tx)
        const w = checkInWindow(b.start_at, b.end_at)
        if (now < w.from || now > w.until)
          throw new ConflictError(
            'This booking cannot be checked in at this time',
            'OUTSIDE_CHECKIN_WINDOW',
            {
              from: win.from.toISOString(),
              until: win.until.toISOString(),
            },
          )
        await tx.$executeRaw`
          UPDATE bookings SET status = 'CHECKED_IN', checked_in_at = ${now}, version = version + 1, updated_at = ${now}
           WHERE id = ${b.id}::uuid`
        await addOutbox(tx, {
          type: 'booking.checked_in',
          routingKey: 'booking.checked_in',
          producer: PRODUCER,
          data: { bookingId: b.id, ref: b.ref, venueId, userId: b.user_id, at: now },
        })
        await audit(tx, {
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'BOOKING_CHECKED_IN',
          entity: 'booking',
          entityId: b.id,
          before: { status: 'CONFIRMED' },
          after: { status: 'CHECKED_IN' },
          ip: actor.ip,
        })
        return { replayed: false, b: (await loadBooking(tx, b.id))! }
      })
      if (!out.replayed)
        publishBookingUpdate(hotLane, {
          bookingId: out.b.id,
          ref: out.b.ref,
          venueId,
          userId: out.b.user_id,
          status: 'CHECKED_IN',
        })
      return {
        replayed: out.replayed,
        booking: bookingJson(out.b, { now: await dbNowOf(prisma) }),
        balanceDueMinor: num(out.b.balance_due_minor),
      }
    },

    async collectBalance(
      venueId: string,
      actor: Actor,
      bookingId: string,
      amountMinor: number,
      key: string,
    ) {
      await staffBooking(venueId, bookingId)
      return runIdempotent(
        prisma,
        { scope: `collect:${venueId}`, key, hash: hashRequest({ b: bookingId, a: amountMinor }) },
        async (tx) => {
          const b = await lockBooking(tx, bookingId)
          if (!b || b.venue_id !== venueId)
            throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
          if (!['CONFIRMED', 'CHECKED_IN'].includes(b.status))
            throw new ConflictError(
              'Only a confirmed booking can take a payment',
              'BOOKING_NOT_CONFIRMED',
              {
                status: b.status,
              },
            )
          const due = num(b.balance_due_minor)
          if (amountMinor > due)
            throw new ConflictError('That is more than the balance due', 'AMOUNT_EXCEEDS_BALANCE', {
              balanceDueMinor: due,
            })
          await tx.$executeRaw`
            UPDATE bookings SET cash_collected_minor = cash_collected_minor + ${BigInt(amountMinor)},
                   payment_status = CASE WHEN ${BigInt(due - amountMinor)} = 0 THEN 'PAID' ELSE payment_status END,
                   version = version + 1, updated_at = clock_timestamp()
             WHERE id = ${bookingId}::uuid`
          await addOutbox(tx, {
            type: 'balance.collected',
            routingKey: 'balance.collected',
            producer: PRODUCER,
            data: {
              bookingId,
              ref: b.ref,
              venueId,
              amountMinor,
              balanceDueMinor: due - amountMinor,
            },
          })
          await audit(tx, {
            actorId: actor.id,
            actorType: 'STAFF',
            venueId,
            action: 'BALANCE_COLLECTED',
            entity: 'booking',
            entityId: bookingId,
            after: { amountMinor, balanceDueMinor: due - amountMinor },
            ip: actor.ip,
          })
          const fresh = (await loadBooking(tx, bookingId))!
          return {
            status: 200,
            body: bookingJson(fresh, { now: await dbNowOf(tx) }),
            after: () =>
              publishBookingUpdate(hotLane, {
                bookingId,
                ref: b.ref,
                venueId,
                userId: b.user_id,
                status: b.status,
              }),
          }
        },
      )
    },

    async markNoShow(venueId: string, actor: Actor, bookingId: string) {
      await staffBooking(venueId, bookingId)
      const out = await prisma.$transaction(async (tx) => {
        const b = (await lockBooking(tx, bookingId))!
        if (b.status === 'NO_SHOW') return { replayed: true, b }
        if (b.status !== 'CONFIRMED')
          throw new ConflictError(
            'Only a confirmed booking can be a no-show',
            'BOOKING_NOT_CONFIRMED',
            {
              status: b.status,
            },
          )
        const now = await dbNowOf(tx)
        const earliest = new Date(b.start_at.getTime() + env.NO_SHOW_AFTER_MINUTES * 60_000)
        if (now < earliest)
          throw new ConflictError(
            `A no-show can be marked ${env.NO_SHOW_AFTER_MINUTES} minutes after the start`,
            'TOO_EARLY_FOR_NO_SHOW',
            { earliest: earliest.toISOString() },
          )
        // the deposit (online money, Phase 3) is forfeited; pay-at-venue bookings have none
        await tx.$executeRaw`
          UPDATE bookings SET status = 'NO_SHOW', no_show_at = ${now}, forfeited_minor = forfeited_minor + deposit_minor,
                 version = version + 1, updated_at = ${now} WHERE id = ${bookingId}::uuid`
        // one app, one database: the strike is counted in the same transaction (an event would add a race)
        if (b.user_id)
          await tx.$executeRaw`UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ${b.user_id}::uuid`
        await addOutbox(tx, {
          type: 'booking.no_show',
          routingKey: 'booking.no_show',
          producer: PRODUCER,
          data: {
            bookingId,
            ref: b.ref,
            venueId,
            userId: b.user_id,
            depositMinor: num(b.deposit_minor),
          },
        })
        await audit(tx, {
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'BOOKING_NO_SHOW',
          entity: 'booking',
          entityId: bookingId,
          before: { status: 'CONFIRMED' },
          after: { status: 'NO_SHOW' },
          ip: actor.ip,
        })
        return { replayed: false, b: (await loadBooking(tx, bookingId))! }
      })
      if (!out.replayed)
        publishBookingUpdate(hotLane, {
          bookingId,
          ref: out.b.ref,
          venueId,
          userId: out.b.user_id,
          status: 'NO_SHOW',
        })
      return { replayed: out.replayed, booking: bookingJson(out.b, { now: await dbNowOf(prisma) }) }
    },

    // ───────────────────────── reading and cancelling ─────────────────────────
    async dayList(
      venueId: string,
      q: { date?: string; status?: string; q?: string; limit: number; offset: number },
    ) {
      const status = q.status ? q.status.split(',').filter(Boolean) : null
      const text = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null
      const where = Prisma.sql`venue_id = ${venueId}::uuid
        ${q.date ? Prisma.sql`AND business_date = ${q.date}::date` : Prisma.empty}
        ${status ? Prisma.sql`AND status = ANY(${status}::text[])` : Prisma.sql`AND status NOT IN ('EXPIRED')`}
        ${text ? Prisma.sql`AND (customer_name ILIKE ${text} OR customer_phone ILIKE ${text} OR ref ILIKE ${text})` : Prisma.empty}`
      const rows = await prisma.$queryRaw<BookingRowRaw[]>`
        SELECT ${BOOKING_COLS} FROM bookings WHERE ${where} ORDER BY start_at, created_at LIMIT ${q.limit} OFFSET ${q.offset}`
      const total = (
        await prisma.$queryRaw<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM bookings WHERE ${where}`
      )[0].n
      const now = await dbNowOf(prisma)
      const courts = await prisma.court.findMany({
        where: { venueId },
        select: { id: true, name: true },
      })
      const cn = new Map(courts.map((c) => [c.id, c.name]))
      return {
        items: rows.map((r) => ({
          ...bookingJson(r, { now, courtName: cn.get(r.court_id) }),
          likelyNoShow: isLikelyNoShow(
            { status: r.status, startAt: r.start_at },
            now,
            env.NO_SHOW_AFTER_MINUTES,
          ),
        })),
        total,
      }
    },

    async getBooking(venueId: string, bookingId: string) {
      const b = await staffBooking(venueId, bookingId)
      const items = await loadItems(prisma, b.id)
      const now = await dbNowOf(prisma)
      return {
        ...bookingJson(b, { now, items, ...(await names(prisma, venueId, b.court_id)) }),
        likelyNoShow: isLikelyNoShow(
          { status: b.status, startAt: b.start_at },
          now,
          env.NO_SHOW_AFTER_MINUTES,
        ),
      }
    },

    async cancel(
      venueId: string,
      actor: Actor,
      bookingId: string,
      itemIds: string[] | undefined,
      reason: string | undefined,
      cancellationId: string,
    ) {
      await staffBooking(venueId, bookingId)
      const r = await cancelBookingItems(prisma, hotLane, {
        bookingId,
        itemIds,
        cancelledBy: 'VENUE',
        reason: reason ?? 'Cancelled by the venue',
        actorId: actor.id,
        cancellationId,
      })
      return cancelResponse(r)
    },

    // ───────────────────────── settings and blocklist ─────────────────────────
    async getSettings(venueId: string) {
      const s = await prisma.bookingSettings.findUnique({ where: { venueId } })
      return {
        venueId,
        payAtVenueEnabled: s?.payAtVenueEnabled ?? false,
        holdSeconds: env.HOLD_SECONDS,
        horizonDays: env.SLOT_HORIZON_DAYS,
      }
    },
    async updateSettings(venueId: string, actor: Actor, input: { payAtVenueEnabled: boolean }) {
      const before = await prisma.bookingSettings.findUnique({ where: { venueId } })
      await prisma.$transaction(async (tx) => {
        await tx.bookingSettings.upsert({
          where: { venueId },
          create: { venueId, payAtVenueEnabled: input.payAtVenueEnabled, updatedBy: actor.id },
          update: {
            payAtVenueEnabled: input.payAtVenueEnabled,
            updatedBy: actor.id,
            updatedAt: new Date(),
          },
        })
        await audit(tx, {
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
      })
      return this.getSettings(venueId)
    },

    async addToBlocklist(venueId: string, actor: Actor, input: { phone: string; reason?: string }) {
      const phone = normalizePhone(input.phone)
      await prisma.venueBlocklist.upsert({
        where: { venueId_phone: { venueId, phone } },
        create: { venueId, phone, reason: input.reason ?? null, createdBy: actor.id },
        update: { reason: input.reason ?? null },
      })
      await prisma.$transaction((tx) =>
        audit(tx, {
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'BLOCKLIST_ADDED',
          entity: 'venue_blocklist',
          entityId: phone,
          after: input,
          ip: actor.ip,
        }),
      )
      return { phone, reason: input.reason ?? null }
    },
    async listBlocklist(venueId: string) {
      const rows = await prisma.venueBlocklist.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
      })
      return rows.map((r) => ({
        phone: r.phone,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      }))
    },
    async removeFromBlocklist(venueId: string, actor: Actor, phoneRaw: string) {
      const phone = normalizePhone(phoneRaw)
      const n = await prisma.venueBlocklist.deleteMany({ where: { venueId, phone } })
      if (n.count === 0) throw new NotFoundError('That number is not on the blocklist', 'NOT_FOUND')
      await prisma.$transaction((tx) =>
        audit(tx, {
          actorId: actor.id,
          actorType: 'STAFF',
          venueId,
          action: 'BLOCKLIST_REMOVED',
          entity: 'venue_blocklist',
          entityId: phone,
          ip: actor.ip,
        }),
      )
      return { phone, removed: true }
    },
  }
}

export type PosService = ReturnType<typeof createPosService>
