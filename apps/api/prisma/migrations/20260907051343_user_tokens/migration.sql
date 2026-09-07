-- CreateEnum
CREATE TYPE "user_token_purpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');
-- CreateTable
CREATE TABLE "user_token" (
    "id" UUID NOT NULL,
    "user_account_id" UUID NOT NULL,
    "purpose" "user_token_purpose" NOT NULL,
    "token_hash" VARCHAR(88) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_token_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "user_token_token_hash_key" ON "user_token"("token_hash");
-- CreateIndex
CREATE INDEX "user_token_user_account_id_purpose_expires_at_idx" ON "user_token"("user_account_id", "purpose", "expires_at");
-- AddForeignKey
ALTER TABLE "user_token" ADD CONSTRAINT "user_token_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_account"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
