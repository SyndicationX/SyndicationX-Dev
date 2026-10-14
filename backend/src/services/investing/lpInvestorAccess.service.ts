/**
 * LP investing-mode nav, session flags, and deal allowlists from:
 * - `deal_lp_investor` only (contact email and/or denormalized `deal_lp_investor.email`).
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  isInvestorDashboardOpportunityOffering,
} from "../../constants/deal-lifecycle/deal-status-rules.js";
import { addDealForm } from "../../schema/deal.schema/add-deal-form.schema.js";
import {
  isCompanyAdminRole,
  isInvestorPortalRole,
  isPlatformAdminRole,
} from "../../constants/roles.js";
import { db, pool } from "../../database/db.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import { contact } from "../../schema/schema.js";
import { userInvestorProfiles } from "../../schema/investing.schema/userProfileBook.schema.js";
import { listDealIdsAssignedToUser } from "../deal/assigningDealUser.service.js";
import { listEquivalentPortalUserIdsForUser } from "../deal/dealMemberScope.service.js";
import {
  filterDealIdsVisibleToInvestors,
  isAddDealFormIncomplete,
} from "../deal/dealFormCompleteness.service.js";
import {
  filterDealIdsByContactOfferingVisibility,
  listContactOrganizationInvestingDealIds,
  listDealIdsSponsoredByCompanyColleague,
} from "../contact/contactOfferingVisibility.service.js";
import { listCrossOrgColleagueSponsoredDealIds } from "../deal/crossOrgColleagueDeal.service.js";

/** Stored `deal_lp_investor.role` values treated as LP Investor for nav + deal scope. */
export function isLpInvestorRoleInLpTable(role: string | null | undefined): boolean {
  const t = String(role ?? "").trim().toLowerCase();
  if (!t) return false;
  return (
    t === "lp investor" ||
    t === "lp investors" ||
    t === "lp_investors" ||
    t === "lp_investor"
  );
}

/**
 * Distinct `deal_id`s where this email matches the LP row via `contact.email` and/or
 * denormalized `deal_lp_investor.email` (e.g. invite flow sets the column before contact is updated).
 * Optional `alsoUserIds` matches portal user ids stored on `contact_member_id` (equivalent accounts).
 */
async function listDealIdsFromLpInvestorTableForEmail(
  emailNorm: string,
  alsoUserIds?: string[],
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  const extraIds = [
    ...new Set(
      (alsoUserIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean),
    ),
  ];
  if ((!e || !e.includes("@")) && extraIds.length === 0) return [];

  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dli.deal_id::text AS deal_id
     FROM deal_lp_investor dli
     WHERE dli.is_draft = false
     AND (
       (
         $1::text <> ''
         AND position('@' in $1) > 1
         AND (
           (
             nullif(trim(dli.email), '') IS NOT NULL
             AND lower(trim(dli.email)) = $1
           )
           OR EXISTS (
             SELECT 1 FROM contact c
             WHERE c.id::text = trim(both from dli.contact_member_id)
               AND nullif(trim(c.email), '') IS NOT NULL
               AND lower(trim(c.email)) = $1
           )
           OR EXISTS (
             SELECT 1 FROM users u
             WHERE u.id::text = trim(both from dli.contact_member_id)
               AND nullif(trim(u.email), '') IS NOT NULL
               AND lower(trim(u.email)) = $1
           )
         )
       )
       OR (
         cardinality($2::text[]) > 0
         AND lower(trim(dli.contact_member_id)) = ANY (
           SELECT lower(trim(x)) FROM unnest($2::text[]) AS x
         )
       )
     )`,
    [e.includes("@") ? e : "", extraIds],
  );

  return [
    ...new Set(
      res.rows.map((r) => String(r.deal_id ?? "").trim()).filter(Boolean),
    ),
  ];
}

/**
 * Deals where this email appears on `deal_member`, was added to the roster by `added_by`,
 * and that adder is a Lead / Admin / Co-sponsor on the same `deal_member` set.
 */
async function listDealIdsFromSponsorInvitedDealMemberForEmail(
  emailNorm: string,
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dm_investor.deal_id::text AS deal_id
     FROM deal_member dm_investor
     INNER JOIN users viewer_u ON lower(trim(viewer_u.email)) = $1
     INNER JOIN users adder_u ON adder_u.id = dm_investor.added_by
     INNER JOIN deal_member dm_sponsor ON
       dm_sponsor.deal_id = dm_investor.deal_id
       AND dm_sponsor.is_draft = false
       AND lower(trim(dm_sponsor.deal_member_role)) IN (
         'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'
       )
       AND (
         trim(dm_sponsor.contact_member_id) = adder_u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm_sponsor.contact_member_id)
             AND lower(trim(c.email)) = lower(trim(adder_u.email))
         )
       )
     WHERE dm_investor.added_by IS NOT NULL
       AND dm_investor.is_draft = false
       AND (
         trim(dm_investor.contact_member_id) = viewer_u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c2
           WHERE c2.id::text = trim(both from dm_investor.contact_member_id)
             AND lower(trim(c2.email)) = $1
         )
       )`,
    [e],
  );
  return [
    ...new Set(
      res.rows.map((r) => String(r.deal_id ?? "").trim()).filter(Boolean),
    ),
  ];
}

/**
 * Deals with a `deal_investment` row for this person: `contact_id` = portal `users.id`,
 * or a CRM `contact` id whose email matches. Includes $0 commitment (sponsor-added
 * rows before a commitment is entered). This path is required because LP–role
 * lines skip `deal_member` and may not yet match `deal_lp_investor` email joins.
 */
async function listDealIdsFromDealInvestmentForEmail(
  emailNorm: string,
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT di.deal_id::text AS deal_id
     FROM deal_investment di
     INNER JOIN users viewer_u ON lower(trim(viewer_u.email)) = $1
     WHERE nullif(trim(di.contact_id), '') IS NOT NULL
       AND di.is_draft = false
       AND (
         trim(both from di.contact_id) = viewer_u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from di.contact_id)
             AND nullif(trim(c.email), '') IS NOT NULL
             AND lower(trim(c.email)) = $1
         )
       )`,
    [e],
  );
  return [
    ...new Set(
      res.rows.map((r) => String(r.deal_id ?? "").trim()).filter(Boolean),
    ),
  ];
}

/**
 * True when this email appears on `deal_member` as a sponsor role.
 * Sponsor participants should stay in syndication shell (not forced investing-only LP nav).
 */
async function hasSponsorDealMemberRoleForEmail(
  emailNorm: string,
): Promise<boolean> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const res = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM deal_member dm
     INNER JOIN users u ON lower(trim(u.email)) = $1
     WHERE dm.is_draft = false
       AND lower(trim(dm.deal_member_role)) IN (
       'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'
     )
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = $1
         )
       )
     LIMIT 1`,
    [e],
  );
  return res.rows.length > 0;
}

/** Distinct deal ids for LP investing portal from `deal_lp_investor` only. */
export async function listLpInvestorDealIdsForUserEmail(
  emailNorm: string,
): Promise<string[]> {
  return listDealIdsFromLpInvestorTableForEmail(emailNorm);
}

/**
 * Distinct deal ids where this email appears on `deal_member` as Lead / Admin / Co-sponsor.
 */
export async function listDealIdsFromSponsorDealMemberForEmail(
  emailNorm: string,
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dm.deal_id::text AS deal_id
     FROM deal_member dm
     INNER JOIN users u ON lower(trim(u.email)) = $1
     WHERE dm.is_draft = false
       AND lower(trim(dm.deal_member_role)) IN (
       'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'
     )
       AND (
         trim(dm.contact_member_id) = u.id::text
         OR EXISTS (
           SELECT 1 FROM contact c
           WHERE c.id::text = trim(both from dm.contact_member_id)
             AND lower(trim(c.email)) = $1
         )
       )`,
    [e],
  );
  return [
    ...new Set(
      res.rows
        .map((r) => String(r.deal_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

const SPONSOR_DEAL_MEMBER_ROLES_SQL = `'lead sponsor', 'admin sponsor', 'co-sponsor', 'co sponsor'`;

/**
 * Portal user ids of people who added or invited this contact — from
 * `deal_lp_investor.added_by`, `deal_member.added_by`, `users.referred_by_user_id`,
 * or `contact.created_by`. Deals are limited afterward to rosters where that
 * person is a Lead, Admin, or Co-sponsor, in any organization.
 */
async function listSponsorUserIdsForInvestorEmail(
  emailNorm: string,
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const res = await pool.query<{ sponsor_user_id: string }>(
    `SELECT DISTINCT adder_u.id::text AS sponsor_user_id
     FROM deal_lp_investor lp
     INNER JOIN users viewer_u ON lower(trim(viewer_u.email)) = $1
     INNER JOIN users adder_u ON adder_u.id = lp.added_by
     WHERE lp.added_by IS NOT NULL
       AND lp.is_draft = false
       AND (
         lower(trim(lp.contact_member_id)) = lower(viewer_u.id::text)
         OR (
           nullif(trim(lp.email), '') IS NOT NULL
           AND lower(trim(lp.email)) = $1
         )
         OR EXISTS (
           SELECT 1 FROM contact c2
           WHERE c2.id::text = trim(both from lp.contact_member_id)
             AND lower(trim(c2.email)) = $1
         )
       )

     UNION

     SELECT DISTINCT adder_u.id::text AS sponsor_user_id
     FROM deal_member dm_investor
     INNER JOIN users viewer_u ON lower(trim(viewer_u.email)) = $1
     INNER JOIN users adder_u ON adder_u.id = dm_investor.added_by
     WHERE dm_investor.added_by IS NOT NULL
       AND dm_investor.is_draft = false
       AND (
         lower(trim(dm_investor.contact_member_id)) = lower(viewer_u.id::text)
         OR EXISTS (
           SELECT 1 FROM contact c2
           WHERE c2.id::text = trim(both from dm_investor.contact_member_id)
             AND lower(trim(c2.email)) = $1
         )
       )

     UNION

     SELECT DISTINCT ref_u.id::text AS sponsor_user_id
     FROM users viewer_u
     INNER JOIN users ref_u ON ref_u.id = viewer_u.referred_by_user_id
     WHERE lower(trim(viewer_u.email)) = $1
       AND viewer_u.referred_by_user_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM deal_member dm
         WHERE dm.is_draft = false
           AND lower(trim(dm.deal_member_role)) IN (
             ${SPONSOR_DEAL_MEMBER_ROLES_SQL}
           )
           AND (
             lower(trim(dm.contact_member_id)) = lower(ref_u.id::text)
             OR EXISTS (
               SELECT 1 FROM contact c_s
               WHERE c_s.id::text = trim(both from dm.contact_member_id)
                 AND lower(trim(c_s.email)) = lower(trim(ref_u.email))
             )
           )
       )

     UNION

     SELECT DISTINCT creator_u.id::text AS sponsor_user_id
     FROM contact c_inv
     INNER JOIN users viewer_u ON lower(trim(viewer_u.email)) = $1
     INNER JOIN users creator_u ON creator_u.id = c_inv.created_by
     WHERE lower(trim(c_inv.email)) = $1
       AND EXISTS (
         SELECT 1 FROM deal_member dm
         WHERE dm.is_draft = false
         AND lower(trim(dm.deal_member_role)) IN (
           ${SPONSOR_DEAL_MEMBER_ROLES_SQL}
         )
         AND (
           lower(trim(dm.contact_member_id)) = lower(creator_u.id::text)
           OR EXISTS (
             SELECT 1 FROM contact c_s
             WHERE c_s.id::text = trim(both from dm.contact_member_id)
               AND lower(trim(c_s.email)) = lower(trim(creator_u.email))
           )
         )
       )`,
    [e],
  );
  return [
    ...new Set(
      res.rows
        .map((r) => String(r.sponsor_user_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

/** All deal ids where any of these portal users is Lead / Admin / Co-sponsor on the roster. */
async function listDealIdsWhereSponsorUsersOnRoster(
  sponsorUserIds: string[],
): Promise<string[]> {
  const sponsors = [
    ...new Set(sponsorUserIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
  ];
  if (sponsors.length === 0) return [];
  const res = await pool.query<{ deal_id: string }>(
    `SELECT DISTINCT dm.deal_id::text AS deal_id
     FROM deal_member dm
     WHERE dm.is_draft = false
     AND lower(trim(dm.deal_member_role)) IN (
       ${SPONSOR_DEAL_MEMBER_ROLES_SQL}
     )
     AND (
       lower(trim(dm.contact_member_id)) = ANY(
         SELECT lower(trim(x)) FROM unnest($1::text[]) AS x
       )
       OR EXISTS (
         SELECT 1 FROM users su
         INNER JOIN contact c ON c.id::text = trim(both from dm.contact_member_id)
         WHERE lower(su.id::text) = ANY(
           SELECT lower(trim(x)) FROM unnest($1::text[]) AS x
         )
           AND lower(trim(c.email)) = lower(trim(su.email))
       )
     )`,
    [sponsors],
  );
  return [
    ...new Set(
      res.rows.map((r) => String(r.deal_id ?? "").trim()).filter(Boolean),
    ),
  ];
}

/**
 * Every offering of the sponsor who added or invited this contact — any
 * organization, not only the deal they were named on. Those deals stay
 * visible. Offering visibility still limits the rest of each company's list.
 */
export async function listInvestorSponsorScopedDealIdsForUser(
  emailNorm: string,
  opts?: { applyContactOfferingVisibility?: boolean },
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const sponsorUserIds = await listSponsorUserIdsForInvestorEmail(e);
  const raw =
    sponsorUserIds.length === 0
      ? await listDealIdsFromLpInvestorTableForEmail(e)
      : await listDealIdsWhereSponsorUsersOnRoster(sponsorUserIds);
  const visible = await filterDealIdsVisibleToInvestors(raw);
  if (opts?.applyContactOfferingVisibility === false) return visible;
  if (sponsorUserIds.length === 0) {
    return filterDealIdsByContactOfferingVisibility(e, visible);
  }
  return filterSponsorScopedDealIdsByContactVisibility(e, visible);
}

/** Opportunity deal ids where at least one linked sponsor is on the deal roster. */
async function filterDealIdsToThoseWithSponsorUsersOnRoster(
  dealIds: string[],
  sponsorUserIds: string[],
): Promise<string[]> {
  const ids = [...new Set(dealIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const sponsorScoped = await listDealIdsWhereSponsorUsersOnRoster(sponsorUserIds);
  const allowed = new Set(sponsorScoped);
  return ids.filter((id) => allowed.has(id));
}

/** Show Offerings, Hide Offerings, 506(b) only, or 506(c) only — same rules as the contact column. */
async function filterSponsorScopedDealIdsByContactVisibility(
  emailNorm: string,
  dealIds: string[],
): Promise<string[]> {
  return filterDealIdsByContactOfferingVisibility(emailNorm, dealIds);
}

/**
 * Investor dashboard “Opportunities” — coming soon (preview) and open-for-investment
 * offerings where a sponsor linked to this investor is on the deal roster.
 */
export async function listInvestorVisibleComingSoonDealIdsForUser(
  emailNorm: string,
): Promise<string[]> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return [];
  const [allOpportunityIds, sponsorUserIds] = await Promise.all([
    listInvestorVisibleComingSoonDealIds(),
    listSponsorUserIdsForInvestorEmail(e),
  ]);
  if (sponsorUserIds.length === 0) return [];
  const scoped = await filterDealIdsToThoseWithSponsorUsersOnRoster(
    allOpportunityIds,
    sponsorUserIds,
  );
  return filterSponsorScopedDealIdsByContactVisibility(e, scoped);
}

/**
 * All investor-dashboard opportunity offerings (not draft / closed / past).
 * Prefer {@link listInvestorVisibleComingSoonDealIdsForUser} for LP viewers.
 */
export async function listInvestorVisibleComingSoonDealIds(): Promise<string[]> {
  const rows = await db
    .select({
      id: addDealForm.id,
      dealStage: addDealForm.dealStage,
      offeringStatus: addDealForm.offeringStatus,
      secType: addDealForm.secType,
      owningEntityName: addDealForm.owningEntityName,
      propertyName: addDealForm.propertyName,
      city: addDealForm.city,
    })
    .from(addDealForm)
    .where(ne(addDealForm.dealStage, "draft"));

  const out: string[] = [];
  for (const row of rows) {
    if (isAddDealFormIncomplete(row)) continue;
    if (
      !isInvestorDashboardOpportunityOffering(
        row.dealStage,
        row.offeringStatus,
      )
    ) {
      continue;
    }
    const id = String(row.id ?? "").trim();
    if (id) out.push(id);
  }
  return out;
}

/**
 * Investing participant deals excluding dashboard “Opportunities” (coming soon /
 * open for investment) scoped to the investor’s linked sponsors.
 */
export async function listDirectInvestingParticipantDealIdsForUser(params: {
  userId: string;
  emailNorm: string;
  applyContactOfferingVisibility?: boolean;
}): Promise<string[]> {
  const emailNorm = String(params.emailNorm ?? "").trim().toLowerCase();
  const userId = String(params.userId ?? "").trim();
  if (!userId) return [];

  const equivalentIds = await listEquivalentPortalUserIdsForUser(userId);
  const viewerKeys =
    equivalentIds.length > 0 ? equivalentIds : userId ? [userId] : [];

  const [lp, sponsor, sponsorInvited, assigned, investment] =
    await Promise.all([
      listDealIdsFromLpInvestorTableForEmail(emailNorm, viewerKeys),
      emailNorm.includes("@")
        ? listDealIdsFromSponsorDealMemberForEmail(emailNorm)
        : Promise.resolve([] as string[]),
      emailNorm.includes("@")
        ? listDealIdsFromSponsorInvitedDealMemberForEmail(emailNorm)
        : Promise.resolve([] as string[]),
      listDealIdsAssignedToUser(userId),
      emailNorm.includes("@")
        ? listDealIdsFromDealInvestmentForEmail(emailNorm)
        : Promise.resolve([] as string[]),
    ]);

  const merged = [
    ...new Set([
      ...lp,
      ...sponsor,
      ...sponsorInvited,
      ...assigned,
      ...investment,
    ]),
  ];
  const visible = await filterDealIdsVisibleToInvestors(merged);
  if (!emailNorm.includes("@")) return visible;
  if (params.applyContactOfferingVisibility === false) return visible;
  return filterDealIdsByContactOfferingVisibility(emailNorm, visible);
}

/**
 * True when this portal user (or an equivalent account) has a non-archived
 * investor profile — used to enable Investing switch for dual co-sponsors.
 */
export async function viewerHasInvestorProfile(
  userId: string,
): Promise<boolean> {
  const uid = String(userId ?? "").trim();
  if (!uid) return false;
  const equivalentIds = await listEquivalentPortalUserIdsForUser(uid);
  const ids = equivalentIds.length > 0 ? equivalentIds : [uid];
  const [row] = await db
    .select({ id: userInvestorProfiles.id })
    .from(userInvestorProfiles)
    .where(
      and(
        inArray(userInvestorProfiles.userId, ids),
        eq(userInvestorProfiles.archived, false),
      ),
    )
    .limit(1);
  return Boolean(row?.id);
}

export async function isDealInDirectInvestingParticipationForUser(
  dealId: string,
  params: { userId: string; emailNorm: string },
): Promise<boolean> {
  const id = String(dealId ?? "").trim();
  if (!id) return false;
  const ids = await listDirectInvestingParticipantDealIdsForUser({
    ...params,
    applyContactOfferingVisibility: false,
  });
  return ids.includes(id);
}

export async function isDealInInvestingParticipantListForUser(
  dealId: string,
  params: { userId: string; emailNorm: string },
): Promise<boolean> {
  const id = String(dealId ?? "").trim();
  if (!id) return false;
  const ids = await listInvestingParticipantDealIdsForUser({
    ...params,
    applyContactOfferingVisibility: false,
  });
  return ids.includes(id);
}

/**
 * Investing dashboard + `/investing/deals`.
 * Offerings from companies where this email is a contact, deals they were
 * added to directly, every deal where a sponsor who invited them is a
 * sponsor, and every other-company deal where any user from this contact's
 * company is a sponsor.
 */
export async function listInvestingParticipantDealIdsForUser(params: {
  userId: string;
  emailNorm: string;
  applyContactOfferingVisibility?: boolean;
}): Promise<string[]> {
  const emailNorm = String(params.emailNorm ?? "").trim().toLowerCase();
  const userId = String(params.userId ?? "").trim();
  if (!userId) return [];
  const applyContactOfferingVisibility =
    params.applyContactOfferingVisibility !== false;

  const organizationDeals = emailNorm.includes("@")
    ? await listContactOrganizationInvestingDealIds(emailNorm)
    : null;

  const [direct, sponsorScoped, companyColleague, crossOrgColleague] =
    await Promise.all([
    listDirectInvestingParticipantDealIdsForUser({
      userId,
      emailNorm,
      applyContactOfferingVisibility,
    }),
    emailNorm.includes("@")
      ? listInvestorSponsorScopedDealIdsForUser(emailNorm, {
          applyContactOfferingVisibility,
        })
      : Promise.resolve([] as string[]),
    emailNorm.includes("@")
      ? listDealIdsSponsoredByCompanyColleague(emailNorm).then((ids) =>
          filterDealIdsVisibleToInvestors([...ids]),
        )
      : Promise.resolve([] as string[]),
    listCrossOrgColleagueSponsoredDealIds(userId),
  ]);

  return [
    ...new Set([
      ...(organizationDeals ?? []),
      ...direct,
      ...sponsorScoped,
      ...companyColleague,
      ...crossOrgColleague,
    ]),
  ];
}

/**
 * For each deal id, the `deal_lp_investor.role` for this portal user (contact email
 * and/or `deal_lp_investor.email` match). Used by GET /deals list when the viewer is LP email–scoped.
 */
export async function mapLpInvestorRoleDisplayByDealIdForUserEmail(
  emailNorm: string,
  dealIds: string[],
): Promise<Map<string, string>> {
  const e = String(emailNorm ?? "").trim().toLowerCase();
  const ids = [...new Set(dealIds.map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (!e || !e.includes("@") || ids.length === 0) return new Map();

  const rows = await db
    .select({
      dealId: dealLpInvestor.dealId,
      role: dealLpInvestor.role,
    })
    .from(dealLpInvestor)
    .leftJoin(
      contact,
      sql`${contact.id}::text = trim(both from ${dealLpInvestor.contactMemberId})`,
    )
    .where(
      and(
        inArray(dealLpInvestor.dealId, ids),
        eq(dealLpInvestor.isDraft, false),
        or(
          sql`(nullif(trim(${contact.email}), '') IS NOT NULL AND lower(trim(${contact.email})) = ${e})`,
          sql`nullif(trim(${dealLpInvestor.email}), '') IS NOT NULL AND lower(trim(${dealLpInvestor.email})) = ${e}`,
        ),
      ),
    );

  const map = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.dealId ?? "").trim();
    const role = String(r.role ?? "").trim();
    if (!id || map.has(id)) continue;
    map.set(id, role || "LP Investor");
  }
  return map;
}

/**
 * Session flags for sign-in / account: investing nav + deal id allowlist (see
 * {@link listLpInvestorDealIdsForUserEmail}).
 */
export async function resolveLpInvestorSessionFlags(emailNorm: string): Promise<{
  lp_investor_nav: boolean;
  lp_investor_deal_ids: string[];
  lp_investor_role_display: string | null;
}> {
  const lpRows = await listLpInvestorDealIdsForUserEmail(emailNorm);
  if (lpRows.length === 0) {
    return {
      lp_investor_nav: false,
      lp_investor_deal_ids: [],
      lp_investor_role_display: null,
    };
  }

  const dealIds = await listInvestorSponsorScopedDealIdsForUser(emailNorm);
  const lp_investor_role_display = "LP Investor";

  return {
    lp_investor_nav: true,
    lp_investor_deal_ids: dealIds,
    lp_investor_role_display,
  };
}

/**
 * Single writer for `is_lp_investor`, `lp_investor_nav`, and `lp_investor_deal_ids` on sign-in / account.
 * Platform/company admins and anyone on a deal as Lead / Admin / Co-sponsor keep the
 * syndication shell (`lp_investor_nav` false) even when also listed as an LP investor —
 * so dual investor + co-sponsor users can switch modes.
 *
 * When a co-sponsor (or other syndication shell user) has LP rows / an investor profile,
 * `lp_investor_deal_ids` is still populated so Investing mode can list their deals.
 */
export async function mergeLpInvestorFlagsIntoUserPayload(
  base: Record<string, unknown>,
  opts: { email: string | null | undefined; portalRole: string | null | undefined; userId?: string | null },
): Promise<Record<string, unknown>> {
  const emailNorm = String(opts.email ?? "").trim().toLowerCase();
  const portalRole = String(opts.portalRole ?? "").trim();
  const userId = String(opts.userId ?? base.id ?? "").trim();

  if (!emailNorm || !emailNorm.includes("@")) {
    return {
      ...base,
      lp_investor_nav: false,
      lp_investor_deal_ids: [],
      lp_investor_role_display: null,
      is_lp_investor: false,
      is_deal_sponsor: false,
    };
  }

  const sponsorOnRoster = await hasSponsorDealMemberRoleForEmail(emailNorm);
  const syndicationShell =
    isPlatformAdminRole(portalRole) ||
    isCompanyAdminRole(portalRole) ||
    sponsorOnRoster;

  /** Pure investor portal role with no sponsor roster seat — investing-only. */
  if (isInvestorPortalRole(portalRole) && !sponsorOnRoster) {
    const lp = await resolveLpInvestorSessionFlags(emailNorm);
    const dealIds =
      userId && lp.lp_investor_deal_ids.length === 0
        ? await listInvestingParticipantDealIdsForUser({ userId, emailNorm })
        : lp.lp_investor_deal_ids;
    return {
      ...base,
      lp_investor_nav: true,
      lp_investor_deal_ids: dealIds,
      lp_investor_role_display: "Investor",
      is_lp_investor: true,
      is_deal_sponsor: false,
    };
  }

  const lp = await resolveLpInvestorSessionFlags(emailNorm);
  let dealIds = lp.lp_investor_deal_ids;
  if (userId) {
    const expanded = await listInvestingParticipantDealIdsForUser({
      userId,
      emailNorm,
    });
    if (expanded.length > 0) dealIds = expanded;
  }
  const hasProfile = userId ? await viewerHasInvestorProfile(userId) : false;
  const hasInvestingDeals = dealIds.length > 0 || hasProfile;
  const lpNav = lp.lp_investor_nav && !syndicationShell;
  return {
    ...base,
    lp_investor_nav: lpNav,
    /** Dual co-sponsor + investor: keep deal ids for Investing switch even when nav is syndicating. */
    lp_investor_deal_ids: hasInvestingDeals ? dealIds : [],
    lp_investor_role_display: lpNav
      ? lp.lp_investor_role_display
      : hasInvestingDeals
        ? "LP Investor"
        : null,
    is_lp_investor: lpNav || hasInvestingDeals,
    is_deal_sponsor: sponsorOnRoster,
  };
}
