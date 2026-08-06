-- =============================================================================
-- Clear DATA from application tables (rows only — tables are NOT dropped).
--
-- TABLES (public schema, 27 — all cleared except where noted):
--   1.  add_deal_form
--   2.  assigning_deal_user
--   3.  companies                    KEEP: platform admin org (Massive Capital)
--   4.  company_admin_audit_logs
--   5.  company_workspace_tab_settings
--   6.  contact
--   7.  contact_email_template
--   8.  deal_investment
--   9.  deal_investor_class
--   10. deal_lp_investor
--   11. deal_member
--   12. deals
--   13. esign_reusable_template
--   14. investment_signatures
--   15. investor_communication_logs
--   16. member_admin_audit_logs
--   17. organization_contact_list
--   18. organization_contact_tag
--   19. soc_auth_audit_logs
--   20. user_beneficiaries
--   21. user_company_membership
--   22. user_investor_profiles
--   23. user_page_navigations
--   24. user_portal_sessions
--   25. user_saved_addresses
--   26. users                        KEEP: platform.admin@example.com
--   (drizzle.__drizzle_migrations is NOT touched)
--
-- IMPORTANT: Do not use TRUNCATE ... CASCADE on companies — users.organization_id
-- references companies, so PostgreSQL could truncate users and remove platform admin.
--
-- Kept user:  platform.admin@example.com (role platform_admin)
-- Kept company: organization_id on that user, or seeded Massive Capital
--   (3f8a9c1e-2b4d-4f6a-8c7e-1d0e9a8b7c6d from migration 0029)
--
-- Run from backend/:
--   psql -h localhost -p 5432 -U postgres -d investor_portal_db -f scripts/clear-application-data-keep-platform-admin.sql
--
-- BACK UP THE DATABASE FIRST.
-- =============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_admin_email constant text := 'platform.admin@example.com';
  v_seed_company_id constant uuid := '3f8a9c1e-2b4d-4f6a-8c7e-1d0e9a8b7c6d';
  v_keep_company_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE lower(trim(u.email)) = lower(v_admin_email)
  ) THEN
    RAISE EXCEPTION
      'Platform admin not found (%). Run migrations/seeds first.', v_admin_email;
  END IF;

  SELECT COALESCE(u.organization_id, v_seed_company_id)
  INTO v_keep_company_id
  FROM public.users u
  WHERE lower(trim(u.email)) = lower(v_admin_email);

  IF NOT EXISTS (
    SELECT 1 FROM public.companies c WHERE c.id = v_keep_company_id
  ) THEN
    RAISE EXCEPTION
      'Platform admin company % not found in public.companies.', v_keep_company_id;
  END IF;

  UPDATE public.users
  SET
    organization_id = v_keep_company_id,
    updated_at = now()
  WHERE lower(trim(email)) = lower(v_admin_email)
    AND organization_id IS DISTINCT FROM v_keep_company_id;
END $$;

BEGIN;

-- Activity (references users)
DELETE FROM public.user_page_navigations;
DELETE FROM public.user_portal_sessions;

-- Audit / mail (RESTRICT on users — clear before deleting other users)
DELETE FROM public.investor_communication_logs;
DELETE FROM public.member_admin_audit_logs;
DELETE FROM public.company_admin_audit_logs;
DELETE FROM public.soc_auth_audit_logs;

-- eSign templates
DELETE FROM public.esign_reusable_template;
DELETE FROM public.investment_signatures;

-- Company membership (scoped roles)
DELETE FROM public.user_company_membership;

-- CRM
DELETE FROM public.contact;
DELETE FROM public.contact_email_template;
DELETE FROM public.organization_contact_tag;
DELETE FROM public.organization_contact_list;

-- Investor profile book
DELETE FROM public.user_beneficiaries;
DELETE FROM public.user_saved_addresses;
DELETE FROM public.user_investor_profiles;

-- Deal graph
DELETE FROM public.deal_investment;
DELETE FROM public.deal_investor_class;
DELETE FROM public.deal_member;
DELETE FROM public.deal_lp_investor;
DELETE FROM public.assigning_deal_user;
DELETE FROM public.add_deal_form;
DELETE FROM public.deals;

-- Company settings (all orgs; platform admin company row stays in companies)
DELETE FROM public.company_workspace_tab_settings;

-- users — remove everyone except platform admin
DELETE FROM public.users u
WHERE lower(trim(u.email)) <> lower('platform.admin@example.com');

-- companies — remove every org except platform admin's company
DELETE FROM public.companies c
WHERE c.id <> (
  SELECT COALESCE(
    u.organization_id,
    '3f8a9c1e-2b4d-4f6a-8c7e-1d0e9a8b7c6d'::uuid
  )
  FROM public.users u
  WHERE lower(trim(u.email)) = lower('platform.admin@example.com')
);

COMMIT;

-- Verify
SELECT id, email, username, role, organization_id
FROM public.users;

SELECT id, name, status
FROM public.companies;

SELECT 'add_deal_form' AS table_name, count(*)::int AS rows FROM public.add_deal_form
UNION ALL SELECT 'assigning_deal_user', count(*)::int FROM public.assigning_deal_user
UNION ALL SELECT 'companies', count(*)::int FROM public.companies
UNION ALL SELECT 'company_admin_audit_logs', count(*)::int FROM public.company_admin_audit_logs
UNION ALL SELECT 'company_workspace_tab_settings', count(*)::int FROM public.company_workspace_tab_settings
UNION ALL SELECT 'contact', count(*)::int FROM public.contact
UNION ALL SELECT 'contact_email_template', count(*)::int FROM public.contact_email_template
UNION ALL SELECT 'deal_investment', count(*)::int FROM public.deal_investment
UNION ALL SELECT 'deal_investor_class', count(*)::int FROM public.deal_investor_class
UNION ALL SELECT 'deal_lp_investor', count(*)::int FROM public.deal_lp_investor
UNION ALL SELECT 'deal_member', count(*)::int FROM public.deal_member
UNION ALL SELECT 'deals', count(*)::int FROM public.deals
UNION ALL SELECT 'esign_reusable_template', count(*)::int FROM public.esign_reusable_template
UNION ALL SELECT 'investment_signatures', count(*)::int FROM public.investment_signatures
UNION ALL SELECT 'investor_communication_logs', count(*)::int FROM public.investor_communication_logs
UNION ALL SELECT 'member_admin_audit_logs', count(*)::int FROM public.member_admin_audit_logs
UNION ALL SELECT 'organization_contact_list', count(*)::int FROM public.organization_contact_list
UNION ALL SELECT 'organization_contact_tag', count(*)::int FROM public.organization_contact_tag
UNION ALL SELECT 'soc_auth_audit_logs', count(*)::int FROM public.soc_auth_audit_logs
UNION ALL SELECT 'user_beneficiaries', count(*)::int FROM public.user_beneficiaries
UNION ALL SELECT 'user_company_membership', count(*)::int FROM public.user_company_membership
UNION ALL SELECT 'user_investor_profiles', count(*)::int FROM public.user_investor_profiles
UNION ALL SELECT 'user_page_navigations', count(*)::int FROM public.user_page_navigations
UNION ALL SELECT 'user_portal_sessions', count(*)::int FROM public.user_portal_sessions
UNION ALL SELECT 'user_saved_addresses', count(*)::int FROM public.user_saved_addresses
UNION ALL SELECT 'users', count(*)::int FROM public.users
ORDER BY table_name;
