import { Prisma } from '@prisma/client'

/** Raw `bookings` row as selected by BOOKING_COLS. */
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

/** Raw `booking_items` row as selected by ITEM_COLS. */
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

export const BOOKING_COLS = Prisma.sql`id, ref, venue_id, court_id, user_id, source, customer_name, customer_phone,
  customer_email, headcount, status, payment_mode, payment_status, start_at, end_at, business_date, total_minor,
  original_total_minor, deposit_minor, online_paid_minor, cash_collected_minor, refunded_minor, forfeited_minor,
  refund_pending_minor, balance_due_minor, slot_ids, hold_id, hold_expires_at, cancellation_cutoff_hours,
  cancelled_at, cancelled_by, cancel_reason, checked_in_at, no_show_at, version, created_at`

export const ITEM_COLS = Prisma.sql`id, booking_id, slot_id, court_id, start_at, end_at, price_minor, online_paid_minor,
  deposit_share_minor, status, refund_due_minor, forfeit_minor, cancelled_at, cancelled_by`
