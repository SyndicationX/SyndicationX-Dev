ALTER TABLE "deal_investment"
  ADD COLUMN IF NOT EXISTS "is_draft" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "deal_member"
  ADD COLUMN IF NOT EXISTS "is_draft" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "deal_lp_investor"
  ADD COLUMN IF NOT EXISTS "is_draft" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "deal_investment"
  SET "is_draft" = true
  WHERE "contact_id" = '__portal_investment_autosave__';
