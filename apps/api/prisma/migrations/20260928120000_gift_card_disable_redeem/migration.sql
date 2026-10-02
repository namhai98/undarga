-- Gift cards: a reversible DISABLED state, manual redemption and refund, and
-- the ledger type spelled out as ADJUSTMENT.
--
-- Everything here is additive or a rename. No row is rewritten, and the
-- append-only trigger on gift_card_transaction is untouched: new columns are
-- only ever set on INSERT.

-- 1. DISABLED: blocked from use, balance kept, reversible. VOID stays the
--    terminal write-off. Not used by anything in this migration, so adding it
--    inside the migration's transaction is safe.
ALTER TYPE "gift_card_status" ADD VALUE IF NOT EXISTS 'DISABLED';

-- 2. ADJUST -> ADJUSTMENT. A label rename: the CHECK constraints that mention
--    it store the enum member by OID and follow automatically;
--    001_hardening.sql is updated to the new spelling for the next re-apply.
ALTER TYPE "gift_card_transaction_type" RENAME VALUE 'ADJUST' TO 'ADJUSTMENT';

-- 3. Why and when a card was disabled. Cleared when it is re-enabled; the
--    audit log keeps the history.
ALTER TABLE "gift_card"
  ADD COLUMN "disabled_at" TIMESTAMPTZ(3),
  ADD COLUMN "disabled_reason" VARCHAR(512);

-- 4. Manual refunds point at the redemption they give back, so the refunds
--    against one redemption can be capped at what it took. Idempotency keys
--    make a retried redemption return the first result instead of spending
--    twice. NULLs are distinct, so rows without a key never collide.
ALTER TABLE "gift_card_transaction"
  ADD COLUMN "reverses_transaction_id" UUID,
  ADD COLUMN "idempotency_key" VARCHAR(128);

CREATE UNIQUE INDEX "gift_card_transaction_company_id_id_key"
  ON "gift_card_transaction"("company_id", "id");
CREATE UNIQUE INDEX "gift_card_transaction_company_id_idempotency_key_key"
  ON "gift_card_transaction"("company_id", "idempotency_key");
CREATE INDEX "gift_card_transaction_company_id_reverses_transaction_id_idx"
  ON "gift_card_transaction"("company_id", "reverses_transaction_id");

ALTER TABLE "gift_card_transaction"
  ADD CONSTRAINT "gift_card_transaction_company_id_reverses_transaction_id_fkey"
  FOREIGN KEY ("company_id", "reverses_transaction_id")
  REFERENCES "gift_card_transaction"("company_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 5. The giftcard:redeem permission, and the grant to the system roles that
--    already hold giftcard:issue (see SYSTEM_ROLE_PERMISSIONS). New companies
--    get it from provisioning; this backfills the existing ones.
INSERT INTO "permission" ("key", "scope", "category", "description")
VALUES ('giftcard:redeem', 'COMPANY', 'giftcard', 'giftcard:redeem')
ON CONFLICT ("key") DO NOTHING;

-- company_role_permission is under FORCE ROW LEVEL SECURITY once hardened, so
-- each company's rows are written with that company set as the tenant — the
-- same way a request would. On a fresh database (hardening not yet applied,
-- no companies) this loop does nothing.
DO $$
DECLARE c uuid;
BEGIN
  FOR c IN SELECT "id" FROM "company" LOOP
    PERFORM set_config('app.current_company_id', c::text, true);
    INSERT INTO "company_role_permission" ("company_id", "role_id", "permission_key")
    SELECT r."company_id", r."id", 'giftcard:redeem'
      FROM "company_role" r
     WHERE r."company_id" = c
       AND r."is_system"
       AND r."key" IN ('OWNER', 'ADMIN', 'BRANCH_MANAGER', 'RECEPTIONIST')
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.current_company_id', '', true);
END $$;
