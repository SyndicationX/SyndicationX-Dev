ALTER TABLE "deal_investment" ADD COLUMN IF NOT EXISTS "commitment_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deal_investment" ADD COLUMN IF NOT EXISTS "commitment_investor_email_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deal_investment" ADD COLUMN IF NOT EXISTS "commitment_sponsor_email_sent_at" timestamp with time zone;
