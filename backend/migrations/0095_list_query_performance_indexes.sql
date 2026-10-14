-- Indexes for the columns every list screen filters on. Without these, each deals /
-- contacts / investors load sequentially scans the parent table, which is the main
-- reason reads drift past the 3s budget the SPA now enforces.
--
-- Functional indexes mirror the `lower(trim(...))` comparisons used in the services;
-- the expression must match exactly for the planner to use the index.

CREATE INDEX IF NOT EXISTS "add_deal_form_organization_id_idx"
  ON "add_deal_form" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "add_deal_form_created_at_idx"
  ON "add_deal_form" ("created_at" DESC);
--> statement-breakpoint
-- Legacy deals with no organization_id are matched by owning entity name vs companies.name.
CREATE INDEX IF NOT EXISTS "add_deal_form_legacy_owning_entity_idx"
  ON "add_deal_form" (lower(trim("owning_entity_name")))
  WHERE "organization_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deal_investment_deal_id_is_draft_idx"
  ON "deal_investment" ("deal_id", "is_draft");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_investment_contact_id_idx"
  ON "deal_investment" ("contact_id");
--> statement-breakpoint

-- deal_id lookups already ride the unique (deal_id, contact_member_id) indexes on the
-- roster tables; these cover the remaining single-column filters.
CREATE INDEX IF NOT EXISTS "deal_lp_investor_added_by_idx"
  ON "deal_lp_investor" ("added_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_lp_investor_contact_member_id_idx"
  ON "deal_lp_investor" (lower(trim("contact_member_id")));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_lp_investor_email_idx"
  ON "deal_lp_investor" (lower(trim("email")));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deal_member_added_by_idx"
  ON "deal_member" ("added_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_member_contact_member_id_idx"
  ON "deal_member" (lower(trim("contact_member_id")));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deal_investor_class_deal_id_idx"
  ON "deal_investor_class" ("deal_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "contact_organization_id_idx"
  ON "contact" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_created_by_idx"
  ON "contact" ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_email_lower_idx"
  ON "contact" (lower(trim("email")));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "users_organization_id_idx"
  ON "users" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_lower_idx"
  ON "users" (lower(trim("email")));
--> statement-breakpoint

-- user_id is covered by the unique (user_id, company_id) index; company_id is not.
CREATE INDEX IF NOT EXISTS "user_company_membership_company_id_idx"
  ON "user_company_membership" ("company_id");
--> statement-breakpoint

-- Primary key is (deal_id, user_id); "deals assigned to me" filters on user_id alone.
CREATE INDEX IF NOT EXISTS "assigning_deal_user_user_id_idx"
  ON "assigning_deal_user" ("user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "companies_name_lower_idx"
  ON "companies" (lower(trim("name")));
