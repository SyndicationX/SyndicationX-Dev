import { pool } from "../../database/db.js";
import { viewerShouldSeeOnlySelfCreatedContacts } from "../deal/dealMemberScope.service.js";

const ORG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ContactOwnerSponsorOption = {
  userId: string;
  displayName: string;
  email: string;
};

type SponsorUserRow = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  username: string | null;
};

function displayNameFromSponsorRow(row: SponsorUserRow): string {
  const full = [row.first_name, row.last_name]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (full) return full;
  return (
    String(row.email ?? "").trim() || String(row.username ?? "").trim() || ""
  );
}

function optionFromRow(row: SponsorUserRow): ContactOwnerSponsorOption | null {
  const userId = String(row.user_id ?? "").trim();
  const displayName = displayNameFromSponsorRow(row);
  if (!userId || !displayName) return null;
  return {
    userId,
    displayName,
    email: String(row.email ?? "").trim(),
  };
}

function sortSponsorOptions(
  items: ContactOwnerSponsorOption[],
): ContactOwnerSponsorOption[] {
  return [...items].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "base",
    }),
  );
}

/**
 * Every Lead Sponsor and Admin sponsor on deals in this organization
 * (deal_member roster, plus deal_investment role fallback).
 */
async function listOrgLeadAndAdminSponsors(
  organizationId: string,
): Promise<ContactOwnerSponsorOption[]> {
  const res = await pool.query<SponsorUserRow>(
    `SELECT DISTINCT u.id::text AS user_id,
            u.first_name,
            u.last_name,
            u.email,
            u.username
     FROM users u
     WHERE EXISTS (
       SELECT 1
       FROM deal_member dm
       INNER JOIN add_deal_form d ON d.id = dm.deal_id
       WHERE d.organization_id = $1::uuid
         AND dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN (
           'lead sponsor',
           'admin sponsor'
         )
         AND (
           trim(dm.contact_member_id) = u.id::text
           OR EXISTS (
             SELECT 1 FROM contact c
             WHERE c.id::text = trim(both from dm.contact_member_id)
               AND lower(trim(c.email)) = lower(trim(u.email))
           )
         )
     )
     OR EXISTS (
       SELECT 1
       FROM deal_investment di
       INNER JOIN add_deal_form d ON d.id = di.deal_id
       WHERE d.organization_id = $1::uuid
         AND di.is_draft = false
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND lower(trim(di.investor_role)) IN (
           'lead sponsor',
           'admin sponsor'
         )
         AND (
           trim(di.contact_id) = u.id::text
           OR EXISTS (
             SELECT 1 FROM contact c
             WHERE c.id::text = trim(both from di.contact_id)
               AND lower(trim(c.email)) = lower(trim(u.email))
           )
         )
     )`,
    [organizationId],
  );
  const byId = new Map<string, ContactOwnerSponsorOption>();
  for (const row of res.rows) {
    const opt = optionFromRow(row);
    if (!opt) continue;
    if (!byId.has(opt.userId)) byId.set(opt.userId, opt);
  }
  return sortSponsorOptions([...byId.values()]);
}

async function viewerSelfOption(
  viewerUserId: string,
): Promise<ContactOwnerSponsorOption[]> {
  const uid = String(viewerUserId ?? "").trim();
  if (!uid) return [];
  const res = await pool.query<SponsorUserRow>(
    `SELECT id::text AS user_id, first_name, last_name, email, username
     FROM users WHERE id = $1::uuid LIMIT 1`,
    [uid],
  );
  const opt = res.rows[0] ? optionFromRow(res.rows[0]) : null;
  return opt ? [opt] : [];
}

/**
 * Co-sponsors who are the Investors-tab Sponsor name (`added_by`) for this
 * contact — not Lead / Admin on that deal.
 */
async function listCoSponsorOwnersForContact(
  contactId: string,
): Promise<ContactOwnerSponsorOption[]> {
  const cid = String(contactId ?? "").trim();
  if (!cid || !ORG_UUID_RE.test(cid)) return [];
  const res = await pool.query<SponsorUserRow>(
    `WITH target AS (
       SELECT c.id::text AS contact_id,
              lower(trim(c.email)) AS email
       FROM contact c
       WHERE c.id = $1::uuid
     ),
     effective AS (
       SELECT lp.deal_id, lp.contact_member_id, lp.email, lp.added_by
       FROM deal_lp_investor lp
       WHERE lp.added_by IS NOT NULL
         AND lp.is_draft = false
         AND trim(coalesce(lp.contact_member_id, '')) <> ''
       UNION ALL
       SELECT dm.deal_id, dm.contact_member_id, NULL::text AS email, dm.added_by
       FROM deal_member dm
       WHERE dm.added_by IS NOT NULL
         AND dm.is_draft = false
         AND trim(coalesce(dm.contact_member_id, '')) <> ''
         AND lower(trim(dm.deal_member_role)) IN (
           'lp investor', 'lp investors', 'lp_investor', 'lp_investors'
         )
     ),
     matched AS (
       SELECT e.deal_id, e.added_by
       FROM effective e
       INNER JOIN target t ON (
         lower(trim(e.contact_member_id)) = lower(trim(t.contact_id))
         OR (
           trim(coalesce(e.email, '')) <> ''
           AND position('@' in trim(e.email)) > 1
           AND lower(trim(e.email)) = t.email
         )
         OR EXISTS (
           SELECT 1 FROM users u
           WHERE lower(trim(u.id::text)) = lower(trim(e.contact_member_id))
             AND t.email <> ''
             AND lower(trim(u.email)) = t.email
         )
       )
     )
     SELECT DISTINCT u.id::text AS user_id,
            u.first_name,
            u.last_name,
            u.email,
            u.username
     FROM matched m
     INNER JOIN users u ON u.id = m.added_by
     WHERE EXISTS (
       SELECT 1
       FROM deal_member dm
       INNER JOIN users su ON su.id = u.id
       WHERE dm.deal_id = m.deal_id
         AND dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN ('co-sponsor', 'co sponsor')
         AND (
           trim(dm.contact_member_id) = su.id::text
           OR EXISTS (
             SELECT 1 FROM contact c
             WHERE c.id::text = trim(both from dm.contact_member_id)
               AND lower(trim(c.email)) = lower(trim(su.email))
           )
         )
     )
     AND NOT EXISTS (
       SELECT 1
       FROM deal_member dm
       INNER JOIN users su ON su.id = u.id
       WHERE dm.deal_id = m.deal_id
         AND dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN (
           'lead sponsor',
           'admin sponsor'
         )
         AND (
           trim(dm.contact_member_id) = su.id::text
           OR EXISTS (
             SELECT 1 FROM contact c
             WHERE c.id::text = trim(both from dm.contact_member_id)
               AND lower(trim(c.email)) = lower(trim(su.email))
           )
         )
     )`,
    [cid],
  );
  const byId = new Map<string, ContactOwnerSponsorOption>();
  for (const row of res.rows) {
    const opt = optionFromRow(row);
    if (!opt) continue;
    if (!byId.has(opt.userId)) byId.set(opt.userId, opt);
  }
  return sortSponsorOptions([...byId.values()]);
}

/**
 * Contact owner picker:
 * - Co-sponsor viewer: only themselves (their investors).
 * - Contact that is a Co-sponsor’s investor: only that Co-sponsor.
 * - Otherwise: all Lead / Admin sponsors in the organization.
 */
export async function listContactOwnerSponsorsForViewer(params: {
  viewerUserId: string;
  viewerRole?: string | null;
  organizationId?: string | null;
  contactId?: string | null;
}): Promise<{
  sponsors: ContactOwnerSponsorOption[];
  lockToListed: boolean;
}> {
  const viewerUserId = String(params.viewerUserId ?? "").trim();
  const orgId = String(params.organizationId ?? "").trim();
  const contactId = String(params.contactId ?? "").trim();

  if (viewerUserId) {
    const coSponsorViewer = await viewerShouldSeeOnlySelfCreatedContacts(
      viewerUserId,
      params.viewerRole,
    );
    if (coSponsorViewer) {
      return {
        sponsors: await viewerSelfOption(viewerUserId),
        lockToListed: true,
      };
    }
  }

  if (contactId) {
    const coOwners = await listCoSponsorOwnersForContact(contactId);
    if (coOwners.length > 0) {
      return { sponsors: coOwners, lockToListed: true };
    }
  }

  if (!orgId || !ORG_UUID_RE.test(orgId)) {
    return { sponsors: [], lockToListed: false };
  }
  return {
    sponsors: await listOrgLeadAndAdminSponsors(orgId),
    lockToListed: false,
  };
}

export function allowedOwnerNamesFromSponsors(
  sponsors: ContactOwnerSponsorOption[],
  extraNames: string[] = [],
): Set<string> {
  const allowed = new Set<string>();
  for (const s of sponsors) {
    const n = s.displayName.trim().toLowerCase();
    if (n) allowed.add(n);
  }
  for (const raw of extraNames) {
    const n = String(raw ?? "").trim().toLowerCase();
    if (n) allowed.add(n);
  }
  return allowed;
}

export function filterOwnersToAllowedNames(
  requested: string[],
  allowedLower: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!allowedLower.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
