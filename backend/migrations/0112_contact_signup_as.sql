ALTER TABLE "contact"
  ADD COLUMN IF NOT EXISTS "signup_as" varchar(32) DEFAULT '' NOT NULL;

UPDATE "contact" AS c
SET "signup_as" = u."signup_as"
FROM "users" AS u
WHERE lower(trim(c."email")) = lower(trim(u."email"))
  AND u."signup_as" IN ('investor', 'syndicator', 'both')
  AND c."signup_as" = '';
