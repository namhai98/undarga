-- Indexes for the dashboard and reports.
--
-- Every report filters on (company_id, <time column>) first; these make that a
-- range scan instead of a filter over the company's whole history. Branch-
-- filtered appointment reports already use (company_id, branch_id, starts_at),
-- and item-level breakdowns use the existing (company_id, service_id|employee_id,
-- starts_at) indexes on appointment_item.

-- Appointments in a date range, no branch filter.
CREATE INDEX "appointment_company_id_starts_at_idx"
  ON "appointment"("company_id", "starts_at");

-- New customers by day.
CREATE INDEX "company_customer_company_id_created_at_idx"
  ON "company_customer"("company_id", "created_at");

-- Promotion usage by day.
CREATE INDEX "promotion_redemption_company_id_redeemed_at_idx"
  ON "promotion_redemption"("company_id", "redeemed_at");

-- Gift-card redemption activity (type = REDEEM / REFUND) by day.
CREATE INDEX "gift_card_transaction_company_id_type_occurred_at_idx"
  ON "gift_card_transaction"("company_id", "type", "occurred_at");

-- Gift cards issued in a date range.
CREATE INDEX "gift_card_company_id_issued_at_idx"
  ON "gift_card"("company_id", "issued_at");
