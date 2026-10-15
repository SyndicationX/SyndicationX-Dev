import { pool } from "../../database/db.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * CRM contacts on this company's deals whose Sponsor name (`added_by`) is a
 * co-sponsor. The Contacts list does not merge these rows in: other users in
 * the company must not see a co-sponsor's contacts. Kept for callers that
 * need the id set without returning it from the directory.
 */
export async function listContactIdsAddedByCoSponsorsOnOrganizationDeals(
  organizationId: string,
): Promise<string[]> {
  const orgId = String(organizationId ?? "").trim();
  if (!UUID_RE.test(orgId)) return [];
  const res = await pool.query<{ contact_id: string }>(
    `WITH co_deals AS (
       SELECT f.id AS deal_id
       FROM add_deal_form f
       WHERE f.organization_id = $1::uuid
     ),
     cosponsor AS (
       SELECT DISTINCT u.id AS user_id, dm.deal_id
       FROM deal_member dm
       INNER JOIN co_deals d ON d.deal_id = dm.deal_id
       INNER JOIN users u ON (
         lower(trim(dm.contact_member_id)) = lower(u.id::text)
         OR EXISTS (
           SELECT 1 FROM contact sc
           WHERE lower(trim(sc.id::text)) = lower(trim(dm.contact_member_id))
             AND position('@' in trim(coalesce(u.email, ''))) > 1
             AND lower(trim(sc.email)) = lower(trim(u.email))
         )
       )
       WHERE dm.is_draft = false
         AND replace(lower(trim(dm.deal_member_role)), '_', ' ') IN ('co-sponsor', 'co sponsor')
         AND NOT EXISTS (
           SELECT 1
           FROM deal_member lead_dm
           WHERE lead_dm.deal_id = dm.deal_id
             AND lead_dm.is_draft = false
             AND (
               lower(trim(lead_dm.deal_member_role)) IN (
                 'lead sponsor', 'lead_sponsor', 'admin sponsor', 'admin_sponsor'
               )
               OR (
                 position('lead' in lower(trim(lead_dm.deal_member_role))) > 0
                 AND position('sponsor' in lower(trim(lead_dm.deal_member_role))) > 0
               )
             )
             AND (
               lower(trim(lead_dm.contact_member_id)) = lower(u.id::text)
               OR EXISTS (
                 SELECT 1 FROM contact sc
                 WHERE lower(trim(sc.id::text)) = lower(trim(lead_dm.contact_member_id))
                   AND position('@' in trim(coalesce(u.email, ''))) > 1
                   AND lower(trim(sc.email)) = lower(trim(u.email))
               )
             )
         )
     ),
     effective AS (
       SELECT lp.deal_id, lp.contact_member_id, lp.email, lp.added_by
       FROM deal_lp_investor lp
       INNER JOIN co_deals d ON d.deal_id = lp.deal_id
       WHERE lp.added_by IS NOT NULL
         AND lp.is_draft = false
         AND trim(coalesce(lp.contact_member_id, '')) <> ''
       UNION ALL
       SELECT dm.deal_id, dm.contact_member_id, NULL::text AS email, dm.added_by
       FROM deal_member dm
       INNER JOIN co_deals d ON d.deal_id = dm.deal_id
       WHERE dm.added_by IS NOT NULL
         AND dm.is_draft = false
         AND trim(coalesce(dm.contact_member_id, '')) <> ''
         AND lower(trim(dm.deal_member_role)) IN (
           'lp investor', 'lp investors', 'lp_investor', 'lp_investors'
         )
     ),
     matched AS (
       SELECT e.contact_member_id, e.email
       FROM effective e
       INNER JOIN cosponsor cs
         ON cs.user_id = e.added_by
        AND cs.deal_id = e.deal_id
     ),
     raw_keys AS (
       SELECT DISTINCT lower(trim(contact_member_id)) AS k
       FROM matched
       WHERE trim(coalesce(contact_member_id, '')) <> ''
     ),
     by_id AS (
       SELECT c.id::text AS contact_id
       FROM contact c
       INNER JOIN raw_keys rk ON lower(trim(c.id::text)) = rk.k
     ),
     by_user_email AS (
       SELECT c.id::text AS contact_id
       FROM raw_keys rk
       INNER JOIN users u ON lower(trim(u.id::text)) = rk.k
       INNER JOIN contact c ON lower(trim(c.email)) = lower(trim(u.email))
       WHERE trim(coalesce(u.email, '')) <> ''
         AND position('@' in trim(u.email)) > 1
     ),
     by_lp_email AS (
       SELECT c.id::text AS contact_id
       FROM matched e
       INNER JOIN contact c ON lower(trim(c.email)) = lower(trim(e.email))
       WHERE trim(coalesce(e.email, '')) <> ''
         AND position('@' in trim(e.email)) > 1
     )
     SELECT DISTINCT contact_id FROM by_id
     UNION
     SELECT DISTINCT contact_id FROM by_user_email
     UNION
     SELECT DISTINCT contact_id FROM by_lp_email`,
    [orgId],
  );
  return [
    ...new Set(
      res.rows
        .map((row) => String(row.contact_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}
