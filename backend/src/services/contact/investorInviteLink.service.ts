import { eq, sql } from "drizzle-orm";
import { INVESTOR } from "../../constants/roles.js";
import {
  isDealStageDraft,
  normalizeDealStageCanonical,
} from "../../constants/deal-lifecycle/deal-stage.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { companies } from "../../schema/company.schema/company.js";
import { contact } from "../../schema/contact.schema.js";
import { dealLpInvestor } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import { insertDealLpInvestorRosterRow } from "../deal/dealLpInvestorRosterInsert.js";
import {
  decryptInvestorInviteRef,
  encryptInvestorInviteRef,
} from "../../utils/investorInviteRefCrypto.js";
import { parseUsPhoneToE164 } from "../../utils/usPhone.js";
import { invalidateContactDirectoryCache } from "../cache/listReadCache.js";
import { queueGhlContactRowSync } from "../ghl/ghlContactSync.service.js";
import {
  resolveOrganizationIdForUserId,
  userHasAccessToOrganization,
} from "../org/orgResolution.service.js";
import { listUserCompanyMemberships } from "../auth/userCompanyMembership.service.js";
import { reconcileAssigningDealUsersForDeal } from "../deal/assigningDealUser.service.js";
import { getAddDealFormById } from "../deal/dealForm.service.js";
import {
  isPortalUserCoSponsorOnDeal,
  isPortalUserDealSponsorOnDeal,
  isPortalUserLeadOrAdminSponsorOnDeal,
} from "../deal/dealMemberScope.service.js";
import {
  buildContactFullName,
  getUserDisplayNameById,
} from "./contact.service.js";

/** Each portal user gets their own link, so signups can be traced back to the sharer. */
export type InvestorInviteLink = {
  ref: string;
  inviteUrl: string;
  dealId?: string;
};

export type InvestorInviteReferrer = {
  sponsorUserId: string;
  organizationId: string | null;
  dealId: string | null;
};

export type BuildDealInvestorInviteLinkResult =
  | { ok: true; link: InvestorInviteLink }
  | { ok: false; status: 403 | 404; message: string };

function frontendOrigin(): string {
  const raw =
    process.env.FRONTEND_URL?.trim() || process.env.BASE_URL?.trim() || "";
  return raw.replace(/\/$/, "");
}

function requireFrontendOrigin(): string {
  const origin = frontendOrigin();
  if (!origin) {
    throw new Error(
      "FRONTEND_URL (or BASE_URL) is not configured on the server; cannot build the invite link.",
    );
  }
  return origin;
}

function inviteSignupUrl(params: {
  ref: string;
  sponsorName: string;
  companyName: string;
  nextPath?: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("ref", params.ref);
  const sponsorName = params.sponsorName.trim();
  const companyName = params.companyName.trim();
  if (sponsorName) search.set("sponsorName", sponsorName);
  if (companyName) search.set("companyName", companyName);
  const nextPath = String(params.nextPath ?? "").trim();
  if (nextPath) search.set("next", nextPath);
  return `${requireFrontendOrigin()}/signup?${search.toString()}`;
}

async function companyRecordById(
  companyId: string,
): Promise<{ id: string; name: string } | null> {
  const id = String(companyId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  if (!row?.id) return null;
  return { id: String(row.id), name: String(row.name ?? "").trim() };
}

/**
 * Company stamped on this user's invite link: the workspace they asked for,
 * otherwise their primary company, otherwise their first membership.
 */
export async function resolveSharerInviteCompany(
  userId: string,
  requestedCompanyId?: string | null,
): Promise<{ companyId: string; companyName: string } | null> {
  const uid = String(userId ?? "").trim();
  if (!uid) return null;
  const requested = String(requestedCompanyId ?? "").trim();
  let companyId = "";
  if (requested && (await userHasAccessToOrganization(uid, requested))) {
    companyId = requested;
  }
  if (!companyId) {
    companyId = (await resolveOrganizationIdForUserId(uid)) ?? "";
  }
  if (!companyId) {
    const memberships = await listUserCompanyMemberships(uid);
    const first = memberships.find((row) => row.companyId.trim());
    if (!first) return null;
    return {
      companyId: first.companyId.trim(),
      companyName: first.companyName.trim(),
    };
  }
  const company = await companyRecordById(companyId);
  if (!company) return null;
  return { companyId: company.id, companyName: company.name };
}

async function assertSharerCanInvite(userId: string): Promise<boolean> {
  const uid = String(userId ?? "").trim();
  if (!uid) return false;
  const [row] = await db
    .select({ role: users.role, userStatus: users.userStatus })
    .from(users)
    .where(eq(users.id, uid))
    .limit(1);
  if (!row) return false;
  if (String(row.role ?? "").trim() === INVESTOR) return false;
  if (String(row.userStatus ?? "").trim().toLowerCase() === "suspended") {
    return false;
  }
  return true;
}

/**
 * Builds this user's investor signup link (`/signup?ref=…`). Investors cannot
 * invite other investors, so they get no link.
 */
export async function buildInvestorInviteLinkForUser(
  userId: string,
  requestedCompanyId?: string | null,
): Promise<InvestorInviteLink | null> {
  const uid = String(userId ?? "").trim();
  if (!(await assertSharerCanInvite(uid))) return null;

  const [sponsorName, company] = await Promise.all([
    getUserDisplayNameById(uid),
    resolveSharerInviteCompany(uid, requestedCompanyId),
  ]);
  const ref = encryptInvestorInviteRef(uid, null, company?.companyId);
  return {
    ref,
    inviteUrl: inviteSignupUrl({
      ref,
      sponsorName,
      companyName: company?.companyName ?? "",
    }),
  };
}

/**
 * Deal-scoped invite unique to this lead / admin / co-sponsor. Investors sign
 * up or sign in with it; the resulting contact stores org, deal, and sponsor.
 */
export async function buildInvestorInviteLinkForDeal(
  userId: string,
  dealId: string,
): Promise<BuildDealInvestorInviteLinkResult> {
  const uid = String(userId ?? "").trim();
  const did = String(dealId ?? "").trim();
  if (!uid || !did) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  if (!(await assertSharerCanInvite(uid))) {
    return {
      ok: false,
      status: 403,
      message: "This account cannot share an investor invite link.",
    };
  }

  const deal = await getAddDealFormById(did);
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  if (deal.archived) {
    return {
      ok: false,
      status: 403,
      message: "Invite links are not available for archived deals.",
    };
  }
  const stage = normalizeDealStageCanonical(deal.dealStage);
  if (isDealStageDraft(deal.dealStage) || stage === "liquidated") {
    return {
      ok: false,
      status: 403,
      message:
        "Change the deal stage before sharing an investor invite link.",
    };
  }
  if (!(await isPortalUserDealSponsorOnDeal(did, uid))) {
    return {
      ok: false,
      status: 403,
      message:
        "Only the lead sponsor, admin sponsor, or co-sponsor can share this deal’s invite link.",
    };
  }

  const dealOrg = String(deal.organizationId ?? "").trim();
  const [sponsorName, dealCompany, sharerCompany] = await Promise.all([
    getUserDisplayNameById(uid),
    dealOrg ? companyRecordById(dealOrg) : Promise.resolve(null),
    resolveSharerInviteCompany(uid),
  ]);
  const company = dealCompany
    ? { companyId: dealCompany.id, companyName: dealCompany.name }
    : sharerCompany;
  const ref = encryptInvestorInviteRef(uid, did, company?.companyId);
  const next = `/deals/${encodeURIComponent(did)}`;
  return {
    ok: true,
    link: {
      ref,
      dealId: did,
      inviteUrl: inviteSignupUrl({
        ref,
        sponsorName,
        companyName: company?.companyName ?? "",
        nextPath: next,
      }),
    },
  };
}

/** Resolves a `ref` query value back to the sharer, dropping stale or suspended users. */
export async function resolveInvestorInviteReferrer(
  rawRef: string | null | undefined,
): Promise<InvestorInviteReferrer | null> {
  const raw = String(rawRef ?? "").trim();
  if (!raw) return null;

  let decoded = null as ReturnType<typeof decryptInvestorInviteRef>;
  try {
    decoded = decryptInvestorInviteRef(decodeURIComponent(raw));
  } catch {
    decoded = decryptInvestorInviteRef(raw);
  }
  if (!decoded?.sponsorUserId) return null;

  const [row] = await db
    .select({
      id: users.id,
      role: users.role,
      userStatus: users.userStatus,
    })
    .from(users)
    .where(eq(users.id, decoded.sponsorUserId))
    .limit(1);
  if (!row?.id) return null;
  if (String(row.role ?? "").trim() === INVESTOR) return null;
  if (String(row.userStatus ?? "").trim().toLowerCase() === "suspended") {
    return null;
  }

  const sponsorUserId = String(row.id).trim();
  const sponsorOrgId =
    (await resolveOrganizationIdForUserId(sponsorUserId)) ?? null;
  const tokenCompany = await companyRecordById(
    String(decoded.companyId ?? "").trim(),
  );
  const tokenCompanyId = tokenCompany?.id ?? null;

  const tokenDealId = String(decoded.dealId ?? "").trim();
  if (!tokenDealId) {
    return {
      sponsorUserId,
      organizationId: tokenCompanyId ?? sponsorOrgId,
      dealId: null,
    };
  }

  const deal = await getAddDealFormById(tokenDealId);
  if (
    !deal ||
    deal.archived ||
    !(await isPortalUserDealSponsorOnDeal(tokenDealId, sponsorUserId))
  ) {
    return {
      sponsorUserId,
      organizationId: tokenCompanyId ?? sponsorOrgId,
      dealId: null,
    };
  }

  const dealOrg = String(deal.organizationId ?? "").trim() || null;
  let organizationId = dealOrg ?? tokenCompanyId ?? sponsorOrgId;
  // A co-sponsor added from another company keeps invite signups in their own
  // company. The deal's company does not receive that co-sponsor's contacts.
  if (
    dealOrg &&
    sponsorOrgId &&
    dealOrg.toLowerCase() !== sponsorOrgId.toLowerCase() &&
    (await isPortalUserCoSponsorOnDeal(tokenDealId, sponsorUserId)) &&
    !(await isPortalUserLeadOrAdminSponsorOnDeal(tokenDealId, sponsorUserId))
  ) {
    organizationId = sponsorOrgId;
  }
  return {
    sponsorUserId,
    organizationId,
    dealId: tokenDealId,
  };
}

async function ensureReferredInvestorOnDeal(params: {
  dealId: string;
  sponsorUserId: string;
  contactId: string;
  investorUserId: string;
  emailNorm: string;
  firstName: string;
  lastName: string;
}): Promise<void> {
  const dealId = String(params.dealId ?? "").trim();
  const contactId = String(params.contactId ?? "").trim();
  const investorUserId = String(params.investorUserId ?? "").trim();
  if (!dealId || !contactId) return;

  const emailNorm = String(params.emailNorm ?? "").trim().toLowerCase();
  const investorName =
    [params.firstName, params.lastName]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ") || emailNorm;

  await insertDealLpInvestorRosterRow({
    dealId,
    investorName,
    addedBy: params.sponsorUserId || null,
    contactMemberId: contactId,
    email: emailNorm.includes("@") ? emailNorm : null,
    role: "LP Investor",
    profileId: "",
    investorClass: "",
    sendInvitationMail: "no",
    isDraft: false,
    updatedAt: new Date(),
  });

  if (investorUserId) {
    await reconcileAssigningDealUsersForDeal(dealId, investorUserId);
  }
}

/**
 * CRM row for an investor who signed up through a sponsor's invite link: owned by
 * that sponsor in their company, the same as a contact they had added by hand.
 */
export async function ensureReferredInvestorContact(params: {
  referrer: InvestorInviteReferrer;
  emailNorm: string;
  firstName: string;
  lastName: string;
  phone: string;
}): Promise<string | null> {
  const { sponsorUserId, organizationId, dealId } = params.referrer;
  const emailNorm = String(params.emailNorm ?? "").trim().toLowerCase();
  if (!sponsorUserId || !emailNorm.includes("@")) return null;

  const emailMatch = sql`lower(trim(${contact.email})) = ${emailNorm}`;
  const matches = await db.select().from(contact).where(emailMatch);
  const orgId = String(organizationId ?? "").trim();
  const orgKey = orgId.toLowerCase();
  const inThisOrg = matches.find((row) => {
    const rowOrg = String(row.organizationId ?? "").trim().toLowerCase();
    if (orgKey && rowOrg === orgKey) return true;
    return !rowOrg && row.createdBy === sponsorUserId;
  });
  const unassigned = matches.find(
    (row) => row.platformAdminOnly || !String(row.organizationId ?? "").trim(),
  );
  const existing = inThisOrg ?? unassigned ?? null;

  const ownerName = (await getUserDisplayNameById(sponsorUserId)).trim();
  const dealToStore = String(dealId ?? "").trim() || null;

  if (!existing && matches.length > 0) {
    /** Already a CRM row for this email. Do not add a second contact for the same person. */
    return String(matches[0]?.id ?? "").trim() || null;
  }

  if (existing) {
    /** Keep an owner someone already assigned; only fill an empty Owners cell. */
    const keepOwners = (existing.owners ?? []).filter((o) => String(o).trim());
    const keepDeal = String(existing.referredByDealId ?? "").trim();
    const keepOrg = String(existing.organizationId ?? "").trim();
    const [updated] = await db
      .update(contact)
      .set({
        isPortalUser: true,
        ...(keepOwners.length === 0 && ownerName
          ? { owners: [ownerName] }
          : {}),
        ...(!keepDeal && dealToStore ? { referredByDealId: dealToStore } : {}),
        ...(!keepOrg && orgId ? { organizationId: orgId } : {}),
      })
      .where(eq(contact.id, existing.id))
      .returning();
    if (updated) {
      invalidateContactDirectoryCache();
      queueGhlContactRowSync(updated);
    }
    return String(updated?.id ?? existing.id).trim() || null;
  }

  const firstName = String(params.firstName ?? "").trim() || "—";
  const lastName = String(params.lastName ?? "").trim() || "—";
  const phoneStored = parseUsPhoneToE164(String(params.phone ?? "").trim()) ?? "";

  const [inserted] = await db
    .insert(contact)
    .values({
      firstName,
      lastName,
      fullName: buildContactFullName(firstName, lastName),
      email: emailNorm,
      phone: phoneStored,
      note: "",
      tags: [],
      lists: [],
      owners: ownerName ? [ownerName] : [],
      status: "active",
      createdBy: sponsorUserId,
      organizationId,
      referredByDealId: dealToStore,
      isPortalUser: true,
      relationship506b: "NO",
      importSource: "invite_link",
    })
    .returning();

  if (inserted) {
    invalidateContactDirectoryCache();
    queueGhlContactRowSync(inserted);
  }
  return String(inserted?.id ?? "").trim() || null;
}

/**
 * Applies a sponsor invite `ref` after investor signup or sign-in: records the
 * referrer on the user, creates/updates the org contact (org + deal + sponsor),
 * and adds an LP roster row when the link was deal-scoped.
 */
export async function applyInvestorInviteAfterAuth(params: {
  inviteRef: string | null | undefined;
  userId: string;
  emailNorm: string;
  firstName: string;
  lastName: string;
  phone: string;
  role: string;
}): Promise<{ applied: boolean; contactId: string | null }> {
  const userId = String(params.userId ?? "").trim();
  const role = String(params.role ?? "").trim();
  if (!userId || role !== INVESTOR) {
    return { applied: false, contactId: null };
  }

  const referrer = await resolveInvestorInviteReferrer(params.inviteRef).catch(
    (e) => {
      console.error("resolveInvestorInviteReferrer:", e);
      return null;
    },
  );
  if (!referrer) return { applied: false, contactId: null };

  try {
    const [existing] = await db
      .select({
        referredByUserId: users.referredByUserId,
        referredByCompanyId: users.referredByCompanyId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const patch: {
      referredByUserId?: string;
      referredByCompanyId?: string;
    } = {};
    if (!String(existing?.referredByUserId ?? "").trim()) {
      patch.referredByUserId = referrer.sponsorUserId;
    }
    const companyId = String(referrer.organizationId ?? "").trim();
    if (!String(existing?.referredByCompanyId ?? "").trim() && companyId) {
      patch.referredByCompanyId = companyId;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(users).set(patch).where(eq(users.id, userId));
    }
  } catch (e) {
    console.error("record investor invite referrer:", e);
  }

  let contactId: string | null = null;
  try {
    contactId = await ensureReferredInvestorContact({
      referrer,
      emailNorm: params.emailNorm,
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
    });
  } catch (e) {
    console.error("ensureReferredInvestorContact:", e);
  }

  if (referrer.dealId && contactId) {
    try {
      await ensureReferredInvestorOnDeal({
        dealId: referrer.dealId,
        sponsorUserId: referrer.sponsorUserId,
        contactId,
        investorUserId: userId,
        emailNorm: params.emailNorm,
        firstName: params.firstName,
        lastName: params.lastName,
      });
    } catch (e) {
      console.error("ensureReferredInvestorOnDeal:", e);
    }
  }

  return { applied: true, contactId };
}

export type StoredInvestorInviteSponsor = {
  sponsorUserId: string;
  companyId: string | null;
};

/** Sponsor and company saved from the invite link, if this investor has one. */
export async function loadStoredInvestorInviteSponsor(
  userId: string,
): Promise<StoredInvestorInviteSponsor | null> {
  const uid = String(userId ?? "").trim();
  if (!uid) return null;
  const [row] = await db
    .select({
      referredByUserId: users.referredByUserId,
      referredByCompanyId: users.referredByCompanyId,
    })
    .from(users)
    .where(eq(users.id, uid))
    .limit(1);
  const sponsorUserId = String(row?.referredByUserId ?? "").trim();
  if (!sponsorUserId) return null;
  let companyId = String(row?.referredByCompanyId ?? "").trim();
  if (!companyId) {
    const company = await resolveSharerInviteCompany(sponsorUserId);
    companyId = company?.companyId?.trim() ?? "";
    if (companyId) {
      await db
        .update(users)
        .set({ referredByCompanyId: companyId })
        .where(eq(users.id, uid));
    }
  }
  return { sponsorUserId, companyId: companyId || null };
}

/** Company name for the investor onboarding Sponsor field. */
export async function loadInvestorInviteCompanyDisplayName(
  userId: string,
): Promise<string> {
  const stored = await loadStoredInvestorInviteSponsor(userId);
  const companyId = stored?.companyId?.trim() ?? "";
  if (!companyId) return "";
  const company = await companyRecordById(companyId);
  return company?.name?.trim() ?? "";
}

/**
 * CRM contact created for this invite (same email, sponsor's company or owner).
 * Soft commitment should keep this id instead of swapping in the portal user id.
 */
export async function findInviteAttributedContactId(params: {
  viewerUserId: string;
  emailNorm: string;
}): Promise<string | null> {
  const viewerUserId = String(params.viewerUserId ?? "").trim();
  const emailNorm = String(params.emailNorm ?? "").trim().toLowerCase();
  if (!viewerUserId || !emailNorm.includes("@")) return null;
  const stored = await loadStoredInvestorInviteSponsor(viewerUserId);
  if (!stored) return null;

  const matches = await db
    .select({
      id: contact.id,
      organizationId: contact.organizationId,
      createdBy: contact.createdBy,
    })
    .from(contact)
    .where(sql`lower(trim(${contact.email})) = ${emailNorm}`);
  const orgKey = String(stored.companyId ?? "").trim().toLowerCase();
  const sponsorKey = stored.sponsorUserId.toLowerCase();
  const inOrg = orgKey
    ? matches.find(
        (row) =>
          String(row.organizationId ?? "").trim().toLowerCase() === orgKey,
      )
    : undefined;
  if (inOrg?.id) return String(inOrg.id).trim();
  const owned = matches.find(
    (row) => String(row.createdBy ?? "").trim().toLowerCase() === sponsorKey,
  );
  return owned?.id ? String(owned.id).trim() : null;
}

/**
 * Soft commitment and e-sign must not replace the invite sponsor with the
 * investor's own user id. An adder who is already someone else is left alone.
 */
export async function retainInviteSponsorOnLpRoster(params: {
  lpRowId: string;
  viewerUserId: string;
  sponsorUserId: string;
}): Promise<void> {
  const lpRowId = String(params.lpRowId ?? "").trim();
  const sponsorUserId = String(params.sponsorUserId ?? "").trim();
  const viewerKey = String(params.viewerUserId ?? "").trim().toLowerCase();
  if (!lpRowId || !sponsorUserId) return;
  const [row] = await db
    .select({ addedBy: dealLpInvestor.addedBy })
    .from(dealLpInvestor)
    .where(eq(dealLpInvestor.id, lpRowId))
    .limit(1);
  const current = String(row?.addedBy ?? "").trim();
  if (current && current.toLowerCase() !== viewerKey) return;
  if (current.toLowerCase() === sponsorUserId.toLowerCase()) return;
  await db
    .update(dealLpInvestor)
    .set({ addedBy: sponsorUserId, updatedAt: new Date() })
    .where(eq(dealLpInvestor.id, lpRowId));
}

/**
 * True when this investor signed up through someone's invite link
 * (`users.referred_by_user_id`). Those accounts do not choose Platform Contacts
 * visibility — they are already on the referrer's org contacts list.
 */
export async function investorSignedUpViaInviteLink(
  userId: string,
): Promise<boolean> {
  const uid = String(userId ?? "").trim();
  if (!uid) return false;
  const [row] = await db
    .select({ referredByUserId: users.referredByUserId })
    .from(users)
    .where(eq(users.id, uid))
    .limit(1);
  return Boolean(String(row?.referredByUserId ?? "").trim());
}
