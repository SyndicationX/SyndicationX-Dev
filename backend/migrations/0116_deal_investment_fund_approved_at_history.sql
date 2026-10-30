ALTER TABLE "deal_investment"
ADD COLUMN IF NOT EXISTS "fund_approved_at_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "deal_investment"
SET "fund_approved_at_history" = jsonb_build_array(
  jsonb_build_object(
    'date', to_jsonb("fund_approved_at"),
    'recordedAt', to_jsonb("fund_approved_at"),
    'source', 'approved'
  )
)
WHERE "fund_approved_at" IS NOT NULL
  AND "fund_approved_at_history" = '[]'::jsonb;
