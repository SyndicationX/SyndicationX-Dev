ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "signup_as" varchar(32) DEFAULT '' NOT NULL;

UPDATE "users"
SET "signup_as" = 'investor'
WHERE "signup_as" = ''
  AND lower(trim("role")) = 'investor';
