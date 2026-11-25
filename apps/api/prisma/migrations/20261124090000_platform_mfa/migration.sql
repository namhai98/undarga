-- Platform MFA (docs/SECURITY.md): the last TOTP time step accepted for each
-- operator. A sign-in must present a later step, so a code read over a
-- shoulder or out of a log cannot be replayed inside its 30-second window.

ALTER TABLE "platform_user"
  ADD COLUMN "mfa_last_step" BIGINT;
