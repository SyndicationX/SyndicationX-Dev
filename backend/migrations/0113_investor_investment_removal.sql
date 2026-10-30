ALTER TABLE "deal_investment"
  ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "removed_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "removal_reason" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "removal_action" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "investor_unlinked_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "investor_unlinked_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "investor_unlink_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deal_investment"
    ADD CONSTRAINT "deal_investment_removed_by_user_id_users_id_fk"
    FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deal_investment"
    ADD CONSTRAINT "deal_investment_investor_unlinked_by_user_id_users_id_fk"
    FOREIGN KEY ("investor_unlinked_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "deal_lp_investor"
  ADD COLUMN IF NOT EXISTS "removed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "removed_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "removal_reason" text DEFAULT '' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deal_lp_investor"
    ADD CONSTRAINT "deal_lp_investor_removed_by_user_id_users_id_fk"
    FOREIGN KEY ("removed_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "deal_member_removal_logs"
  ADD COLUMN IF NOT EXISTS "action" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reason" text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "affected_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "confirmed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_investment_active_deal_idx"
  ON "deal_investment" ("deal_id")
  WHERE "removed_at" IS NULL AND "investor_unlinked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_lp_investor_active_deal_idx"
  ON "deal_lp_investor" ("deal_id")
  WHERE "removed_at" IS NULL;
