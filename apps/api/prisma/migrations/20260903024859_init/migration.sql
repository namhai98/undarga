-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "permission_scope" AS ENUM ('PLATFORM', 'COMPANY');

-- CreateEnum
CREATE TYPE "feature_value_type" AS ENUM ('BOOLEAN', 'LIMIT', 'METERED');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('PENDING_SETUP', 'ACTIVE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "domain_status" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "branch_status" AS ENUM ('ACTIVE', 'TEMPORARILY_CLOSED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "employee_status" AS ENUM ('ACTIVE', 'ON_LEAVE', 'INACTIVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "catalog_status" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "resource_kind" AS ENUM ('ROOM', 'CHAIR', 'EQUIPMENT', 'MEETING_ROOM', 'TREATMENT_ROOM', 'SERVICE_BAY', 'OTHER');

-- CreateEnum
CREATE TYPE "resource_status" AS ENUM ('ACTIVE', 'OUT_OF_SERVICE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "customer_status" AS ENUM ('ACTIVE', 'BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('MARKETING_EMAIL', 'MARKETING_SMS', 'DATA_PROCESSING', 'APPOINTMENT_REMINDERS');

-- CreateEnum
CREATE TYPE "time_off_type" AS ENUM ('VACATION', 'SICK', 'UNPAID', 'TRAINING', 'PUBLIC_HOLIDAY', 'OTHER');

-- CreateEnum
CREATE TYPE "time_off_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('HOLD', 'PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED');

-- CreateEnum
CREATE TYPE "appointment_payment_status" AS ENUM ('UNPAID', 'DEPOSIT_PAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOID');

-- CreateEnum
CREATE TYPE "booking_source" AS ENUM ('ONLINE', 'WALK_IN', 'PHONE', 'STAFF', 'API', 'IMPORT');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('PLATFORM_USER', 'COMPANY_USER', 'CUSTOMER', 'SYSTEM', 'API_KEY');

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'ONLINE', 'GIFT_CARD', 'WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_purpose" AS ENUM ('BOOKING', 'DEPOSIT', 'BALANCE', 'NO_SHOW_FEE', 'CANCELLATION_FEE', 'GIFT_CARD_PURCHASE', 'TIP', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "refund_destination" AS ENUM ('ORIGINAL_METHOD', 'GIFT_CARD', 'CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID', 'CREDITED');

-- CreateEnum
CREATE TYPE "ledger_account" AS ENUM ('REVENUE', 'TAX_PAYABLE', 'CASH_CLEARING', 'CARD_CLEARING', 'BANK_CLEARING', 'ONLINE_CLEARING', 'GIFT_CARD_LIABILITY', 'DEPOSITS_HELD', 'DISCOUNT', 'REFUNDS', 'PROCESSING_FEES', 'TIPS', 'ROUNDING');

-- CreateEnum
CREATE TYPE "discount_type" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SERVICE');

-- CreateEnum
CREATE TYPE "promotion_status" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "coupon_status" AS ENUM ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "gift_card_status" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'DEPLETED', 'EXPIRED', 'VOID');

-- CreateEnum
CREATE TYPE "gift_card_transaction_type" AS ENUM ('ISSUE', 'REDEEM', 'REFUND', 'ADJUST', 'EXPIRE', 'VOID');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL', 'SMS', 'PUSH', 'IN_APP');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING', 'CANCELLED');

-- CreateEnum
CREATE TYPE "recipient_type" AS ENUM ('CUSTOMER', 'COMPANY_USER', 'EMPLOYEE', 'PLATFORM_USER');

-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "subscription_invoice_status" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'UNCOLLECTIBLE', 'VOID');

-- CreateEnum
CREATE TYPE "usage_metric" AS ENUM ('APPOINTMENTS_CREATED', 'SMS_SENT', 'EMAILS_SENT', 'STORAGE_MB', 'ACTIVE_EMPLOYEES', 'ACTIVE_CUSTOMERS');

-- CreateEnum
CREATE TYPE "file_scan_status" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "symbol" VARCHAR(8),
    "minor_unit" SMALLINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "timezone" (
    "name" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "timezone_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "permission" (
    "key" VARCHAR(96) NOT NULL,
    "scope" "permission_scope" NOT NULL,
    "category" VARCHAR(48) NOT NULL,
    "description" VARCHAR(256) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature" (
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "value_type" "feature_value_type" NOT NULL,
    "unit" VARCHAR(24),
    "description" VARCHAR(256),

    CONSTRAINT "feature_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(128) NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "mfa_secret" VARCHAR(255),
    "mfa_enrolled_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_session" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "token_hash" VARCHAR(88) NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role" (
    "id" UUID NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "description" VARCHAR(256),
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_permission" (
    "role_id" UUID NOT NULL,
    "permission_key" VARCHAR(96) NOT NULL,

    CONSTRAINT "platform_role_permission_pkey" PRIMARY KEY ("role_id","permission_key")
);

-- CreateTable
CREATE TABLE "platform_user_role" (
    "platform_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_user_role_pkey" PRIMARY KEY ("platform_user_id","role_id")
);

-- CreateTable
CREATE TABLE "impersonation_grant" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "reason" VARCHAR(512) NOT NULL,
    "allow_writes" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impersonation_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "description" VARCHAR(512),
    "price_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "interval" "billing_interval" NOT NULL,
    "trial_days" SMALLINT NOT NULL DEFAULT 0,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entitlement" (
    "plan_id" UUID NOT NULL,
    "feature_key" VARCHAR(64) NOT NULL,
    "limit_int" INTEGER,
    "limit_bool" BOOLEAN,

    CONSTRAINT "plan_entitlement_pkey" PRIMARY KEY ("plan_id","feature_key")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status" NOT NULL DEFAULT 'TRIALING',
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "trial_ends_at" TIMESTAMPTZ(3),
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3) NOT NULL,
    "grace_ends_at" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMPTZ(3),
    "provider" VARCHAR(32),
    "provider_subscription_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_entitlement_override" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "feature_key" VARCHAR(64) NOT NULL,
    "limit_int" INTEGER,
    "limit_bool" BOOLEAN,
    "reason" VARCHAR(512) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_entitlement_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoice" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "status" "subscription_invoice_status" NOT NULL DEFAULT 'DRAFT',
    "amount_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "issued_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "attempt_count" SMALLINT NOT NULL DEFAULT 0,
    "provider_invoice_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payment" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(32),
    "provider_payment_id" VARCHAR(128),
    "failure_reason" VARCHAR(512),
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_record" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "metric" "usage_metric" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "period_key" VARCHAR(16) NOT NULL,
    "ref_type" VARCHAR(32),
    "ref_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counter" (
    "company_id" UUID NOT NULL,
    "metric" "usage_metric" NOT NULL,
    "period_key" VARCHAR(16) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usage_counter_pkey" PRIMARY KEY ("company_id","metric","period_key")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "legal_name" VARCHAR(160) NOT NULL,
    "display_name" VARCHAR(160) NOT NULL,
    "status" "company_status" NOT NULL DEFAULT 'PENDING_SETUP',
    "default_timezone_name" VARCHAR(64) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "registration_number" VARCHAR(64),
    "tax_number" VARCHAR(64),
    "contact_email" CITEXT,
    "contact_phone" VARCHAR(32),
    "suspended_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_settings" (
    "company_id" UUID NOT NULL,
    "slot_granularity_min" SMALLINT NOT NULL DEFAULT 15,
    "booking_lead_time_min" INTEGER NOT NULL DEFAULT 60,
    "max_advance_booking_days" SMALLINT NOT NULL DEFAULT 90,
    "cancellation_window_hours" SMALLINT NOT NULL DEFAULT 24,
    "hold_ttl_seconds" INTEGER NOT NULL DEFAULT 600,
    "auto_confirm_bookings" BOOLEAN NOT NULL DEFAULT true,
    "allow_online_booking" BOOLEAN NOT NULL DEFAULT true,
    "allow_customer_cancel" BOOLEAN NOT NULL DEFAULT true,
    "allow_customer_reschedule" BOOLEAN NOT NULL DEFAULT true,
    "require_deposit" BOOLEAN NOT NULL DEFAULT false,
    "deposit_percent_bps" INTEGER NOT NULL DEFAULT 0,
    "no_show_fee_percent_bps" INTEGER NOT NULL DEFAULT 0,
    "late_cancel_fee_percent_bps" INTEGER NOT NULL DEFAULT 0,
    "reminder_offsets_minutes" INTEGER[] DEFAULT ARRAY[1440, 120]::INTEGER[],
    "default_locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "company_branding" (
    "company_id" UUID NOT NULL,
    "logo_file_id" UUID,
    "favicon_file_id" UUID,
    "email_header_file_id" UUID,
    "primary_color" VARCHAR(9) NOT NULL DEFAULT '#0F6B63',
    "accent_color" VARCHAR(9) NOT NULL DEFAULT '#8A5A12',
    "background_color" VARCHAR(9) NOT NULL DEFAULT '#FFFFFF',
    "font_family" VARCHAR(96),
    "custom_css" VARCHAR(8000),
    "booking_page_headline" VARCHAR(160),
    "booking_page_blurb" VARCHAR(1000),
    "email_from_name" VARCHAR(96),
    "email_reply_to" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_branding_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "company_domain" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "hostname" VARCHAR(253) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" "domain_status" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verification_token" VARCHAR(64),
    "verified_at" TIMESTAMPTZ(3),
    "certificate_status" VARCHAR(32),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "password_hash" VARCHAR(255),
    "full_name" VARCHAR(128) NOT NULL,
    "phone" VARCHAR(32),
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "email_verified_at" TIMESTAMPTZ(3),
    "mfa_secret" VARCHAR(255),
    "mfa_enrolled_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "failed_login_count" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "token_hash" VARCHAR(88) NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_user" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "status" "user_status" NOT NULL DEFAULT 'INVITED',
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "display_name" VARCHAR(128),
    "invited_at" TIMESTAMPTZ(3),
    "joined_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "company_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_role" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "description" VARCHAR(256),
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "company_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_role_permission" (
    "company_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" VARCHAR(96) NOT NULL,

    CONSTRAINT "company_role_permission_pkey" PRIMARY KEY ("company_id","role_id","permission_key")
);

-- CreateTable
CREATE TABLE "company_user_role" (
    "company_id" UUID NOT NULL,
    "company_user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_user_role_pkey" PRIMARY KEY ("company_id","company_user_id","role_id")
);

-- CreateTable
CREATE TABLE "company_user_branch" (
    "company_id" UUID NOT NULL,
    "company_user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "company_user_branch_pkey" PRIMARY KEY ("company_id","company_user_id","branch_id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "status" "branch_status" NOT NULL DEFAULT 'ACTIVE',
    "timezone_name" VARCHAR(64) NOT NULL,
    "currency_code" CHAR(3),
    "phone" VARCHAR(32),
    "email" CITEXT,
    "address_line1" VARCHAR(160),
    "address_line2" VARCHAR(160),
    "city" VARCHAR(96),
    "district" VARCHAR(96),
    "postal_code" VARCHAR(24),
    "country_code" CHAR(2),
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_settings" (
    "branch_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "slot_granularity_min" SMALLINT,
    "booking_lead_time_min" INTEGER,
    "max_advance_booking_days" SMALLINT,
    "cancellation_window_hours" SMALLINT,
    "allow_online_booking" BOOLEAN,
    "require_deposit" BOOLEAN,
    "deposit_percent_bps" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_settings_pkey" PRIMARY KEY ("branch_id")
);

-- CreateTable
CREATE TABLE "business_hours" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "opens_at" TIME(0),
    "closes_at" TIME(0),
    "crosses_midnight" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_closure" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" VARCHAR(256) NOT NULL,
    "is_full_day" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branch_closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "user_account_id" UUID,
    "employee_code" VARCHAR(24),
    "display_name" VARCHAR(128) NOT NULL,
    "status" "employee_status" NOT NULL DEFAULT 'ACTIVE',
    "is_bookable" BOOLEAN NOT NULL DEFAULT true,
    "accepts_walk_ins" BOOLEAN NOT NULL DEFAULT true,
    "calendar_color" VARCHAR(9),
    "hired_on" DATE,
    "employment_ended_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profile" (
    "employee_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "job_title" VARCHAR(96),
    "bio" VARCHAR(2000),
    "avatar_file_id" UUID,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phone" VARCHAR(32),
    "emergency_contact" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_profile_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "employee_branch" (
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_branch_pkey" PRIMARY KEY ("company_id","employee_id","branch_id")
);

-- CreateTable
CREATE TABLE "employee_service" (
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "duration_override_min" SMALLINT,
    "price_override_minor" BIGINT,
    "proficiency" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_service_pkey" PRIMARY KEY ("company_id","employee_id","service_id")
);

-- CreateTable
CREATE TABLE "employee_schedule" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "crosses_midnight" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedule_break" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "label" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_schedule_break_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedule_exception" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID,
    "date" DATE NOT NULL,
    "is_working" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIME(0),
    "ends_at" TIME(0),
    "note" VARCHAR(256),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_schedule_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_time_off" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "time_off_type" NOT NULL,
    "status" "time_off_status" NOT NULL DEFAULT 'PENDING',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "reason" VARCHAR(512),
    "approved_by_company_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejection_reason" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_category" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(1000),
    "color" VARCHAR(9),
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "status" "catalog_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "service_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "category_id" UUID,
    "code" VARCHAR(24),
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "status" "catalog_status" NOT NULL DEFAULT 'ACTIVE',
    "duration_min" SMALLINT NOT NULL,
    "buffer_before_min" SMALLINT NOT NULL DEFAULT 0,
    "buffer_after_min" SMALLINT NOT NULL DEFAULT 0,
    "price_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "tax_rate_id" UUID,
    "capacity" SMALLINT NOT NULL DEFAULT 1,
    "requires_employee" BOOLEAN NOT NULL DEFAULT true,
    "requires_resource" BOOLEAN NOT NULL DEFAULT false,
    "is_online_bookable" BOOLEAN NOT NULL DEFAULT true,
    "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
    "deposit_minor" BIGINT,
    "color" VARCHAR(9),
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_branch" (
    "company_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "price_override_minor" BIGINT,
    "duration_override_min" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_branch_pkey" PRIMARY KEY ("company_id","service_id","branch_id")
);

-- CreateTable
CREATE TABLE "service_availability_rule" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "branch_id" UUID,
    "day_of_week" SMALLINT NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_availability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "rate_ppm" INTEGER NOT NULL,
    "is_inclusive" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "tax_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_type" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "kind" "resource_kind" NOT NULL,
    "description" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "resource_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "resource_type_id" UUID NOT NULL,
    "code" VARCHAR(24),
    "name" VARCHAR(128) NOT NULL,
    "status" "resource_status" NOT NULL DEFAULT 'ACTIVE',
    "capacity" SMALLINT NOT NULL DEFAULT 1,
    "is_bookable" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_resource_requirement" (
    "company_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "resource_type_id" UUID NOT NULL,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_resource_requirement_pkey" PRIMARY KEY ("company_id","service_id","resource_type_id")
);

-- CreateTable
CREATE TABLE "customer_identity" (
    "id" UUID NOT NULL,
    "email" CITEXT,
    "phone" VARCHAR(32),
    "full_name" VARCHAR(128),
    "password_hash" VARCHAR(255),
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(3),
    "phone_verified_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "customer_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_customer" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "customer_identity_id" UUID,
    "first_name" VARCHAR(96) NOT NULL,
    "last_name" VARCHAR(96),
    "email" CITEXT,
    "phone" VARCHAR(32),
    "birth_date" DATE,
    "gender" VARCHAR(24),
    "locale" VARCHAR(12),
    "status" "customer_status" NOT NULL DEFAULT 'ACTIVE',
    "preferred_employee_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" VARCHAR(4000),
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "total_visits" INTEGER NOT NULL DEFAULT 0,
    "total_no_shows" INTEGER NOT NULL DEFAULT 0,
    "total_spent_minor" BIGINT NOT NULL DEFAULT 0,
    "first_visit_at" TIMESTAMPTZ(3),
    "last_visit_at" TIMESTAMPTZ(3),
    "blocked_at" TIMESTAMPTZ(3),
    "blocked_reason" VARCHAR(512),
    "source" "booking_source" NOT NULL DEFAULT 'STAFF',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "company_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_customer_note" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "author_company_user_id" UUID,
    "body" VARCHAR(4000) NOT NULL,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "company_customer_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_consent" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "consent_type" NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "source" VARCHAR(64) NOT NULL,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "appointment_number" VARCHAR(24) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'PENDING',
    "payment_status" "appointment_payment_status" NOT NULL DEFAULT 'UNPAID',
    "source" "booking_source" NOT NULL DEFAULT 'ONLINE',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "booked_timezone_name" VARCHAR(64) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "customer_note" VARCHAR(2000),
    "internal_note" VARCHAR(2000),
    "created_by_type" "actor_type" NOT NULL DEFAULT 'CUSTOMER',
    "created_by_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "checked_in_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "no_show_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_type" "actor_type",
    "cancelled_by_id" UUID,
    "cancellation_reason" VARCHAR(512),
    "cancellation_fee_minor" BIGINT NOT NULL DEFAULT 0,
    "rescheduled_from_id" UUID,
    "hold_expires_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_item" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "employee_id" UUID,
    "status" "appointment_status" NOT NULL DEFAULT 'PENDING',
    "sequence" SMALLINT NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_min" SMALLINT NOT NULL,
    "buffer_before_min" SMALLINT NOT NULL DEFAULT 0,
    "buffer_after_min" SMALLINT NOT NULL DEFAULT 0,
    "reserved_range" tstzrange,
    "blocks_calendar" BOOLEAN NOT NULL DEFAULT true,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_resource" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "appointment_item_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reserved_range" tstzrange,
    "blocks_calendar" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_status_history" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "fromStatus" "appointment_status",
    "to_status" "appointment_status" NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_label" VARCHAR(160),
    "reason" VARCHAR(512),
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "employee_id" UUID,
    "status" "waitlist_status" NOT NULL DEFAULT 'WAITING',
    "desired_from" TIMESTAMPTZ(3) NOT NULL,
    "desired_to" TIMESTAMPTZ(3) NOT NULL,
    "note" VARCHAR(512),
    "offered_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "branch_id" UUID,
    "appointment_id" UUID,
    "customer_id" UUID,
    "payment_number" VARCHAR(24) NOT NULL,
    "method" "payment_method" NOT NULL,
    "purpose" "payment_purpose" NOT NULL DEFAULT 'BOOKING',
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "net_minor" BIGINT NOT NULL DEFAULT 0,
    "refunded_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "provider" VARCHAR(32),
    "provider_intent_id" VARCHAR(128),
    "provider_charge_id" VARCHAR(128),
    "idempotency_key" VARCHAR(128),
    "received_by_company_user_id" UUID,
    "failure_reason" VARCHAR(512),
    "metadata" JSONB,
    "authorized_at" TIMESTAMPTZ(3),
    "captured_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "appointment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "destination" "refund_destination" NOT NULL DEFAULT 'ORIGINAL_METHOD',
    "status" "refund_status" NOT NULL DEFAULT 'PENDING',
    "reason" VARCHAR(512) NOT NULL,
    "provider_refund_id" VARCHAR(128),
    "issued_gift_card_id" UUID,
    "requested_by_type" "actor_type" NOT NULL,
    "requested_by_id" UUID,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "issued_at" TIMESTAMPTZ(3),
    "pdf_file_id" UUID,
    "fiscal_reference" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "description" VARCHAR(256) NOT NULL,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "unit_price_minor" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_rate_ppm" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account" "ledger_account" NOT NULL,
    "debit_minor" BIGINT NOT NULL DEFAULT 0,
    "credit_minor" BIGINT NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "ref_type" VARCHAR(32) NOT NULL,
    "ref_id" UUID,
    "payment_id" UUID,
    "refund_id" UUID,
    "description" VARCHAR(256),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(1000),
    "status" "promotion_status" NOT NULL DEFAULT 'DRAFT',
    "discount_type" "discount_type" NOT NULL,
    "discount_value_bps" INTEGER,
    "discount_amount_minor" BIGINT,
    "max_discount_minor" BIGINT,
    "currency_code" CHAR(3) NOT NULL,
    "min_purchase_minor" BIGINT,
    "days_of_week" SMALLINT[] DEFAULT ARRAY[]::SMALLINT[],
    "time_from" TIME(0),
    "time_to" TIME(0),
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3),
    "new_customers_only" BOOLEAN NOT NULL DEFAULT false,
    "requires_coupon" BOOLEAN NOT NULL DEFAULT false,
    "is_auto_apply" BOOLEAN NOT NULL DEFAULT false,
    "is_stackable" BOOLEAN NOT NULL DEFAULT false,
    "priority" SMALLINT NOT NULL DEFAULT 100,
    "applies_to_channels" "booking_source"[] DEFAULT ARRAY[]::"booking_source"[],
    "max_redemptions" INTEGER,
    "max_redemptions_per_customer" SMALLINT,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_service" (
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,

    CONSTRAINT "promotion_service_pkey" PRIMARY KEY ("company_id","promotion_id","service_id")
);

-- CreateTable
CREATE TABLE "promotion_branch" (
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "promotion_branch_pkey" PRIMARY KEY ("company_id","promotion_id","branch_id")
);

-- CreateTable
CREATE TABLE "promotion_employee" (
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,

    CONSTRAINT "promotion_employee_pkey" PRIMARY KEY ("company_id","promotion_id","employee_id")
);

-- CreateTable
CREATE TABLE "promotion_customer" (
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,

    CONSTRAINT "promotion_customer_pkey" PRIMARY KEY ("company_id","promotion_id","customer_id")
);

-- CreateTable
CREATE TABLE "coupon" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "code" VARCHAR(48) NOT NULL,
    "code_hash" VARCHAR(88) NOT NULL,
    "status" "coupon_status" NOT NULL DEFAULT 'ACTIVE',
    "max_redemptions" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "issued_to_customer_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemption" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "coupon_id" UUID,
    "appointment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "allocation" JSONB,
    "redeemed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code_hash" VARCHAR(88) NOT NULL,
    "code_last4" VARCHAR(4) NOT NULL,
    "pin_hash" VARCHAR(88),
    "status" "gift_card_status" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "initial_balance_minor" BIGINT NOT NULL,
    "current_balance_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "purchased_by_customer_id" UUID,
    "issued_to_customer_id" UUID,
    "purchase_payment_id" UUID,
    "branch_id" UUID,
    "recipient_name" VARCHAR(128),
    "recipient_email" CITEXT,
    "message" VARCHAR(1000),
    "issued_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "depleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gift_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gift_card_transaction" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "gift_card_id" UUID NOT NULL,
    "type" "gift_card_transaction_type" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "appointment_id" UUID,
    "payment_id" UUID,
    "performed_by_type" "actor_type" NOT NULL,
    "performed_by_id" UUID,
    "reason" VARCHAR(512),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_card_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "key" VARCHAR(64) NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "subject" VARCHAR(256),
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID,
    "channel" "notification_channel" NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "recipient_type" "recipient_type" NOT NULL,
    "recipient_id" UUID,
    "recipient_address" VARCHAR(320) NOT NULL,
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-US',
    "subject" VARCHAR(256),
    "body_preview" VARCHAR(512),
    "payload" JSONB,
    "appointment_id" UUID,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "failure_reason" VARCHAR(1000),
    "retry_count" SMALLINT NOT NULL DEFAULT 0,
    "max_retries" SMALLINT NOT NULL DEFAULT 3,
    "next_retry_at" TIMESTAMPTZ(3),
    "provider" VARCHAR(32),
    "provider_message_id" VARCHAR(128),
    "dedupe_key" VARCHAR(160),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "subject_type" "recipient_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "type" VARCHAR(64),
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "company_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "actor_label" VARCHAR(160) NOT NULL,
    "impersonation_grant_id" UUID,
    "action" VARCHAR(96) NOT NULL,
    "resource_type" VARCHAR(48) NOT NULL,
    "resource_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "request_id" UUID,
    "prev_hash" BYTEA,
    "row_hash" BYTEA NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id","occurred_at")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "type" VARCHAR(96) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "key" VARCHAR(160) NOT NULL,
    "endpoint" VARCHAR(160) NOT NULL,
    "request_hash" VARCHAR(88) NOT NULL,
    "status_code" SMALLINT,
    "response_body" JSONB,
    "locked_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "file_name" VARCHAR(256) NOT NULL,
    "mime_type" VARCHAR(128) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum" VARCHAR(88) NOT NULL,
    "scan_status" "file_scan_status" NOT NULL DEFAULT 'PENDING',
    "scanned_at" TIMESTAMPTZ(3),
    "uploaded_by_type" "actor_type" NOT NULL,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permission_scope_category_idx" ON "permission"("scope", "category");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE INDEX "platform_user_status_idx" ON "platform_user"("status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_session_token_hash_key" ON "platform_session"("token_hash");

-- CreateIndex
CREATE INDEX "platform_session_platform_user_id_idx" ON "platform_session"("platform_user_id");

-- CreateIndex
CREATE INDEX "platform_session_family_id_idx" ON "platform_session"("family_id");

-- CreateIndex
CREATE INDEX "platform_session_expires_at_idx" ON "platform_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_key_key" ON "platform_role"("key");

-- CreateIndex
CREATE INDEX "impersonation_grant_company_id_expires_at_idx" ON "impersonation_grant"("company_id", "expires_at");

-- CreateIndex
CREATE INDEX "impersonation_grant_platform_user_id_created_at_idx" ON "impersonation_grant"("platform_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "plan_key_key" ON "plan"("key");

-- CreateIndex
CREATE INDEX "plan_is_public_sort_order_idx" ON "plan"("is_public", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_company_id_key" ON "subscription"("company_id");

-- CreateIndex
CREATE INDEX "subscription_status_current_period_end_idx" ON "subscription"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscription_provider_subscription_id_idx" ON "subscription"("provider_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_company_id_id_key" ON "subscription"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_entitlement_override_company_id_feature_key_key" ON "subscription_entitlement_override"("company_id", "feature_key");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_entitlement_override_company_id_id_key" ON "subscription_entitlement_override"("company_id", "id");

-- CreateIndex
CREATE INDEX "subscription_invoice_company_id_status_due_at_idx" ON "subscription_invoice"("company_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoice_company_id_number_key" ON "subscription_invoice"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoice_company_id_id_key" ON "subscription_invoice"("company_id", "id");

-- CreateIndex
CREATE INDEX "subscription_payment_company_id_status_idx" ON "subscription_payment"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payment_company_id_id_key" ON "subscription_payment"("company_id", "id");

-- CreateIndex
CREATE INDEX "usage_record_company_id_metric_period_key_idx" ON "usage_record"("company_id", "metric", "period_key");

-- CreateIndex
CREATE INDEX "usage_record_company_id_occurred_at_idx" ON "usage_record"("company_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_slug_key" ON "company"("slug");

-- CreateIndex
CREATE INDEX "company_status_idx" ON "company"("status");

-- CreateIndex
CREATE UNIQUE INDEX "company_domain_hostname_key" ON "company_domain"("hostname");

-- CreateIndex
CREATE INDEX "company_domain_company_id_status_idx" ON "company_domain"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_domain_company_id_id_key" ON "company_domain"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE INDEX "user_account_status_idx" ON "user_account"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");

-- CreateIndex
CREATE INDEX "user_session_user_account_id_idx" ON "user_session"("user_account_id");

-- CreateIndex
CREATE INDEX "user_session_family_id_idx" ON "user_session"("family_id");

-- CreateIndex
CREATE INDEX "user_session_expires_at_idx" ON "user_session"("expires_at");

-- CreateIndex
CREATE INDEX "company_user_user_account_id_idx" ON "company_user"("user_account_id");

-- CreateIndex
CREATE INDEX "company_user_company_id_status_idx" ON "company_user"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_user_company_id_user_account_id_key" ON "company_user"("company_id", "user_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_user_company_id_id_key" ON "company_user"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "company_role_company_id_id_key" ON "company_role"("company_id", "id");

-- CreateIndex
CREATE INDEX "branch_company_id_status_idx" ON "branch"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "branch_company_id_id_key" ON "branch"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_settings_company_id_branch_id_key" ON "branch_settings"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "business_hours_company_id_branch_id_day_of_week_idx" ON "business_hours"("company_id", "branch_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "business_hours_company_id_branch_id_day_of_week_effective_f_key" ON "business_hours"("company_id", "branch_id", "day_of_week", "effective_from");

-- CreateIndex
CREATE INDEX "branch_closure_company_id_branch_id_starts_at_idx" ON "branch_closure"("company_id", "branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "employee_company_id_status_idx" ON "employee"("company_id", "status");

-- CreateIndex
CREATE INDEX "employee_company_id_is_bookable_idx" ON "employee"("company_id", "is_bookable");

-- CreateIndex
CREATE UNIQUE INDEX "employee_company_id_id_key" ON "employee"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_profile_company_id_employee_id_key" ON "employee_profile"("company_id", "employee_id");

-- CreateIndex
CREATE INDEX "employee_branch_company_id_branch_id_idx" ON "employee_branch"("company_id", "branch_id");

-- CreateIndex
CREATE INDEX "employee_service_company_id_service_id_idx" ON "employee_service"("company_id", "service_id");

-- CreateIndex
CREATE INDEX "employee_schedule_company_id_employee_id_day_of_week_effect_idx" ON "employee_schedule"("company_id", "employee_id", "day_of_week", "effective_from");

-- CreateIndex
CREATE INDEX "employee_schedule_company_id_branch_id_day_of_week_idx" ON "employee_schedule"("company_id", "branch_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "employee_schedule_company_id_id_key" ON "employee_schedule"("company_id", "id");

-- CreateIndex
CREATE INDEX "employee_schedule_break_company_id_schedule_id_idx" ON "employee_schedule_break"("company_id", "schedule_id");

-- CreateIndex
CREATE INDEX "employee_schedule_exception_company_id_date_idx" ON "employee_schedule_exception"("company_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_schedule_exception_company_id_employee_id_date_key" ON "employee_schedule_exception"("company_id", "employee_id", "date");

-- CreateIndex
CREATE INDEX "employee_time_off_company_id_employee_id_starts_at_ends_at_idx" ON "employee_time_off"("company_id", "employee_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "employee_time_off_company_id_status_idx" ON "employee_time_off"("company_id", "status");

-- CreateIndex
CREATE INDEX "service_category_company_id_status_sort_order_idx" ON "service_category"("company_id", "status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "service_category_company_id_id_key" ON "service_category"("company_id", "id");

-- CreateIndex
CREATE INDEX "service_company_id_status_category_id_idx" ON "service"("company_id", "status", "category_id");

-- CreateIndex
CREATE INDEX "service_company_id_is_online_bookable_idx" ON "service"("company_id", "is_online_bookable");

-- CreateIndex
CREATE UNIQUE INDEX "service_company_id_id_key" ON "service"("company_id", "id");

-- CreateIndex
CREATE INDEX "service_branch_company_id_branch_id_is_available_idx" ON "service_branch"("company_id", "branch_id", "is_available");

-- CreateIndex
CREATE INDEX "service_availability_rule_company_id_service_id_day_of_week_idx" ON "service_availability_rule"("company_id", "service_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_company_id_id_key" ON "tax_rate"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_type_company_id_id_key" ON "resource_type"("company_id", "id");

-- CreateIndex
CREATE INDEX "resource_company_id_branch_id_status_idx" ON "resource"("company_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "resource_company_id_resource_type_id_idx" ON "resource"("company_id", "resource_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_company_id_id_key" ON "resource"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identity_email_key" ON "customer_identity"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identity_phone_key" ON "customer_identity"("phone");

-- CreateIndex
CREATE INDEX "company_customer_company_id_status_idx" ON "company_customer"("company_id", "status");

-- CreateIndex
CREATE INDEX "company_customer_company_id_phone_idx" ON "company_customer"("company_id", "phone");

-- CreateIndex
CREATE INDEX "company_customer_company_id_email_idx" ON "company_customer"("company_id", "email");

-- CreateIndex
CREATE INDEX "company_customer_company_id_last_visit_at_idx" ON "company_customer"("company_id", "last_visit_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_customer_company_id_customer_identity_id_key" ON "company_customer"("company_id", "customer_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_customer_company_id_id_key" ON "company_customer"("company_id", "id");

-- CreateIndex
CREATE INDEX "company_customer_note_company_id_customer_id_created_at_idx" ON "company_customer_note"("company_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_consent_company_id_customer_id_type_idx" ON "customer_consent"("company_id", "customer_id", "type");

-- CreateIndex
CREATE INDEX "appointment_company_id_branch_id_starts_at_idx" ON "appointment"("company_id", "branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_company_id_customer_id_starts_at_idx" ON "appointment"("company_id", "customer_id", "starts_at" DESC);

-- CreateIndex
CREATE INDEX "appointment_company_id_status_starts_at_idx" ON "appointment"("company_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_company_id_payment_status_idx" ON "appointment"("company_id", "payment_status");

-- CreateIndex
CREATE INDEX "appointment_hold_expires_at_idx" ON "appointment"("hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_company_id_appointment_number_key" ON "appointment"("company_id", "appointment_number");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_company_id_id_key" ON "appointment"("company_id", "id");

-- CreateIndex
CREATE INDEX "appointment_item_company_id_appointment_id_idx" ON "appointment_item"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "appointment_item_company_id_employee_id_starts_at_idx" ON "appointment_item"("company_id", "employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_item_company_id_service_id_starts_at_idx" ON "appointment_item"("company_id", "service_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_item_company_id_branch_id_starts_at_idx" ON "appointment_item"("company_id", "branch_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_item_company_id_id_key" ON "appointment_item"("company_id", "id");

-- CreateIndex
CREATE INDEX "appointment_resource_company_id_resource_id_starts_at_idx" ON "appointment_resource"("company_id", "resource_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_resource_company_id_appointment_item_id_idx" ON "appointment_resource"("company_id", "appointment_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_resource_company_id_id_key" ON "appointment_resource"("company_id", "id");

-- CreateIndex
CREATE INDEX "appointment_status_history_company_id_appointment_id_change_idx" ON "appointment_status_history"("company_id", "appointment_id", "changed_at");

-- CreateIndex
CREATE INDEX "waitlist_entry_company_id_status_desired_from_idx" ON "waitlist_entry"("company_id", "status", "desired_from");

-- CreateIndex
CREATE INDEX "waitlist_entry_company_id_customer_id_idx" ON "waitlist_entry"("company_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_key_key" ON "payment"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_company_id_appointment_id_idx" ON "payment"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "payment_company_id_created_at_idx" ON "payment"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_company_id_status_method_idx" ON "payment"("company_id", "status", "method");

-- CreateIndex
CREATE INDEX "payment_company_id_customer_id_idx" ON "payment"("company_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_company_id_payment_number_key" ON "payment"("company_id", "payment_number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_company_id_id_key" ON "payment"("company_id", "id");

-- CreateIndex
CREATE INDEX "refund_company_id_payment_id_idx" ON "refund"("company_id", "payment_id");

-- CreateIndex
CREATE INDEX "refund_company_id_status_idx" ON "refund"("company_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "refund_company_id_id_key" ON "refund"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_appointment_id_key" ON "invoice"("appointment_id");

-- CreateIndex
CREATE INDEX "invoice_company_id_issued_at_idx" ON "invoice"("company_id", "issued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_company_id_number_key" ON "invoice"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_company_id_id_key" ON "invoice"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_company_id_appointment_id_key" ON "invoice"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "invoice_line_company_id_invoice_id_idx" ON "invoice_line"("company_id", "invoice_id");

-- CreateIndex
CREATE INDEX "ledger_entry_company_id_occurred_at_idx" ON "ledger_entry"("company_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entry_company_id_account_occurred_at_idx" ON "ledger_entry"("company_id", "account", "occurred_at");

-- CreateIndex
CREATE INDEX "ledger_entry_journal_id_idx" ON "ledger_entry"("journal_id");

-- CreateIndex
CREATE INDEX "promotion_company_id_status_starts_at_ends_at_idx" ON "promotion"("company_id", "status", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "promotion_company_id_is_auto_apply_status_idx" ON "promotion"("company_id", "is_auto_apply", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_company_id_id_key" ON "promotion"("company_id", "id");

-- CreateIndex
CREATE INDEX "promotion_service_company_id_service_id_idx" ON "promotion_service"("company_id", "service_id");

-- CreateIndex
CREATE INDEX "promotion_customer_company_id_customer_id_idx" ON "promotion_customer"("company_id", "customer_id");

-- CreateIndex
CREATE INDEX "coupon_company_id_code_hash_idx" ON "coupon"("company_id", "code_hash");

-- CreateIndex
CREATE INDEX "coupon_company_id_promotion_id_idx" ON "coupon"("company_id", "promotion_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_company_id_code_key" ON "coupon"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_company_id_id_key" ON "coupon"("company_id", "id");

-- CreateIndex
CREATE INDEX "promotion_redemption_company_id_customer_id_idx" ON "promotion_redemption"("company_id", "customer_id");

-- CreateIndex
CREATE INDEX "promotion_redemption_company_id_promotion_id_idx" ON "promotion_redemption"("company_id", "promotion_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemption_company_id_promotion_id_appointment_id_key" ON "promotion_redemption"("company_id", "promotion_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_code_hash_key" ON "gift_card"("code_hash");

-- CreateIndex
CREATE INDEX "gift_card_company_id_status_idx" ON "gift_card"("company_id", "status");

-- CreateIndex
CREATE INDEX "gift_card_company_id_issued_to_customer_id_idx" ON "gift_card"("company_id", "issued_to_customer_id");

-- CreateIndex
CREATE INDEX "gift_card_company_id_expires_at_idx" ON "gift_card"("company_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "gift_card_company_id_id_key" ON "gift_card"("company_id", "id");

-- CreateIndex
CREATE INDEX "gift_card_transaction_company_id_gift_card_id_occurred_at_idx" ON "gift_card_transaction"("company_id", "gift_card_id", "occurred_at");

-- CreateIndex
CREATE INDEX "gift_card_transaction_company_id_appointment_id_idx" ON "gift_card_transaction"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "notification_template_key_channel_locale_idx" ON "notification_template"("key", "channel", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_company_id_key_channel_locale_key" ON "notification_template"("company_id", "key", "channel", "locale");

-- CreateIndex
CREATE INDEX "notification_status_scheduled_for_idx" ON "notification"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "notification_company_id_created_at_idx" ON "notification"("company_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_company_id_appointment_id_idx" ON "notification"("company_id", "appointment_id");

-- CreateIndex
CREATE INDEX "notification_company_id_recipient_type_recipient_id_idx" ON "notification"("company_id", "recipient_type", "recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_company_id_dedupe_key_key" ON "notification"("company_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_preference_company_id_subject_type_subject_id_idx" ON "notification_preference"("company_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_company_id_subject_type_subject_id__key" ON "notification_preference"("company_id", "subject_type", "subject_id", "channel", "type");

-- CreateIndex
CREATE INDEX "audit_log_company_id_occurred_at_idx" ON "audit_log"("company_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_company_id_resource_type_resource_id_idx" ON "audit_log"("company_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_actor_id_occurred_at_idx" ON "audit_log"("company_id", "actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_company_id_action_occurred_at_idx" ON "audit_log"("company_id", "action", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_event_status_occurred_at_idx" ON "outbox_event"("status", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_event_company_id_type_occurred_at_idx" ON "outbox_event"("company_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_company_id_key_key" ON "idempotency_key"("company_id", "key");

-- CreateIndex
CREATE INDEX "file_company_id_scan_status_idx" ON "file"("company_id", "scan_status");

-- CreateIndex
CREATE UNIQUE INDEX "file_company_id_id_key" ON "file"("company_id", "id");

-- AddForeignKey
ALTER TABLE "platform_session" ADD CONSTRAINT "platform_session_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_role_permission" ADD CONSTRAINT "platform_role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_role"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_role_permission" ADD CONSTRAINT "platform_role_permission_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permission"("key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_user_role" ADD CONSTRAINT "platform_user_role_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "platform_user_role" ADD CONSTRAINT "platform_user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "platform_role"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "impersonation_grant" ADD CONSTRAINT "impersonation_grant_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "impersonation_grant" ADD CONSTRAINT "impersonation_grant_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "plan" ADD CONSTRAINT "plan_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature"("key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_entitlement_override" ADD CONSTRAINT "subscription_entitlement_override_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_entitlement_override" ADD CONSTRAINT "subscription_entitlement_override_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature"("key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_company_id_subscription_id_fkey" FOREIGN KEY ("company_id", "subscription_id") REFERENCES "subscription"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_invoice" ADD CONSTRAINT "subscription_invoice_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "subscription_invoice"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usage_counter" ADD CONSTRAINT "usage_counter_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_default_timezone_name_fkey" FOREIGN KEY ("default_timezone_name") REFERENCES "timezone"("name") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company" ADD CONSTRAINT "company_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_branding" ADD CONSTRAINT "company_branding_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_branding" ADD CONSTRAINT "company_branding_company_id_logo_file_id_fkey" FOREIGN KEY ("company_id", "logo_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_branding" ADD CONSTRAINT "company_branding_company_id_favicon_file_id_fkey" FOREIGN KEY ("company_id", "favicon_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_branding" ADD CONSTRAINT "company_branding_company_id_email_header_file_id_fkey" FOREIGN KEY ("company_id", "email_header_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_domain" ADD CONSTRAINT "company_domain_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user" ADD CONSTRAINT "company_user_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user" ADD CONSTRAINT "company_user_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_account"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_role" ADD CONSTRAINT "company_role_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_role_permission" ADD CONSTRAINT "company_role_permission_company_id_role_id_fkey" FOREIGN KEY ("company_id", "role_id") REFERENCES "company_role"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_role_permission" ADD CONSTRAINT "company_role_permission_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permission"("key") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user_role" ADD CONSTRAINT "company_user_role_company_id_company_user_id_fkey" FOREIGN KEY ("company_id", "company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user_role" ADD CONSTRAINT "company_user_role_company_id_role_id_fkey" FOREIGN KEY ("company_id", "role_id") REFERENCES "company_role"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user_branch" ADD CONSTRAINT "company_user_branch_company_id_company_user_id_fkey" FOREIGN KEY ("company_id", "company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_user_branch" ADD CONSTRAINT "company_user_branch_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_timezone_name_fkey" FOREIGN KEY ("timezone_name") REFERENCES "timezone"("name") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch_settings" ADD CONSTRAINT "branch_settings_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "branch_closure" ADD CONSTRAINT "branch_closure_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_profile" ADD CONSTRAINT "employee_profile_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_profile" ADD CONSTRAINT "employee_profile_company_id_avatar_file_id_fkey" FOREIGN KEY ("company_id", "avatar_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_branch" ADD CONSTRAINT "employee_branch_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_branch" ADD CONSTRAINT "employee_branch_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_schedule" ADD CONSTRAINT "employee_schedule_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_schedule" ADD CONSTRAINT "employee_schedule_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_schedule_break" ADD CONSTRAINT "employee_schedule_break_company_id_schedule_id_fkey" FOREIGN KEY ("company_id", "schedule_id") REFERENCES "employee_schedule"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_schedule_exception" ADD CONSTRAINT "employee_schedule_exception_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_company_id_approved_by_company_user_id_fkey" FOREIGN KEY ("company_id", "approved_by_company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_company_id_parent_id_fkey" FOREIGN KEY ("company_id", "parent_id") REFERENCES "service_category"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_company_id_category_id_fkey" FOREIGN KEY ("company_id", "category_id") REFERENCES "service_category"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_company_id_tax_rate_id_fkey" FOREIGN KEY ("company_id", "tax_rate_id") REFERENCES "tax_rate"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_branch" ADD CONSTRAINT "service_branch_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_branch" ADD CONSTRAINT "service_branch_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_availability_rule" ADD CONSTRAINT "service_availability_rule_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "resource_type" ADD CONSTRAINT "resource_type_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_company_id_resource_type_id_fkey" FOREIGN KEY ("company_id", "resource_type_id") REFERENCES "resource_type"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_resource_requirement" ADD CONSTRAINT "service_resource_requirement_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_resource_requirement" ADD CONSTRAINT "service_resource_requirement_company_id_resource_type_id_fkey" FOREIGN KEY ("company_id", "resource_type_id") REFERENCES "resource_type"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer" ADD CONSTRAINT "company_customer_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer" ADD CONSTRAINT "company_customer_customer_identity_id_fkey" FOREIGN KEY ("customer_identity_id") REFERENCES "customer_identity"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer" ADD CONSTRAINT "company_customer_company_id_preferred_employee_id_fkey" FOREIGN KEY ("company_id", "preferred_employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer_note" ADD CONSTRAINT "company_customer_note_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer_note" ADD CONSTRAINT "company_customer_note_company_id_author_company_user_id_fkey" FOREIGN KEY ("company_id", "author_company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_consent" ADD CONSTRAINT "customer_consent_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_booked_timezone_name_fkey" FOREIGN KEY ("booked_timezone_name") REFERENCES "timezone"("name") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_company_id_rescheduled_from_id_fkey" FOREIGN KEY ("company_id", "rescheduled_from_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_item" ADD CONSTRAINT "appointment_item_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_item" ADD CONSTRAINT "appointment_item_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_item" ADD CONSTRAINT "appointment_item_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_item" ADD CONSTRAINT "appointment_item_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_resource" ADD CONSTRAINT "appointment_resource_company_id_appointment_item_id_fkey" FOREIGN KEY ("company_id", "appointment_item_id") REFERENCES "appointment_item"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_resource" ADD CONSTRAINT "appointment_resource_company_id_resource_id_fkey" FOREIGN KEY ("company_id", "resource_id") REFERENCES "resource"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_company_id_received_by_company_user_id_fkey" FOREIGN KEY ("company_id", "received_by_company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_company_id_pdf_file_id_fkey" FOREIGN KEY ("company_id", "pdf_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_company_id_invoice_id_fkey" FOREIGN KEY ("company_id", "invoice_id") REFERENCES "invoice"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_company_id_refund_id_fkey" FOREIGN KEY ("company_id", "refund_id") REFERENCES "refund"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_service" ADD CONSTRAINT "promotion_service_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_service" ADD CONSTRAINT "promotion_service_company_id_service_id_fkey" FOREIGN KEY ("company_id", "service_id") REFERENCES "service"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_branch" ADD CONSTRAINT "promotion_branch_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_branch" ADD CONSTRAINT "promotion_branch_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_employee" ADD CONSTRAINT "promotion_employee_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_employee" ADD CONSTRAINT "promotion_employee_company_id_employee_id_fkey" FOREIGN KEY ("company_id", "employee_id") REFERENCES "employee"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_customer" ADD CONSTRAINT "promotion_customer_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_customer" ADD CONSTRAINT "promotion_customer_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_redemption" ADD CONSTRAINT "promotion_redemption_company_id_promotion_id_fkey" FOREIGN KEY ("company_id", "promotion_id") REFERENCES "promotion"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_redemption" ADD CONSTRAINT "promotion_redemption_company_id_coupon_id_fkey" FOREIGN KEY ("company_id", "coupon_id") REFERENCES "coupon"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_redemption" ADD CONSTRAINT "promotion_redemption_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "promotion_redemption" ADD CONSTRAINT "promotion_redemption_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "branch"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_company_id_purchased_by_customer_id_fkey" FOREIGN KEY ("company_id", "purchased_by_customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_company_id_issued_to_customer_id_fkey" FOREIGN KEY ("company_id", "issued_to_customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card" ADD CONSTRAINT "gift_card_company_id_purchase_payment_id_fkey" FOREIGN KEY ("company_id", "purchase_payment_id") REFERENCES "payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card_transaction" ADD CONSTRAINT "gift_card_transaction_company_id_gift_card_id_fkey" FOREIGN KEY ("company_id", "gift_card_id") REFERENCES "gift_card"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card_transaction" ADD CONSTRAINT "gift_card_transaction_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "gift_card_transaction" ADD CONSTRAINT "gift_card_transaction_company_id_payment_id_fkey" FOREIGN KEY ("company_id", "payment_id") REFERENCES "payment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_template"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_company_id_appointment_id_fkey" FOREIGN KEY ("company_id", "appointment_id") REFERENCES "appointment"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
