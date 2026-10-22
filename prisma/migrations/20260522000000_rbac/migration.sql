-- RBAC phase 1: permissions, roles, role_permissions, user_roles, the 4 system roles (the backfill
-- needs them) and a backfill from users.platform_role / venue_memberships. Permissions and
-- role_permissions are NOT seeded here: `npm run db:seed:rbac` (prisma/seed-rbac.ts) owns them, from
-- src/modules/rbac/rbac.api-map.ts and rbac.roles.ts. Additive: the old columns and guards stay
-- until the guard swap. Role IDs here are gen_random_uuid() (v4) because the app's UUID v7 is not
-- available in SQL; every later row is created by the app with uuidv7().

CREATE TABLE "permissions" (
  "id"          UUID NOT NULL,
  "code"        TEXT NOT NULL,
  "resource"    TEXT NOT NULL,
  "action"      TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "permissions_code_format" CHECK ("code" ~ '^[a-z_]+(\.[a-z_]+)+$')
);
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions" ("code");

CREATE TABLE "roles" (
  "id"          UUID NOT NULL,
  "code"        TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "scope"       TEXT NOT NULL CHECK ("scope" IN ('PLATFORM','VENUE')),
  "is_system"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_code_format" CHECK ("code" ~ '^[A-Z_]+$')
);
CREATE UNIQUE INDEX "roles_code_key" ON "roles" ("code");
CREATE UNIQUE INDEX "roles_id_scope_key" ON "roles" ("id", "scope");

CREATE TABLE "role_permissions" (
  "role_id"       UUID NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permission_id" UUID NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");

CREATE TABLE "user_roles" (
  "id"          UUID NOT NULL,
  "user_id"     UUID NOT NULL REFERENCES "users"("id"),
  "role_id"     UUID NOT NULL,
  "scope"       TEXT NOT NULL,
  "venue_id"    UUID,
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "assigned_by" UUID,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
  -- the scope copied here can never disagree with the role's own scope
  CONSTRAINT "user_roles_role_scope_fkey" FOREIGN KEY ("role_id", "scope") REFERENCES "roles"("id", "scope"),
  -- a venue-scoped assignment names a venue, a platform-scoped one does not
  CONSTRAINT "user_roles_venue_scope_check" CHECK (("scope" = 'VENUE') = ("venue_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "user_roles_platform_unique" ON "user_roles" ("user_id", "role_id") WHERE "venue_id" IS NULL;
CREATE UNIQUE INDEX "user_roles_venue_unique" ON "user_roles" ("user_id", "role_id", "venue_id") WHERE "venue_id" IS NOT NULL;
CREATE INDEX "user_roles_user_id_is_active_idx" ON "user_roles" ("user_id", "is_active");
CREATE INDEX "user_roles_venue_id_idx" ON "user_roles" ("venue_id");

-- ───────── Seed: the 4 system roles (the backfill below needs them; names are kept in step by seed-rbac) ─────────
INSERT INTO "roles" ("id","code","name","description","scope") VALUES
  (gen_random_uuid(),'USER','User','Every signed-up player','PLATFORM'),
  (gen_random_uuid(),'GROUND_OWNER','Ground owner','Owns a ground or venue','VENUE'),
  (gen_random_uuid(),'TOURNAMENT_ORGANIZER','Tournament organizer','Creates and runs tournaments','PLATFORM'),
  (gen_random_uuid(),'ADMIN','Admin','Platform administrator','PLATFORM');

-- ───────── Backfill from the old columns ─────────
-- Every live user is a USER. Deleted accounts are skipped.
INSERT INTO "user_roles" ("id","user_id","role_id","scope")
SELECT gen_random_uuid(), u.id, r.id, r.scope FROM "users" u JOIN "roles" r ON r.code = 'USER'
WHERE u.status <> 'DELETED';

INSERT INTO "user_roles" ("id","user_id","role_id","scope")
SELECT gen_random_uuid(), u.id, r.id, r.scope FROM "users" u JOIN "roles" r ON r.code = 'ADMIN'
WHERE u.platform_role = 'PLATFORM_ADMIN' AND u.status <> 'DELETED';

-- Venue OWNER memberships become GROUND_OWNER. MANAGER / FRONT_DESK / SCORER are not among the 4
-- roles yet: they keep working through venue_memberships and requireVenueRole until they are added.
INSERT INTO "user_roles" ("id","user_id","role_id","scope","venue_id","is_active","assigned_by")
SELECT gen_random_uuid(), m.user_id, r.id, r.scope, m.venue_id, m.is_active, m.invited_by
FROM "venue_memberships" m JOIN "roles" r ON r.code = 'GROUND_OWNER'
WHERE m.role = 'OWNER';
