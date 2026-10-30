ALTER TABLE "deal_investment"
  ADD COLUMN IF NOT EXISTS "funded_amount" text,
  ADD COLUMN IF NOT EXISTS "capital_balance" text,
  ADD COLUMN IF NOT EXISTS "cash_balance" text,
  ADD COLUMN IF NOT EXISTS "deployed_capital" text,
  ADD COLUMN IF NOT EXISTS "percent_of_class_by_target_raise" text,
  ADD COLUMN IF NOT EXISTS "percent_of_class_by_total_raised" text,
  ADD COLUMN IF NOT EXISTS "shares_owned" text,
  ADD COLUMN IF NOT EXISTS "distributed_amount" text,
  ADD COLUMN IF NOT EXISTS "reinvest_distributions" text,
  ADD COLUMN IF NOT EXISTS "reinvestment_percentage" text,
  ADD COLUMN IF NOT EXISTS "accrued_preferred_return" text,
  ADD COLUMN IF NOT EXISTS "unpaid_preferred_return" text,
  ADD COLUMN IF NOT EXISTS "preferred_return_start_date" date;
