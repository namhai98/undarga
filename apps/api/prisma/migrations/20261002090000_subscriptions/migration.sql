-- SaaS subscriptions: lifecycle states, invoice plan reference, usage index.
--
-- The plan / feature / plan_entitlement catalog itself is reference data and is
-- written by `pnpm db:seed` (src/subscriptions/plan-catalog.ts), not here.

-- 1. Status names as the product uses them. Label renames: the column default
--    and any stored value follow by OID. EXPIRED is new and unused in this
--    migration, so adding it inside the transaction is safe.
ALTER TYPE "subscription_status" RENAME VALUE 'TRIALING' TO 'TRIAL';
ALTER TYPE "subscription_status" RENAME VALUE 'CANCELED' TO 'CANCELLED';
ALTER TYPE "subscription_status" ADD VALUE IF NOT EXISTS 'EXPIRED';

-- 2. Why a subscription was cancelled, and when it expired.
ALTER TABLE "subscription"
  ADD COLUMN "cancel_reason" VARCHAR(512),
  ADD COLUMN "expired_at" TIMESTAMPTZ(3);

-- 3. The plan an invoice bills, and its name at the time.
ALTER TABLE "subscription_invoice"
  ADD COLUMN "plan_id" UUID,
  ADD COLUMN "plan_name" VARCHAR(96);
ALTER TABLE "subscription_invoice"
  ADD CONSTRAINT "subscription_invoice_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
CREATE INDEX "subscription_invoice_company_id_created_at_idx"
  ON "subscription_invoice"("company_id", "created_at" DESC);

-- 4. Appointments created this month (the plan's monthly limit).
CREATE INDEX "appointment_company_id_created_at_idx"
  ON "appointment"("company_id", "created_at");
