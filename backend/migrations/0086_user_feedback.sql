CREATE TABLE IF NOT EXISTS "user_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "username" varchar(200) NOT NULL,
  "user_email" varchar(255) NOT NULL,
  "page_key" varchar(120) NOT NULL,
  "page_label" varchar(200) NOT NULL,
  "sub_page_key" varchar(120) DEFAULT '' NOT NULL,
  "sub_page_label" varchar(200) DEFAULT '' NOT NULL,
  "description" text NOT NULL,
  "status" varchar(32) DEFAULT 'Pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone,
  "reviewed_by_user_id" uuid,
  "reviewed_by_name" varchar(200)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback"
    ADD CONSTRAINT "user_feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback"
    ADD CONSTRAINT "user_feedback_reviewed_by_user_id_users_id_fk"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_status_idx"
  ON "user_feedback" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_user_id_idx"
  ON "user_feedback" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_created_at_idx"
  ON "user_feedback" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_page_catalog" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "page_key" varchar(120) NOT NULL UNIQUE,
  "page_label" varchar(200) NOT NULL,
  "sort_order" varchar(16) DEFAULT '100' NOT NULL,
  "sub_pages" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
