-- Online payments through external providers (docs/PAYMENTS.md).
--
-- payment_transaction   one online payment attempt; tenant-scoped (RLS via
--                       001_hardening.sql). Holds provider references only —
--                       never card numbers, CVV or other credentials.
-- payment_webhook_event every webhook delivery, for audit and debugging;
--                       platform-only (tenants are denied it in 001_hardening.sql).

-- CreateEnum
CREATE TYPE "payment_transaction_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment_transaction_kind" AS ENUM ('APPOINTMENT', 'SUBSCRIPTION_INVOICE');

-- CreateEnum
CREATE TYPE "payment_webhook_status" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'REJECTED');
-- CreateTable
CREATE TABLE "payment_transaction" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "payment_transaction_kind" NOT NULL,
    "status" "payment_transaction_status" NOT NULL DEFAULT 'PENDING',
    "appointment_id" UUID,
    "subscription_invoice_id" UUID,
    "customer_id" UUID,
    "payment_id" UUID,
    "subscription_payment_id" UUID,
    "initiated_by_type" "actor_type" NOT NULL,
    "initiated_by_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "provider_transaction_id" VARCHAR(128),
    "provider_payment_id" VARCHAR(128),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "checkout" JSONB,
    "metadata" JSONB,
    "failure_reason" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "succeeded_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_event" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "status" "payment_webhook_status" NOT NULL DEFAULT 'RECEIVED',
    "signature_valid" BOOLEAN NOT NULL,
    "provider_transaction_id" VARCHAR(128),
    "transaction_id" UUID,
    "company_id" UUID,
    "payload" JSONB,
    "error" VARCHAR(1000),
    "attempts" SMALLINT NOT NULL DEFAULT 1,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_transaction_company_id_status_created_at_idx" ON "payment_transaction"("company_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_transaction_company_id_appointment_id_idx" ON "payment_transaction"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "payment_transaction_company_id_subscription_invoice_id_idx" ON "payment_transaction"("company_id", "subscription_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_company_id_id_key" ON "payment_transaction"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_company_id_idempotency_key_key" ON "payment_transaction"("company_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_provider_provider_transaction_id_key" ON "payment_transaction"("provider", "provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_webhook_event_transaction_id_idx" ON "payment_webhook_event"("transaction_id");

-- CreateIndex
CREATE INDEX "payment_webhook_event_received_at_idx" ON "payment_webhook_event"("received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_event_provider_event_key_key" ON "payment_webhook_event"("provider", "event_key");

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_subscription_invoice_id_fkey" FOREIGN KEY ("company_id", "subscription_invoice_id") REFERENCES "subscription_invoice"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_company_id_subscription_payment_id_fkey" FOREIGN KEY ("company_id", "subscription_payment_id") REFERENCES "subscription_payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_webhook_event" ADD CONSTRAINT "payment_webhook_event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
-- Only when missing: the init migration creates this key, and it is absent
-- here only where 001_hardening.sql rebuilt audit_log (partitioned) before
-- this migration ran. A fresh database applying every migration in one go
-- still has it, and a plain ADD CONSTRAINT would fail the deploy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_log_company_id_fkey' AND conrelid = 'audit_log'::regclass
  ) THEN
    ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;


-- Money is positive, refunds never exceed it, fees never exceed it.
ALTER TABLE "payment_transaction"
  ADD CONSTRAINT "payment_transaction_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "payment_transaction_refund_within_amount"
    CHECK ("refunded_minor" >= 0 AND "refunded_minor" <= "amount_minor"),
  ADD CONSTRAINT "payment_transaction_fee_within_amount"
    CHECK ("fee_minor" >= 0 AND "fee_minor" <= "amount_minor");

-- Exactly one thing is being paid for, and it matches the kind.
ALTER TABLE "payment_transaction"
  ADD CONSTRAINT "payment_transaction_target_matches_kind" CHECK (
    ("kind" = 'APPOINTMENT' AND "appointment_id" IS NOT NULL AND "subscription_invoice_id" IS NULL)
    OR
    ("kind" = 'SUBSCRIPTION_INVOICE' AND "subscription_invoice_id" IS NOT NULL AND "appointment_id" IS NULL)
  );

-- No duplicate charges: at most ONE open (pending or processing) transaction
-- per appointment and per invoice. A second request gets the open one back.
CREATE UNIQUE INDEX "payment_transaction_one_open_per_appointment"
  ON "payment_transaction" ("company_id", "appointment_id")
  WHERE "status" IN ('PENDING', 'PROCESSING') AND "appointment_id" IS NOT NULL;
CREATE UNIQUE INDEX "payment_transaction_one_open_per_invoice"
  ON "payment_transaction" ("company_id", "subscription_invoice_id")
  WHERE "status" IN ('PENDING', 'PROCESSING') AND "subscription_invoice_id" IS NOT NULL;

-- The money that moved is settled at most once per provider.
CREATE UNIQUE INDEX "payment_transaction_provider_payment_unique"
  ON "payment_transaction" ("provider", "provider_payment_id")
  WHERE "provider_payment_id" IS NOT NULL;
