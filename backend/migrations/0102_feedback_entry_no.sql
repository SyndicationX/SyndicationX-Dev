-- Stable entry number: the first submitted feedback is 1, the next is 2, and so on.
-- Existing rows are numbered by submission time so the original order is kept.

ALTER TABLE "user_feedback"
  ADD COLUMN IF NOT EXISTS "feedback_no" integer;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "id" ASC) AS n
  FROM "user_feedback"
  WHERE "feedback_no" IS NULL
)
UPDATE "user_feedback" AS u
SET "feedback_no" = ranked.n + COALESCE(
  (SELECT MAX("feedback_no") FROM "user_feedback"),
  0
)
FROM ranked
WHERE u."id" = ranked."id";

CREATE SEQUENCE IF NOT EXISTS "user_feedback_feedback_no_seq";

DO $$
DECLARE
  max_no integer;
BEGIN
  SELECT MAX("feedback_no") INTO max_no FROM "user_feedback";
  IF max_no IS NULL THEN
    PERFORM setval('user_feedback_feedback_no_seq', 1, false);
  ELSE
    PERFORM setval('user_feedback_feedback_no_seq', max_no, true);
  END IF;
END $$;

ALTER TABLE "user_feedback"
  ALTER COLUMN "feedback_no" SET DEFAULT nextval('user_feedback_feedback_no_seq');

ALTER TABLE "user_feedback"
  ALTER COLUMN "feedback_no" SET NOT NULL;

ALTER SEQUENCE "user_feedback_feedback_no_seq"
  OWNED BY "user_feedback"."feedback_no";

CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_feedback_no_uidx"
  ON "user_feedback" ("feedback_no");
