-- Calendar integration (docs/CALENDAR-INTEGRATION.md).

-- CreateTable
CREATE TABLE "calendar_connection" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "account_email" VARCHAR(320),
    "credentials" TEXT NOT NULL,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "scopes" VARCHAR(512) NOT NULL,
    "calendar_id" VARCHAR(512) NOT NULL DEFAULT 'primary',
    "calendar_name" VARCHAR(256),
    "calendar_time_zone" VARCHAR(64),
    "sync_completed" BOOLEAN NOT NULL DEFAULT true,
    "use_for_availability" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ(3),
    "busy_synced_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(512),
    "last_error_at" TIMESTAMPTZ(3),
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_oauth_state" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "user_account_id" UUID NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_oauth_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_link" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "calendar_id" VARCHAR(512) NOT NULL,
    "external_event_id" VARCHAR(1024) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
    "last_error" VARCHAR(512),
    "last_error_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_event_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_sync_job" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "calendar_sync_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_busy_block" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_busy_block_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_connection_status_idx" ON "calendar_connection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connection_company_id_employee_id_key" ON "calendar_connection"("company_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connection_company_id_id_key" ON "calendar_connection"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_oauth_state_state_hash_key" ON "calendar_oauth_state"("state_hash");

-- CreateIndex
CREATE INDEX "calendar_oauth_state_company_id_expires_at_idx" ON "calendar_oauth_state"("company_id", "expires_at");

-- CreateIndex
CREATE INDEX "calendar_event_link_company_id_appointment_id_idx" ON "calendar_event_link"("company_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_link_connection_id_appointment_id_key" ON "calendar_event_link"("connection_id", "appointment_id");

-- CreateIndex
CREATE INDEX "calendar_sync_job_status_next_attempt_at_idx" ON "calendar_sync_job"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_sync_job_company_id_appointment_id_key" ON "calendar_sync_job"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "calendar_busy_block_company_id_employee_id_starts_at_idx" ON "calendar_busy_block"("company_id", "employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "calendar_busy_block_connection_id_idx" ON "calendar_busy_block"("connection_id");

-- AddForeignKey
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calendar_event_link" ADD CONSTRAINT "calendar_event_link_company_id_connection_id_fkey" FOREIGN KEY ("company_id", "connection_id") REFERENCES "calendar_connection"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calendar_busy_block" ADD CONSTRAINT "calendar_busy_block_company_id_connection_id_fkey" FOREIGN KEY ("company_id", "connection_id") REFERENCES "calendar_connection"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Closed value sets, checked by the database rather than trusted to the API.
ALTER TABLE "calendar_connection"
  ADD CONSTRAINT "calendar_connection_provider_check" CHECK ("provider" IN ('google', 'microsoft')),
  ADD CONSTRAINT "calendar_connection_status_check" CHECK ("status" IN ('ACTIVE', 'NEEDS_REAUTH', 'ERROR'));
ALTER TABLE "calendar_oauth_state"
  ADD CONSTRAINT "calendar_oauth_state_provider_check" CHECK ("provider" IN ('google', 'microsoft'));
ALTER TABLE "calendar_sync_job"
  ADD CONSTRAINT "calendar_sync_job_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'));
ALTER TABLE "calendar_busy_block"
  ADD CONSTRAINT "calendar_busy_block_range_check" CHECK ("ends_at" > "starts_at");
