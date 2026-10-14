-- Optional triage priority on user_feedback (platform admin only on submit).
-- Values: P0 | P1 | P2 | P3

ALTER TABLE "user_feedback"
  ADD COLUMN IF NOT EXISTS "priority" varchar(8);

CREATE INDEX IF NOT EXISTS "user_feedback_priority_idx"
  ON "user_feedback" ("priority");
