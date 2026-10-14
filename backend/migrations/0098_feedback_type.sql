-- Optional triage type on user_feedback (platform admin only on submit).
-- Values: Feature Request | Bug Report | Change Request

ALTER TABLE "user_feedback"
  ADD COLUMN IF NOT EXISTS "feedback_type" varchar(40);

CREATE INDEX IF NOT EXISTS "user_feedback_feedback_type_idx"
  ON "user_feedback" ("feedback_type");
