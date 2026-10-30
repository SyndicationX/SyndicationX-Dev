CREATE TABLE IF NOT EXISTS "user_investor_connect_bank_deletions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "stripe_connect_account_id" varchar(255) NOT NULL,
  "profile_ids" jsonb NOT NULL,
  "deleted_by_user_id" uuid NOT NULL,
  "deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_investor_connect_bank_deletions"
    ADD CONSTRAINT "user_investor_connect_bank_deletions_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_investor_connect_bank_deletions"
    ADD CONSTRAINT "user_investor_connect_bank_deletions_deleted_by_user_id_users_id_fk"
    FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_investor_connect_bank_deletions_uidx"
  ON "user_investor_connect_bank_deletions" ("user_id", "stripe_connect_account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_investor_connect_bank_deletions_user_idx"
  ON "user_investor_connect_bank_deletions" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investor_bank_account_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "action" varchar(32) NOT NULL,
  "bank_account_record_id" varchar(255) NOT NULL,
  "profile_ids" jsonb NOT NULL,
  "changes_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "investor_bank_account_audit_logs"
    ADD CONSTRAINT "investor_bank_account_audit_logs_actor_user_id_users_id_fk"
    FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "investor_bank_account_audit_logs"
    ADD CONSTRAINT "investor_bank_account_audit_logs_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investor_bank_account_audit_owner_idx"
  ON "investor_bank_account_audit_logs" ("owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investor_bank_account_audit_record_idx"
  ON "investor_bank_account_audit_logs" ("bank_account_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investor_bank_account_audit_created_idx"
  ON "investor_bank_account_audit_logs" ("created_at");
