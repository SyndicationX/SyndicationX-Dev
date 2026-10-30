ALTER TABLE "deal_member_removal_logs"
  ADD COLUMN IF NOT EXISTS "removed_snapshot" jsonb DEFAULT '{"investments":[],"lpInvestors":[],"rosterMember":null}'::jsonb NOT NULL;
