import { eq } from "drizzle-orm";
import {
  isDealInDirectInvestingParticipationForUser,
  isDealInInvestingParticipantListForUser,
} from "../investing/lpInvestorAccess.service.js";
import { isDealStageDraft } from "../../constants/deal-lifecycle/deal-stage.js";
import {
  DEAL_PARTICIPANT,
  isCompanyAdminRole,
  isPlatformAdminRole,
  ORG_DIRECTORY_MEMBER_ROLES,
  PLATFORM_USER,
} from "../../constants/roles.js";
import { mapWithConcurrency } from "../../common/mapWithConcurrency.js";
import { db } from "../../database/db.js";
import type { AddDealFormRow } from "../../schema/deal.schema/add-deal-form.schema.js";
import { users } from "../../schema/schema.js";
import {
  assignCreatorToDeal,
  isUserAssignedToDeal,
  listDealIdsAssignedToUser,
} from "./assigningDealUser.service.js";
import {
  resolveActiveOrganizationIdForUser,
} from "../org/orgResolution.service.js";
import {
  getAddDealFormById,
  isAddDealFormInOrganizationScope,
  listAddDealFormsByIds,
  listAddDealFormsForViewer,
  type DealViewerScope,
} from "./dealForm.service.js";
import { isAddDealFormIncomplete } from "./dealFormCompleteness.service.js";
import {
  isPortalUserOnDealMemberRoster,
  listDealIdsFromDealMemberRosterForUser,
  listDealIdsWhereViewerIsCoSponsor,
  listDealIdsWhereViewerIsLeadOrAdminSponsor,
  isPortalUserDealSponsorOnDeal,
  viewerHasNonCoSponsorDealMemberRole,
} from "./dealMemberScope.service.js";
import { assignCreatorAsLeadSponsorOnDeal } from "./dealMember.service.js";
import { listLpInvestorDealIdsForUserEmail, listInvestingParticipantDealIdsForUser } from "../investing/lpInvestorAccess.service.js";
import { isDealAllowedByContactOfferingVisibility } from "../contact/contactOfferingVisibility.service.js";
import { isInvestingPortalRequest } from "../../middleware/portalMode.middleware.js";
import { listCrossOrgColleagueSponsoredDealIds } from "./crossOrgColleagueDeal.service.js";

export type { DealViewerScope } from "./dealForm.service.js";

function isOrgWorkspaceStaffRole(role: string): boolean {
  return (ORG_DIRECTORY_MEMBER_ROLES as readonly string[]).includes(role);
}

async function viewerEmailNormForScope(scope: DealViewerScope): Promise<string> {
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1);
  return String(row?.email ?? "").trim().toLowerCase();
}

export async function resolveDealViewerScope(
  userId: string,
  jwtUserRole: string | undefined,
  requestedOrganizationId?: string | null,
): Promise<DealViewerScope> {
  const [row] = await db
    .select({
      organizationId: users.organizationId,
      role: users.role,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const preloaded = row
    ? {
        organizationId: row.organizationId,
        role: row.role,
      }
    : null;
  const organizationId = await resolveActiveOrganizationIdForUser(
    userId,
    requestedOrganizationId,
    preloaded,
  );
  const dbRole = String(row?.role ?? "").trim();
  const jwtRole = String(jwtUserRole ?? "").trim();
  const role = dbRole || jwtRole;
  const isPlatformAdmin = isPlatformAdminRole(role);
  const assignedParticipationOnly = role === DEAL_PARTICIPANT;
  const seesAllDeals =
    !assignedParticipationOnly &&
    (isPlatformAdmin || (role === PLATFORM_USER && organizationId == null));

  const emailNorm = String(row?.email ?? "").trim().toLowerCase();
  const [lpDealIds, coSponsorDealIdsEarly, leadAdminSponsorDealIds] =
    await Promise.all([
      listLpInvestorDealIdsForUserEmail(emailNorm),
      listDealIdsWhereViewerIsCoSponsor(userId),
      listDealIdsWhereViewerIsLeadOrAdminSponsor(userId),
    ]);
  const viewerIsSponsorOnAnyDeal =
    coSponsorDealIdsEarly.length > 0 || leadAdminSponsorDealIds.length > 0;
  /**
   * Sponsors (Lead / Admin / Co) keep syndicating deal scope. LP email scope
   * must not replace that list — Investing uses `includeParticipantDeals`
   * separately when they have an investor profile / LP rows.
   */
  const applyLpEmailScope =
    lpDealIds.length > 0 &&
    !viewerIsSponsorOnAnyDeal &&
    !isPlatformAdminRole(role) &&
    !isCompanyAdminRole(role);

  let lpInvestorEmailScopedDealIds: string[] | null = null;
  if (applyLpEmailScope) {
    // Direct LP deals + inviting-sponsor offerings. Contact offering
    // visibility is applied only in Investing Mode.
    lpInvestorEmailScopedDealIds =
      await listInvestingParticipantDealIdsForUser({
        userId,
        emailNorm,
        applyContactOfferingVisibility: isInvestingPortalRequest(),
      });
  }

  let coSponsorDashboardDealIds: string[] | null = null;
  if (
    !applyLpEmailScope &&
    !assignedParticipationOnly &&
    !isPlatformAdmin &&
    !isCompanyAdminRole(role)
  ) {
    const hasOtherRosterRole = await viewerHasNonCoSponsorDealMemberRole(
      userId,
    );
    if (coSponsorDealIdsEarly.length > 0 && !hasOtherRosterRole) {
      coSponsorDashboardDealIds = coSponsorDealIdsEarly;
    }
  }

  /**
   * CRM Contacts Visibility (Show / Hide / 506(c) only) applies only in Investing
   * Mode. Syndicating lists and deal access ignore it so sponsors / dual-role
   * users still see every workspace deal they are entitled to.
   */
  const enforceContactOfferingVisibility =
    !isPlatformAdmin && isInvestingPortalRequest();

  const crossOrgColleagueSponsoredDealIds = isPlatformAdmin
    ? []
    : await listCrossOrgColleagueSponsoredDealIds(userId);

  /**
   * Users from Contacts (deal_participant / investor — not org staff) may only
   * see syndicating deals where they are Lead, Admin, or Co-sponsor.
   */
  const syndicationSponsorOnly = !isOrgWorkspaceStaffRole(role);
  const syndicationSponsorDealIds = syndicationSponsorOnly
    ? [...new Set([...leadAdminSponsorDealIds, ...coSponsorDealIdsEarly])]
    : null;

  return {
    userId,
    organizationId,
    isPlatformAdmin,
    seesAllDeals,
    assignedParticipationOnly,
    lpInvestorEmailScopedDealIds,
    coSponsorDashboardDealIds,
    enforceContactOfferingVisibility,
    syndicationSponsorOnly,
    syndicationSponsorDealIds,
    crossOrgColleagueSponsoredDealIds,
  };
}

function dealIdInList(dealId: string, ids: string[] | null | undefined): boolean {
  const key = String(dealId ?? "").trim().toLowerCase();
  if (!key || !ids?.length) return false;
  return ids.some((id) => id.toLowerCase() === key);
}

/** Syndication workspace (org, roster sponsor, platform admin) — not LP-only access. */
export async function viewerHasSyndicationDealWorkspaceAccess(
  deal: AddDealFormRow,
  scope: DealViewerScope,
): Promise<boolean> {
  const dealId = String(deal.id);
  if (scope.syndicationSponsorOnly) {
    if (scope.syndicationSponsorDealIds?.includes(dealId)) return true;
    return isPortalUserDealSponsorOnDeal(dealId, scope.userId);
  }
  if (scope.seesAllDeals) return true;
  if (await isPortalUserOnDealMemberRoster(dealId, scope.userId)) return true;
  if (scope.coSponsorDashboardDealIds?.includes(dealId)) return true;
  if (
    scope.organizationId &&
    (await isAddDealFormInOrganizationScope(deal, scope.organizationId))
  ) {
    return true;
  }
  if (
    !scope.syndicationSponsorOnly &&
    dealIdInList(dealId, scope.crossOrgColleagueSponsoredDealIds)
  ) {
    return true;
  }
  return false;
}

async function investorParticipantMayReadDeal(
  deal: AddDealFormRow,
  scope: DealViewerScope,
): Promise<boolean> {
  if (!isAddDealFormIncomplete(deal) || isDealStageDraft(deal.dealStage)) {
    return true;
  }
  return viewerHasSyndicationDealWorkspaceAccess(deal, scope);
}

/** Investing lists: hide unfinished autosave deals. Draft deals stay visible to contacts. */
export async function filterDealsVisibleToInvestorParticipants(
  rows: AddDealFormRow[],
  scope: DealViewerScope,
): Promise<AddDealFormRow[]> {
  const visible = await mapWithConcurrency(rows, 8, (row) =>
    investorParticipantMayReadDeal(row, scope),
  );
  return rows.filter((_, i) => visible[i] === true);
}

export async function dealAccessibleToViewerScope(
  deal: AddDealFormRow | undefined | null,
  scope: DealViewerScope,
): Promise<boolean> {
  if (!deal) return false;
  const dealRow = deal;
  const dealId = String(dealRow.id);
  const dealSecType = dealRow.secType;

  /**
   * CRM Contacts Visibility (Hide / 506c-only) gates Investing Mode deal access
   * only. Syndicating workspace access never applies this preference.
   */
  async function passesContactOfferingVisibility(): Promise<boolean> {
    if (scope.isPlatformAdmin || !scope.enforceContactOfferingVisibility) {
      return true;
    }
    if (dealIdInList(dealId, scope.crossOrgColleagueSponsoredDealIds)) {
      return true;
    }
    const emailNorm = await viewerEmailNormForScope(scope);
    if (!emailNorm) return true;
    return isDealAllowedByContactOfferingVisibility({
      emailNorm,
      dealId,
      secType: dealSecType,
    });
  }

  let baseOk = false;
  if (scope.syndicationSponsorOnly && !isInvestingPortalRequest()) {
    baseOk = await viewerHasSyndicationDealWorkspaceAccess(dealRow, scope);
  } else if (await isPortalUserOnDealMemberRoster(dealId, scope.userId)) {
    baseOk = true;
  } else if (scope.lpInvestorEmailScopedDealIds != null) {
    if (scope.lpInvestorEmailScopedDealIds.includes(dealId)) {
      baseOk = true;
    } else {
      const emailNorm = await viewerEmailNormForScope(scope);
      if (
        emailNorm &&
        (await isDealInDirectInvestingParticipationForUser(dealId, {
          userId: scope.userId,
          emailNorm,
        }))
      ) {
        baseOk = true;
      }
    }
  } else if (scope.coSponsorDashboardDealIds?.length) {
    baseOk = scope.coSponsorDashboardDealIds.includes(dealId);
  } else if (scope.assignedParticipationOnly) {
    baseOk = await isUserAssignedToDeal(scope.userId, dealId);
  } else if (scope.seesAllDeals) {
    baseOk = true;
  } else if (scope.organizationId) {
    baseOk = await isAddDealFormInOrganizationScope(
      dealRow,
      scope.organizationId,
    );
  }

  /**
   * Investing: offerings from the sponsors linked to this contact, already
   * limited by Offering visibility (Show / Hide / 506(b) / 506(c)). A sponsor
   * roster seat must not replace that list or block deals the contact is not
   * personally on.
   */
  if (
    !baseOk &&
    dealIdInList(dealId, scope.crossOrgColleagueSponsoredDealIds) &&
    (!scope.syndicationSponsorOnly || isInvestingPortalRequest())
  ) {
    baseOk = true;
  }

  if (!baseOk && isInvestingPortalRequest() && !scope.isPlatformAdmin) {
    const emailNorm = await viewerEmailNormForScope(scope);
    if (
      emailNorm &&
      (await isDealInInvestingParticipantListForUser(dealId, {
        userId: scope.userId,
        emailNorm,
      }))
    ) {
      baseOk = true;
    }
  }

  if (!baseOk) return false;
  return passesContactOfferingVisibility();
}

export async function getAddDealFormForViewer(
  dealId: string,
  scope: DealViewerScope,
): Promise<AddDealFormRow | undefined> {
  const row = await getAddDealFormById(dealId);
  if (!(await dealAccessibleToViewerScope(row, scope))) return undefined;
  return row;
}

/**
 * Draft deals created via POST before creator assignment was linked — repair
 * org-scoped in-progress drafts for `deal_participant` on read/write.
 */
export async function getAddDealFormForViewerWithDraftCreatorRepair(
  dealId: string,
  scope: DealViewerScope,
): Promise<AddDealFormRow | undefined> {
  const existing = await getAddDealFormForViewerOrAssignedParticipant(
    dealId,
    scope,
  );
  if (existing) return existing;
  if (!scope.assignedParticipationOnly || !scope.organizationId) {
    return undefined;
  }
  const row = await getAddDealFormById(dealId);
  if (!row || !isDealStageDraft(row.dealStage)) return undefined;
  if (!(await isAddDealFormInOrganizationScope(row, scope.organizationId))) {
    return undefined;
  }
  await assignCreatorToDeal(dealId, scope.userId);
  await assignCreatorAsLeadSponsorOnDeal(dealId, scope.userId);
  return getAddDealFormForViewer(dealId, scope);
}

export async function assertDealIdInViewerScope(
  dealId: string,
  scope: DealViewerScope,
): Promise<boolean> {
  const row = await getAddDealFormById(dealId);
  return dealAccessibleToViewerScope(row, scope);
}

/**
 * Read access: company-scoped deals **or** deals where the user is linked on the
 * roster / investments (`assigning_deal_user` / `deal_investment` / LP roster).
 */
export async function assertDealIdReadableOrAssignedParticipant(
  dealId: string,
  scope: DealViewerScope,
): Promise<boolean> {
  const row = await getAddDealFormById(dealId);
  if (!row) return false;
  const dealSecType = row.secType;
  if (!(await investorParticipantMayReadDeal(row, scope))) return false;
  if (await dealAccessibleToViewerScope(row, scope)) return true;
  if (scope.syndicationSponsorOnly && !isInvestingPortalRequest()) return false;
  /** LP email scope (incl. empty after Hide Offerings) — no org/assigned fallthrough. */
  if (scope.lpInvestorEmailScopedDealIds != null) return false;
  if (scope.coSponsorDashboardDealIds != null) return false;
  const emailNorm = await viewerEmailNormForScope(scope);
  async function passesOffering(): Promise<boolean> {
    if (scope.isPlatformAdmin || !emailNorm) return true;
    if (!scope.enforceContactOfferingVisibility) return true;
    return isDealAllowedByContactOfferingVisibility({
      emailNorm,
      dealId,
      secType: dealSecType,
    });
  }
  if (await isUserAssignedToDeal(scope.userId, dealId)) {
    return passesOffering();
  }
  if (
    emailNorm &&
    (await isDealInDirectInvestingParticipationForUser(dealId, {
      userId: scope.userId,
      emailNorm,
    }))
  ) {
    return passesOffering();
  }
  if (
    emailNorm &&
    (await isDealInInvestingParticipantListForUser(dealId, {
      userId: scope.userId,
      emailNorm,
    }))
  ) {
    return passesOffering();
  }
  return false;
}

/** Same as {@link getAddDealFormForViewer} plus portal users assigned to the deal as investors. */
export async function getAddDealFormForViewerOrAssignedParticipant(
  dealId: string,
  scope: DealViewerScope,
): Promise<AddDealFormRow | undefined> {
  const row = await getAddDealFormById(dealId);
  if (!row) return undefined;
  const dealSecType = row.secType;
  if (!(await investorParticipantMayReadDeal(row, scope))) return undefined;
  if (await dealAccessibleToViewerScope(row, scope)) return row;
  if (scope.syndicationSponsorOnly && !isInvestingPortalRequest()) {
    return undefined;
  }
  if (scope.lpInvestorEmailScopedDealIds != null) return undefined;
  if (scope.coSponsorDashboardDealIds != null) return undefined;
  const emailNorm = await viewerEmailNormForScope(scope);
  async function passesOffering(): Promise<boolean> {
    if (scope.isPlatformAdmin || !emailNorm) return true;
    if (!scope.enforceContactOfferingVisibility) return true;
    return isDealAllowedByContactOfferingVisibility({
      emailNorm,
      dealId,
      secType: dealSecType,
    });
  }
  if (await isUserAssignedToDeal(scope.userId, dealId)) {
    return (await passesOffering()) ? row : undefined;
  }
  if (
    emailNorm &&
    (await isDealInInvestingParticipantListForUser(dealId, {
      userId: scope.userId,
      emailNorm,
    }))
  ) {
    return (await passesOffering()) ? row : undefined;
  }
  return undefined;
}

async function mergeDealRowsById(
  base: AddDealFormRow[],
  extraIds: string[],
): Promise<AddDealFormRow[]> {
  const visibleIds = new Set(base.map((r) => String(r.id)));
  const missing = extraIds.filter((id) => !visibleIds.has(id));
  if (missing.length === 0) return base;
  const extraRows = await listAddDealFormsByIds(missing);
  if (extraRows.length === 0) return base;
  const byId = new Map<string, AddDealFormRow>();
  for (const r of base) byId.set(String(r.id), r);
  for (const r of extraRows) byId.set(String(r.id), r);
  return [...byId.values()].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}

export async function listDealsForViewer(
  scope: DealViewerScope,
): Promise<AddDealFormRow[]> {
  if (scope.syndicationSponsorOnly) {
    return listAddDealFormsByIds(scope.syndicationSponsorDealIds ?? []);
  }
  const base = await listAddDealFormsForViewer(scope);
  if (scope.seesAllDeals) return base;

  const [leadAdminIds, coSponsorIds] = await Promise.all([
    listDealIdsWhereViewerIsLeadOrAdminSponsor(scope.userId),
    listDealIdsWhereViewerIsCoSponsor(scope.userId),
  ]);
  /**
   * Syndicating: always include every deal the viewer is Lead / Admin / Co on,
   * including deals outside the active org and when they also have LP rows.
   */
  const sponsorIds = [...new Set([...leadAdminIds, ...coSponsorIds])];
  let rows = await mergeDealRowsById(base, sponsorIds);

  if (scope.lpInvestorEmailScopedDealIds != null) {
    return withCrossOrgColleagueSponsoredDeals(rows, scope);
  }

  const rosterIds = await listDealIdsFromDealMemberRosterForUser(scope.userId);
  if (rosterIds.length === 0) {
    return withCrossOrgColleagueSponsoredDeals(rows, scope);
  }

  const visibleIds = new Set(rows.map((r) => String(r.id)));
  const missing = rosterIds.filter((id) => !visibleIds.has(id));
  if (missing.length === 0) {
    return withCrossOrgColleagueSponsoredDeals(rows, scope);
  }

  const extraRows = await listAddDealFormsByIds(missing);
  const orgId = scope.organizationId;
  const scopedExtras =
    orgId != null
      ? (
          await Promise.all(
            extraRows.map(async (r) =>
              (await isAddDealFormInOrganizationScope(r, orgId)) ? r : null,
            ),
          )
        ).filter((r): r is AddDealFormRow => r != null)
      : extraRows;
  const merged =
    scopedExtras.length === 0
      ? rows
      : await mergeDealRowsById(
          rows,
          scopedExtras.map((r) => String(r.id)),
        );
  return withCrossOrgColleagueSponsoredDeals(merged, scope);
}

/** Investing lists that start from org deals also include a peer's other-org offerings. */
export async function withCrossOrgColleagueSponsoredDeals(
  rows: AddDealFormRow[],
  scope: DealViewerScope,
): Promise<AddDealFormRow[]> {
  return mergeDealRowsById(rows, scope.crossOrgColleagueSponsoredDealIds ?? []);
}

/**
 * Deals the viewer’s company syndicates **plus** any deal where they appear as
 * a portal participant (`assigning_deal_user`).
 */
export async function listDealsForViewerIncludingAssignedParticipation(
  scope: DealViewerScope,
): Promise<AddDealFormRow[]> {
  if (scope.lpInvestorEmailScopedDealIds != null) {
    return listAddDealFormsForViewer(scope);
  }
  if (scope.coSponsorDashboardDealIds?.length) {
    return listAddDealFormsForViewer(scope);
  }
  const orgDeals = await listAddDealFormsForViewer(scope);
  const orgIds = new Set(orgDeals.map((r) => String(r.id)));
  const assignedIds = await listDealIdsAssignedToUser(scope.userId);
  const missing = assignedIds.filter((id) => !orgIds.has(id));
  if (missing.length === 0) return orgDeals;
  const extraRows = await listAddDealFormsByIds(missing);
  const byId = new Map<string, AddDealFormRow>();
  for (const r of orgDeals) byId.set(String(r.id), r);
  for (const r of extraRows) byId.set(String(r.id), r);
  return [...byId.values()].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );
}
