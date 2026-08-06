import { pool } from "../../database/db.js";
import { isCompanyAdminRole } from "../../constants/roles.js";

const DEAL_INVESTMENT_AUTOSAVE_CONTACT =
  "__portal_investment_autosave__";

/**
 * Distinct deal ids where this portal user appears on `deal_member` with any
 * non-empty role (portal user id or contact email match).
 */
export async function listDealIdsFromDealMemberRosterForUser(
  userId: string,
): Promise<string[]> {
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dm.deal_id::text AS deal_id
     FROM deal_member dm
     INNER JOIN users u ON u.id = $1::uuid
     WHERE trim(dm.deal_member_role) <> ''
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )`,
    [userId],
  );
  return [
    ...new Set(
      res.rows
        .map((r) => String(r.deal_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

/** True when the portal user has any `deal_member` roster row on this deal. */
export async function isPortalUserOnDealMemberRoster(
  dealId: string,
  userId: string,
): Promise<boolean> {
  const d = String(dealId ?? "").trim();
  const s = String(userId ?? "").trim();
  if (!d || !s) return false;
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     INNER JOIN users u ON u.id = $2::uuid
     WHERE dm.deal_id = $1::uuid
       AND trim(dm.deal_member_role) <> ''
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     LIMIT 1`,
    [d, s],
  );
  return res.rows.length > 0;
}

export type ViewerDealMemberRoleKind =
  | "lead_sponsor"
  | "admin_sponsor"
  | "co_sponsor"
  | "lp_investor"
  | null;

function classifyDealMemberRoleRaw(raw: string): {
  lead: boolean;
  admin: boolean;
  co: boolean;
  lp: boolean;
} {
  const t = String(raw ?? "").trim().toLowerCase();
  const lead =
    t === "lead sponsor" ||
    t === "lead_sponsor" ||
    (t.includes("lead") && t.includes("sponsor"));
  const admin = t === "admin sponsor" || t === "admin_sponsor";
  const co = t === "co-sponsor" || t === "co sponsor" || t === "co_sponsor";
  const lp =
    t === "lp investor" ||
    t === "lp investors" ||
    t === "lp_investor" ||
    t === "lp_investors";
  return { lead, admin, co, lp };
}

/**
 * Viewer’s roster role on one deal (unfiltered). Used for tab visibility when the
 * members list API is scoped to rows the co-sponsor added.
 */
export async function resolveViewerDealMemberRoleOnDeal(
  dealId: string,
  userId: string,
): Promise<ViewerDealMemberRoleKind> {
  const d = String(dealId ?? "").trim();
  const uid = String(userId ?? "").trim();
  if (!d || !uid) return null;

  const res = await pool.query<{ role: string }>(
    `SELECT lower(trim(dm.deal_member_role)) AS role
     FROM deal_member dm
     INNER JOIN users u ON u.id = $2::uuid
     WHERE dm.deal_id = $1::uuid
       AND trim(dm.deal_member_role) <> ''
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     UNION ALL
     SELECT lower(trim(di.investor_role)) AS role
     FROM deal_investment di
     INNER JOIN users u ON u.id = $2::uuid
     WHERE di.deal_id = $1::uuid
       AND trim(di.investor_role) <> ''
       AND trim(di.contact_id) <> '__portal_investment_autosave__'
       AND (
         trim(di.contact_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from di.contact_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )`,
    [d, uid],
  );

  let hasLead = false;
  let hasAdmin = false;
  let hasCo = false;
  let hasLp = false;
  for (const row of res.rows) {
    const c = classifyDealMemberRoleRaw(row.role ?? "");
    if (c.lead) hasLead = true;
    if (c.admin) hasAdmin = true;
    if (c.co) hasCo = true;
    if (c.lp) hasLp = true;
  }
  if (hasLead) return "lead_sponsor";
  if (hasAdmin) return "admin_sponsor";
  if (hasCo) return "co_sponsor";
  if (hasLp) return "lp_investor";
  return null;
}

/**
 * Distinct deal ids where this user appears on `deal_member` as Co-sponsor
 * (portal user id or contact email match).
 */
export async function listDealIdsWhereViewerIsCoSponsor(
  userId: string,
): Promise<string[]> {
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dm.deal_id::text AS deal_id
     FROM deal_member dm
     INNER JOIN users u ON u.id = $1::uuid
     WHERE lower(trim(dm.deal_member_role)) IN ('co-sponsor', 'co sponsor')
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     UNION
     SELECT DISTINCT di.deal_id::text AS deal_id
     FROM deal_investment di
     INNER JOIN users u ON u.id = $1::uuid
     WHERE lower(trim(di.investor_role)) IN ('co-sponsor', 'co sponsor')
       AND trim(di.contact_id) <> $2
       AND (
         trim(di.contact_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(di.contact_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )`,
    [userId, DEAL_INVESTMENT_AUTOSAVE_CONTACT],
  );
  return [
    ...new Set(
      res.rows
        .map((r) => String(r.deal_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Co-sponsors (not company admin, not Lead/Admin sponsor on any deal) see only CRM
 * contacts they created (`contact.created_by`).
 */
export async function viewerShouldSeeOnlySelfCreatedContacts(
  userId: string,
  roleForScope?: string | null,
): Promise<boolean> {
  const uid = String(userId ?? "").trim();
  if (!uid) return false;
  if (isCompanyAdminRole(String(roleForScope ?? "").trim())) return false;
  if (await viewerIsLeadOrAdminSponsorOnAnyDeal(uid)) return false;
  const coDealIds = await listDealIdsWhereViewerIsCoSponsor(uid);
  return coDealIds.length > 0;
}

/**
 * True if this user has any `deal_member` row with a non-empty role that is
 * **not** Co-sponsor (e.g. Lead Sponsor, admin sponsor, LP investors).
 * Used to avoid narrowing the syndication dashboard to co-sponsor-only deals
 * when they also hold another roster role somewhere.
 */
export async function viewerHasNonCoSponsorDealMemberRole(
  userId: string,
): Promise<boolean> {
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     INNER JOIN users u ON u.id = $1::uuid
     WHERE trim(dm.deal_member_role) <> ''
       AND lower(trim(dm.deal_member_role)) NOT IN ('co-sponsor', 'co sponsor')
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

/**
 * True when the viewer appears on any deal as Lead Sponsor or Admin sponsor
 * (portal user id or contact email match). Used so sponsor team sees full-company
 * CRM contacts (including portal/member rows), same as company admin.
 */
export async function viewerIsLeadOrAdminSponsorOnAnyDeal(
  userId: string,
): Promise<boolean> {
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     INNER JOIN users u ON u.id = $1::uuid
     WHERE lower(trim(dm.deal_member_role)) IN ('lead sponsor', 'admin sponsor')
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     LIMIT 1`,
    [userId],
  );
  return res.rows.length > 0;
}

const SPONSOR_ROLES_IN =
  "('lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor')";

/**
 * True when this portal user appears on `deal_member` for the deal in a Lead / Admin /
 * Co-sponsor role (id or contact email match).
 */
/** True when the portal user is Co-sponsor on this deal (not Lead / Admin). */
export async function isPortalUserCoSponsorOnDeal(
  dealId: string,
  userId: string,
): Promise<boolean> {
  const role = await resolveViewerDealMemberRoleOnDeal(dealId, userId);
  return role === "co_sponsor";
}

/** True when the portal user is Lead Sponsor or Admin sponsor on this deal. */
export async function isPortalUserLeadOrAdminSponsorOnDeal(
  dealId: string,
  userId: string,
): Promise<boolean> {
  const role = await resolveViewerDealMemberRoleOnDeal(dealId, userId);
  return role === "lead_sponsor" || role === "admin_sponsor";
}

/** True when the portal user is Lead Sponsor on this deal (id or contact email match). */
export async function isPortalUserLeadSponsorOnDeal(
  dealId: string,
  userId: string,
): Promise<boolean> {
  const role = await resolveViewerDealMemberRoleOnDeal(dealId, userId);
  return role === "lead_sponsor";
}

export async function isPortalUserSponsorOnDeal(
  dealId: string,
  sponsorUserId: string,
): Promise<boolean> {
  const d = String(dealId ?? "").trim();
  const s = String(sponsorUserId ?? "").trim();
  if (!d || !s) return false;
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     INNER JOIN users u ON u.id = $2::uuid
     WHERE dm.deal_id = $1::uuid
       AND lower(trim(dm.deal_member_role)) IN ${SPONSOR_ROLES_IN}
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     UNION ALL
     SELECT 1 AS ok
     FROM deal_investment di
     INNER JOIN users u ON u.id = $2::uuid
     WHERE di.deal_id = $1::uuid
       AND lower(trim(di.investor_role)) IN ${SPONSOR_ROLES_IN}
       AND trim(di.contact_id) <> '__portal_investment_autosave__'
       AND (
         trim(di.contact_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from di.contact_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       )
     LIMIT 1`,
    [d, s],
  );
  return res.rows.length > 0;
}
