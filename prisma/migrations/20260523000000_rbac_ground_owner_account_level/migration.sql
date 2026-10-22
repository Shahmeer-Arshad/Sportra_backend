-- GROUND_OWNER becomes an account-level (PLATFORM) role: "this person may create venues".
-- Which venues someone actually owns stays in venue_memberships. Also: signup_intent values are now
-- USER | GROUND_OWNER | STAFF (was PLAYER | OWNER | STAFF), and every live user gets a USER role row.

-- ───────── signup_intent: PLAYER -> USER, OWNER -> GROUND_OWNER ─────────
ALTER TABLE "users" DROP CONSTRAINT users_signup_intent_check;
UPDATE "users" SET signup_intent = 'USER' WHERE signup_intent = 'PLAYER';
UPDATE "users" SET signup_intent = 'GROUND_OWNER' WHERE signup_intent = 'OWNER';
ALTER TABLE "users" ALTER COLUMN "signup_intent" SET DEFAULT 'USER';
ALTER TABLE "users" ADD CONSTRAINT users_signup_intent_check CHECK (signup_intent IN ('USER','GROUND_OWNER','STAFF'));

-- ───────── GROUND_OWNER: VENUE scope -> PLATFORM scope ─────────
CREATE TEMP TABLE _owners AS
  SELECT ur.user_id, bool_or(ur.is_active) AS is_active, min(ur.created_at) AS created_at
    FROM "user_roles" ur JOIN "roles" r ON r.id = ur.role_id
   WHERE r.code = 'GROUND_OWNER'
   GROUP BY ur.user_id;

DELETE FROM "user_roles" WHERE role_id = (SELECT id FROM "roles" WHERE code = 'GROUND_OWNER');
UPDATE "roles" SET scope = 'PLATFORM' WHERE code = 'GROUND_OWNER';

INSERT INTO "user_roles" ("id","user_id","role_id","scope","is_active","created_at")
SELECT gen_random_uuid(), o.user_id, r.id, 'PLATFORM', o.is_active, o.created_at
  FROM _owners o JOIN "roles" r ON r.code = 'GROUND_OWNER';

DROP TABLE _owners;

-- People who signed up as owners but have not created a venue yet
INSERT INTO "user_roles" ("id","user_id","role_id","scope")
SELECT gen_random_uuid(), u.id, r.id, 'PLATFORM'
  FROM "users" u JOIN "roles" r ON r.code = 'GROUND_OWNER'
 WHERE u.signup_intent = 'GROUND_OWNER' AND u.status <> 'DELETED'
   AND NOT EXISTS (SELECT 1 FROM "user_roles" x WHERE x.user_id = u.id AND x.role_id = r.id);

-- Everyone who signed up after the first RBAC migration and has no USER role yet
INSERT INTO "user_roles" ("id","user_id","role_id","scope")
SELECT gen_random_uuid(), u.id, r.id, 'PLATFORM'
  FROM "users" u JOIN "roles" r ON r.code = 'USER'
 WHERE u.status <> 'DELETED'
   AND NOT EXISTS (SELECT 1 FROM "user_roles" x WHERE x.user_id = u.id AND x.role_id = r.id);
