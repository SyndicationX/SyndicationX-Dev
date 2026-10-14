-- 506(b) pre-existing relationship flag on CRM contacts (nullable).
-- Values: YES | NO

ALTER TABLE "contact"
ADD COLUMN IF NOT EXISTS "relationship_506b" varchar(16);
