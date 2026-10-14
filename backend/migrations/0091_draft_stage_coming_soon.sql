-- Draft deals show Deal Status "Coming Soon" instead of the legacy hidden status.
ALTER TABLE "add_deal_form"
  ALTER COLUMN "offering_status" SET DEFAULT 'coming_soon';

UPDATE "add_deal_form"
SET "offering_status" = 'coming_soon'
WHERE "offering_status" = 'draft_hidden';

COMMENT ON COLUMN "add_deal_form"."offering_status" IS
  'Investor-facing offering workflow status. Draft stage starts at coming_soon; investor access is gated on deal_stage, not this column.';
