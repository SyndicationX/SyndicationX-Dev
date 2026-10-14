ALTER TABLE "user_feedback"
  ADD COLUMN IF NOT EXISTS "admin_response" text;
--> statement-breakpoint
ALTER TABLE "user_feedback"
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
