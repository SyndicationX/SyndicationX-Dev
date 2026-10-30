ALTER TABLE "deal_investment" ADD COLUMN IF NOT EXISTS "investor_archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investor_deal_participation" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "add_deal_form"("id") ON DELETE CASCADE,
  "archived_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  PRIMARY KEY ("user_id", "deal_id")
);
