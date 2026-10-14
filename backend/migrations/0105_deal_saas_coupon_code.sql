-- One SaaS coupon redemption per deal.

ALTER TABLE "add_deal_form"
  ADD COLUMN IF NOT EXISTS "saas_coupon_code" varchar(64);

COMMENT ON COLUMN "add_deal_form"."saas_coupon_code" IS
  'Promotion code already redeemed for this deal. A deal can use a coupon only once.';
