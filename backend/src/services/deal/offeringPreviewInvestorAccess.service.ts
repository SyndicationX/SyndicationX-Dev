import { and, eq } from "drizzle-orm";
import { isPlatformAdminRole } from "../../constants/roles.js";
import { canInvestorAccessPublicOffering } from "../../constants/deal-lifecycle/deal-status-rules.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { contact } from "../../schema/contact.schema.js";
import { dealMember } from "../../schema/deal.schema/deal-member.schema.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import { insertDealLpInvestorRosterRow } from "./dealLpInvestorRosterInsert.js";
import {
  decryptOfferingPreviewSponsorRef,
  resolvePublicPreviewDealId,
} from "../../utils/offeringPreviewCrypto.js";
import { dealSaasLockHttpPayload } from "../billing/dealBilling.service.js";
import {
  invalidateContactDirectoryCache,
  invalidateDealsListCache,
} from "../cache/listReadCache.js";
import { ensureReferredInvestorContact } from "../contact/investorInviteLink.service.js";
import { resolveOrganizationIdForUserId } from "../org/orgResolution.service.js";
import {
  isUserAssignedToDeal,
  reconcileAssigningDealUsersForDeal,
} from "./assigningDealUser.service.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { resolveInvestNowViewerContactOnDeal } from "./dealInvestNowViewerContact.service.js";
import {
  isPortalUserDealSponsorOnDeal,
  isPortalUserOnDealMemberRoster,
  isPortalUserSponsorOnDeal,
} from "./dealMemberScope.service.js";
import {
  decodeOfferingPreviewSponsorRefParam,
  resolvePortalUserIdForContactMemberId,
} from "./offeringPreviewSponsorRef.service.js";

function isLeadSponsorRole(role: string | null | undefined): boolean {
  const t = String(role ?? "").trim().toLowerCase();
  return t === "lead sponsor" || t === "lead_sponsor";
}

async function resolveLeadSponsorUserId(dealId: string): Promise<string | null> {
  const rows = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
    })
    .from(dealMember)
    .where(and(eq(dealMember.dealId, dealId), eq(dealMember.isDraft, false)));
  const lead = rows.find((row) => isLeadSponsorRole(row.dealMemberRole));
  if (!lead) return null;
  return resolvePortalUserIdForContactMemberId(lead.contactMemberId);
}

/**
 * Sponsor who shared the offering preview, or the deal lead sponsor when the
 * link has no `ref`. Used to place a new signup on that sponsor's contacts.
 */
async function resolveOfferingPreviewSignupSponsor(params: {
  previewToken: string;
  sponsorRef: string;
}): Promise<{
  sponsorUserId: string;
  organizationId: string | null;
  dealId: string;
} | null> {
  const previewDealId = params.previewToken
    ? resolvePublicPreviewDealId(params.previewToken)
    : null;

  let dealId = String(previewDealId ?? "").trim();
  let sponsorUserId = "";

  const rawRef = decodeOfferingPreviewSponsorRefParam(params.sponsorRef);
  if (rawRef) {
    const decoded = decryptOfferingPreviewSponsorRef(rawRef);
    const decodedDealId = String(decoded?.dealId ?? "").trim();
    const decodedSponsorId = String(decoded?.sponsorUserId ?? "").trim();
    const dealMatches =
      !dealId || decodedDealId.toLowerCase() === dealId.toLowerCase();
    if (
      decoded &&
      dealMatches &&
      decodedSponsorId &&
      (await isPortalUserSponsorOnDeal(decodedDealId, decodedSponsorId))
    ) {
      dealId = decodedDealId;
      sponsorUserId = decodedSponsorId;
    }
  }

  if (!sponsorUserId && dealId) {
    sponsorUserId = (await resolveLeadSponsorUserId(dealId)) ?? "";
  }
  if (!dealId || !sponsorUserId) return null;

  const deal = await getAddDealFormById(dealId);
  if (!deal || deal.archived) return null;

  const sponsorOrg =
    (await resolveOrganizationIdForUserId(sponsorUserId)) ?? null;
  const dealOrg = String(deal.organizationId ?? "").trim() || null;
  return {
    sponsorUserId,
    organizationId: dealOrg ?? sponsorOrg,
    dealId,
  };
}

/**
 * Investor who signed up from a public offering preview: CRM contact in the
 * sharing sponsor's organization, owned by that sponsor.
 */
export async function applyOfferingPreviewSignupContact(params: {
  previewToken: string;
  sponsorRef: string;
  userId: string;
  emailNorm: string;
  firstName: string;
  lastName: string;
  phone: string;
}): Promise<{
  applied: boolean;
  contactId: string | null;
  sponsorUserId: string | null;
}> {
  const userId = String(params.userId ?? "").trim();
  if (!userId) return { applied: false, contactId: null, sponsorUserId: null };

  const referrer = await resolveOfferingPreviewSignupSponsor({
    previewToken: String(params.previewToken ?? "").trim(),
    sponsorRef: String(params.sponsorRef ?? "").trim(),
  });
  if (!referrer) return { applied: false, contactId: null, sponsorUserId: null };
  if (userId.toLowerCase() === referrer.sponsorUserId.toLowerCase()) {
    return {
      applied: false,
      contactId: null,
      sponsorUserId: referrer.sponsorUserId,
    };
  }

  try {
    const [existing] = await db
      .select({ referredByUserId: users.referredByUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!String(existing?.referredByUserId ?? "").trim()) {
      await db
        .update(users)
        .set({ referredByUserId: referrer.sponsorUserId })
        .where(eq(users.id, userId));
    }
  } catch (e) {
    console.error("record offering preview signup referrer:", e);
  }

  try {
    const contactId = await ensureReferredInvestorContact({
      referrer,
      emailNorm: params.emailNorm,
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
    });
    if (!contactId) {
      return {
        applied: false,
        contactId: null,
        sponsorUserId: referrer.sponsorUserId,
      };
    }
    const [current] = await db
      .select({
        organizationId: contact.organizationId,
      })
      .from(contact)
      .where(eq(contact.id, contactId))
      .limit(1);
    const currentOrg = String(current?.organizationId ?? "").trim().toLowerCase();
    const targetOrg = String(referrer.organizationId ?? "").trim().toLowerCase();
    const claimForThisOrg = !currentOrg || currentOrg === targetOrg;
    await db
      .update(contact)
      .set({
        ...(claimForThisOrg
          ? {
              organizationId: referrer.organizationId,
              createdBy: referrer.sponsorUserId,
              platformAdminOnly: false,
            }
          : {}),
        visibleToUsers: false,
        isPortalUser: true,
      })
      .where(eq(contact.id, contactId));
    invalidateContactDirectoryCache();
    invalidateDealsListCache();
    return {
      applied: true,
      contactId,
      sponsorUserId: referrer.sponsorUserId,
    };
  } catch (e) {
    console.error("ensure offering preview signup contact:", e);
    return {
      applied: false,
      contactId: null,
      sponsorUserId: referrer.sponsorUserId,
    };
  }
}

export type OfferingPreviewAccessGrantResult =
  | { ok: true; dealId: string }
  | { ok: false; status: 400 | 402 | 403 | 404; message: string };

/**
 * Converts a valid public-preview visit into access to this one offering.
 * This creates only an LP roster link; it never creates a deal-member/sponsor role.
 */
export async function grantOfferingPreviewInvestorAccess(params: {
  userId: string;
  previewToken: string;
  sponsorRef?: string;
}): Promise<OfferingPreviewAccessGrantResult> {
  const userId = String(params.userId ?? "").trim();
  const previewToken = String(params.previewToken ?? "").trim();
  const sponsorRef = String(params.sponsorRef ?? "").trim();
  if (!userId || !previewToken) {
    return { ok: false, status: 400, message: "Preview token is required." };
  }

  const dealId = resolvePublicPreviewDealId(previewToken);
  if (!dealId) {
    return { ok: false, status: 400, message: "Invalid preview link." };
  }

  const [user, deal] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        phone: users.phone,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0]),
    getAddDealFormById(dealId),
  ]);

  if (!user) {
    return { ok: false, status: 404, message: "User not found." };
  }
  if (!deal) {
    return { ok: false, status: 404, message: "Offering not found." };
  }
  if (
    deal.archived ||
    !canInvestorAccessPublicOffering(deal.dealStage, deal.offeringStatus)
  ) {
    return { ok: false, status: 403, message: "This offering is not available." };
  }
  if (await dealSaasLockHttpPayload(deal)) {
    return {
      ok: false,
      status: 402,
      message: "This offering is temporarily unavailable.",
    };
  }

  const emailNorm = String(user.email ?? "").trim().toLowerCase();

  const previewContact = isPlatformAdminRole(user.role)
    ? { applied: false, contactId: null, sponsorUserId: null }
    : await applyOfferingPreviewSignupContact({
        previewToken,
        sponsorRef,
        userId,
        emailNorm,
        firstName: String(user.firstName ?? "").trim(),
        lastName: String(user.lastName ?? "").trim(),
        phone: String(user.phone ?? "").trim(),
      }).catch((e) => {
        console.error("applyOfferingPreviewSignupContact during claim:", e);
        return { applied: false, contactId: null, sponsorUserId: null };
      });
  const sharingSponsorUserId = String(previewContact.sponsorUserId ?? "").trim();

  const resolved = await resolveInvestNowViewerContactOnDeal({
    dealId,
    viewerEmailNorm: emailNorm,
    viewerUserId: userId,
  });
  const contactMemberId = resolved.contactMemberId.trim();
  if (!contactMemberId) {
    return {
      ok: false,
      status: 400,
      message: "Could not link this offering to your account.",
    };
  }

  if (resolved.lpInvestorRow) {
    if (resolved.lpInvestorRow.isDraft) {
      await db
        .update(dealLpInvestor)
        .set({ isDraft: false, updatedAt: new Date() })
        .where(
          and(
            eq(dealLpInvestor.dealId, dealId),
            eq(dealLpInvestor.id, resolved.lpInvestorRow.id),
          ),
        );
      await reconcileAssigningDealUsersForDeal(dealId, userId);
    }
    return { ok: true, dealId };
  }

  if (
    isPlatformAdminRole(user.role) ||
    (await isPortalUserDealSponsorOnDeal(dealId, userId)) ||
    (await isPortalUserOnDealMemberRoster(dealId, userId)) ||
    (await isUserAssignedToDeal(userId, dealId))
  ) {
    return { ok: true, dealId };
  }

  {
    const investorName =
      [user.firstName, user.lastName]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join(" ") ||
      String(user.username ?? "").trim() ||
      emailNorm;

    await insertDealLpInvestorRosterRow({
      dealId,
      investorName,
      addedBy: sharingSponsorUserId || null,
      contactMemberId,
      email: emailNorm || null,
      role: "LP Investor",
      profileId: "",
      investorClass: "",
      sendInvitationMail: "no",
      isDraft: false,
      updatedAt: new Date(),
    });
  }

  await reconcileAssigningDealUsersForDeal(dealId, userId);
  invalidateDealsListCache();
  return { ok: true, dealId };
}
