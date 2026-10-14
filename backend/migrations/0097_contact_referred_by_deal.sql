-- Deal-scoped investor invite links (lead / admin / co-sponsor). The CRM row
-- for a signup or sign-in through that link stores the referring deal together
-- with organization_id and created_by (the sponsor user).

ALTER TABLE "contact"
ADD COLUMN IF NOT EXISTS "referred_by_deal_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contact_referred_by_deal_id_fkey'
  ) THEN
    ALTER TABLE "contact"
    ADD CONSTRAINT "contact_referred_by_deal_id_fkey"
    FOREIGN KEY ("referred_by_deal_id") REFERENCES "add_deal_form"("id") ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS contact_referred_by_deal_id_idx
  ON "contact" ("referred_by_deal_id");

COMMENT ON COLUMN "contact"."referred_by_deal_id" IS
  'Deal whose sponsor invite link created or attributed this contact; null for other sources.';
