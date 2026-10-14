CREATE TABLE IF NOT EXISTS "deal_member_removal_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" uuid NOT NULL,
  "removed_row_id" uuid NOT NULL,
  "removed_contact_id" text DEFAULT '' NOT NULL,
  "removed_name" text DEFAULT '' NOT NULL,
  "removed_role" text DEFAULT '' NOT NULL,
  "deleted_by_user_id" uuid NOT NULL,
  "deleted_by_name" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deal_member_removal_logs"
    ADD CONSTRAINT "deal_member_removal_logs_deal_id_add_deal_form_id_fk"
    FOREIGN KEY ("deal_id") REFERENCES "public"."add_deal_form"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deal_member_removal_logs"
    ADD CONSTRAINT "deal_member_removal_logs_deleted_by_user_id_users_id_fk"
    FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_member_removal_logs_deal_id_idx"
  ON "deal_member_removal_logs" ("deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_member_removal_logs_deleted_by_user_id_idx"
  ON "deal_member_removal_logs" ("deleted_by_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_member_removal_logs_created_at_idx"
  ON "deal_member_removal_logs" ("created_at");
