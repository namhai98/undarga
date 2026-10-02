-- =============================================================================
--  001_hardening.sql — everything Prisma cannot express
-- =============================================================================
--  Applied by scripts/apply-hardening.js after the Prisma migration. Idempotent:
--  safe to re-run after any schema change, and it refuses to finish if a
--  company-owned table ends up without a row-security policy.
--
--  Contents
--    1.  Extensions and helper functions
--    2.  Database roles and grants
--    2z. Reset (drops constraints + triggers so the file is re-runnable)
--    3.  The reserved range (trigger-maintained)
--    4.  Exclusion constraints — the double-booking guarantee
--    5.  CHECK constraints
--    6.  Partial unique indexes (soft-delete aware)
--    7.  Partial / expression indexes
--    8.  Row-Level Security
--    9.  Triggers
--    10. audit_log partitioning
--    11. Reconciliation helpers
--
--  IMPORTANT: `prisma db push` MUST be banned, including in development — it
--  does not see any object in this file and will silently drop them.
--  Add every object here to the migrate-diff ignore list.
-- =============================================================================


-- -----------------------------------------------------------------------------
--  1. EXTENSIONS AND HELPER FUNCTIONS
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- exclusion constraints on (uuid, range)
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- customer name search
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive email

-- The single source of tenant context. Returns NULL when unset, which every
-- RLS policy treats as "see nothing".
CREATE OR REPLACE FUNCTION current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_company_id', true), '')::uuid
$$;

-- Wall clock -> instant, DST-correct. The ONLY conversion idiom in the system.
CREATE OR REPLACE FUNCTION local_to_instant(d date, t time, tz text)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT (d + t) AT TIME ZONE tz
$$;


-- -----------------------------------------------------------------------------
--  1z. AUDIT LOG PARTITIONING
--
--  Runs BEFORE roles, grants and row-level security, because recreating a table
--  discards both. `CREATE TABLE ... (LIKE ... INCLUDING ALL)` copies columns,
--  defaults, constraints and indexes — but not grants and not RLS policies.
--
--  Guarded on relkind so a re-run is a no-op. Without the guard, every
--  re-application would rename the live partitioned table, build an empty
--  replacement, and DROP the original — taking every audit partition with it.
--  That is a data-loss bug in a script an operator is expected to re-run.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'audit_log' AND c.relkind = 'r'
  ) THEN
    -- Ordinary table: this is the first run, so convert it.
    ALTER TABLE audit_log RENAME TO audit_log_unpartitioned;
    CREATE TABLE audit_log (LIKE audit_log_unpartitioned INCLUDING ALL)
      PARTITION BY RANGE (occurred_at);
    DROP TABLE audit_log_unpartitioned;
    RAISE NOTICE 'audit_log converted to a partitioned table';
  END IF;
END $$;


-- -----------------------------------------------------------------------------
--  2. ROLES AND GRANTS
-- -----------------------------------------------------------------------------

-- app_tenant   : RLS enforced. Every request. Transaction-mode pooling ONLY.
-- app_platform : BYPASSRLS. Platform module, migrations, and the two-step
--                worker claim. Separate credentials, separate pool, audited.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOINHERIT LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform NOINHERIT LOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_tenant, app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_platform;

-- The audit log is append-only for tenants at the privilege level, not merely
-- by convention.
REVOKE UPDATE, DELETE ON audit_log FROM app_tenant;

-- The platform realm is invisible to tenant connections.
REVOKE ALL ON platform_user, platform_role, platform_role_permission,
              platform_user_role FROM app_tenant;

-- Reference data is read-only to everyone but migrations.
REVOKE INSERT, UPDATE, DELETE ON currency, timezone, permission, feature
  FROM app_tenant;


-- -----------------------------------------------------------------------------
--  2z. RESET
--
--  Drops every constraint and trigger this file owns, so the whole script is
--  re-runnable. Postgres has no ADD CONSTRAINT IF NOT EXISTS, and re-running
--  hardening after a schema change is routine, so the alternative is an
--  operator hand-editing SQL under pressure.
--
--  Safe because the file executes as a single implicit transaction: if
--  anything below fails, these drops roll back with it and the previous
--  hardening stays intact. Generated from the CREATE statements below.
-- -----------------------------------------------------------------------------

ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_time_order;
ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_totals_nonneg;
ALTER TABLE appointment_item DROP CONSTRAINT IF EXISTS appointment_item_duration_positive;
ALTER TABLE appointment_item DROP CONSTRAINT IF EXISTS appointment_item_employee_no_overlap;
ALTER TABLE appointment_item DROP CONSTRAINT IF EXISTS appointment_item_time_order;
ALTER TABLE appointment_resource DROP CONSTRAINT IF EXISTS appointment_resource_no_overlap;
ALTER TABLE appointment_resource DROP CONSTRAINT IF EXISTS appointment_resource_time_order;
ALTER TABLE branch_closure DROP CONSTRAINT IF EXISTS branch_closure_time_order;
ALTER TABLE business_hours DROP CONSTRAINT IF EXISTS business_hours_dow;
ALTER TABLE company_invitation DROP CONSTRAINT IF EXISTS company_invitation_terminal_state;
ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS settings_bps_range;
ALTER TABLE employee_schedule DROP CONSTRAINT IF EXISTS emp_schedule_dow;
ALTER TABLE employee_time_off DROP CONSTRAINT IF EXISTS time_off_time_order;
ALTER TABLE gift_card DROP CONSTRAINT IF EXISTS gift_card_balance_nonneg;
ALTER TABLE gift_card DROP CONSTRAINT IF EXISTS gift_card_balance_within_initial;
ALTER TABLE gift_card_transaction DROP CONSTRAINT IF EXISTS gift_card_adjust_reason;
ALTER TABLE gift_card_transaction DROP CONSTRAINT IF EXISTS gift_card_txn_sign;
ALTER TABLE ledger_entry DROP CONSTRAINT IF EXISTS ledger_nonneg;
ALTER TABLE ledger_entry DROP CONSTRAINT IF EXISTS ledger_single_sided;
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_amount_positive;
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_refund_within_amount;
ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_date_order;
ALTER TABLE promotion DROP CONSTRAINT IF EXISTS promotion_discount_shape;
ALTER TABLE refund DROP CONSTRAINT IF EXISTS refund_amount_positive;
ALTER TABLE service DROP CONSTRAINT IF EXISTS service_price_nonneg;
ALTER TABLE service_availability_rule DROP CONSTRAINT IF EXISTS svc_avail_dow;
ALTER TABLE tax_rate DROP CONSTRAINT IF EXISTS tax_rate_range;
ALTER TABLE waitlist_entry DROP CONSTRAINT IF EXISTS waitlist_time_order;
DROP TRIGGER IF EXISTS appointment_bump_version ON appointment;
DROP TRIGGER IF EXISTS appointment_item_blocks_calendar ON appointment_item;
DROP TRIGGER IF EXISTS appointment_item_reserved_range ON appointment_item;
DROP TRIGGER IF EXISTS appointment_resource_reserved_range ON appointment_resource;
DROP TRIGGER IF EXISTS appointment_status_history_append_only ON appointment_status_history;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS business_hours_midnight ON business_hours;
DROP TRIGGER IF EXISTS employee_schedule_midnight ON employee_schedule;
DROP TRIGGER IF EXISTS gift_card_transaction_append_only ON gift_card_transaction;
DROP TRIGGER IF EXISTS ledger_entry_append_only ON ledger_entry;

-- -----------------------------------------------------------------------------
--  3. THE RESERVED RANGE
--
--  `reserved_range` is the half-open interval the booking actually occupies,
--  buffers included. It is what the exclusion constraints in section 4 compare.
--
--  WHY A TRIGGER AND NOT A GENERATED COLUMN
--
--  The obvious form is a STORED generated column:
--
--      GENERATED ALWAYS AS (tstzrange(starts_at - make_interval(...), ...))
--
--  Postgres rejects it: "generation expression is not immutable" (42P17).
--  `timestamptz + interval` is only STABLE, because an interval carrying month
--  or day components resolves against the session TimeZone. Ours never does —
--  minutes are exact epoch arithmetic — but the planner cannot know that from
--  the operator alone.
--
--  Two ways out. Wrap the arithmetic in a function falsely marked IMMUTABLE,
--  or maintain the column from a trigger. The trigger is chosen: lying to the
--  planner about immutability is the kind of shortcut that is correct today and
--  silently wrong after someone edits the function, and this column backs the
--  only thing preventing double bookings.
--
--  The column itself is created by the Prisma migration (declared there as
--  Unsupported("tstzrange")), so this section only adds the trigger, backfills,
--  and enforces NOT NULL — a NULL range would silently opt a row out of the
--  exclusion constraint, since NULL never conflicts.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_appointment_item_reserved_range() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.reserved_range := tstzrange(
    NEW.starts_at - make_interval(mins => NEW.buffer_before_min),
    NEW.ends_at   + make_interval(mins => NEW.buffer_after_min),
    '[)'
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION set_appointment_resource_reserved_range() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.reserved_range := tstzrange(NEW.starts_at, NEW.ends_at, '[)');
  RETURN NEW;
END $$;

-- Backfill before the NOT NULL and the exclusion constraint below.
UPDATE appointment_item
   SET reserved_range = tstzrange(
         starts_at - make_interval(mins => buffer_before_min),
         ends_at   + make_interval(mins => buffer_after_min),
         '[)')
 WHERE reserved_range IS NULL;

UPDATE appointment_resource
   SET reserved_range = tstzrange(starts_at, ends_at, '[)')
 WHERE reserved_range IS NULL;

ALTER TABLE appointment_item     ALTER COLUMN reserved_range SET NOT NULL;
ALTER TABLE appointment_resource ALTER COLUMN reserved_range SET NOT NULL;


-- -----------------------------------------------------------------------------
--  4. EXCLUSION CONSTRAINTS — THE DOUBLE-BOOKING GUARANTEE
--
--  Application-level check-then-insert loses every race. This does not.
--  company_id leads the constraint so the GIST index stays tenant-local.
--  The predicate is the IMMUTABLE boolean blocks_calendar rather than
--  `status IN (...)`: changing an EXCLUDE predicate later requires a full table
--  rewrite under ACCESS EXCLUSIVE.
-- -----------------------------------------------------------------------------

ALTER TABLE appointment_item
  ADD CONSTRAINT appointment_item_employee_no_overlap
  EXCLUDE USING gist (
    company_id     WITH =,
    employee_id    WITH =,
    reserved_range WITH &&
  )
  WHERE (employee_id IS NOT NULL AND blocks_calendar);

ALTER TABLE appointment_resource
  ADD CONSTRAINT appointment_resource_no_overlap
  EXCLUDE USING gist (
    company_id     WITH =,
    resource_id    WITH =,
    reserved_range WITH &&
  )
  WHERE (blocks_calendar);

COMMENT ON CONSTRAINT appointment_item_employee_no_overlap ON appointment_item IS
  'The only thing preventing double booking. Violations (SQLSTATE 23P01) must be '
  'mapped to a 409 SLOT_TAKEN, never a 500. Do not drop without a maintenance window.';


-- -----------------------------------------------------------------------------
--  5. CHECK CONSTRAINTS
-- -----------------------------------------------------------------------------

-- Time ordering
ALTER TABLE appointment            ADD CONSTRAINT appointment_time_order        CHECK (ends_at > starts_at);
ALTER TABLE appointment_item       ADD CONSTRAINT appointment_item_time_order   CHECK (ends_at > starts_at);
ALTER TABLE appointment_resource   ADD CONSTRAINT appointment_resource_time_order CHECK (ends_at > starts_at);
ALTER TABLE branch_closure         ADD CONSTRAINT branch_closure_time_order     CHECK (ends_at > starts_at);
ALTER TABLE employee_time_off      ADD CONSTRAINT time_off_time_order           CHECK (ends_at > starts_at);
ALTER TABLE waitlist_entry         ADD CONSTRAINT waitlist_time_order           CHECK (desired_to > desired_from);

-- An invitation has one terminal state, not two. Status is derived from these
-- timestamps, so a row that is both accepted and revoked has no meaning and
-- would make the derivation ambiguous.
ALTER TABLE company_invitation ADD CONSTRAINT company_invitation_terminal_state
  CHECK (accepted_at IS NULL OR revoked_at IS NULL);

-- Day-of-week domain
ALTER TABLE business_hours              ADD CONSTRAINT business_hours_dow  CHECK (day_of_week BETWEEN 0 AND 6);
ALTER TABLE employee_schedule           ADD CONSTRAINT emp_schedule_dow    CHECK (day_of_week BETWEEN 0 AND 6);
ALTER TABLE service_availability_rule   ADD CONSTRAINT svc_avail_dow       CHECK (day_of_week BETWEEN 0 AND 6);

-- Money is never negative where it cannot be
ALTER TABLE payment   ADD CONSTRAINT payment_amount_positive  CHECK (amount_minor > 0);
ALTER TABLE refund    ADD CONSTRAINT refund_amount_positive   CHECK (amount_minor > 0);
ALTER TABLE service   ADD CONSTRAINT service_price_nonneg     CHECK (price_minor >= 0);
ALTER TABLE appointment ADD CONSTRAINT appointment_totals_nonneg
  CHECK (subtotal_minor >= 0 AND discount_minor >= 0 AND tax_minor >= 0
         AND total_minor >= 0 AND paid_minor >= 0 AND refunded_minor >= 0);

-- A refund can never exceed what was paid
ALTER TABLE payment ADD CONSTRAINT payment_refund_within_amount
  CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor);

-- Gift card overdraw is structurally impossible
ALTER TABLE gift_card ADD CONSTRAINT gift_card_balance_nonneg
  CHECK (current_balance_minor >= 0);
ALTER TABLE gift_card ADD CONSTRAINT gift_card_balance_within_initial
  CHECK (current_balance_minor <= initial_balance_minor + 0);  -- REFUND can top up; see note
COMMENT ON CONSTRAINT gift_card_balance_within_initial ON gift_card IS
  'Relax this if refund-to-original-card is allowed to exceed the initial load.';

-- Ledger: exactly one side per row, and no negatives
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_single_sided
  CHECK ((debit_minor = 0) <> (credit_minor = 0));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_nonneg
  CHECK (debit_minor >= 0 AND credit_minor >= 0);

-- Discount shape must match discount type
ALTER TABLE promotion ADD CONSTRAINT promotion_discount_shape CHECK (
  (discount_type = 'PERCENTAGE'   AND discount_value_bps IS NOT NULL
                                  AND discount_value_bps BETWEEN 1 AND 10000)
  OR (discount_type = 'FIXED_AMOUNT' AND discount_amount_minor IS NOT NULL
                                     AND discount_amount_minor > 0)
  OR (discount_type = 'FREE_SERVICE')
);
ALTER TABLE promotion ADD CONSTRAINT promotion_date_order
  CHECK (ends_at IS NULL OR ends_at > starts_at);

-- Gift card ADJUSTMENT must carry a reason
ALTER TABLE gift_card_transaction ADD CONSTRAINT gift_card_adjust_reason
  CHECK (type <> 'ADJUSTMENT' OR reason IS NOT NULL);

-- Transaction sign must match its type
ALTER TABLE gift_card_transaction ADD CONSTRAINT gift_card_txn_sign CHECK (
  (type IN ('ISSUE', 'REFUND')            AND amount_minor > 0)
  OR (type IN ('REDEEM', 'EXPIRE', 'VOID') AND amount_minor < 0)
  OR (type = 'ADJUSTMENT')
);

-- One appointment, one currency (v1 constraint — see docs/DATABASE.md §16.2)
CREATE OR REPLACE FUNCTION assert_item_currency_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE appt_currency char(3);
BEGIN
  SELECT currency_code INTO appt_currency
    FROM appointment WHERE id = NEW.appointment_id AND company_id = NEW.company_id;
  IF appt_currency IS NULL THEN
    RAISE EXCEPTION 'appointment % not found in company %', NEW.appointment_id, NEW.company_id;
  END IF;
  RETURN NEW;
END $$;

-- Tax rate sanity
ALTER TABLE tax_rate ADD CONSTRAINT tax_rate_range CHECK (rate_ppm BETWEEN 0 AND 1000000);

-- Deposit / fee percentages are basis points
ALTER TABLE company_settings ADD CONSTRAINT settings_bps_range CHECK (
  deposit_percent_bps BETWEEN 0 AND 10000
  AND no_show_fee_percent_bps BETWEEN 0 AND 10000
  AND late_cancel_fee_percent_bps BETWEEN 0 AND 10000
);

-- A resource-only booking must still name a service
ALTER TABLE appointment_item ADD CONSTRAINT appointment_item_duration_positive
  CHECK (duration_min > 0);

-- Plan entitlement must populate the column matching its feature value type
-- (enforced by trigger rather than CHECK, because it needs a lookup).


-- -----------------------------------------------------------------------------
--  6. PARTIAL UNIQUE INDEXES (soft-delete aware)
--  Prisma cannot express a filtered unique index, so these are created here and
--  the corresponding @@unique is deliberately OMITTED from schema.prisma.
--  Effect: a company may delete branch "DT" and later create a new "DT", while
--  the old row stays referenced by history.
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS branch_company_code_uq
  ON branch (company_id, code) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employee_company_code_uq
  ON employee (company_id, employee_code)
  WHERE deleted_at IS NULL AND employee_code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_company_code_uq
  ON service (company_id, code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_category_company_name_uq
  ON service_category (company_id, parent_id, name) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS resource_company_branch_code_uq
  ON resource (company_id, branch_id, code)
  WHERE deleted_at IS NULL AND code IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS resource_type_company_key_uq
  ON resource_type (company_id, key) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS company_role_company_key_uq
  ON company_role (company_id, key) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tax_rate_company_name_uq
  ON tax_rate (company_id, name) WHERE deleted_at IS NULL;

-- At most one LIVE invitation per address per company.
--
-- Filtered on the terminal states rather than on deleted_at (invitations are
-- not soft-deleted): re-inviting someone after they accepted, or after the
-- invitation was revoked or expired, must stay possible. Two simultaneously
-- valid tokens for one address must not — an admin who "re-sends" would
-- otherwise leave the earlier link working, and revoking the visible one would
-- not close the door.
CREATE UNIQUE INDEX IF NOT EXISTS company_invitation_live_email_uq
  ON company_invitation (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Customer contact uniqueness within a tenant, ignoring soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS company_customer_email_uq
  ON company_customer (company_id, email)
  WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS company_customer_phone_uq
  ON company_customer (company_id, phone)
  WHERE deleted_at IS NULL AND phone IS NOT NULL;

-- One coupon may be redeemed at most once per appointment.
CREATE UNIQUE INDEX IF NOT EXISTS promotion_redemption_coupon_appt_uq
  ON promotion_redemption (company_id, coupon_id, appointment_id)
  WHERE coupon_id IS NOT NULL;

-- Exactly one primary domain and one primary branch per employee.
CREATE UNIQUE INDEX IF NOT EXISTS company_domain_primary_uq
  ON company_domain (company_id) WHERE is_primary;

CREATE UNIQUE INDEX IF NOT EXISTS employee_branch_primary_uq
  ON employee_branch (company_id, employee_id) WHERE is_primary;

-- Exactly one default tax rate per company.
CREATE UNIQUE INDEX IF NOT EXISTS tax_rate_default_uq
  ON tax_rate (company_id) WHERE is_default AND deleted_at IS NULL;


-- -----------------------------------------------------------------------------
--  7. PARTIAL AND EXPRESSION INDEXES
-- -----------------------------------------------------------------------------

-- Active-booking scans skip cancelled/completed history entirely.
CREATE INDEX IF NOT EXISTS appointment_active_idx
  ON appointment (company_id, starts_at)
  WHERE status IN ('HOLD','PENDING','CONFIRMED','CHECKED_IN','IN_PROGRESS');

-- Hold sweeper. No company_id: a cross-tenant job on the platform pool.
CREATE INDEX IF NOT EXISTS appointment_hold_expiry_idx
  ON appointment (hold_expires_at) WHERE status = 'HOLD';

-- Availability subtraction reads only approved time off.
CREATE INDEX IF NOT EXISTS employee_time_off_approved_idx
  ON employee_time_off (company_id, employee_id, starts_at, ends_at)
  WHERE status = 'APPROVED';

-- Dispatcher claim queries. Both are used with FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS notification_dispatch_idx
  ON notification (scheduled_for)
  WHERE status IN ('PENDING','SCHEDULED','RETRYING');

CREATE INDEX IF NOT EXISTS outbox_unpublished_idx
  ON outbox_event (occurred_at) WHERE published_at IS NULL;

-- Customer search. Tenant-partitioned by the leading company_id predicate in
-- every query; the trigram index accelerates the name match.
CREATE INDEX IF NOT EXISTS company_customer_name_trgm_idx
  ON company_customer USING gin (
    (coalesce(first_name,'') || ' ' || coalesce(last_name,'')) gin_trgm_ops
  );

-- Live catalog only.
CREATE INDEX IF NOT EXISTS service_active_idx
  ON service (company_id, category_id) WHERE deleted_at IS NULL AND status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS employee_bookable_idx
  ON employee (company_id) WHERE deleted_at IS NULL AND is_bookable AND status = 'ACTIVE';

-- Auto-apply promotions are evaluated on every quote.
CREATE INDEX IF NOT EXISTS promotion_auto_apply_idx
  ON promotion (company_id, starts_at, ends_at)
  WHERE status = 'ACTIVE' AND is_auto_apply AND deleted_at IS NULL;

-- Sweepers.
CREATE INDEX IF NOT EXISTS idempotency_key_expiry_idx ON idempotency_key (expires_at);
CREATE INDEX IF NOT EXISTS user_session_expiry_idx    ON user_session (expires_at) WHERE revoked_at IS NULL;


-- -----------------------------------------------------------------------------
--  8. ROW-LEVEL SECURITY
--  Layer 1 of four. The hard guarantee: an application bug cannot read across
--  tenants, because the database will not return the rows.
-- -----------------------------------------------------------------------------

-- 8z. Drop every existing policy first, so this file is re-runnable.
--
--     Policies are declared here and nowhere else, so clearing them is safe and
--     makes the section idempotent as a whole rather than statement by
--     statement. The whole file runs inside one implicit transaction, so a
--     failure anywhere leaves the previous policy set intact.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT pol.polname, cls.relname
      FROM pg_policy pol
      JOIN pg_class cls ON cls.oid = pol.polrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE ns.nspname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.polname, p.relname);
  END LOOP;
END $$;

-- 8a. Standard policy for every tenant table with a NOT NULL company_id.
DO $$
DECLARE
  t text;
  -- `company` is NOT in this list: its tenant key is `id`, not `company_id`,
  -- so it gets its own policy immediately below.
  tenant_tables text[] := ARRAY[
    'company_settings','company_branding','company_domain',
    'company_role','company_role_permission','company_user','company_user_role',
    'company_user_branch','company_invitation','company_invitation_role',
    'branch','branch_settings','business_hours','branch_closure',
    'employee','employee_profile','employee_branch','employee_service',
    'employee_schedule','employee_schedule_break','employee_schedule_exception',
    'employee_time_off',
    'service_category','service','service_branch','service_availability_rule',
    'service_resource_requirement','tax_rate',
    'resource_type','resource',
    'company_customer','company_customer_note','customer_consent',
    'appointment','appointment_item','appointment_resource',
    'appointment_status_history','waitlist_entry',
    'payment','refund','invoice','invoice_line','ledger_entry',
    'promotion','promotion_service','promotion_branch','promotion_employee',
    'promotion_customer','coupon','promotion_redemption',
    'gift_card','gift_card_transaction',
    'notification','notification_preference','appointment_reminder',
    'subscription','subscription_entitlement_override','subscription_invoice',
    'subscription_payment','usage_record','usage_counter',
    'outbox_event','idempotency_key','file'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant_isolation ON %1$I
        USING (company_id = current_company_id())
        WITH CHECK (company_id = current_company_id())
    $f$, t);
  END LOOP;
END $$;

-- The tenant root filters on its own primary key.
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
ALTER TABLE company FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_tenant_isolation ON company;
CREATE POLICY company_tenant_isolation ON company
  USING (id = current_company_id())
  WITH CHECK (id = current_company_id());

-- 8b. notification_template: NULL company_id rows are platform defaults,
--     readable by every tenant, writable by none.
ALTER TABLE notification_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_template FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_template_read ON notification_template;
DROP POLICY IF EXISTS notification_template_write ON notification_template;
CREATE POLICY notification_template_read ON notification_template FOR SELECT
  USING (company_id IS NULL OR company_id = current_company_id());

CREATE POLICY notification_template_write ON notification_template
  FOR ALL
  USING (company_id = current_company_id())
  WITH CHECK (company_id = current_company_id());

-- 8c. audit_log: append-only for tenants, and platform rows (NULL company_id)
--     are invisible to them.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_read ON audit_log;
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
CREATE POLICY audit_log_read ON audit_log FOR SELECT
  USING (company_id = current_company_id());

CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (company_id = current_company_id());

-- 8d. The platform realm is closed to tenant connections outright.
--
--     `user_session` and `platform_session` are in this list even though
--     user_session belongs to the staff realm: sessions are credentials, and
--     nothing reachable from a tenant request has any reason to read them.
--     Authentication touches them on the directory/auth connection, before any
--     tenant exists. Without this, a tenant connection could enumerate every
--     session hash on the platform.
--
--     `user_token` is here for the same reason and is worse if omitted: it
--     holds password-reset and email-verification tokens. A tenant connection
--     able to read it could reset any account on the platform.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_user','platform_role',
                           'platform_role_permission','platform_user_role',
                           'impersonation_grant','platform_session',
                           'user_session','user_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %1$I_deny_tenants ON %1$I USING (false)', t);
  END LOOP;
END $$;

-- 8e. user_account and customer_identity are global. A tenant reaches them only
--     through its own company_user / company_customer rows, so the policy is an
--     EXISTS against a table that is itself RLS-filtered.
ALTER TABLE user_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_account FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_account_via_membership ON user_account;
CREATE POLICY user_account_via_membership ON user_account FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM company_user cu
     WHERE cu.user_account_id = user_account.id
       AND cu.company_id = current_company_id()
  ));

ALTER TABLE customer_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_identity_via_profile ON customer_identity;
CREATE POLICY customer_identity_via_profile ON customer_identity FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM company_customer cc
     WHERE cc.customer_identity_id = customer_identity.id
       AND cc.company_id = current_company_id()
  ));
-- Tenants may never write the global identity.
REVOKE INSERT, UPDATE, DELETE ON customer_identity FROM app_tenant;

-- 8f. Reference and plan data: readable by all, written only by migrations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['currency','timezone','permission','feature',
                           'plan','plan_entitlement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %1$I_read_all ON %1$I FOR SELECT USING (true)', t);
  END LOOP;
END $$;


-- -----------------------------------------------------------------------------
--  9. TRIGGERS
-- -----------------------------------------------------------------------------

-- 9a. Overnight-shift flag, so the availability materializer never has to guess.
CREATE OR REPLACE FUNCTION set_crosses_midnight() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.crosses_midnight :=
    NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL AND NEW.ends_at <= NEW.starts_at;
  RETURN NEW;
END $$;

CREATE TRIGGER employee_schedule_midnight
  BEFORE INSERT OR UPDATE ON employee_schedule
  FOR EACH ROW EXECUTE FUNCTION set_crosses_midnight();

CREATE OR REPLACE FUNCTION set_hours_crosses_midnight() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.crosses_midnight :=
    NEW.opens_at IS NOT NULL AND NEW.closes_at IS NOT NULL AND NEW.closes_at <= NEW.opens_at;
  RETURN NEW;
END $$;

CREATE TRIGGER business_hours_midnight
  BEFORE INSERT OR UPDATE ON business_hours
  FOR EACH ROW EXECUTE FUNCTION set_hours_crosses_midnight();

-- 9b. blocks_calendar is derived from status, never set by hand. This keeps the
--     exclusion-constraint predicate honest without making it status-dependent.
CREATE OR REPLACE FUNCTION sync_blocks_calendar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.blocks_calendar :=
    NEW.status IN ('HOLD','PENDING','CONFIRMED','CHECKED_IN','IN_PROGRESS');
  RETURN NEW;
END $$;

-- Fires on every INSERT/UPDATE, not just UPDATE OF status: reserved_range also
-- depends on starts_at, ends_at and the buffers, and a partial column list here
-- would let a reschedule move the times while leaving the reserved range — and
-- therefore the overlap check — pointing at the old slot.
CREATE TRIGGER appointment_item_blocks_calendar
  BEFORE INSERT OR UPDATE ON appointment_item
  FOR EACH ROW EXECUTE FUNCTION sync_blocks_calendar();

CREATE TRIGGER appointment_item_reserved_range
  BEFORE INSERT OR UPDATE ON appointment_item
  FOR EACH ROW EXECUTE FUNCTION set_appointment_item_reserved_range();

CREATE TRIGGER appointment_resource_reserved_range
  BEFORE INSERT OR UPDATE ON appointment_resource
  FOR EACH ROW EXECUTE FUNCTION set_appointment_resource_reserved_range();

-- 9c. The audit log is immutable. Privileges already prevent this for
--     app_tenant; the trigger stops it for everyone, including a superuser
--     running an ad-hoc UPDATE.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END $$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- 9d. Ledger and gift-card transactions are likewise append-only.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER gift_card_transaction_append_only
  BEFORE UPDATE OR DELETE ON gift_card_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER appointment_status_history_append_only
  BEFORE UPDATE OR DELETE ON appointment_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 9e. Optimistic locking: bump the version on every appointment write.
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER appointment_bump_version
  BEFORE UPDATE ON appointment
  FOR EACH ROW EXECUTE FUNCTION bump_version();


-- -----------------------------------------------------------------------------
--  10. AUDIT LOG PARTITIONING
--  MUST be created partitioned in the FIRST migration — converting later
--  requires a full rewrite. A missing partition is an INSERT failure, which
--  would block every audited action, so next month's partition is pre-created
--  by a scheduled job.
-- -----------------------------------------------------------------------------

-- The conversion itself has MOVED to section 1z, before roles and RLS.
--
-- It has to run first. `CREATE TABLE ... (LIKE ... INCLUDING ALL)` copies
-- columns, defaults, constraints and indexes — but NOT grants and NOT row
-- security policies. Converting the table here, after sections 2 and 8, threw
-- both away silently: the new partitioned `audit_log` came out ungranted and
-- unprotected, and the only symptom was the CI check in section 11 reporting a
-- table with no policy.
--
-- Only the partition helper remains here.

CREATE OR REPLACE FUNCTION ensure_audit_partition(target date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  start_date date := date_trunc('month', target)::date;
  end_date   date := (date_trunc('month', target) + interval '1 month')::date;
  part_name  text := format('audit_log_%s', to_char(start_date, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name, start_date, end_date);
  END IF;

  -- RLS ON THE PARTITION IS NOT OPTIONAL.
  --
  -- Postgres applies the PARENT's policies when a row is reached through the
  -- parent, but a partition queried DIRECTLY is governed by its own policies.
  -- A partition with RLS disabled is therefore a complete bypass:
  -- `SELECT * FROM audit_log_2026_09` would return every tenant's rows.
  --
  -- Enabling RLS with no policy denies direct access outright, which is what we
  -- want: all reads must go through `audit_log`.
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part_name);
END $$;

SELECT ensure_audit_partition(CURRENT_DATE);
SELECT ensure_audit_partition((CURRENT_DATE + interval '1 month')::date);


-- -----------------------------------------------------------------------------
--  11. RECONCILIATION HELPERS
--  Read-only checks run nightly. They do not repair; they report, because a
--  self-healing money system hides the bug that caused the drift.
-- -----------------------------------------------------------------------------

-- Every journal must balance to zero.
CREATE OR REPLACE VIEW unbalanced_journals AS
  SELECT company_id, journal_id, currency_code,
         SUM(debit_minor) AS total_debit,
         SUM(credit_minor) AS total_credit
    FROM ledger_entry
   GROUP BY company_id, journal_id, currency_code
  HAVING SUM(debit_minor) <> SUM(credit_minor);

-- The cached gift card balance must equal the ledger.
CREATE OR REPLACE VIEW gift_card_balance_drift AS
  SELECT g.company_id, g.id AS gift_card_id,
         g.current_balance_minor AS cached,
         COALESCE(SUM(t.amount_minor), 0) AS derived
    FROM gift_card g
    LEFT JOIN gift_card_transaction t
      ON t.gift_card_id = g.id AND t.company_id = g.company_id
   GROUP BY g.company_id, g.id, g.current_balance_minor
  HAVING g.current_balance_minor <> COALESCE(SUM(t.amount_minor), 0);

-- appointment.paid_minor must equal the sum of successful payments.
CREATE OR REPLACE VIEW appointment_payment_drift AS
  SELECT a.company_id, a.id AS appointment_id,
         a.paid_minor AS cached,
         COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status = 'SUCCEEDED'), 0) AS derived
    FROM appointment a
    LEFT JOIN payment p ON p.appointment_id = a.id AND p.company_id = a.company_id
   GROUP BY a.company_id, a.id, a.paid_minor
  HAVING a.paid_minor <> COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status = 'SUCCEEDED'), 0);

-- CI guard: every tenant table must have RLS enabled and a policy.
CREATE OR REPLACE VIEW tables_missing_rls AS
  SELECT c.relname AS table_name,
         CASE WHEN NOT c.relrowsecurity THEN 'row security disabled'
              ELSE 'row security enabled but no policy' END AS reason
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id'
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT a.attisdropped
     AND (
       -- Every company-owned table must have row security switched on,
       -- partitions included: a partition read directly is governed by its own
       -- policies, so one with RLS off is a straight bypass of the parent.
       NOT c.relrowsecurity
       -- A policy is required on ordinary tables. Partitions deliberately have
       -- none — RLS enabled with no policy denies direct access, and all reads
       -- are meant to go through the parent.
       OR (NOT c.relispartition
           AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
     );

COMMENT ON VIEW tables_missing_rls IS
  'Must return zero rows. A non-empty result fails CI: a tenant table without a '
  'row-level security policy is a cross-tenant data leak waiting to be found.';
