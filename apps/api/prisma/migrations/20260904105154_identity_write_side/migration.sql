-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "company_invitation" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "token_hash" VARCHAR(88) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_company_user_id" UUID,
    "company_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "company_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_invitation_role" (
    "company_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "company_invitation_role_pkey" PRIMARY KEY ("company_id","invitation_id","role_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_invitation_token_hash_key" ON "company_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "company_invitation_company_id_created_at_idx" ON "company_invitation"("company_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "company_invitation_company_id_id_key" ON "company_invitation"("company_id", "id");

-- AddForeignKey
ALTER TABLE "company_invitation" ADD CONSTRAINT "company_invitation_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_invitation" ADD CONSTRAINT "company_invitation_company_id_invited_by_company_user_id_fkey" FOREIGN KEY ("company_id", "invited_by_company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_invitation" ADD CONSTRAINT "company_invitation_company_id_company_user_id_fkey" FOREIGN KEY ("company_id", "company_user_id") REFERENCES "company_user"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_invitation_role" ADD CONSTRAINT "company_invitation_role_company_id_invitation_id_fkey" FOREIGN KEY ("company_id", "invitation_id") REFERENCES "company_invitation"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_invitation_role" ADD CONSTRAINT "company_invitation_role_company_id_role_id_fkey" FOREIGN KEY ("company_id", "role_id") REFERENCES "company_role"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

