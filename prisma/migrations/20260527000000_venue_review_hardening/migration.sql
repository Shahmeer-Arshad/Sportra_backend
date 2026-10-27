-- Venue review hardening: two-level suspend, review claim, per-submission snapshots, change
-- requests for live venues, copy-of-rejected-venue.

-- 1) venues
ALTER TABLE "venues" ADD COLUMN "suspension_mode" TEXT;
ALTER TABLE "venues" ADD COLUMN "suspended_at" TIMESTAMPTZ;
ALTER TABLE "venues" ADD COLUMN "suspension_lock_id" UUID;
ALTER TABLE "venues" ADD COLUMN "review_claimed_by" UUID;
ALTER TABLE "venues" ADD COLUMN "review_claimed_at" TIMESTAMPTZ;
ALTER TABLE "venues" ADD COLUMN "copied_from" UUID;
ALTER TABLE "venues" ADD CONSTRAINT venues_suspension_mode_check
  CHECK (suspension_mode IS NULL OR suspension_mode IN ('PAUSE_ONLINE','STOP_ALL'));
-- a mode only exists while the venue is suspended
ALTER TABLE "venues" ADD CONSTRAINT venues_suspension_mode_state
  CHECK ((suspension_mode IS NULL) OR verification_status = 'SUSPENDED');
-- suspended venues from before this change are the lighter kind
UPDATE "venues" SET suspension_mode = 'PAUSE_ONLINE', suspended_at = updated_at
 WHERE verification_status = 'SUSPENDED';

-- 2) what the owner submitted, one row per submission (the admin diff compares two of them)
CREATE TABLE "venue_submissions" (
  "id" UUID NOT NULL,
  "venue_id" UUID NOT NULL,
  "submission_no" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "venue_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_submissions_venue_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id"),
  CONSTRAINT "venue_submissions_no_key" UNIQUE ("venue_id", "submission_no")
);

-- 3) edits to a live venue that wait for an admin
CREATE TABLE "venue_change_requests" (
  "id" UUID NOT NULL,
  "venue_id" UUID NOT NULL,
  "op" TEXT NOT NULL,
  "params" JSONB NOT NULL DEFAULT '{}',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "requested_by" UUID NOT NULL,
  "decided_by" UUID,
  "decision_note" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "decided_at" TIMESTAMPTZ,
  CONSTRAINT "venue_change_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_change_requests_venue_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id"),
  CONSTRAINT "venue_change_requests_op_check"
    CHECK (op IN ('court.add','court.update','rule.add','rule.delete','venue.update_hours')),
  CONSTRAINT "venue_change_requests_status_check"
    CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN','FAILED'))
);
CREATE INDEX "venue_change_requests_status" ON "venue_change_requests" ("status", "created_at");
CREATE INDEX "venue_change_requests_venue" ON "venue_change_requests" ("venue_id", "status");
