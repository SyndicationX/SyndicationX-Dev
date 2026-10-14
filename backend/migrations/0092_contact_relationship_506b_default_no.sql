-- All Contacts Relationship defaults to No (no 506(b) pre-existing relationship).

ALTER TABLE "contact"
  ALTER COLUMN "relationship_506b" SET DEFAULT 'NO';

UPDATE "contact"
SET "relationship_506b" = 'NO'
WHERE "relationship_506b" IS NULL
   OR trim("relationship_506b") = '';

COMMENT ON COLUMN "contact"."relationship_506b" IS
  '506(b) pre-existing relationship. YES | NO; defaults to NO.';
