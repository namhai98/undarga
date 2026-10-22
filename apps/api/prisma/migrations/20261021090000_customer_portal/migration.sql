-- Customer portal sign-in (docs/CUSTOMER-PORTAL.md).
--
-- customer_login_code  one-time email codes, HMAC only; tenant-scoped (RLS).
-- customer_session     portal refresh sessions, rotated; tenant-scoped (RLS).

-- CreateTable
CREATE TABLE "customer_login_code" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "company_customer_id" UUID NOT NULL,
    "code_hash" VARCHAR(88) NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_login_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_session" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "company_customer_id" UUID NOT NULL,
    "customer_identity_id" UUID NOT NULL,
    "token_hash" VARCHAR(88) NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_login_code_company_id_company_customer_id_created__idx" ON "customer_login_code"("company_id", "company_customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "customer_login_code_company_id_id_key" ON "customer_login_code"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_session_token_hash_key" ON "customer_session"("token_hash");

-- CreateIndex
CREATE INDEX "customer_session_company_id_family_id_idx" ON "customer_session"("company_id", "family_id");

-- CreateIndex
CREATE INDEX "customer_session_expires_at_idx" ON "customer_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_session_company_id_id_key" ON "customer_session"("company_id", "id");

-- AddForeignKey
ALTER TABLE "customer_login_code" ADD CONSTRAINT "customer_login_code_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_login_code" ADD CONSTRAINT "customer_login_code_company_id_company_customer_id_fkey" FOREIGN KEY ("company_id", "company_customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_company_id_company_customer_id_fkey" FOREIGN KEY ("company_id", "company_customer_id") REFERENCES "company_customer"("company_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_customer_identity_id_fkey" FOREIGN KEY ("customer_identity_id") REFERENCES "customer_identity"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


ALTER TABLE "customer_login_code"
  ADD CONSTRAINT "customer_login_code_attempts_nonnegative" CHECK ("attempts" >= 0);
