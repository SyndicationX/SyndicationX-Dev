-- Organization invite: who sent it, and when. Separate from referred_by_user_id
-- (investor invite links) so company invites do not change investor attribution.

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "invited_by_user_id" uuid;

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "invited_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_invited_by_user_id_fkey'
  ) THEN
    ALTER TABLE "users"
    ADD CONSTRAINT "users_invited_by_user_id_fkey"
    FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END
$$;

COMMENT ON COLUMN "users"."invited_by_user_id" IS
  'Portal user who sent the organization member invite; null for self-serve signups.';

COMMENT ON COLUMN "users"."invited_at" IS
  'When the organization member invitation was sent.';
