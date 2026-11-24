-- Advanced booking (docs/ADVANCED-BOOKING.md): booking rules, service rules,
-- resource availability, recurring series.

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "appointment_series_status" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "time_off_type" ADD VALUE 'PERSONAL';

-- AlterTable
ALTER TABLE "appointment" ADD COLUMN     "series_id" UUID,
ADD COLUMN     "series_index" SMALLINT;

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "reschedule_deadline_hours" SMALLINT,
ADD COLUMN     "rescheduling_allowed" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "service" ADD COLUMN     "booking_lead_time_min" INTEGER,
ADD COLUMN     "cancellation_window_hours" SMALLINT,
ADD COLUMN     "max_advance_booking_days" SMALLINT,
ADD COLUMN     "max_concurrent_bookings" SMALLINT;

-- CreateTable
CREATE TABLE "resource_availability_rule" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_availability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_unavailability" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(16) NOT NULL DEFAULT 'OTHER',
    "note" VARCHAR(512),
    "created_by_type" "actor_type" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_unavailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_series" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "employee_id" UUID,
    "resource_id" UUID,
    "frequency" "recurrence_frequency" NOT NULL,
    "interval" SMALLINT NOT NULL DEFAULT 1,
    "weekdays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "local_start_time" VARCHAR(5) NOT NULL,
    "timezone_name" VARCHAR(64) NOT NULL,
    "until_date" DATE,
    "occurrence_count" SMALLINT,
    "status" "appointment_series_status" NOT NULL DEFAULT 'ACTIVE',
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" VARCHAR(512),
    "created_by_type" "actor_type" NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_availability_rule_company_id_resource_id_day_of_we_idx" ON "resource_availability_rule"("company_id", "resource_id", "day_of_week");

-- CreateIndex
CREATE INDEX "resource_unavailability_company_id_resource_id_starts_at_idx" ON "resource_unavailability"("company_id", "resource_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_series_company_id_customer_id_idx" ON "appointment_series"("company_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_series_company_id_id_key" ON "appointment_series"("company_id", "id");

-- CreateIndex
CREATE INDEX "appointment_company_id_series_id_idx" ON "appointment"("company_id", "series_id");

-- AddForeignKey
ALTER TABLE "resource_availability_rule" ADD CONSTRAINT "resource_availability_rule_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "resource"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "resource_unavailability" ADD CONSTRAINT "resource_unavailability_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "resource"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_company_id_series_id_fkey" FOREIGN KEY ("company_id", "series_id") REFERENCES "appointment_series"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Closed value sets and shapes the API also enforces.
ALTER TABLE "resource_availability_rule"
  ADD CONSTRAINT "resource_availability_rule_day_check" CHECK ("day_of_week" BETWEEN 0 AND 6),
  ADD CONSTRAINT "resource_availability_rule_range_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "resource_unavailability"
  ADD CONSTRAINT "resource_unavailability_reason_check" CHECK ("reason" IN ('MAINTENANCE', 'OUT_OF_SERVICE', 'RESERVED', 'OTHER')),
  ADD CONSTRAINT "resource_unavailability_range_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "appointment_series"
  ADD CONSTRAINT "appointment_series_interval_check" CHECK ("interval" BETWEEN 1 AND 12),
  ADD CONSTRAINT "appointment_series_weekdays_check" CHECK ("weekdays" <@ ARRAY[0,1,2,3,4,5,6]),
  ADD CONSTRAINT "appointment_series_end_check" CHECK (("until_date" IS NULL) <> ("occurrence_count" IS NULL)),
  ADD CONSTRAINT "appointment_series_count_check" CHECK ("occurrence_count" IS NULL OR "occurrence_count" BETWEEN 1 AND 104);
ALTER TABLE "service"
  ADD CONSTRAINT "service_booking_rules_check" CHECK (
    ("booking_lead_time_min" IS NULL OR "booking_lead_time_min" >= 0) AND
    ("max_advance_booking_days" IS NULL OR "max_advance_booking_days" >= 1) AND
    ("cancellation_window_hours" IS NULL OR "cancellation_window_hours" >= 0) AND
    ("max_concurrent_bookings" IS NULL OR "max_concurrent_bookings" >= 1));
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_reschedule_deadline_check" CHECK ("reschedule_deadline_hours" IS NULL OR "reschedule_deadline_hours" >= 0);
