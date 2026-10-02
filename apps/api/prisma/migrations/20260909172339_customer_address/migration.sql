-- A customer's address, as one free-text line.
--
-- Not structured like `branch.address_line1`/`city`/`postal_code`: a branch is
-- geocoded and shown on a map, while a customer address is a note for whoever
-- is driving there. Structuring it would impose one country's postal shape on
-- every tenant.
--
-- Nullable with no default, so the column add is a metadata-only operation and
-- does not rewrite the table.
ALTER TABLE "company_customer" ADD COLUMN "address" VARCHAR(512);
