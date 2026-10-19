-- Phase 3: payments, webhooks, refunds, disputes, ledger, daily closings, payouts, reconciliation.
-- Hand-written (constraints, triggers, functions). Final state only: the doc's baseline DDL and the
-- migrations that supersede it (F6 verified-only webhook table, F7 late success, F10 ledger uniqueness)
-- are merged. Backend_Docs/04_Phase_3_Payments_Ledger_Settlement.md.

-- ───────────────────────── payments ─────────────────────────
CREATE TABLE "payments" (
  "id"                    UUID NOT NULL,
  "reference_type"        TEXT NOT NULL CHECK ("reference_type" IN ('BOOKING','TOURNAMENT_REGISTRATION')),
  "reference_id"          UUID NOT NULL,
  "payer_user_id"         UUID NOT NULL,
  "venue_id"              UUID NOT NULL,
  "purpose"               TEXT NOT NULL CHECK ("purpose" IN ('DEPOSIT','FULL','BALANCE_ONLINE','ENTRY_FEE')),
  "mode"                  TEXT,
  "method"                TEXT NOT NULL CHECK ("method" IN ('RAAST','EASYPAISA','JAZZCASH','CARD')),
  "gateway"               TEXT NOT NULL,
  "amount_minor"          BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "currency"              CHAR(3) NOT NULL DEFAULT 'PKR',
  "status"                TEXT NOT NULL CHECK ("status" IN
                          ('INITIATED','PENDING','SUCCEEDED','FAILED','EXPIRED','PARTIALLY_REFUNDED','REFUNDED')),
  "gateway_ref"           TEXT,
  "gateway_session_id"    TEXT,
  "redirect_url"          TEXT,
  "idempotency_key"       TEXT,
  "expires_at"            TIMESTAMPTZ,
  "paid_at"               TIMESTAMPTZ,
  "failure_reason"        TEXT,
  "refund_required_reason" TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payments_gateway_ref_key" UNIQUE ("gateway", "gateway_ref"),
  CONSTRAINT "payments_idempotency_key_key" UNIQUE ("idempotency_key")
);
CREATE INDEX "payments_ref" ON "payments" ("reference_type", "reference_id");
CREATE INDEX "payments_pending" ON "payments" ("expires_at") WHERE "status" IN ('INITIATED','PENDING');
CREATE INDEX "payments_payer" ON "payments" ("payer_user_id", "created_at" DESC);
CREATE INDEX "payments_venue" ON "payments" ("venue_id", "created_at" DESC);

-- Webhook ledger: ONLY signature-verified events live here (F6). Rejected calls go to webhook_rejections.
CREATE TABLE "payment_events" (
  "id"                BIGSERIAL NOT NULL,
  "gateway"           TEXT NOT NULL,
  "gateway_event_id"  TEXT NOT NULL,
  "event_type"        TEXT NOT NULL CHECK ("event_type" IN
                      ('PAYMENT_SUCCEEDED','PAYMENT_FAILED','PAYMENT_EXPIRED','REFUND_SUCCEEDED','REFUND_FAILED','OTHER')),
  "payment_id"        UUID,
  "reference_type"    TEXT,
  "reference_id"      UUID,
  "amount_minor"      BIGINT,
  "currency"          CHAR(3),
  "gateway_paid_at"   TIMESTAMPTZ,
  "raw"               JSONB NOT NULL,
  "processing_status" TEXT NOT NULL DEFAULT 'RECEIVED' CHECK ("processing_status" IN
                      ('RECEIVED','PROCESSED','FAILED','UNMATCHED','AMOUNT_MISMATCH',
                       'EXPIRED_HOLD_REFUND_REQUIRED','REFUND_REQUIRED','REFUND_COMPLETED','RESOLVED')),
  "outcome"           TEXT,
  "outcome_detail"    JSONB,
  "received_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at"      TIMESTAMPTZ,
  CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_events_gateway_event_uniq" UNIQUE ("gateway", "gateway_event_id")
);
CREATE INDEX "payment_events_payment" ON "payment_events" ("payment_id", "event_type");
CREATE INDEX "payment_events_attention" ON "payment_events" ("processing_status", "received_at")
  WHERE "processing_status" NOT IN ('PROCESSED','REFUND_COMPLETED','RESOLVED');

CREATE TABLE "webhook_rejections" (
  "id"          BIGSERIAL NOT NULL,
  "gateway"     TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "headers"     JSONB NOT NULL,
  "body_sha256" TEXT NOT NULL,
  "source_ip"   TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "webhook_rejections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
  "id"                    UUID NOT NULL,
  "payment_id"            UUID NOT NULL REFERENCES "payments"("id"),
  "amount_minor"          BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "reason"                TEXT NOT NULL,
  "reason_code"           TEXT,
  "kind"                  TEXT NOT NULL CHECK ("kind" IN ('CANCELLATION','LATE_PAYMENT','NO_SHOW','MANUAL','DISPUTE')),
  "status"                TEXT NOT NULL CHECK ("status" IN
                          ('PENDING_APPROVAL','REQUESTED','PROCESSING','SUCCEEDED','FAILED','REJECTED')),
  "gateway_refund_ref"    TEXT,
  "initiated_by"          TEXT NOT NULL,
  "requested_by"          UUID,
  "approved_by"           UUID,
  "attempts"              INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processing_started_at" TIMESTAMPTZ,
  "last_error"            TEXT,
  "idempotency_key"       TEXT,
  "cancellation_id"       UUID,
  "source_event_id"       UUID,
  "booking_id"            UUID,
  "dispute_id"            UUID,
  -- does the refund take money back from the venue's books (false for a payment that was never booked)
  "venue_impact"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_idempotency_uniq" UNIQUE ("idempotency_key")
);
CREATE INDEX "refunds_queue" ON "refunds" ("next_attempt_at") WHERE "status" IN ('REQUESTED','PROCESSING');
CREATE INDEX "refunds_payment" ON "refunds" ("payment_id");
CREATE INDEX "refunds_cancellation" ON "refunds" ("cancellation_id") WHERE "cancellation_id" IS NOT NULL;
CREATE INDEX "refunds_booking" ON "refunds" ("booking_id") WHERE "booking_id" IS NOT NULL;

-- How each payment was resolved against a booking: one resolution per payment, ever
CREATE TABLE "booking_payments" (
  "payment_id"       UUID NOT NULL,
  "booking_id"       UUID NOT NULL REFERENCES "bookings"("id"),
  "payment_event_id" BIGINT,
  "amount_minor"     BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "paid_at"          TIMESTAMPTZ,
  "resolution"       TEXT NOT NULL CHECK ("resolution" IN ('APPLIED','APPLIED_LATE','REFUND_REQUIRED')),
  "reason_code"      TEXT,
  "resolved_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "booking_payments_pkey" PRIMARY KEY ("payment_id")
);
CREATE INDEX "booking_payments_booking" ON "booking_payments" ("booking_id");

-- ───────────────────────── disputes ─────────────────────────
CREATE TABLE "disputes" (
  "id"                      UUID NOT NULL,
  "booking_id"              UUID NOT NULL REFERENCES "bookings"("id"),
  "venue_id"                UUID NOT NULL,
  "opened_by"               UUID NOT NULL,
  "opener_role"             TEXT NOT NULL CHECK ("opener_role" IN ('PLAYER','VENUE')),
  "category"                TEXT NOT NULL CHECK ("category" IN ('VENUE_CLOSED','WRONG_CHARGE','NO_SHOW_CONTEST','COURT_CONDITION','OTHER')),
  "description"             TEXT NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'OPEN' CHECK ("status" IN ('OPEN','UNDER_REVIEW','RESOLVED','REJECTED')),
  "resolution"              TEXT CHECK ("resolution" IN ('REFUND_FULL','REFUND_PARTIAL','WAIVE_FORFEIT','NO_ACTION')),
  "resolution_amount_minor" BIGINT CHECK ("resolution_amount_minor" >= 0),
  "proposal"                JSONB,                    -- a money resolution above the threshold waits for a second admin
  "proposed_by"             UUID,
  "resolved_by"             UUID,
  "resolved_note"           TEXT,
  "resolved_at"             TIMESTAMPTZ,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "disputes_one_open" ON "disputes" ("booking_id", "opener_role") WHERE "status" IN ('OPEN','UNDER_REVIEW');
CREATE INDEX "disputes_status" ON "disputes" ("status", "created_at");

-- ───────────────────────── ledger (append-only) ─────────────────────────
CREATE TABLE "ledger_entries" (
  "id"                BIGSERIAL NOT NULL,
  "event_id"          UUID NOT NULL,
  "venue_id"          UUID NOT NULL,
  "business_date"     DATE NOT NULL,
  "entry_type"        TEXT NOT NULL CHECK ("entry_type" IN
                      ('ONLINE_PAYMENT_IN','CASH_COLLECTED','WALKIN_CASH','ENTRY_FEE_IN','COMMISSION',
                       'REFUND_OUT','DEPOSIT_FORFEITED','PAYOUT','ADJUSTMENT','REVERSAL')),
  "direction"         TEXT NOT NULL CHECK ("direction" IN ('CREDIT','DEBIT')),
  "amount_minor"      BIGINT NOT NULL CHECK ("amount_minor" > 0),
  "reference_type"    TEXT,
  "reference_id"      UUID,
  "payment_id"        UUID,
  "reverses_entry_id" BIGINT REFERENCES "ledger_entries"("id"),
  "recorded_by"       TEXT NOT NULL,
  "note"              TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
  -- F10: one payment event posts several entries (payment-in AND commission), but each only once
  CONSTRAINT "ledger_entries_event_type_uniq" UNIQUE ("event_id", "entry_type", "direction")
);
CREATE INDEX "ledger_venue_day" ON "ledger_entries" ("venue_id", "business_date", "entry_type");
CREATE INDEX "ledger_venue_id" ON "ledger_entries" ("venue_id", "id");

CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END $$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

CREATE TABLE "daily_closings" (
  "id"                 UUID NOT NULL,
  "venue_id"           UUID NOT NULL,
  "business_date"      DATE NOT NULL,
  "expected"           JSONB NOT NULL,
  "counted_cash_minor" BIGINT NOT NULL CHECK ("counted_cash_minor" >= 0),
  "variance_minor"     BIGINT NOT NULL,
  "notes"              TEXT,
  "status"             TEXT NOT NULL CHECK ("status" IN ('CLOSED','REOPENED')),
  "closed_by"          UUID NOT NULL,
  "closed_at"          TIMESTAMPTZ NOT NULL,
  "reopened_by"        UUID,
  "reopened_at"        TIMESTAMPTZ,
  "reopen_reason"      TEXT,
  "ledger_watermark"   TIMESTAMPTZ NOT NULL,
  "warnings"           JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "daily_closings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daily_closings_venue_date_key" UNIQUE ("venue_id", "business_date")
);

CREATE TABLE "payouts" (
  "id"                   UUID NOT NULL,
  "venue_id"             UUID NOT NULL,
  "period_from"          DATE NOT NULL,
  "period_to"            DATE NOT NULL,
  "gross_online_minor"   BIGINT NOT NULL,
  "commission_minor"     BIGINT NOT NULL,
  "refunds_minor"        BIGINT NOT NULL,
  "adjustments_minor"    BIGINT NOT NULL,
  "carry_forward_minor"  BIGINT NOT NULL DEFAULT 0,
  "net_minor"            BIGINT NOT NULL,
  "currency"             CHAR(3) NOT NULL DEFAULT 'PKR',
  "status"               TEXT NOT NULL CHECK ("status" IN ('DRAFT','APPROVED','PAID','FAILED','CARRIED')),
  "ledger_from_id"       BIGINT NOT NULL DEFAULT 0,
  "ledger_to_id"         BIGINT NOT NULL DEFAULT 0,
  "approved_by"          UUID,
  "approved_at"          TIMESTAMPTZ,
  "paid_at"              TIMESTAMPTZ,
  "bank_ref"             TEXT,
  "statement_url"        TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payouts_watermark_check" CHECK ("ledger_to_id" >= "ledger_from_id")
);
-- Payouts are defined by a ledger watermark, never by dates alone: late events cannot be missed or paid twice
CREATE UNIQUE INDEX "payouts_no_overlap" ON "payouts" ("venue_id", "ledger_to_id");
CREATE INDEX "payouts_status" ON "payouts" ("status", "created_at");

CREATE TABLE "payout_lines" (
  "id"               BIGSERIAL NOT NULL,
  "payout_id"        UUID NOT NULL REFERENCES "payouts"("id"),
  "reference_type"   TEXT NOT NULL,
  "reference_id"     UUID NOT NULL,
  "gross_minor"      BIGINT NOT NULL,
  "commission_minor" BIGINT NOT NULL,
  "refunds_minor"    BIGINT NOT NULL,
  CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "payout_lines_payout" ON "payout_lines" ("payout_id");

-- ───────────────────────── reconciliation ─────────────────────────
CREATE TABLE "reconciliation_runs" (
  "id"            UUID NOT NULL,
  "gateway"       TEXT NOT NULL,
  "business_date" DATE NOT NULL,
  "status"        TEXT NOT NULL CHECK ("status" IN ('RUNNING','COMPLETED','FAILED')),
  "matched"       INTEGER NOT NULL DEFAULT 0,
  "mismatched"    INTEGER NOT NULL DEFAULT 0,
  "report_sha256" TEXT,
  "started_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finished_at"   TIMESTAMPTZ,
  CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reconciliation_runs_gateway_date_key" UNIQUE ("gateway", "business_date")
);
CREATE TABLE "reconciliation_items" (
  "id"                   BIGSERIAL NOT NULL,
  "run_id"               UUID NOT NULL REFERENCES "reconciliation_runs"("id"),
  "gateway_ref"          TEXT,
  "payment_id"           UUID,
  "diff_type"            TEXT NOT NULL CHECK ("diff_type" IN ('MISSING_IN_DB','MISSING_AT_GATEWAY','AMOUNT_DIFF','STATUS_DIFF','FEE_DIFF')),
  "our_amount_minor"     BIGINT,
  "gateway_amount_minor" BIGINT,
  "gateway_fee_minor"    BIGINT,
  "resolution"           TEXT CHECK ("resolution" IN ('OPEN','FIXED','ACCEPTED','REFUNDED')),
  "resolved_by"          UUID,
  "note"                 TEXT,
  CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reconciliation_open" ON "reconciliation_items" ("run_id") WHERE "resolution" = 'OPEN';

-- ───────────────────────── mock gateway (development and tests only) ─────────────────────────
-- What a payment provider would hold on its side. Lives in our database only so the API process and the
-- worker see the same "gateway" and so reconciliation has a settlement report to compare with.
CREATE TABLE "mock_gateway_txns" (
  "session_id"    TEXT NOT NULL,
  "amount_minor"  BIGINT NOT NULL,
  "currency"      CHAR(3) NOT NULL DEFAULT 'PKR',
  "status"        TEXT NOT NULL CHECK ("status" IN ('CREATED','PAID','FAILED','EXPIRED')),
  "paid_at"       TIMESTAMPTZ,
  "fee_minor"     BIGINT NOT NULL DEFAULT 0,
  "refunded_minor" BIGINT NOT NULL DEFAULT 0,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "mock_gateway_txns_pkey" PRIMARY KEY ("session_id")
);
CREATE TABLE "mock_gateway_refunds" (
  "idempotency_key" TEXT NOT NULL,
  "refund_ref"      TEXT NOT NULL,
  "session_id"      TEXT NOT NULL,
  "amount_minor"    BIGINT NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "mock_gateway_refunds_pkey" PRIMARY KEY ("idempotency_key")
);

-- ───────────────────────── booking side: settle a cancellation refund ─────────────────────────
CREATE OR REPLACE FUNCTION apply_refund_result(
  p_cancellation_id uuid,
  p_refunded_minor  bigint
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id uuid;
  v_c          booking_cancellations%ROWTYPE;
  v_marked     int := 0;
BEGIN
  SELECT booking_id INTO v_booking_id FROM booking_cancellations WHERE id = p_cancellation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCELLATION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  PERFORM 1 FROM bookings WHERE id = v_booking_id FOR UPDATE;          -- same lock order as cancel
  SELECT * INTO v_c FROM booking_cancellations WHERE id = p_cancellation_id FOR UPDATE;

  IF v_c.refunded_minor + p_refunded_minor > v_c.refund_due_minor THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_DUE' USING ERRCODE = '55000';
  END IF;

  UPDATE booking_cancellations SET refunded_minor = refunded_minor + p_refunded_minor WHERE id = p_cancellation_id;

  UPDATE bookings
     SET refunded_minor       = refunded_minor + p_refunded_minor,
         refund_pending_minor = refund_pending_minor - p_refunded_minor,
         payment_status       = CASE WHEN status LIKE 'CANCELLED%'
                                      AND refund_pending_minor - p_refunded_minor = 0
                                     THEN 'REFUNDED' ELSE payment_status END,
         version              = version + 1,
         updated_at           = now()
   WHERE id = v_booking_id;

  IF v_c.refunded_minor + p_refunded_minor = v_c.refund_due_minor THEN
    UPDATE booking_items
       SET status = 'REFUNDED', version = version + 1, updated_at = now()
     WHERE cancellation_id = p_cancellation_id AND status = 'CANCELLED' AND refund_due_minor > 0;
    GET DIAGNOSTICS v_marked = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('cancellationId', p_cancellation_id, 'itemsMarkedRefunded', v_marked,
                            'fullyRefunded', (v_c.refunded_minor + p_refunded_minor = v_c.refund_due_minor));
END $$;
