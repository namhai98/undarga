-- Security hardening (docs/SECURITY.md): lock platform accounts after repeated
-- failed sign-ins, as staff accounts already are.

ALTER TABLE "platform_user"
  ADD COLUMN "failed_login_count" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(3);

ALTER TABLE "platform_user"
  ADD CONSTRAINT "platform_user_failed_login_count_check" CHECK ("failed_login_count" >= 0);
