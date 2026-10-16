-- Phase 1: identity + venue modules. Pre-launch, so the starter users/refresh_tokens are replaced
-- (no real data exists). Later changes must use expand/contract.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DROP TABLE "refresh_tokens";
DROP TABLE "users";
DROP TYPE "Role";
-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ,
    "password_hash" TEXT,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "phone_verified_at" TIMESTAMPTZ,
    "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_opt_in_at" TIMESTAMPTZ,
    "whatsapp_opt_in_source" TEXT,
    "whatsapp_opt_in_text_version" TEXT,
    "whatsapp_opt_out_at" TIMESTAMPTZ,
    "platform_role" TEXT NOT NULL DEFAULT 'USER',
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "signup_intent" TEXT NOT NULL DEFAULT 'PLAYER',
    "no_show_count" INTEGER NOT NULL DEFAULT 0,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "token_valid_after" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "invited_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "consumed_at" TIMESTAMPTZ,
    "request_ip" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "replaced_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "consent_text_version" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_invitations" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" UUID NOT NULL,
    "city" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "area_id" UUID,
    "address" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whatsapp_number" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "operating_hours" JSONB NOT NULL,
    "cancellation_cutoff_hours" INTEGER NOT NULL DEFAULT 12,
    "commission_bps" INTEGER NOT NULL DEFAULT 0,
    "verification_status" TEXT NOT NULL DEFAULT 'DRAFT',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onboarding_step" INTEGER NOT NULL DEFAULT 1,
    "submitted_at" TIMESTAMPTZ,
    "verified_at" TIMESTAMPTZ,
    "verified_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courts" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "capacity" INTEGER,
    "slot_minutes" INTEGER NOT NULL DEFAULT 60,
    "hours_override" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "court_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "day_type" TEXT NOT NULL,
    "start_date" TEXT,
    "end_date" TEXT,
    "from_time" TEXT NOT NULL,
    "to_time" TEXT NOT NULL,
    "price_minor" BIGINT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_reviews" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "submission_no" INTEGER NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "comments" TEXT,
    "field_flags" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "venue_memberships_venue_id_idx" ON "venue_memberships"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_memberships_user_id_venue_id_key" ON "venue_memberships"("user_id", "venue_id");

-- CreateIndex
CREATE INDEX "otp_lookup" ON "otp_challenges"("email", "purpose", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "whatsapp_consents_user_id_occurred_at_idx" ON "whatsapp_consents"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "staff_invitations_token_hash_key" ON "staff_invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "areas_city_slug_key" ON "areas"("city", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "venues_slug_key" ON "venues"("slug");

-- CreateIndex
CREATE INDEX "venues_city_area_id_idx" ON "venues"("city", "area_id");

-- CreateIndex
CREATE INDEX "courts_venue_id_idx" ON "courts"("venue_id");

-- CreateIndex
CREATE INDEX "courts_sport_surface_idx" ON "courts"("sport", "surface");

-- CreateIndex
CREATE INDEX "pricing_rules_court_id_priority_idx" ON "pricing_rules"("court_id", "priority" DESC);

-- CreateIndex
CREATE INDEX "venue_reviews_venue_id_created_at_idx" ON "venue_reviews"("venue_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "venue_memberships" ADD CONSTRAINT "venue_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_consents" ADD CONSTRAINT "whatsapp_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courts" ADD CONSTRAINT "courts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_court_id_fkey" FOREIGN KEY ("court_id") REFERENCES "courts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_reviews" ADD CONSTRAINT "venue_reviews_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── Constraints Prisma cannot express ─────────
ALTER TABLE "users" ADD CONSTRAINT users_platform_role_check CHECK (platform_role IN ('USER','PLATFORM_ADMIN'));
ALTER TABLE "users" ADD CONSTRAINT users_status_check CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','SUSPENDED','DELETED'));
ALTER TABLE "users" ADD CONSTRAINT users_signup_intent_check CHECK (signup_intent IN ('PLAYER','OWNER','STAFF'));
ALTER TABLE "users" ADD CONSTRAINT users_email_lowercase_check CHECK (email = lower(email));
-- Opted-in users always have a timestamp and a phone number (consent evidence).
ALTER TABLE "users" ADD CONSTRAINT users_whatsapp_consent_evidence
  CHECK (whatsapp_opt_in = false OR (whatsapp_opt_in_at IS NOT NULL AND phone IS NOT NULL));
ALTER TABLE "venue_memberships" ADD CONSTRAINT venue_memberships_role_check CHECK (role IN ('OWNER','MANAGER','FRONT_DESK','SCORER'));
ALTER TABLE "otp_challenges" ADD CONSTRAINT otp_purpose_check CHECK (purpose IN
  ('SIGNUP_VERIFY','LOGIN_STEP_UP','LOGIN_PASSWORDLESS','PASSWORD_RESET','EMAIL_CHANGE','STAFF_INVITE'));
ALTER TABLE "whatsapp_consents" ADD CONSTRAINT whatsapp_consents_action_check CHECK (action IN ('OPT_IN','OPT_OUT'));
ALTER TABLE "staff_invitations" ADD CONSTRAINT staff_invitations_role_check CHECK (role IN ('MANAGER','FRONT_DESK','SCORER'));
CREATE UNIQUE INDEX staff_invitations_open ON "staff_invitations" (venue_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE "venues" ADD CONSTRAINT venues_status_check CHECK (verification_status IN
  ('DRAFT','SUBMITTED','UNDER_REVIEW','CHANGES_REQUESTED','VERIFIED','REJECTED','SUSPENDED'));
ALTER TABLE "venues" ADD CONSTRAINT venues_cutoff_check CHECK (cancellation_cutoff_hours BETWEEN 12 AND 24);
ALTER TABLE "venues" ADD CONSTRAINT venues_commission_check CHECK (commission_bps BETWEEN 0 AND 3000);
ALTER TABLE "venues" ADD CONSTRAINT venues_lat_check CHECK (lat BETWEEN -90 AND 90);
ALTER TABLE "venues" ADD CONSTRAINT venues_lng_check CHECK (lng BETWEEN -180 AND 180);
ALTER TABLE "courts" ADD CONSTRAINT courts_sport_check CHECK (sport IN
  ('FUTSAL_5V5','BOX_CRICKET','HARDBALL_CRICKET','PADEL','BADMINTON','NET_PRACTICE'));
ALTER TABLE "courts" ADD CONSTRAINT courts_surface_check CHECK (surface IN
  ('SYNTHETIC_TURF','NATURAL_GRASS','INDOOR_ACRYLIC','WOODEN_FLOOR','GLASS_PADEL'));
ALTER TABLE "courts" ADD CONSTRAINT courts_slot_minutes_check CHECK (slot_minutes IN (30,60,90,120));
ALTER TABLE "pricing_rules" ADD CONSTRAINT pricing_day_type_check CHECK (day_type IN ('ANY','WEEKDAY','WEEKEND','DATE_RANGE'));
ALTER TABLE "pricing_rules" ADD CONSTRAINT pricing_tag_check CHECK (tag IN ('PEAK','OFF_PEAK'));
ALTER TABLE "pricing_rules" ADD CONSTRAINT pricing_price_check CHECK (price_minor >= 0);
ALTER TABLE "venue_reviews" ADD CONSTRAINT venue_reviews_decision_check CHECK (decision IN
  ('APPROVED','CHANGES_REQUESTED','REJECTED','SUSPENDED','REINSTATED'));

-- ───────── Geo search: PostGIS point built from lat/lng, GiST + trigram indexes ─────────
ALTER TABLE "venues" ADD COLUMN location geography(Point,4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED;
CREATE INDEX venues_location_gix ON "venues" USING gist (location);
CREATE INDEX venues_name_trgm ON "venues" USING gin (name gin_trgm_ops);
CREATE INDEX venues_amenities_gin ON "venues" USING gin (amenities);
CREATE INDEX venues_live ON "venues" (city, area_id) WHERE verification_status = 'VERIFIED' AND is_active;
