-- Notification system: company channel settings, full message bodies, and a
-- reminder log that makes a duplicate reminder impossible.
--
-- Additive only. Every new column is nullable or has a default, so existing
-- rows need no backfill and the ALTERs are metadata-only.

-- 1. Company-wide switches. Reminder offsets already live in
--    company_settings.reminder_offsets_minutes. NULL event channels = the
--    platform default for every notification type.
ALTER TABLE "company_settings"
  ADD COLUMN "email_notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sms_notifications_enabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_notifications_enabled"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "reminders_enabled"           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notification_event_channels" JSONB;

-- 2. The rendered message the provider is handed. `body_preview` stays the
--    short, listable form; before this, the worker could only send the preview.
ALTER TABLE "notification" ADD COLUMN "body" TEXT;

-- 3. One row per scheduled reminder. The unique key is the duplicate guard: two
--    sweeps racing each try to insert, and exactly one succeeds. RLS is added
--    by 001_hardening.sql (tenant_tables list).
CREATE TABLE "appointment_reminder" (
    "id"             UUID NOT NULL,
    "company_id"     UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "starts_at"      TIMESTAMPTZ(3) NOT NULL,
    "remind_at"      TIMESTAMPTZ(3) NOT NULL,
    "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_reminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointment_reminder_company_id_appointment_id_offset_minut_key"
  ON "appointment_reminder"("company_id", "appointment_id", "offset_minutes", "starts_at");

ALTER TABLE "appointment_reminder"
  ADD CONSTRAINT "appointment_reminder_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "company"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "appointment_reminder"
  ADD CONSTRAINT "appointment_reminder_company_id_appointment_id_fkey"
  FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
