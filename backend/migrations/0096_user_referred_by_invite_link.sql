-- Investor signed up through a sponsor's "Invite Investor Link" (Contacts page).
-- These accounts skip the "Do you want to be visible to users?" question in My
-- account: they already belong to the referring sponsor's org contacts.

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "referred_by_user_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referred_by_user_id_fkey'
  ) THEN
    ALTER TABLE "users"
    ADD CONSTRAINT "users_referred_by_user_id_fkey"
    FOREIGN KEY ("referred_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
END
$$;

COMMENT ON COLUMN "users"."referred_by_user_id" IS
  'Portal user whose investor invite link was used at signup; null for direct signups.';
