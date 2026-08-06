/**
 * Wipes application data and keeps only the seeded platform admin login row
 * (email, username, password_hash unchanged).
 *
 * Usage (from backend/):
 *   node scripts/cleanup-db-keep-platform-admin.mjs
 *   node scripts/cleanup-db-keep-platform-admin.mjs --dry-run
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

const PLATFORM_ADMIN_ID = "b2c15cb6-1678-4819-9d24-6fdd8d192064";
const PLATFORM_ADMIN_ORG_ID = "3f8a9c1e-2b4d-4f6a-8c7e-1d0e9a8b7c6d";

const dryRun = process.argv.includes("--dry-run");

const pool = new pg.Pool({
  user: process.env.DATABASE_USER ?? "postgres",
  password: process.env.DATABASE_PASSWORD ?? "Postgresql123",
  host: process.env.DATABASE_HOST ?? "localhost",
  port: Number(process.env.DATABASE_PORT ?? "5432"),
  database: process.env.DATABASE_NAME ?? "investor_portal_db",
});

const CLEANUP_SQL = `
BEGIN;

-- Activity
DELETE FROM user_page_navigations;
DELETE FROM user_portal_sessions;

-- Audit / mail (RESTRICT on users — clear before user deletes)
DELETE FROM investor_communication_logs;
DELETE FROM member_admin_audit_logs;
DELETE FROM company_admin_audit_logs;
DELETE FROM soc_auth_audit_logs;

-- eSign / signatures
DELETE FROM investment_signatures;
DELETE FROM esign_reusable_template;

-- Company membership
DELETE FROM user_company_membership;

-- CRM
DELETE FROM contact;
DELETE FROM contact_email_template;
DELETE FROM organization_contact_tag;
DELETE FROM organization_contact_list;

-- Investor profile book (all users, including platform admin test data)
DELETE FROM user_beneficiaries;
DELETE FROM user_saved_addresses;
DELETE FROM user_investor_profiles;

-- Deal graph
DELETE FROM deal_investment;
DELETE FROM deal_investor_class;
DELETE FROM deal_member;
DELETE FROM deal_lp_investor;
DELETE FROM assigning_deal_user;
DELETE FROM add_deal_form;
DELETE FROM deals;

-- Company settings
DELETE FROM company_workspace_tab_settings;

-- Non–platform-admin users
DELETE FROM users
WHERE id <> '${PLATFORM_ADMIN_ID}'::uuid
  AND NOT (
    role = 'platform_admin'
    AND lower(trim(email)) = lower('platform.admin@example.com')
  );

-- All companies except Massive Capital (platform admin org)
DELETE FROM companies
WHERE id <> '${PLATFORM_ADMIN_ORG_ID}'::uuid;

-- Ensure Massive Capital org exists (seed may not have run on this DB)
INSERT INTO companies (id, name, status, created_at, updated_at)
VALUES (
  '${PLATFORM_ADMIN_ORG_ID}'::uuid,
  'Massive Capital',
  'active',
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = now();

-- Link platform admin to org (password_hash / email / username unchanged)
UPDATE users
SET
  organization_id = '${PLATFORM_ADMIN_ORG_ID}'::uuid,
  updated_at = now()
WHERE
  id = '${PLATFORM_ADMIN_ID}'::uuid
  OR (
    role = 'platform_admin'
    AND lower(trim(email)) = lower('platform.admin@example.com')
  );

COMMIT;
`;

async function main() {
  const dbName = process.env.DATABASE_NAME ?? "investor_portal_db";
  console.log(`Database: ${dbName}${dryRun ? " (dry-run)" : ""}`);

  const client = await pool.connect();
  try {
    const adminCheck = await client.query(
      `SELECT id, email, username, role
       FROM users
       WHERE id = $1::uuid
          OR (role = 'platform_admin' AND lower(trim(email)) = lower($2))`,
      [PLATFORM_ADMIN_ID, "platform.admin@example.com"],
    );

    if (adminCheck.rowCount === 0) {
      console.error(
        "Platform admin user not found. Run migrations first (0010_seed_platform_users.sql).",
      );
      process.exit(1);
    }

    console.log("Platform admin to preserve:");
    for (const row of adminCheck.rows) {
      console.log(`  ${row.email} (${row.id}) role=${row.role}`);
    }

    const countsBefore = await client.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM companies) AS companies,
        (SELECT count(*)::int FROM add_deal_form) AS deals,
        (SELECT count(*)::int FROM contact) AS contacts
    `);
    console.log("Before:", countsBefore.rows[0]);

    if (dryRun) {
      console.log("Dry-run: no changes applied.");
      return;
    }

    await client.query(CLEANUP_SQL);

    const countsAfter = await client.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM companies) AS companies,
        (SELECT count(*)::int FROM add_deal_form) AS deals,
        (SELECT count(*)::int FROM contact) AS contacts
    `);
    console.log("After:", countsAfter.rows[0]);
    console.log("Cleanup complete. Platform admin credentials unchanged.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
