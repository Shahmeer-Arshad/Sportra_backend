import { createHash } from 'crypto'
import { env } from '../../config/env'
import { SlotUpdate } from './booking.inventory'
import { BookingRowRaw, ItemRowRaw } from './repositories/columns'

/** Money leaves the API as plain numbers (paisa). BigInt is not JSON-safe and values are far below 2^53. */
export const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v))

export const qrSecret = () =>
  env.QR_PASS_SECRET ??
  createHash('sha256').update(`qr-pass:${env.ACCESS_TOKEN_SECRET}`).digest('hex')

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

/** Response shape for a cancellation: hides the internal slot list, keeps money as numbers. */
export const cancelResponse = (r: CancelResult) => {
  const { slots, ...rest } = r
  return { ...rest, freedSlotIds: slots.map((s) => s.slotId) }
}

// ───────────── outage lock ─────────────
export const outageJson = (l: {
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

/** A walk-in or manual booking that needs a phone call when a window closes. */
export const manualCallJson = (m: {
  id: string
  ref: string
  source: string
  customer_name: string
  customer_phone: string
  start_at: Date
}) => ({
  bookingId: m.id,
  ref: m.ref,
  source: m.source,
  customerName: m.customer_name,
  customerPhone: m.customer_phone,
  startAt: m.start_at.toISOString(),
})
