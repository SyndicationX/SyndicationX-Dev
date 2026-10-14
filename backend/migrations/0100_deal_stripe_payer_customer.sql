-- Stripe Customer used when the lead sponsor pays this deal's SaaS fee.
-- Kept separate from companies.stripe_customer_id so one company's deals
-- do not share the first payer's email and Link phone.

ALTER TABLE "add_deal_form"
  ADD COLUMN IF NOT EXISTS "stripe_payer_customer_id" varchar(255);

CREATE INDEX IF NOT EXISTS "add_deal_form_stripe_payer_customer_idx"
  ON "add_deal_form" ("stripe_payer_customer_id")
  WHERE "stripe_payer_customer_id" IS NOT NULL;

COMMENT ON COLUMN "add_deal_form"."stripe_payer_customer_id" IS
  'Stripe Customer id (cus_…) for this deal''s lead-sponsor payer.';
