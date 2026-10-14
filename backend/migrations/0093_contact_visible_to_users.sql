-- Self-registered investors can opt in (My account) so company users see them
-- in All Contacts. Default remains hidden except to platform admins.

ALTER TABLE "contact"
ADD COLUMN IF NOT EXISTS "visible_to_users" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "contact"."visible_to_users" IS
  'Self-registered investor opted in to appear in company All Contacts lists.';
