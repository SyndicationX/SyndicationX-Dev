-- Company captured from an Invite Investor link (sponsor user + company).
-- Kept separate from users.organization_id so the investor is not a company member.

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "referred_by_company_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referred_by_company_id_fkey'
  ) THEN
    ALTER TABLE "users"
    ADD CONSTRAINT "users_referred_by_company_id_fkey"
    FOREIGN KEY ("referred_by_company_id") REFERENCES "companies"("id") ON DELETE SET NULL;
  END IF;
END
$$;

COMMENT ON COLUMN "users"."referred_by_company_id" IS
  'Company on the investor invite link used at signup; null for direct signups.';
