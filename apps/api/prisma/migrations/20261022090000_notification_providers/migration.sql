-- Real notification providers (docs/NOTIFICATION-PROVIDERS.md).
--
-- notification.status UNKNOWN   the provider never answered; not auto-retried.
-- notification.provider_*       signed delivery receipts (delivered / bounced).
-- notification_provider_config  a company's own sending account; credentials
--                               encrypted by the API (AES-256-GCM). Tenant-scoped.

-- AlterEnum
ALTER TYPE "notification_status" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "provider_config_id" UUID,
ADD COLUMN     "provider_event_at" TIMESTAMPTZ(3),
ADD COLUMN     "provider_status" VARCHAR(32);

-- CreateTable
CREATE TABLE "notification_provider_config" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentials" TEXT NOT NULL,
    "secret_hint" VARCHAR(8) NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED',
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_provider_config_company_id_channel_key" ON "notification_provider_config"("company_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_provider_config_company_id_id_key" ON "notification_provider_config"("company_id", "id");

-- AddForeignKey
ALTER TABLE "notification_provider_config" ADD CONSTRAINT "notification_provider_config_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


ALTER TABLE "notification_provider_config"
  ADD CONSTRAINT "notification_provider_config_status_known"
  CHECK ("status" IN ('UNVERIFIED', 'CONNECTED', 'FAILED'));
