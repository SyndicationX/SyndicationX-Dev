import { isDealStageDraft } from "../../constants/deal-lifecycle/deal-stage.js";
import { isPlatformAdminRole } from "../../constants/roles.js";
import { pool } from "../../database/db.js";
import { listOrganizationIdsForUser } from "../org/orgResolution.service.js";
import { isPortalUserDealSponsorOnDeal } from "./dealMemberScope.service.js";
import { resolvePortalUserIdForContactMemberId } from "./offeringPreviewSponsorRef.service.js";
import { isAddDealFormIncomplete } from "./dealFormCompleteness.service.js";
import {
  isAddDealFormInOrganizationScope,
  listAddDealFormsByIds,
} from "./dealForm.service.js";

const SPONSOR_ROLES_SQL = `'lead sponsor', 'lead_sponsor', 'admin sponsor', 'admin_sponsor', 'co-sponsor', 'co sponsor', 'co_sponsor'`;
const AUTOSAVE_CONTACT = "__portal_investment_autosave__";
const DEAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingMembershipTableError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4; i += 1) {
    if (!cur || typeof cur !== "object") break;
    const e = cur as { code?: string; message?: string; cause?: unknown };
    if (e.code === "42P01") return true;
    const msg = String(e.message ?? "").toLowerCase();
    if (msg.includes('relation "user_company_membership" does not exist')) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

function colleagueDealSql(includeMembership: boolean): string {
  const viewerOrgs = includeMembership
    ? `SELECT lower(trim(u.organization_id::text)) AS org_id
       FROM users u
       WHERE u.id = $1::uuid
         AND u.organization_id IS NOT NULL
       UNION
       SELECT lower(trim(m.company_id::text)) AS org_id
       FROM user_company_membership m
       WHERE m.user_id = $1::uuid`
    : `SELECT lower(trim(u.organization_id::text)) AS org_id
       FROM users u
       WHERE u.id = $1::uuid
         AND u.organization_id IS NOT NULL`;
  const peerUsers = includeMembership
    ? `SELECT u.id::text AS user_id, lower(trim(u.email)) AS email
       FROM users u
       WHERE u.organization_id IS NOT NULL
         AND lower(trim(u.organization_id::text)) IN (SELECT org_id FROM viewer_orgs)
       UNION
       SELECT u.id::text AS user_id, lower(trim(u.email)) AS email
       FROM users u
       INNER JOIN user_company_membership m ON m.user_id = u.id
       WHERE lower(trim(m.company_id::text)) IN (SELECT org_id FROM viewer_orgs)`
    : `SELECT u.id::text AS user_id, lower(trim(u.email)) AS email
       FROM users u
       WHERE u.organization_id IS NOT NULL
         AND lower(trim(u.organization_id::text)) IN (SELECT org_id FROM viewer_orgs)`;
  return `WITH viewer_orgs AS (
         ${viewerOrgs}
       ),
       peer_users AS (
         ${peerUsers}
       )
       SELECT DISTINCT src.deal_id
       FROM (
         SELECT dm.deal_id::text AS deal_id
         FROM deal_member dm
         INNER JOIN add_deal_form f ON f.id = dm.deal_id
         WHERE dm.is_draft = false
           AND lower(trim(dm.deal_member_role)) IN (${SPONSOR_ROLES_SQL})
           AND (
             f.organization_id IS NULL
             OR lower(trim(f.organization_id::text)) NOT IN (SELECT org_id FROM viewer_orgs)
           )
           AND (
             lower(trim(dm.contact_member_id)) IN (SELECT lower(user_id) FROM peer_users)
             OR EXISTS (
               SELECT 1
               FROM contact sponsor_contact
               INNER JOIN peer_users pu
                 ON lower(trim(sponsor_contact.email)) = pu.email
               WHERE sponsor_contact.id::text = trim(both from dm.contact_member_id)
             )
           )
         UNION
         SELECT di.deal_id::text AS deal_id
         FROM deal_investment di
         INNER JOIN add_deal_form f ON f.id = di.deal_id
         WHERE di.is_draft = false
           AND trim(di.contact_id) <> '${AUTOSAVE_CONTACT}'
           AND lower(trim(di.investor_role)) IN (${SPONSOR_ROLES_SQL})
           AND (
             f.organization_id IS NULL
             OR lower(trim(f.organization_id::text)) NOT IN (SELECT org_id FROM viewer_orgs)
           )
           AND (
             lower(trim(di.contact_id)) IN (SELECT lower(user_id) FROM peer_users)
             OR EXISTS (
               SELECT 1
               FROM contact sponsor_contact
               INNER JOIN peer_users pu
                 ON lower(trim(sponsor_contact.email)) = pu.email
               WHERE sponsor_contact.id::text = trim(both from di.contact_id)
             )
           )
       ) src
       WHERE nullif(trim(src.deal_id), '') IS NOT NULL`;
}

/**
 * Deals outside this user's organizations where a peer in those organizations
 * is Lead, Admin, or Co-sponsor. Drafts and unfinished autosaves are omitted.
 */
export async function listCrossOrgColleagueSponsoredDealIds(
  userId: string,
): Promise<string[]> {
  const uid = String(userId ?? "").trim();
  if (!uid) return [];
  const orgIds = await listOrganizationIdsForUser(uid);
  if (orgIds.length === 0) return [];

  let rows: { deal_id: string }[];
  try {
    const res = await pool.query<{ deal_id: string }>(colleagueDealSql(true), [
      uid,
    ]);
    rows = res.rows;
  } catch (err) {
    if (!isMissingMembershipTableError(err)) throw err;
    const res = await pool.query<{ deal_id: string }>(colleagueDealSql(false), [
      uid,
    ]);
    rows = res.rows;
  }

  const ids = [
    ...new Set(
      rows.map((row) => String(row.deal_id ?? "").trim()).filter(Boolean),
    ),
  ];
  if (ids.length === 0) return [];

  const deals = await listAddDealFormsByIds(ids);
  const visible: string[] = [];
  for (const deal of deals) {
    if (isDealStageDraft(deal.dealStage)) continue;
    if (isAddDealFormIncomplete(deal)) continue;
    let inViewerOrg = false;
    for (const orgId of orgIds) {
      if (await isAddDealFormInOrganizationScope(deal, orgId)) {
        inViewerOrg = true;
        break;
      }
    }
    if (inViewerOrg) continue;
    visible.push(String(deal.id));
  }
  return visible;
}

/**
 * Org colleague can open this other-company deal, but is not a sponsor on it.
 * Lead, Admin, and Co-sponsors keep their own access. Same-org workspace staff
 * are not in this set.
 */
export async function viewerHasCrossOrgColleagueViewOnlyAccess(
  dealId: string,
  userId: string,
  userRole?: string | null,
): Promise<boolean> {
  const id = String(dealId ?? "").trim();
  const uid = String(userId ?? "").trim();
  if (!id || !uid) return false;
  if (isPlatformAdminRole(userRole)) return false;
  if (await isPortalUserDealSponsorOnDeal(id, uid)) return false;
  const ids = await listCrossOrgColleagueSponsoredDealIds(uid);
  const key = id.toLowerCase();
  return ids.some((deal) => deal.toLowerCase() === key);
}

/**
 * Sponsor in one of the viewer's organizations who grants this cross-org deal
 * visibility. Document reads use this sponsor's Lead/Admin/Co sharing scope.
 */
export async function resolveCrossOrgColleagueSponsorForDeal(
  dealId: string,
  viewerUserId: string,
): Promise<string | null> {
  const id = String(dealId ?? "").trim();
  const uid = String(viewerUserId ?? "").trim();
  if (!DEAL_UUID_RE.test(id) || !DEAL_UUID_RE.test(uid)) return null;
  const res = await pool.query<{ user_id: string }>(
    `WITH viewer_orgs AS (
       SELECT u.organization_id AS org_id
       FROM users u
       WHERE u.id = $2::uuid AND u.organization_id IS NOT NULL
       UNION
       SELECT m.company_id AS org_id
       FROM user_company_membership m
       WHERE m.user_id = $2::uuid
     ),
     sponsor_rows AS (
       SELECT dm.contact_member_id,
              lower(trim(dm.deal_member_role)) AS sponsor_role
       FROM deal_member dm
       WHERE dm.deal_id = $1::uuid
         AND dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN (
           ${SPONSOR_ROLES_SQL}
         )
       UNION
       SELECT di.contact_id AS contact_member_id,
              lower(trim(di.investor_role)) AS sponsor_role
       FROM deal_investment di
       WHERE di.deal_id = $1::uuid
         AND di.is_draft = false
         AND trim(di.contact_id) <> '${AUTOSAVE_CONTACT}'
         AND lower(trim(di.investor_role)) IN (
           ${SPONSOR_ROLES_SQL}
         )
     ),
     sponsor_users AS (
       SELECT DISTINCT u.id::text AS user_id, sr.sponsor_role
       FROM sponsor_rows sr
       INNER JOIN users u
         ON trim(sr.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1
           FROM contact c
           WHERE c.id::text = trim(both from sr.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       WHERE u.organization_id IN (SELECT org_id FROM viewer_orgs)
          OR EXISTS (
            SELECT 1
            FROM user_company_membership m
            WHERE m.user_id = u.id
              AND m.company_id IN (SELECT org_id FROM viewer_orgs)
          )
     )
     SELECT user_id
     FROM sponsor_users
     ORDER BY CASE sponsor_role
       WHEN 'lead sponsor' THEN 1
       WHEN 'lead_sponsor' THEN 1
       WHEN 'admin sponsor' THEN 2
       WHEN 'admin_sponsor' THEN 2
       ELSE 3
     END
     LIMIT 1`,
    [id, uid],
  );
  return String(res.rows[0]?.user_id ?? "").trim() || null;
}

function outsideOrganizationSponsorSql(includeMembership: boolean): string {
  const investorOrgs = includeMembership
    ? `SELECT u.organization_id AS org_id
       FROM users u
       WHERE u.id = $2::uuid AND u.organization_id IS NOT NULL
       UNION
       SELECT u.referred_by_company_id AS org_id
       FROM users u
       WHERE u.id = $2::uuid AND u.referred_by_company_id IS NOT NULL
       UNION
       SELECT m.company_id AS org_id
       FROM user_company_membership m
       WHERE m.user_id = $2::uuid`
    : `SELECT u.organization_id AS org_id
       FROM users u
       WHERE u.id = $2::uuid AND u.organization_id IS NOT NULL
       UNION
       SELECT u.referred_by_company_id AS org_id
       FROM users u
       WHERE u.id = $2::uuid AND u.referred_by_company_id IS NOT NULL`;
  const sponsorInOutsideOrg = includeMembership
    ? `u.organization_id IN (SELECT org_id FROM outside_orgs)
       OR EXISTS (
         SELECT 1
         FROM user_company_membership sponsor_membership
         WHERE sponsor_membership.user_id = u.id
           AND sponsor_membership.company_id IN (SELECT org_id FROM outside_orgs)
       )`
    : `u.organization_id IN (SELECT org_id FROM outside_orgs)`;
  return `WITH deal_org AS (
       SELECT f.organization_id AS org_id
       FROM add_deal_form f
       WHERE f.id = $1::uuid
     ),
     investor_orgs AS (
       ${investorOrgs}
       UNION
       SELECT NULLIF($3, '')::uuid AS org_id
       WHERE NULLIF($3, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ),
     outside_orgs AS (
       SELECT org_id
       FROM investor_orgs
       WHERE org_id IS NOT NULL
         AND org_id IS DISTINCT FROM (SELECT org_id FROM deal_org)
     ),
     sponsor_rows AS (
       SELECT dm.contact_member_id,
              lower(trim(dm.deal_member_role)) AS sponsor_role
       FROM deal_member dm
       WHERE dm.deal_id = $1::uuid
         AND dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN (${SPONSOR_ROLES_SQL})
       UNION
       SELECT di.contact_id AS contact_member_id,
              lower(trim(di.investor_role)) AS sponsor_role
       FROM deal_investment di
       WHERE di.deal_id = $1::uuid
         AND di.is_draft = false
         AND trim(di.contact_id) <> '${AUTOSAVE_CONTACT}'
         AND lower(trim(di.investor_role)) IN (${SPONSOR_ROLES_SQL})
     )
     SELECT u.id::text AS user_id
     FROM sponsor_rows sr
     INNER JOIN users u
       ON trim(sr.contact_member_id) = u.id::text
       OR EXISTS (
         SELECT 1
         FROM contact c
         WHERE c.id::text = trim(both from sr.contact_member_id)
           AND lower(trim(c.email)) = lower(trim(u.email))
       )
     WHERE ${sponsorInOutsideOrg}
     ORDER BY CASE sr.sponsor_role
       WHEN 'lead sponsor' THEN 1
       WHEN 'lead_sponsor' THEN 1
       WHEN 'admin sponsor' THEN 2
       WHEN 'admin_sponsor' THEN 2
       ELSE 3
     END
     LIMIT 1`;
}

/**
 * Org 2 investor on an Org 1 deal: the sponsor from the investor's own
 * organization. A lead sponsor in the deal's organization does not win just
 * because the investor also belongs to that organization.
 */
export async function resolveOutsideOrganizationSponsorForDeal(
  dealId: string,
  investorUserId: string,
  activeOrganizationId?: string | null,
): Promise<string | null> {
  const id = String(dealId ?? "").trim();
  const uid = String(investorUserId ?? "").trim();
  const activeOrg = String(activeOrganizationId ?? "").trim();
  if (!DEAL_UUID_RE.test(id) || !DEAL_UUID_RE.test(uid)) return null;
  const params = [id, uid, activeOrg];
  let rows: { user_id: string }[];
  try {
    const res = await pool.query<{ user_id: string }>(
      outsideOrganizationSponsorSql(true),
      params,
    );
    rows = res.rows;
  } catch (err) {
    if (!isMissingMembershipTableError(err)) throw err;
    const res = await pool.query<{ user_id: string }>(
      outsideOrganizationSponsorSql(false),
      params,
    );
    rows = res.rows;
  }
  return String(rows[0]?.user_id ?? "").trim() || null;
}

const SPONSOR_ROLE_MATCH =
  "('lead sponsor', 'lead_sponsor', 'admin sponsor', 'admin_sponsor', 'co-sponsor', 'co sponsor', 'co_sponsor')";

/**
 * Lead, Admin, or Co-sponsor on this deal, including a roster contact that
 * has not been linked to a portal login yet.
 */
async function resolveDealSponsorUserId(
  dealId: string,
  rawId: string,
  investorUserId: string,
): Promise<string | null> {
  const raw = String(rawId ?? "").trim();
  const investor = String(investorUserId ?? "").trim().toLowerCase();
  if (!raw || raw.toLowerCase() === investor) return null;
  const portal = await resolvePortalUserIdForContactMemberId(raw);
  const portalId = String(portal ?? "").trim();
  if (portalId && portalId.toLowerCase() !== investor) {
    if (await isPortalUserDealSponsorOnDeal(dealId, portalId)) return portalId;
  }
  if (!DEAL_UUID_RE.test(raw)) return null;
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     WHERE dm.deal_id = $1::uuid
       AND dm.is_draft = false
       AND lower(trim(dm.deal_member_role)) IN ${SPONSOR_ROLE_MATCH}
       AND (
         trim(dm.contact_member_id) = $2
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(dm.contact_member_id)
             AND c.id::text = $2
         )
       )
     UNION ALL
     SELECT 1 AS ok
     FROM deal_investment di
     WHERE di.deal_id = $1::uuid
       AND di.is_draft = false
       AND lower(trim(di.investor_role)) IN ${SPONSOR_ROLE_MATCH}
       AND trim(di.contact_id) <> '${AUTOSAVE_CONTACT}'
       AND trim(di.contact_id) = $2
     LIMIT 1`,
    [dealId, raw],
  );
  if (res.rows.length === 0) return null;
  return portalId || raw;
}

/**
 * Sponsor who invited this investor to this deal: the offering link they
 * opened, the deal invite recorded on their contact, or the roster adder.
 * The sponsor may be the Lead Sponsor, an Admin sponsor, or a Co-sponsor.
 */
export async function resolveDealInviterSponsorUserId(
  dealId: string,
  investorUserId: string,
  referringSponsorUserId?: string | null,
): Promise<string | null> {
  const id = String(dealId ?? "").trim();
  const uid = String(investorUserId ?? "").trim();
  const referred = String(referringSponsorUserId ?? "").trim();
  if (!DEAL_UUID_RE.test(id) || !DEAL_UUID_RE.test(uid)) return null;
  const res = await pool.query<{ user_id: string }>(
    `SELECT src.user_id
     FROM (
       SELECT u.referred_by_user_id::text AS user_id, 1 AS rank
       FROM users u
       WHERE u.id = $2::uuid
         AND u.referred_by_user_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM contact c
           WHERE c.referred_by_deal_id = $1::uuid
             AND lower(trim(c.email)) = lower(trim(u.email))
         )
       UNION ALL
       SELECT dm.added_by::text AS user_id, 2 AS rank
       FROM deal_member dm
       INNER JOIN users u ON u.id = $2::uuid
       WHERE dm.deal_id = $1::uuid
         AND dm.is_draft = false
         AND dm.added_by IS NOT NULL
         AND dm.added_by <> u.id
         AND (
           trim(dm.contact_member_id) = u.id::text
           OR EXISTS (
             SELECT 1
             FROM contact c
             WHERE c.id::text = trim(dm.contact_member_id)
               AND lower(trim(c.email)) = lower(trim(u.email))
           )
         )
       UNION ALL
       SELECT lp.added_by::text AS user_id, 3 AS rank
       FROM deal_lp_investor lp
       INNER JOIN users u ON u.id = $2::uuid
       WHERE lp.deal_id = $1::uuid
         AND lp.added_by IS NOT NULL
         AND lp.added_by <> u.id
         AND (
           trim(lp.contact_member_id) = u.id::text
           OR lower(trim(coalesce(lp.email, ''))) = lower(trim(u.email))
         )
     ) src
     WHERE src.user_id IS NOT NULL
     ORDER BY src.rank
     LIMIT 1`,
    [id, uid],
  );
  const candidate = String(res.rows[0]?.user_id ?? "").trim();
  const fromRoster = await resolveDealSponsorUserId(id, candidate, uid);
  if (fromRoster) return fromRoster;
  return resolveDealSponsorUserId(id, referred, uid);
}

/**
 * Org 2 investors are attributed to their organization's sponsor on the deal.
 * Everyone else is attributed to the user who invited them to this deal.
 */
export async function resolveInvestNowAddedByUserId(params: {
  dealId: string;
  investorUserId: string;
  referringSponsorUserId?: string | null;
  activeOrganizationId?: string | null;
}): Promise<string> {
  const investorUserId = String(params.investorUserId ?? "").trim();
  const outsideSponsor = await resolveOutsideOrganizationSponsorForDeal(
    params.dealId,
    investorUserId,
    params.activeOrganizationId,
  );
  if (outsideSponsor) return outsideSponsor;
  const inviter = await resolveDealInviterSponsorUserId(
    params.dealId,
    investorUserId,
    params.referringSponsorUserId,
  );
  return inviter || investorUserId;
}
