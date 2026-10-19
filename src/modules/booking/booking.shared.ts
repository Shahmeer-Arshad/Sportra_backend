import { Prisma, PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'
import { env } from '../../config/env'
import { HotLane } from '../../lib/hotlane'
import { pgError } from '../../lib/pgerror'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors'
import { SlotLike, checkConsecutive, makeBookingRef, normalizePhone } from './booking.domain'
import { SlotUpdate, publishBookingUpdate, publishSlotUpdates } from './booking.inventory'

/** Money leaves the API as plain numbers (paisa). BigInt is not JSON-safe and values are far below 2^53. */
export const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v))

export const qrSecret = () =>
  env.QR_PASS_SECRET ??
  createHash('sha256').update(`qr-pass:${env.ACCESS_TOKEN_SECRET}`).digest('hex')

// ───────────── requested hours: validation without locking ─────────────
export interface RequestedSlot {
  id: string
  courtId: string
  venueId: string
  startAt: Date
  endAt: Date
  priceMinor: bigint
  status: string
}
export interface VenueInfo {
  id: string
  name: string
  city: string
  timezone: string
  cancellationCutoffHours: number
  verified: boolean
  isActive: boolean
}

/**
 * Cheap pre-checks on the requested hours: they exist, one court, consecutive, not in the past.
 * This reads without locking; the real guarantee is acquireSlots under row locks.
 */
export async function resolveRequestedSlots(
  prisma: PrismaClient | Prisma.TransactionClient,
  o: {
    slotIds: string[]
    courtId?: string
    venueId?: string
    maxSlots: number
    /** holds need a future start; POS may sell the hour that is currently being played */
    pastRule: 'START_IN_FUTURE' | 'END_IN_FUTURE'
  },
): Promise<{ slots: RequestedSlot[]; venue: VenueInfo; courtName: string }> {
  const rows = await prisma.$queryRaw<
    {
      id: string
      court_id: string
      venue_id: string
      start_at: Date
      end_at: Date
      price_minor: bigint
      status: string
    }[]
  >`SELECT id, court_id, venue_id, start_at, end_at, price_minor, status FROM slots WHERE id = ANY(${o.slotIds}::uuid[])`
  const slots: RequestedSlot[] = rows.map((r) => ({
    id: r.id,
    courtId: r.court_id,
    venueId: r.venue_id,
    startAt: r.start_at,
    endAt: r.end_at,
    priceMinor: r.price_minor,
    status: r.status,
  }))
  if (new Set(o.slotIds).size !== o.slotIds.length)
    throw new BadRequestError('Duplicate hours in the request', 'INVALID_SLOT_SELECTION', {
      reason: 'DUPLICATE_SLOTS',
    })
  if (slots.length !== o.slotIds.length)
    throw new NotFoundError('One or more hours do not exist', 'SLOT_NOT_FOUND')
  const bad = checkConsecutive(slots as unknown as SlotLike[], o.maxSlots)
  if (bad)
    throw new BadRequestError(
      bad === 'NOT_CONSECUTIVE'
        ? 'Hours must be consecutive'
        : bad === 'TOO_MANY_SLOTS'
          ? `You can select at most ${o.maxSlots} hours`
          : bad === 'DIFFERENT_COURTS'
            ? 'All hours must be on the same court'
            : 'Invalid hour selection',
      'INVALID_SLOT_SELECTION',
      { reason: bad },
    )
  const first = slots[0]
  if (o.courtId && first.courtId !== o.courtId)
    throw new BadRequestError('Those hours are not on that court', 'INVALID_SLOT_SELECTION', {
      reason: 'WRONG_COURT',
    })
  if (o.venueId && first.venueId !== o.venueId)
    throw new NotFoundError('One or more hours do not exist', 'SLOT_NOT_FOUND')

  const now = Date.now()
  const past = slots.some((s) =>
    o.pastRule === 'START_IN_FUTURE' ? s.startAt.getTime() <= now : s.endAt.getTime() <= now,
  )
  if (past) throw new BadRequestError('Those hours are in the past', 'SLOT_IN_PAST')

  const v = await prisma.venue.findUnique({ where: { id: first.venueId } })
  const court = await prisma.court.findUnique({ where: { id: first.courtId } })
  if (!v || !court) throw new NotFoundError('Venue not found', 'VENUE_NOT_FOUND')
  return {
    slots: slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime()),
    venue: {
      id: v.id,
      name: v.name,
      city: v.city,
      timezone: v.timezone,
      cancellationCutoffHours: v.cancellationCutoffHours,
      verified: v.verificationStatus === 'VERIFIED',
      isActive: v.isActive && court.isActive,
    },
    courtName: court.name,
  }
}

/** Phone numbers a venue has blocked (compared in one normalised shape). */
export async function isBlocklisted(
  db: PrismaClient | Prisma.TransactionClient,
  venueId: string,
  phone: string | null | undefined,
): Promise<boolean> {
  if (!phone) return false
  const n = await db.venueBlocklist.count({ where: { venueId, phone: normalizePhone(phone) } })
  return n > 0
}

// ───────────── booking rows ─────────────
export interface NewBooking {
  id: string
  venueId: string
  city: string
  courtId: string
  userId: string | null
  source: 'APP' | 'WALKIN' | 'MANUAL' | 'TOURNAMENT'
  customerName: string
  customerPhone: string
  customerEmail?: string | null
  headcount?: number | null
  status: 'PENDING_PAYMENT' | 'CONFIRMED'
  paymentMode: 'CASH_ONLY' | 'DEPOSIT_20' | 'FULL_ONLINE' | 'TOURNAMENT'
  paymentStatus?: 'UNPAID' | 'PAID'
  startAt: Date
  endAt: Date
  businessDate: string
  totalMinor: bigint
  cutoffHours: number
  slotIds: string[]
  holdId?: string | null
  holdExpiresAt?: Date | null
  cashCollectedMinor?: bigint
  createdBy: string | null
}

/** Insert a booking with a fresh readable ref (KHI-7F3K2). A ref collision just picks another ref. */
export async function insertBooking(tx: Prisma.TransactionClient, b: NewBooking): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = makeBookingRef(b.city)
    const n = await tx.$executeRaw`
      INSERT INTO bookings (id, ref, venue_id, court_id, user_id, source, customer_name, customer_phone, customer_email,
        headcount, status, payment_mode, payment_status, start_at, end_at, business_date, total_minor, original_total_minor,
        cash_collected_minor, slot_ids, hold_id, hold_expires_at, cancellation_cutoff_hours, created_by)
      VALUES (${b.id}::uuid, ${ref}, ${b.venueId}::uuid, ${b.courtId}::uuid, ${b.userId}::uuid, ${b.source},
        ${b.customerName}, ${b.customerPhone}, ${b.customerEmail ?? null}, ${b.headcount ?? null}, ${b.status},
        ${b.paymentMode}, ${b.paymentStatus ?? 'UNPAID'}, ${b.startAt}, ${b.endAt}, ${b.businessDate}::date, ${b.totalMinor}, ${b.totalMinor},
        ${b.cashCollectedMinor ?? 0n}, ${b.slotIds}::uuid[], ${b.holdId ?? null}::uuid, ${b.holdExpiresAt ?? null},
        ${b.cutoffHours}, ${b.createdBy}::uuid)
      ON CONFLICT (ref) DO NOTHING`
    if (n === 1) return ref
  }
  throw new ConflictError('Could not allocate a booking reference, try again', 'REF_COLLISION')
}

/** Items are created at confirmation only (never at hold time, finding F2). */
export async function createItems(
  tx: Prisma.TransactionClient,
  bookingId: string,
  expected: number,
  onlinePaid = 0n,
  deposit = 0n,
) {
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT create_confirmed_items(${bookingId}::uuid, ${onlinePaid}::bigint, ${deposit}::bigint) AS n`
  if (r[0].n !== expected)
    throw new ConflictError('Could not itemise the booking', 'ITEMISE_FAILED')
}

// ───────────── presentation ─────────────
export interface BookingRowRaw {
  id: string
  ref: string
  venue_id: string
  court_id: string
  user_id: string | null
  source: string
  customer_name: string
  customer_phone: string
  customer_email: string | null
  headcount: number | null
  status: string
  payment_mode: string
  payment_status: string
  start_at: Date
  end_at: Date
  business_date: Date
  total_minor: bigint
  original_total_minor: bigint
  deposit_minor: bigint
  online_paid_minor: bigint
  cash_collected_minor: bigint
  refunded_minor: bigint
  forfeited_minor: bigint
  refund_pending_minor: bigint
  balance_due_minor: bigint
  slot_ids: string[]
  hold_id: string | null
  hold_expires_at: Date | null
  cancellation_cutoff_hours: number
  cancelled_at: Date | null
  cancelled_by: string | null
  cancel_reason: string | null
  checked_in_at: Date | null
  no_show_at: Date | null
  version: number
  created_at: Date
}

export interface ItemRowRaw {
  id: string
  booking_id: string
  slot_id: string
  court_id: string
  start_at: Date
  end_at: Date
  price_minor: bigint
  online_paid_minor: bigint
  deposit_share_minor: bigint
  status: string
  refund_due_minor: bigint
  forfeit_minor: bigint
  cancelled_at: Date | null
  cancelled_by: string | null
}

export const itemJson = (i: ItemRowRaw) => ({
  id: i.id,
  slotId: i.slot_id,
  courtId: i.court_id,
  startAt: i.start_at.toISOString(),
  endAt: i.end_at.toISOString(),
  priceMinor: num(i.price_minor),
  onlinePaidMinor: num(i.online_paid_minor),
  status: i.status,
  refundDueMinor: num(i.refund_due_minor),
  forfeitMinor: num(i.forfeit_minor),
  cancelledAt: i.cancelled_at?.toISOString() ?? null,
  cancelledBy: i.cancelled_by,
})

/** A pending booking whose hold has run out is EXPIRED, whether or not the sweeper has run yet. */
export function effectiveBookingStatus(
  b: { status: string; hold_expires_at: Date | null },
  now: Date,
) {
  return b.status === 'PENDING_PAYMENT' &&
    b.hold_expires_at &&
    b.hold_expires_at.getTime() <= now.getTime()
    ? 'EXPIRED'
    : b.status
}

export function bookingJson(
  b: BookingRowRaw,
  extra: { now: Date; venueName?: string; courtName?: string; items?: ItemRowRaw[] },
) {
  const status = effectiveBookingStatus(b, extra.now)
  const holdLive = status === 'PENDING_PAYMENT' && b.hold_expires_at
  return {
    id: b.id,
    ref: b.ref,
    status,
    source: b.source,
    venueId: b.venue_id,
    ...(extra.venueName !== undefined && { venueName: extra.venueName }),
    courtId: b.court_id,
    ...(extra.courtName !== undefined && { courtName: extra.courtName }),
    customerName: b.customer_name,
    customerPhone: b.customer_phone,
    headcount: b.headcount,
    startAt: b.start_at.toISOString(),
    endAt: b.end_at.toISOString(),
    businessDate: b.business_date.toISOString().slice(0, 10),
    totalMinor: num(b.total_minor),
    depositMinor: num(b.deposit_minor),
    onlinePaidMinor: num(b.online_paid_minor),
    cashCollectedMinor: num(b.cash_collected_minor),
    refundedMinor: num(b.refunded_minor),
    refundPendingMinor: num(b.refund_pending_minor),
    forfeitedMinor: num(b.forfeited_minor),
    balanceDueMinor: num(b.balance_due_minor),
    paymentMode: b.payment_mode,
    paymentStatus: b.payment_status,
    cancellationCutoffHours: b.cancellation_cutoff_hours,
    holdExpiresAt: holdLive ? b.hold_expires_at!.toISOString() : null,
    secondsRemaining: holdLive
      ? Math.max(0, Math.ceil((b.hold_expires_at!.getTime() - extra.now.getTime()) / 1000))
      : null,
    serverNow: extra.now.toISOString(),
    cancelledAt: b.cancelled_at?.toISOString() ?? null,
    cancelledBy: b.cancelled_by,
    cancelReason: b.cancel_reason,
    checkedInAt: b.checked_in_at?.toISOString() ?? null,
    createdAt: b.created_at.toISOString(),
    version: b.version,
    ...(extra.items && { items: extra.items.map(itemJson) }),
  }
}

export const BOOKING_COLS = Prisma.sql`id, ref, venue_id, court_id, user_id, source, customer_name, customer_phone,
  customer_email, headcount, status, payment_mode, payment_status, start_at, end_at, business_date, total_minor,
  original_total_minor, deposit_minor, online_paid_minor, cash_collected_minor, refunded_minor, forfeited_minor,
  refund_pending_minor, balance_due_minor, slot_ids, hold_id, hold_expires_at, cancellation_cutoff_hours,
  cancelled_at, cancelled_by, cancel_reason, checked_in_at, no_show_at, version, created_at`

export const ITEM_COLS = Prisma.sql`id, booking_id, slot_id, court_id, start_at, end_at, price_minor, online_paid_minor,
  deposit_share_minor, status, refund_due_minor, forfeit_minor, cancelled_at, cancelled_by`

export async function loadBooking(
  db: PrismaClient | Prisma.TransactionClient,
  id: string,
): Promise<BookingRowRaw | null> {
  const r = await db.$queryRaw<
    BookingRowRaw[]
  >`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ${id}::uuid`
  return r[0] ?? null
}
export async function loadItems(db: PrismaClient | Prisma.TransactionClient, bookingId: string) {
  return db.$queryRaw<ItemRowRaw[]>`
    SELECT ${ITEM_COLS} FROM booking_items WHERE booking_id = ${bookingId}::uuid ORDER BY start_at`
}
export async function lockBooking(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<BookingRowRaw | null> {
  const r = await tx.$queryRaw<
    BookingRowRaw[]
  >`SELECT ${BOOKING_COLS} FROM bookings WHERE id = ${id}::uuid FOR UPDATE`
  return r[0] ?? null
}
export async function dbNowOf(db: PrismaClient | Prisma.TransactionClient): Promise<Date> {
  return (await db.$queryRaw<{ n: Date }[]>`SELECT clock_timestamp() AS n`)[0].n
}

// ───────────── cancellation (shared by player, staff, admin and the outage lock) ─────────────
export interface CancelCommand {
  bookingId: string
  itemIds?: string[]
  cancelledBy: 'USER' | 'VENUE' | 'SYSTEM'
  reason?: string | null
  actorId: string | null
  cancellationId: string
  releaseTo?: 'AVAILABLE' | 'BLOCKED'
  blockReason?: string | null
  blockRef?: string | null
}
export interface CancelResult {
  cancellationId: string
  bookingId: string
  bookingRef: string
  venueId: string
  userId: string | null
  cancelledBy: string
  reason: string | null
  items: Array<Record<string, unknown>>
  refundDueMinor: number
  forfeitMinor: number
  bookingFullyCancelled: boolean
  booking: {
    status: string
    totalMinor: number
    depositMinor: number
    balanceDueMinor: number
    activeItemCount: number
  }
  slots: SlotUpdate[]
  replayed: boolean
}

export function mapCancelError(e: unknown): never {
  const pg = pgError(e)
  if (!pg) throw e
  const m = pg.message
  if (m.startsWith('BOOKING_NOT_FOUND'))
    throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND')
  if (m.startsWith('FORBIDDEN'))
    throw new ForbiddenError('You cannot cancel this booking', 'FORBIDDEN')
  if (m.startsWith('BOOKING_NOT_CANCELLABLE'))
    throw new ConflictError(
      'This booking cannot be cancelled in its current state',
      'BOOKING_NOT_CANCELLABLE',
      {
        status: m.split(':')[1] ?? null,
      },
    )
  if (m.startsWith('ITEM_ALREADY_STARTED'))
    throw new ConflictError('That hour has already started', 'ITEM_ALREADY_STARTED')
  if (m.startsWith('ITEM_NOT_CANCELLABLE'))
    throw new ConflictError(
      'One or more hours cannot be cancelled (unknown or already cancelled)',
      'ITEM_NOT_CANCELLABLE',
    )
  if (m.startsWith('IDEMPOTENCY_CONFLICT'))
    throw new ConflictError(
      'This Idempotency-Key was already used for a different request',
      'IDEMPOTENCY_CONFLICT',
    )
  if (m.startsWith('NO_ITEMS_SPECIFIED') || m.startsWith('INVALID_ARGUMENT'))
    throw new BadRequestError('Invalid cancellation request', 'VALIDATION_ERROR')
  throw e
}

/**
 * One round trip, one transaction: the SQL function cancel_booking_items owns every invariant
 * (per-hour cutoff, money, freeing the hours, parent recalculation, event, audit). Afterwards the
 * hot lane is told, but only for a first call: a replay publishes nothing new.
 */
export async function cancelBookingItems(
  prisma: PrismaClient,
  hotLane: HotLane,
  cmd: CancelCommand,
): Promise<CancelResult> {
  let result: CancelResult
  try {
    result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`)
        let itemIds = cmd.itemIds
        if (!itemIds || itemIds.length === 0) {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM booking_items WHERE booking_id = ${cmd.bookingId}::uuid AND status = 'CONFIRMED'`
          itemIds = rows.map((r) => r.id)
          // a replay of a full cancellation has no CONFIRMED items left: let the function answer from its stored result
          if (itemIds.length === 0) itemIds = ['00000000-0000-0000-0000-000000000000']
        }
        const rows = await tx.$queryRaw<{ r: CancelResult }[]>`
          SELECT cancel_booking_items(${cmd.bookingId}::uuid, ${itemIds}::uuid[], ${cmd.cancelledBy}, ${cmd.reason ?? null},
            ${cmd.actorId}::uuid, ${cmd.cancellationId}::uuid, ${cmd.releaseTo ?? 'AVAILABLE'}, ${cmd.blockReason ?? null},
            ${cmd.blockRef ?? null}::uuid) AS r`
        return rows[0].r
      },
      { maxWait: 20_000, timeout: 20_000 },
    )
  } catch (e) {
    mapCancelError(e)
  }
  if (!result.replayed) {
    const at = new Date()
    publishSlotUpdates(hotLane, result.slots, at)
    publishBookingUpdate(hotLane, {
      bookingId: result.bookingId,
      ref: result.bookingRef,
      venueId: result.venueId,
      userId: result.userId,
      status: result.booking.status,
    })
  }
  return result
}

/** Response shape for a cancellation: hides the internal slot list, keeps money as numbers. */
export const cancelResponse = (r: CancelResult) => {
  const { slots, ...rest } = r
  return { ...rest, freedSlotIds: slots.map((s) => s.slotId) }
}
