-- Seat package already paid for a deal (5, 10, or 10plus).
-- Kept beside the Stripe price so a platform-priced Price still knows what was paid.

ALTER TABLE "add_deal_form"
  ADD COLUMN IF NOT EXISTS "stripe_seat_band" varchar(16);

COMMENT ON COLUMN "add_deal_form"."stripe_seat_band" IS
  'Co-sponsor package already paid for this deal: 5, 10, or 10plus.';
