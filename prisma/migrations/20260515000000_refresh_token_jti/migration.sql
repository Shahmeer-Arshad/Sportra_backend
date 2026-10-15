-- Schema drift fix: refresh_tokens.jti was in schema.prisma but never migrated.
-- Old refresh tokens cannot be rotated without a jti, so they are cleared (users log in again).
DELETE FROM "refresh_tokens";

-- DropIndex
DROP INDEX "refresh_tokens_hashed_token_key";

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN "jti" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_jti_key" ON "refresh_tokens"("jti");
