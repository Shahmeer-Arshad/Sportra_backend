-- Regression fix. 20260518000000_phase2_booking created
-- booking_items.cancellation_id REFERENCES booking_cancellations(id) DEFERRABLE INITIALLY DEFERRED
-- on purpose: cancel_booking_items() sets booking_items.cancellation_id BEFORE it inserts the
-- matching booking_cancellations row, later in the same transaction (see that migration's step 5
-- vs step 8). 20261029174559_fk_cleanup dropped and re-added this FK without the DEFERRABLE
-- clause (an artifact of an auto-generated drop/recreate), which makes every cancellation fail
-- with a foreign-key violation. Restoring the original, documented behavior.
ALTER TABLE "booking_items"
  ALTER CONSTRAINT "booking_items_cancellation_id_fkey" DEFERRABLE INITIALLY DEFERRED;
