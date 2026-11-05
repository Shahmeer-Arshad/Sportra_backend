/**
 * The POS cash drawer: the live-grid header tiles (cash today, still to collect, arriving next,
 * cash in drawer) and the "Close Today's Cash" screen. Reads `ledger_entries` (cash entry types
 * only — see repositories/ledger.queries.ts) and `daily_closings`, both already migrated for the
 * full Phase 3 design; this service only ever touches the cash slice of them.
 */
import { addDays, todayIn } from '../../lib/time'
import { BookingQueries } from './booking.repository'
import { num } from './booking.view'

export function createClosingService(repo: BookingQueries) {
  async function expectedBreakdown(venueId: string, date: string) {
    const totals = await repo.ledgerTotalsForDay(venueId, date)
    return {
      walkinCashMinor: num(totals.walkinCashMinor),
      cashCollectedMinor: num(totals.cashCollectedMinor),
      cashRefundMinor: num(totals.cashRefundMinor),
      expectedCashMinor: num(totals.expectedCashMinor),
    }
  }

  return {
    async daySummary(venueId: string, date: string) {
      const now = await repo.clock()
      const [slotCounts, stillToCollect, arriving, courts, expected, closing, bookingsToday] =
        await Promise.all([
          repo.slotCounts(venueId, date),
          repo.stillToCollectForDay(venueId, date),
          repo.arrivingNext(venueId, date, now, 8),
          repo.courtNamesOfVenue(venueId),
          expectedBreakdown(venueId, date),
          repo.getClosing(venueId, date),
          repo.bookingCountsForDay(venueId, date),
        ])
      const courtName = new Map(courts.map((c) => [c.id, c.name]))
      // after a close, whatever staff counted is presumed pulled from the drawer; only cash that
      // arrived after that count is still sitting in it
      const cashInDrawerMinor =
        closing && closing.status === 'CLOSED'
          ? Math.max(0, expected.expectedCashMinor - num(closing.counted_cash_minor))
          : expected.expectedCashMinor

      return {
        venueId,
        date,
        serverNow: now.toISOString(),
        bookedHours: slotCounts.booked,
        totalHours: slotCounts.total,
        cashTodayMinor: expected.expectedCashMinor,
        stillToCollectMinor: num(stillToCollect.amountMinor),
        stillToCollectBookingCount: stillToCollect.bookingCount,
        cashInDrawerMinor,
        bookingsToday,
        expected,
        alreadyClosed: !!closing && closing.status === 'CLOSED',
        arrivingNext: arriving.map((b) => ({
          bookingId: b.id,
          ref: b.ref,
          source: b.source,
          customerName: b.customer_name,
          startAt: b.start_at.toISOString(),
          courtName: courtName.get(b.court_id) ?? null,
          dueMinor: num(b.balance_due_minor),
        })),
      }
    },

    /** Rolling N-day occupancy (today through today+days-1) for a My Grounds card. */
    async occupancy(venueId: string, days: number) {
      const venue = await repo.venueById(venueId)
      const from = todayIn(venue?.timezone)
      const to = addDays(from, Math.max(1, days) - 1)
      const { total, booked } = await repo.slotCountsRange(venueId, from, to)
      return {
        venueId,
        from,
        to,
        bookedHours: booked,
        totalHours: total,
        pct: total > 0 ? Math.round((booked / total) * 100) : 0,
      }
    },

    async closingPreview(venueId: string, date: string) {
      return { venueId, date, expected: await expectedBreakdown(venueId, date) }
    },

    /** The persisted closing record for a day, or null when it hasn't been closed yet. */
    async getRecordedClosing(venueId: string, date: string) {
      const c = await repo.getClosing(venueId, date)
      if (!c) return null
      return {
        id: c.id,
        venueId: c.venue_id,
        businessDate: date,
        expected: c.expected,
        countedCashMinor: num(c.counted_cash_minor),
        varianceMinor: num(c.variance_minor),
        notes: c.notes,
        status: c.status,
        closedBy: c.closed_by,
        closedAt: c.closed_at.toISOString(),
        reopenedBy: c.reopened_by,
        reopenedAt: c.reopened_at?.toISOString() ?? null,
        reopenReason: c.reopen_reason,
      }
    },
  }
}
export type ClosingService = ReturnType<typeof createClosingService>
