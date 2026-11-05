-- POS walk-in/manual booking payment method (Cash / Bank transfer / Free). Only CASH amounts post
-- to the cash ledger (ledger_entries, already migrated in 20260519000000_phase3_payments_ledger) --
-- a bank transfer or a comp never touches the physical cash drawer.
ALTER TABLE "bookings" ADD COLUMN "payment_method" TEXT NOT NULL DEFAULT 'CASH';
ALTER TABLE "bookings" ADD CONSTRAINT bookings_payment_method_check
  CHECK (payment_method IN ('CASH','BANK_TRANSFER','FREE'));

-- outage_locks.reason was narrower than slots.block_reason (which already allows PRIVATE_EVENT) --
-- the POS "Rain Lock" screen offers Heavy rain / Power cut / Pitch repair / Private event as the
-- four reasons, so the outage reason enum needs to match.
ALTER TABLE "outage_locks" DROP CONSTRAINT "outage_locks_reason_check";
ALTER TABLE "outage_locks" ADD CONSTRAINT "outage_locks_reason_check"
  CHECK (reason IN ('RAIN','POWER_OUTAGE','MAINTENANCE','PRIVATE_EVENT','OTHER'));
