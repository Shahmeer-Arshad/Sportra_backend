-- Phase 2: slot inventory, holds, itemised bookings, partial cancellation, invites, outage locks.
-- Hand-written: Prisma cannot express exclusion constraints, partial indexes, generated columns
-- or functions. Final state only (the baseline parent-level overlap constraint is never created,
-- see Backend_Docs/03 section 4.2 findings F1-F3).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- UUID v7 for ids generated inside SQL functions (the app uses src/lib/id.ts for everything else).
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
              FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- ───────────────────────── slots ─────────────────────────
CREATE TABLE "slots" (
  "id"              UUID NOT NULL,
  "court_id"        UUID NOT NULL,
  "venue_id"        UUID NOT NULL,
  "start_at"        TIMESTAMPTZ NOT NULL,
  "end_at"          TIMESTAMPTZ NOT NULL,
  "business_date"   DATE NOT NULL,
  "price_minor"     BIGINT NOT NULL CHECK ("price_minor" >= 0),
  "price_tag"       TEXT NOT NULL CHECK ("price_tag" IN ('PEAK','OFF_PEAK')),
  "status"          TEXT NOT NULL DEFAULT 'AVAILABLE'
                    CHECK ("status" IN ('AVAILABLE','HELD','BOOKED_APP','BOOKED_WALKIN','BLOCKED')),
  "hold_id"         UUID,
  "hold_expires_at" TIMESTAMPTZ,
  "booking_id"      UUID,
  "block_reason"    TEXT CHECK ("block_reason" IN ('RAIN','POWER_OUTAGE','MAINTENANCE','PRIVATE_EVENT','TOURNAMENT','OTHER')),
  "block_ref"       UUID,
  "block_note"      TEXT,
  "version"         INTEGER NOT NULL DEFAULT 0,
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "slots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "slots_court_start_key" UNIQUE ("court_id", "start_at"),
  CONSTRAINT "slots_time_check" CHECK ("end_at" > "start_at"),
  CONSTRAINT "slots_hold_check" CHECK (("status" = 'HELD') = ("hold_id" IS NOT NULL AND "hold_expires_at" IS NOT NULL))
) WITH (fillfactor = 80);
CREATE INDEX "slots_grid" ON "slots" ("venue_id", "business_date", "court_id", "start_at");
CREATE INDEX "slots_holds" ON "slots" ("hold_expires_at") WHERE "status" = 'HELD';
CREATE INDEX "slots_booking" ON "slots" ("booking_id") WHERE "booking_id" IS NOT NULL;
CREATE INDEX "slots_block_ref" ON "slots" ("block_ref") WHERE "block_ref" IS NOT NULL;

-- ───────────────────────── bookings ─────────────────────────
CREATE TABLE "bookings" (
  "id"                        UUID NOT NULL,
  "ref"                       TEXT NOT NULL,
  "venue_id"                  UUID NOT NULL,
  "court_id"                  UUID NOT NULL,
  "user_id"                   UUID,                       -- NULL for walk-ins
  "source"                    TEXT NOT NULL CHECK ("source" IN ('APP','WALKIN','MANUAL','TOURNAMENT')),
  "customer_name"             TEXT NOT NULL,
  "customer_phone"            TEXT NOT NULL,
  "customer_email"            TEXT,
  "headcount"                 SMALLINT CHECK ("headcount" BETWEEN 1 AND 100),
  "status"                    TEXT NOT NULL CHECK ("status" IN
                              ('PENDING_PAYMENT','CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW',
                               'CANCELLED_BY_USER','CANCELLED_BY_VENUE','EXPIRED')),
  "payment_mode"              TEXT NOT NULL CHECK ("payment_mode" IN ('DEPOSIT_20','FULL_ONLINE','CASH_ONLY','TOURNAMENT')),
  "payment_status"            TEXT NOT NULL DEFAULT 'UNPAID' CHECK ("payment_status" IN ('UNPAID','PAID','REFUND_REQUIRED','REFUNDED')),
  "start_at"                  TIMESTAMPTZ NOT NULL,
  "end_at"                    TIMESTAMPTZ NOT NULL,
  "business_date"             DATE NOT NULL,
  "total_minor"               BIGINT NOT NULL CHECK ("total_minor" >= 0),
  "original_total_minor"      BIGINT NOT NULL CHECK ("original_total_minor" >= 0),
  "deposit_minor"             BIGINT NOT NULL DEFAULT 0 CHECK ("deposit_minor" >= 0),
  "online_paid_minor"         BIGINT NOT NULL DEFAULT 0 CHECK ("online_paid_minor" >= 0),
  "cash_collected_minor"      BIGINT NOT NULL DEFAULT 0 CHECK ("cash_collected_minor" >= 0),
  "refunded_minor"            BIGINT NOT NULL DEFAULT 0 CHECK ("refunded_minor" >= 0),
  "forfeited_minor"           BIGINT NOT NULL DEFAULT 0 CHECK ("forfeited_minor" >= 0),
  "refund_pending_minor"      BIGINT NOT NULL DEFAULT 0 CHECK ("refund_pending_minor" >= 0),
  "commission_minor"          BIGINT NOT NULL DEFAULT 0 CHECK ("commission_minor" >= 0),
  "slot_ids"                  UUID[] NOT NULL DEFAULT '{}',   -- hold-time intent (F3)
  "hold_id"                   UUID,
  "hold_expires_at"           TIMESTAMPTZ,
  "cancellation_cutoff_hours" SMALLINT NOT NULL DEFAULT 12 CHECK ("cancellation_cutoff_hours" BETWEEN 12 AND 24),
  "cancelled_at"              TIMESTAMPTZ,
  "cancelled_by"              TEXT,
  "cancel_reason"             TEXT,
  "checked_in_at"             TIMESTAMPTZ,
  "no_show_at"                TIMESTAMPTZ,
  "created_by"                UUID,
  "version"                   INTEGER NOT NULL DEFAULT 0,
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- what the customer still owes at the venue (never negative)
  "balance_due_minor"         BIGINT GENERATED ALWAYS AS (
    GREATEST(
      "total_minor"
        - ("online_paid_minor" - "refunded_minor" - "refund_pending_minor" - "forfeited_minor")
        - "cash_collected_minor",
      0)
  ) STORED,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bookings_ref_key" UNIQUE ("ref"),
  CONSTRAINT "bookings_time_check" CHECK ("end_at" > "start_at"),
  CONSTRAINT "bookings_hold_check" CHECK ("status" <> 'PENDING_PAYMENT' OR ("hold_id" IS NOT NULL AND "hold_expires_at" IS NOT NULL))
);
CREATE INDEX "bookings_user" ON "bookings" ("user_id", "start_at" DESC);
CREATE INDEX "bookings_venue" ON "bookings" ("venue_id", "start_at", "status");
CREATE INDEX "bookings_venue_day" ON "bookings" ("venue_id", "business_date");
CREATE INDEX "bookings_hold" ON "bookings" ("hold_expires_at") WHERE "status" = 'PENDING_PAYMENT';
CREATE INDEX "bookings_hold_id" ON "bookings" ("hold_id") WHERE "hold_id" IS NOT NULL;

-- ───────────────────────── cancellations + itemised lines ─────────────────────────
CREATE TABLE "booking_cancellations" (
  "id"               UUID NOT NULL,                       -- client supplied idempotency key
  "booking_id"       UUID NOT NULL REFERENCES "bookings"("id"),
  "cancelled_by"     TEXT NOT NULL CHECK ("cancelled_by" IN ('USER','VENUE','SYSTEM')),
  "reason"           TEXT,
  "actor_id"         UUID,
  "refund_due_minor" BIGINT NOT NULL DEFAULT 0 CHECK ("refund_due_minor" >= 0),
  "forfeit_minor"    BIGINT NOT NULL DEFAULT 0 CHECK ("forfeit_minor" >= 0),
  "refunded_minor"   BIGINT NOT NULL DEFAULT 0 CHECK ("refunded_minor" >= 0),
  "result"           JSONB NOT NULL,                      -- full response, replayed on duplicate calls
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "booking_cancellations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_cancellations_refund_check" CHECK ("refunded_minor" <= "refund_due_minor")
);
CREATE INDEX "booking_cancellations_booking" ON "booking_cancellations" ("booking_id");

CREATE TABLE "booking_items" (
  "id"                  UUID NOT NULL,
  "booking_id"          UUID NOT NULL REFERENCES "bookings"("id"),
  "slot_id"             UUID NOT NULL REFERENCES "slots"("id"),
  "court_id"            UUID NOT NULL,
  "venue_id"            UUID NOT NULL,
  "start_at"            TIMESTAMPTZ NOT NULL,
  "end_at"              TIMESTAMPTZ NOT NULL,
  "price_minor"         BIGINT NOT NULL CHECK ("price_minor" >= 0),
  "online_paid_minor"   BIGINT NOT NULL DEFAULT 0 CHECK ("online_paid_minor" >= 0),
  "deposit_share_minor" BIGINT NOT NULL DEFAULT 0 CHECK ("deposit_share_minor" >= 0),
  "status"              TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK ("status" IN ('CONFIRMED','CANCELLED','REFUNDED')),
  "refund_due_minor"    BIGINT NOT NULL DEFAULT 0 CHECK ("refund_due_minor" >= 0),
  "forfeit_minor"       BIGINT NOT NULL DEFAULT 0 CHECK ("forfeit_minor" >= 0),
  "cancellation_id"     UUID REFERENCES "booking_cancellations"("id") DEFERRABLE INITIALLY DEFERRED,
  "cancelled_at"        TIMESTAMPTZ,
  "cancelled_by"        TEXT CHECK ("cancelled_by" IN ('USER','VENUE','SYSTEM')),
  "cancel_reason"       TEXT,
  "version"             INTEGER NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_items_time_check" CHECK ("end_at" > "start_at"),
  CONSTRAINT "booking_items_deposit_check" CHECK ("deposit_share_minor" <= "online_paid_minor"),
  CONSTRAINT "booking_items_refund_check" CHECK ("refund_due_minor" + "forfeit_minor" <= "online_paid_minor"),
  CONSTRAINT "booking_items_cancel_check" CHECK (("status" = 'CONFIRMED') = ("cancelled_at" IS NULL)),
  CONSTRAINT "booking_items_cancel_ref_check" CHECK ("status" = 'CONFIRMED' OR "cancellation_id" IS NOT NULL),
  -- DEFENSE IN DEPTH (F1): the database itself refuses two active items on overlapping time for a court
  CONSTRAINT "booking_items_no_overlap" EXCLUDE USING gist
    ("court_id" WITH =, tstzrange("start_at", "end_at", '[)') WITH &&)
    WHERE ("status" = 'CONFIRMED')
);
CREATE UNIQUE INDEX "booking_items_one_active_per_slot" ON "booking_items" ("slot_id") WHERE "status" = 'CONFIRMED';
CREATE UNIQUE INDEX "booking_items_booking_slot_active" ON "booking_items" ("booking_id", "slot_id") WHERE "status" = 'CONFIRMED';
CREATE INDEX "booking_items_booking" ON "booking_items" ("booking_id", "status");
CREATE INDEX "booking_items_cancellation" ON "booking_items" ("cancellation_id") WHERE "cancellation_id" IS NOT NULL;
CREATE INDEX "booking_items_venue_time" ON "booking_items" ("venue_id", "start_at");

-- ───────────────────────── idempotency ─────────────────────────
CREATE TABLE "idempotency_keys" (
  "key"          TEXT NOT NULL,
  "scope"        TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response"     JSONB,
  "status_code"  INTEGER,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("scope", "key")
);
CREATE INDEX "idempotency_keys_created" ON "idempotency_keys" ("created_at");

-- ───────────────────────── invites ─────────────────────────
CREATE TABLE "invites" (
  "id"         UUID NOT NULL,
  "booking_id" UUID NOT NULL REFERENCES "bookings"("id"),
  "token_hash" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invites_token_hash_key" UNIQUE ("token_hash")
);
CREATE INDEX "invites_booking" ON "invites" ("booking_id");

CREATE TABLE "invite_rsvps" (
  "id"         UUID NOT NULL,
  "invite_id"  UUID NOT NULL REFERENCES "invites"("id"),
  "name"       TEXT NOT NULL,
  "phone"      TEXT,
  "rsvp_key"   TEXT NOT NULL,                              -- phone, or lower-cased name when no phone
  "status"     TEXT NOT NULL CHECK ("status" IN ('GOING','NOT_GOING')),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "invite_rsvps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invite_rsvps_unique" UNIQUE ("invite_id", "rsvp_key")
);

-- ───────────────────────── per-venue booking settings + blocklist ─────────────────────────
CREATE TABLE "booking_settings" (
  "venue_id"             UUID NOT NULL,
  "pay_at_venue_enabled" BOOLEAN NOT NULL DEFAULT false,   -- pilot mode flag (Backend_Docs/03 section 2.4)
  "updated_by"           UUID,
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "booking_settings_pkey" PRIMARY KEY ("venue_id")
);

CREATE TABLE "venue_blocklist" (
  "venue_id"   UUID NOT NULL,
  "phone"      TEXT NOT NULL,
  "reason"     TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "venue_blocklist_pkey" PRIMARY KEY ("venue_id", "phone")
);

-- ───────────────────────── outage locks (tracked job with progress) ─────────────────────────
CREATE TABLE "outage_locks" (
  "id"             UUID NOT NULL,
  "venue_id"       UUID NOT NULL,
  "court_ids"      UUID[] NOT NULL,
  "window_start"   TIMESTAMPTZ NOT NULL,
  "window_end"     TIMESTAMPTZ NOT NULL,
  "reason"         TEXT NOT NULL CHECK ("reason" IN ('RAIN','POWER_OUTAGE','MAINTENANCE','OTHER')),
  "note"           TEXT,
  "status"         TEXT NOT NULL DEFAULT 'PROCESSING' CHECK ("status" IN ('PROCESSING','ACTIVE','RELEASED')),
  "total_bookings" INTEGER NOT NULL DEFAULT 0,
  "processed"      INTEGER NOT NULL DEFAULT 0,
  "failed"         INTEGER NOT NULL DEFAULT 0,
  "manual_to_call" JSONB NOT NULL DEFAULT '[]',            -- walk-in / manual bookings staff must phone
  "created_by"     UUID NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "released_at"    TIMESTAMPTZ,
  "released_by"    UUID,
  CONSTRAINT "outage_locks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outage_locks_window_check" CHECK ("window_end" > "window_start")
);
CREATE INDEX "outage_locks_venue" ON "outage_locks" ("venue_id", "created_at" DESC);
CREATE INDEX "outage_locks_open" ON "outage_locks" ("status") WHERE "status" <> 'RELEASED';

-- ───────────────────────── functions ─────────────────────────
-- Splits the online payment / deposit across a booking's hours by price using the largest-remainder
-- method, so SUM(item amounts) equals the booking amounts exactly (no paisa drift).
CREATE OR REPLACE FUNCTION create_confirmed_items(
  p_booking_id        uuid,
  p_online_paid_minor bigint,
  p_deposit_minor     bigint
) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  IF p_deposit_minor > p_online_paid_minor THEN
    RAISE EXCEPTION 'DEPOSIT_EXCEEDS_PAID' USING ERRCODE = '22023';
  END IF;

  WITH b AS (
    SELECT slot_ids FROM bookings WHERE id = p_booking_id
  ),
  src AS (
    SELECT s.id AS slot_id, s.court_id, s.venue_id, s.start_at, s.end_at, s.price_minor,
           (SUM(s.price_minor) OVER ())::bigint AS total
    FROM slots s JOIN b ON s.id = ANY (b.slot_ids)
  ),
  base AS (
    SELECT *,
      CASE WHEN total = 0 THEN 0 ELSE (p_online_paid_minor * price_minor) / total END AS paid_floor,
      CASE WHEN total = 0 THEN 0 ELSE (p_online_paid_minor * price_minor) % total END AS paid_rem,
      CASE WHEN total = 0 THEN 0 ELSE (p_deposit_minor     * price_minor) / total END AS dep_floor,
      CASE WHEN total = 0 THEN 0 ELSE (p_deposit_minor     * price_minor) % total END AS dep_rem
    FROM src
  ),
  ranked AS (
    SELECT *,
      row_number() OVER (ORDER BY paid_rem DESC, start_at) AS paid_rank,
      p_online_paid_minor - (SUM(paid_floor) OVER ())::bigint AS paid_left,
      row_number() OVER (ORDER BY dep_rem DESC, start_at)  AS dep_rank,
      p_deposit_minor     - (SUM(dep_floor)  OVER ())::bigint AS dep_left
    FROM base
  )
  INSERT INTO booking_items
    (id, booking_id, slot_id, court_id, venue_id, start_at, end_at, price_minor,
     online_paid_minor, deposit_share_minor)
  SELECT uuid_v7(), p_booking_id, slot_id, court_id, venue_id, start_at, end_at, price_minor,
         paid_floor + CASE WHEN paid_rank <= paid_left THEN 1 ELSE 0 END,
         dep_floor  + CASE WHEN dep_rank  <= dep_left  THEN 1 ELSE 0 END
  FROM ranked;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Atomic, idempotent partial/full cancellation. Every mutation of a booking takes the parent row
-- lock first; lock order is always bookings -> booking_items -> slots.
CREATE OR REPLACE FUNCTION cancel_booking_items(
  p_booking_id      uuid,
  p_item_ids        uuid[],
  p_cancelled_by    text,                       -- 'USER' | 'VENUE' | 'SYSTEM'
  p_reason          text,
  p_actor_id        uuid,
  p_cancellation_id uuid,                       -- idempotency key (client generated)
  p_release_to      text        DEFAULT 'AVAILABLE',   -- 'BLOCKED' for outage lock
  p_block_reason    text        DEFAULT NULL,
  p_block_ref       uuid        DEFAULT NULL,
  p_now             timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_b          bookings%ROWTYPE;
  v_prev       booking_cancellations%ROWTYPE;
  v_expected   int;
  v_found      int;
  v_started    int;
  v_items      jsonb;
  v_refund     bigint;
  v_forfeit    bigint;
  v_slots      jsonb;
  v_active     int;
  v_total      bigint;
  v_deposit    bigint;
  v_min_start  timestamptz;
  v_max_end    timestamptz;
  v_new_status text;
  v_balance    bigint;
  v_event_id   uuid := uuid_v7();
  v_result     jsonb;
BEGIN
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RAISE EXCEPTION 'NO_ITEMS_SPECIFIED' USING ERRCODE = '22023';
  END IF;
  IF p_cancelled_by NOT IN ('USER','VENUE','SYSTEM') OR p_release_to NOT IN ('AVAILABLE','BLOCKED') THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  -- 1. serialise on the parent row
  SELECT * INTO v_b FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 2. idempotent replay: no side effects, no new event
  SELECT * INTO v_prev FROM booking_cancellations WHERE id = p_cancellation_id;
  IF FOUND THEN
    IF v_prev.booking_id <> p_booking_id THEN
      -- (not 23505: that code reaches the app as an anonymous constraint error, losing the message)
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000';
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  -- 3. authorisation & state
  IF p_cancelled_by = 'USER' AND v_b.user_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_b.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'BOOKING_NOT_CANCELLABLE:%', v_b.status USING ERRCODE = '55000';
  END IF;

  -- 4. lock + validate target items
  v_expected := (SELECT count(DISTINCT x) FROM unnest(p_item_ids) AS x);

  SELECT count(*), count(*) FILTER (WHERE start_at <= p_now)
    INTO v_found, v_started
  FROM (SELECT id, start_at
          FROM booking_items
         WHERE booking_id = p_booking_id AND id = ANY (p_item_ids) AND status = 'CONFIRMED'
         ORDER BY start_at
           FOR UPDATE) locked;

  IF v_found <> v_expected THEN
    RAISE EXCEPTION 'ITEM_NOT_CANCELLABLE' USING ERRCODE = '55000';
  END IF;
  IF p_cancelled_by = 'USER' AND v_started > 0 THEN
    RAISE EXCEPTION 'ITEM_ALREADY_STARTED' USING ERRCODE = '55000';
  END IF;

  -- 5. cancel items + per-item money
  WITH target AS (
    SELECT id,
           (p_cancelled_by <> 'USER'
            OR start_at - make_interval(hours => v_b.cancellation_cutoff_hours) > p_now) AS full_refund
      FROM booking_items
     WHERE booking_id = p_booking_id AND id = ANY (p_item_ids) AND status = 'CONFIRMED'
  ),
  c AS (
    UPDATE booking_items i
       SET status           = 'CANCELLED',
           cancelled_at     = p_now,
           cancelled_by     = p_cancelled_by,
           cancel_reason    = p_reason,
           cancellation_id  = p_cancellation_id,
           refund_due_minor = CASE WHEN t.full_refund THEN i.online_paid_minor
                                   ELSE i.online_paid_minor - i.deposit_share_minor END,
           forfeit_minor    = CASE WHEN t.full_refund THEN 0 ELSE i.deposit_share_minor END,
           version          = i.version + 1,
           updated_at       = p_now
      FROM target t
     WHERE i.id = t.id
    RETURNING i.id, i.slot_id, i.start_at, i.end_at, i.price_minor, i.refund_due_minor, i.forfeit_minor
  )
  SELECT jsonb_agg(jsonb_build_object(
           'itemId', id, 'slotId', slot_id, 'startAt', start_at, 'endAt', end_at,
           'priceMinor', price_minor, 'refundDueMinor', refund_due_minor, 'forfeitMinor', forfeit_minor)
         ORDER BY start_at),
         COALESCE(SUM(refund_due_minor), 0),
         COALESCE(SUM(forfeit_minor), 0)
    INTO v_items, v_refund, v_forfeit
    FROM c;

  -- 6. free (or block) the slots, deterministic lock order
  PERFORM 1
     FROM slots
    WHERE id IN (SELECT slot_id FROM booking_items WHERE cancellation_id = p_cancellation_id)
    ORDER BY start_at
      FOR UPDATE;

  WITH s AS (
    UPDATE slots sl
       SET status       = p_release_to,
           block_reason = CASE WHEN p_release_to = 'BLOCKED' THEN p_block_reason END,
           block_ref    = CASE WHEN p_release_to = 'BLOCKED' THEN p_block_ref END,
           booking_id   = NULL,
           version      = sl.version + 1,
           updated_at   = p_now
     WHERE sl.id IN (SELECT slot_id FROM booking_items WHERE cancellation_id = p_cancellation_id)
       AND sl.booking_id = p_booking_id
       AND sl.status IN ('BOOKED_APP','BOOKED_WALKIN')
       AND sl.end_at > p_now                          -- never "resell" hours already played
    RETURNING sl.id, sl.court_id, sl.venue_id, sl.business_date, sl.status, sl.version, sl.block_reason
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slotId', id, 'courtId', court_id, 'venueId', venue_id, 'businessDate', business_date,
           'status', status, 'version', version, 'blockReason', block_reason)),
         '[]'::jsonb)
    INTO v_slots
    FROM s;

  -- 7. recalculate the parent
  SELECT count(*),
         COALESCE(SUM(price_minor), 0),
         COALESCE(SUM(deposit_share_minor), 0),
         min(start_at), max(end_at)
    INTO v_active, v_total, v_deposit, v_min_start, v_max_end
    FROM booking_items
   WHERE booking_id = p_booking_id AND status = 'CONFIRMED';

  v_new_status := CASE WHEN v_active > 0              THEN v_b.status
                       WHEN p_cancelled_by = 'USER'   THEN 'CANCELLED_BY_USER'
                       ELSE 'CANCELLED_BY_VENUE' END;

  UPDATE bookings
     SET total_minor          = v_total,
         deposit_minor        = v_deposit,
         start_at             = COALESCE(v_min_start, start_at),
         end_at               = COALESCE(v_max_end,   end_at),
         slot_ids             = ARRAY(SELECT slot_id FROM booking_items
                                       WHERE booking_id = p_booking_id AND status = 'CONFIRMED'
                                       ORDER BY start_at),
         refund_pending_minor = refund_pending_minor + v_refund,
         forfeited_minor      = forfeited_minor + v_forfeit,
         status               = v_new_status,
         cancelled_at         = CASE WHEN v_active = 0 THEN p_now ELSE cancelled_at END,
         cancelled_by         = CASE WHEN v_active = 0 THEN p_cancelled_by ELSE cancelled_by END,
         cancel_reason        = CASE WHEN v_active = 0 THEN p_reason ELSE cancel_reason END,
         version              = version + 1,
         updated_at           = p_now
   WHERE id = p_booking_id
  RETURNING balance_due_minor INTO v_balance;

  -- 8. result, cancellation row, outbox, audit
  v_result := jsonb_build_object(
    'cancellationId', p_cancellation_id,
    'bookingId',      p_booking_id,
    'bookingRef',     v_b.ref,
    'venueId',        v_b.venue_id,
    'userId',         v_b.user_id,
    'cancelledBy',    p_cancelled_by,
    'reason',         p_reason,
    'items',          v_items,
    'refundDueMinor', v_refund,
    'forfeitMinor',   v_forfeit,
    'bookingFullyCancelled', (v_active = 0),
    'booking', jsonb_build_object(
        'status', v_new_status, 'totalMinor', v_total, 'depositMinor', v_deposit,
        'balanceDueMinor', v_balance, 'activeItemCount', v_active),
    'slots',    v_slots,
    'replayed', false);

  INSERT INTO booking_cancellations
         (id, booking_id, cancelled_by, reason, actor_id, refund_due_minor, forfeit_minor, result, created_at)
  VALUES (p_cancellation_id, p_booking_id, p_cancelled_by, p_reason, p_actor_id, v_refund, v_forfeit, v_result, p_now);

  INSERT INTO outbox (id, event_type, routing_key, payload, headers)
  VALUES (v_event_id, 'BookingItemCancelled', 'booking.item.cancelled',
          jsonb_build_object(
            'id', v_event_id, 'type', 'BookingItemCancelled', 'version', 1,
            'occurredAt', p_now, 'producer', 'booking', 'traceId', NULL,
            'data', v_result - 'slots'),
          '{}'::jsonb);

  INSERT INTO audit_logs (actor_id, actor_type, venue_id, action, entity, entity_id, after, at)
  VALUES (p_actor_id, p_cancelled_by, v_b.venue_id, 'BOOKING_ITEMS_CANCELLED', 'booking',
          p_booking_id::text, v_result - 'slots', p_now);

  RETURN v_result;
END $$;
