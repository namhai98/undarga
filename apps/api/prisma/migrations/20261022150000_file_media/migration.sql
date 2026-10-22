-- File & media management (docs/FILE-STORAGE.md).

-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "image_file_id" UUID;

-- AlterTable
ALTER TABLE "company_customer" ADD COLUMN     "photo_file_id" UUID;

-- AlterTable
ALTER TABLE "file" ADD COLUMN     "height" INTEGER,
ADD COLUMN     "purged_at" TIMESTAMPTZ(3),
ADD COLUMN     "purpose" VARCHAR(32) NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "status" VARCHAR(16) NOT NULL DEFAULT 'READY',
ADD COLUMN     "storage_provider" VARCHAR(16) NOT NULL DEFAULT 'local',
ADD COLUMN     "target_id" UUID,
ADD COLUMN     "visibility" VARCHAR(16) NOT NULL DEFAULT 'PRIVATE',
ADD COLUMN     "width" INTEGER;

-- AlterTable
ALTER TABLE "service" ADD COLUMN     "image_file_id" UUID;

-- CreateIndex
CREATE INDEX "file_company_id_purpose_target_id_idx" ON "file"("company_id", "purpose", "target_id");

-- CreateIndex
CREATE INDEX "file_status_created_at_idx" ON "file"("status", "created_at");

-- CreateIndex
CREATE INDEX "file_deleted_at_purged_at_idx" ON "file"("deleted_at", "purged_at");

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_company_id_image_file_id_fkey" FOREIGN KEY ("company_id", "image_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_company_id_image_file_id_fkey" FOREIGN KEY ("company_id", "image_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "company_customer" ADD CONSTRAINT "company_customer_company_id_photo_file_id_fkey" FOREIGN KEY ("company_id", "photo_file_id") REFERENCES "file"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Closed value sets.
ALTER TABLE "file"
  ADD CONSTRAINT "file_purpose_check" CHECK ("purpose" IN ('OTHER', 'COMPANY_LOGO', 'BRANCH_IMAGE', 'EMPLOYEE_PHOTO', 'SERVICE_IMAGE', 'CUSTOMER_PHOTO')),
  ADD CONSTRAINT "file_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'PRIVATE')),
  ADD CONSTRAINT "file_status_check" CHECK ("status" IN ('UPLOADING', 'READY')),
  ADD CONSTRAINT "file_storage_provider_check" CHECK ("storage_provider" IN ('local', 's3')),
  ADD CONSTRAINT "file_size_check" CHECK ("size_bytes" >= 0);
-- A storage key is server-generated: no traversal, no absolute paths.
ALTER TABLE "file"
  ADD CONSTRAINT "file_storage_key_check" CHECK ("storage_key" ~ '^[a-z]+/[0-9a-f-]{36}/[a-z_]+/[0-9a-f-]{36}\.[a-z0-9]{2,5}$');
