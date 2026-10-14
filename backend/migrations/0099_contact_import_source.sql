-- Contact import provenance and staging.

ALTER TABLE "contact"
  ADD COLUMN IF NOT EXISTS "import_source" varchar(32) NOT NULL DEFAULT 'manual';

UPDATE "contact"
SET "import_source" = 'invite_link'
WHERE "referred_by_deal_id" IS NOT NULL
  AND COALESCE(NULLIF(trim("import_source"), ''), 'manual') = 'manual';

CREATE TABLE IF NOT EXISTS "contact_import_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "file_name" varchar(255) NOT NULL DEFAULT '',
  "file_type" varchar(16) NOT NULL DEFAULT 'csv',
  "headers" jsonb NOT NULL,
  "mapping" jsonb,
  "duplicate_mode" varchar(16) NOT NULL DEFAULT 'skip',
  "status" varchar(32) NOT NULL DEFAULT 'parsed',
  "counts" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "contact_import_row" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id" uuid NOT NULL REFERENCES "contact_import_batch"("id") ON DELETE CASCADE,
  "row_index" integer NOT NULL,
  "raw" jsonb NOT NULL,
  "normalized" jsonb,
  "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "duplicate_contact_id" uuid REFERENCES "contact"("id") ON DELETE SET NULL,
  "duplicate_match" varchar(16),
  "status" varchar(32) NOT NULL DEFAULT 'parsed',
  "import_contact_id" uuid REFERENCES "contact"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "contact_import_source_idx"
  ON "contact" ("import_source");

CREATE INDEX IF NOT EXISTS "contact_import_batch_created_by_idx"
  ON "contact_import_batch" ("created_by", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "contact_import_row_batch_idx"
  ON "contact_import_row" ("batch_id", "row_index");

CREATE INDEX IF NOT EXISTS "contact_import_row_duplicate_idx"
  ON "contact_import_row" ("duplicate_contact_id");

COMMENT ON COLUMN "contact"."import_source" IS
  'How this contact first entered the CRM: manual, csv, excel, invite_link, portal_signup, or ghl.';
