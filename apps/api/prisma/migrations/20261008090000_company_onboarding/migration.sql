-- Company onboarding state (docs/ONBOARDING.md).
--
-- Guides the web app back into the wizard; nothing in the API gates on it.

CREATE TYPE "onboarding_status" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

ALTER TABLE "company"
  ADD COLUMN "onboarding_status" "onboarding_status" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "onboarding_completed_at" TIMESTAMPTZ(3);

-- Companies that predate the wizard. One with a branch was set up by other
-- means and must not be sent back through it; one without a branch genuinely
-- has not started, which is exactly what the default already says.
UPDATE "company" c
   SET "onboarding_status" = 'COMPLETED',
       "onboarding_completed_at" = c."created_at"
 WHERE EXISTS (
   SELECT 1 FROM "branch" b WHERE b."company_id" = c."id" AND b."deleted_at" IS NULL
 );
