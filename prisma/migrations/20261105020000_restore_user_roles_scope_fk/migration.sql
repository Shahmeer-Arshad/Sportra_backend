-- Second regression fix from 20261029174559_fk_cleanup (see 20261105010000's comment for the
-- first). That migration dropped user_roles_role_scope_fkey — the composite FK that enforces
-- user_roles.scope === roles.scope for the role it points at, via the roles_id_scope_key unique
-- index from 20260522000000_rbac — and never recreated it. Without it, a user_roles row can carry
-- a scope that disagrees with its own role's scope (tests/rbac.test.ts expects this to be rejected).
ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_role_scope_fkey" FOREIGN KEY ("role_id", "scope") REFERENCES "roles"("id", "scope");
