import { Prisma } from '@prisma/client'
import { uuidv7 } from '../../../lib/id'
import { Db } from '../../../lib/outbox'

/**
 * The physical cash drawer slice of `ledger_entries` / `daily_closings` (both tables were already
 * migrated for the full Phase 3 design; only the cash entry types are posted here — no payment
 * gateway exists yet, so ONLINE_PAYMENT_IN / COMMISSION / PAYOUT are out of scope).
 */
export type CashEntryType = 'WALKIN_CASH' | 'CASH_COLLECTED' | 'REFUND_OUT'

export interface LedgerEntryInput {
  venueId: string
  businessDate: string // yyyy-mm-dd
  entryType: CashEntryType
  direction: 'CREDIT' | 'DEBIT'
  amountMinor: bigint
  referenceType: 'BOOKING'
  referenceId: string
  recordedBy: string
  note?: string | null
  eventId?: string
}

export interface LedgerTotals {
  walkinCashMinor: bigint
  cashCollectedMinor: bigint
  cashRefundMinor: bigint
  /** walkinCash + cashCollected - cashRefund: what should physically be in the drawer. */
  expectedCashMinor: bigint
}

/** JSON-safe (plain number) version of LedgerTotals, as stored in daily_closings.expected. */
export interface ExpectedBreakdown {
  walkinCashMinor: number
  cashCollectedMinor: number
  cashRefundMinor: number
  expectedCashMinor: number
}

export interface ClosingRow {
  id: string
  venue_id: string
  business_date: Date
  expected: unknown
  counted_cash_minor: bigint
  variance_minor: bigint
  notes: string | null
  status: string
  closed_by: string
  closed_at: Date
  reopened_by: string | null
  reopened_at: Date | null
  reopen_reason: string | null
  ledger_watermark: Date
  warnings: unknown
}

const CLOSING_COLS = Prisma.sql`id, venue_id, business_date, expected, counted_cash_minor, variance_minor, notes,
  status, closed_by, closed_at, reopened_by, reopened_at, reopen_reason, ledger_watermark, warnings`

export function ledgerQueries(db: Db) {
  return {
    /**
     * Append-only cash movement. `eventId` defaults to a fresh id: the callers here are already
     * guarded against double-execution upstream (an idempotent mediator transaction, or a cancel
     * whose replay is detected before this runs), so a stable id is not needed for correctness —
     * the ON CONFLICT is a belt-and-braces guard against a genuine double emit, not a dedupe key.
     */
    async postLedgerEntry(input: LedgerEntryInput): Promise<void> {
      // `id` is BIGSERIAL (auto-increment), unlike every other table in this app — only `event_id`
      // is the app-generated uuid.
      await db.$executeRaw`
        INSERT INTO ledger_entries
          (event_id, venue_id, business_date, entry_type, direction, amount_minor,
           reference_type, reference_id, recorded_by, note)
        VALUES (${input.eventId ?? uuidv7()}::uuid, ${input.venueId}::uuid, ${input.businessDate}::date,
          ${input.entryType}, ${input.direction}, ${input.amountMinor}, ${input.referenceType}, ${input.referenceId}::uuid,
          ${input.recordedBy}, ${input.note ?? null})
        ON CONFLICT ON CONSTRAINT ledger_entries_event_type_uniq DO NOTHING`
    },

    /** Cash-only totals for one venue-day: what a closing should expect in the drawer. */
    async ledgerTotalsForDay(venueId: string, businessDate: string): Promise<LedgerTotals> {
      const rows = await db.$queryRaw<{ entry_type: string; total: bigint }[]>`
        SELECT entry_type, COALESCE(SUM(amount_minor), 0)::bigint AS total
          FROM ledger_entries
         WHERE venue_id = ${venueId}::uuid AND business_date = ${businessDate}::date
           AND entry_type IN ('WALKIN_CASH', 'CASH_COLLECTED', 'REFUND_OUT')
         GROUP BY entry_type`
      const by = new Map(rows.map((r) => [r.entry_type, r.total]))
      const walkinCashMinor = by.get('WALKIN_CASH') ?? 0n
      const cashCollectedMinor = by.get('CASH_COLLECTED') ?? 0n
      const cashRefundMinor = by.get('REFUND_OUT') ?? 0n
      return {
        walkinCashMinor,
        cashCollectedMinor,
        cashRefundMinor,
        expectedCashMinor: walkinCashMinor + cashCollectedMinor - cashRefundMinor,
      }
    },

    getClosing: (venueId: string, businessDate: string) =>
      db
        .$queryRaw<
          ClosingRow[]
        >`SELECT ${CLOSING_COLS} FROM daily_closings WHERE venue_id = ${venueId}::uuid AND business_date = ${businessDate}::date`
        .then((r) => r[0] ?? null),

    /** False when the day is already closed (unique (venue_id, business_date) stopped the insert). */
    async insertClosing(c: {
      id: string
      venueId: string
      businessDate: string
      expected: ExpectedBreakdown
      countedCashMinor: bigint
      varianceMinor: bigint
      notes: string | null
      closedBy: string
      closedAt: Date
      ledgerWatermark: Date
    }): Promise<boolean> {
      const n = await db.$executeRaw`
        INSERT INTO daily_closings
          (id, venue_id, business_date, expected, counted_cash_minor, variance_minor, notes,
           status, closed_by, closed_at, ledger_watermark, warnings)
        VALUES (${c.id}::uuid, ${c.venueId}::uuid, ${c.businessDate}::date, ${JSON.stringify(c.expected)}::jsonb,
          ${c.countedCashMinor}, ${c.varianceMinor}, ${c.notes}, 'CLOSED', ${c.closedBy}::uuid, ${c.closedAt},
          ${c.ledgerWatermark}, '[]'::jsonb)
        ON CONFLICT ON CONSTRAINT daily_closings_venue_date_key DO NOTHING`
      return n === 1
    },

    /** True when a CLOSED row existed and was reopened. */
    async reopenClosing(
      venueId: string,
      businessDate: string,
      reopenedBy: string,
      reason: string,
    ): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE daily_closings
           SET status = 'REOPENED', reopened_by = ${reopenedBy}::uuid, reopened_at = clock_timestamp(),
               reopen_reason = ${reason}
         WHERE venue_id = ${venueId}::uuid AND business_date = ${businessDate}::date AND status = 'CLOSED'`
      return n === 1
    },
  }
}
