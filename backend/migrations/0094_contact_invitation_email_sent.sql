-- Track whether a portal signup invitation was emailed for a CRM contact.

ALTER TABLE "contact"
ADD COLUMN IF NOT EXISTS "invitation_email_sent" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "contact"."invitation_email_sent" IS
  'True after a portal signup invitation email was successfully sent for this contact.';
