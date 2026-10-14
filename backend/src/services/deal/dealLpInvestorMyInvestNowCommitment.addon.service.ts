/**
 * LP “Invest now”: by default **adds** the posted amount to the existing committed total on the
 * latest LP `deal_investment` for this deal + contact (locked row), with optional `status` and
 * `doc_signed_date`. First commitment (no LP row yet) stores the amount as-is.
 * When the user selects a **different** saved “My profile” (both old and new book ids present and
 * different) or a **different** commitment kind (`profile_id` individual / joint / …) than the
 * locked row, a **new** `deal_investment` row is inserted for this tranche; prior rows are kept.
 * Syncs `deal_lp_investor.committed_amount` to the **sum** of that contact’s LP investment rows.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  isDocSignedEsignCompleted,
  isDocSignedEsignPending,
} from "../../constants/deal-doc-signed.js";
import { userInvestorProfiles } from "../../schema/investing.schema/userProfileBook.schema.js";
import { contact, users } from "../../schema/schema.js";
import { dealLpInvestor, } from "../../schema/deal.schema/deal-lp-investor.schema.js";
import {
  dealInvestment,
  type DealInvestmentInsert,
} from "../../schema/deal.schema/deal-investment.schema.js";
import { committedNumericFromDealInvestmentRow, insertDealInvestment, isLpInvestorRole, LP_INVESTOR_ROLE_STORED, resolveFirstLpInvestorClassForDeal, resolveInvestorClassForDealInvestment, } from "./dealInvestment.service.js";
import { resolveInvestNowViewerContactOnDeal } from "./dealInvestNowViewerContact.service.js";
import { upsertDealLpInvestor } from "./dealLpInvestor.service.js";
import {
  resolveOfferingPreviewSponsorAttribution,
} from "./offeringPreviewSponsorRef.service.js";
import { resolveInvestNowAddedByUserId } from "./crossOrgColleagueDeal.service.js";
import {
  loadStoredInvestorInviteSponsor,
  retainInviteSponsorOnLpRoster,
} from "../contact/investorInviteLink.service.js";
import {
  normalizeInvestorQuestionnaireAnswersInput,
  serializeInvestorQuestionnaireAnswers,
} from "./investorQuestionnaireAnswers.service.js";
import {
  normalizeInvestorW9FormInput,
  serializeInvestorW9Form,
} from "./investorW9Form.service.js";
const LP_INVESTOR_TABLE_ROLE = "LP Investor";

async function sumLpDealInvestmentCommittedForContact(
  dealId: string,
  contactMemberId: string,
): Promise<string> {
  const rows = await db
    .select()
    .from(dealInvestment)
    .where(
      and(
        eq(dealInvestment.dealId, dealId),
        eq(dealInvestment.contactId, contactMemberId),
      ),
    );
  let t = 0;
  for (const r of rows) {
    if (isLpInvestorRole(r.investor_role)) {
      t += committedNumericFromDealInvestmentRow(r);
    }
  }
  return formatCumulativeCommitmentStored(t);
}

export type ApplyMyInvestNowCommitmentResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      code?: "duplicate_profile_for_deal";
    };

export type ApplyMyInvestNowCommitmentInput = {
  dealId: string;
  viewerEmailNorm: string;
  viewerUserId: string;
  committedAmount: unknown;
  profileId?: unknown;
  /** When true, `user_investor_profile_id` in the request should be applied (or cleared to null if empty). */
  userInvestorProfileInBody?: boolean;
  userInvestorProfileId?: string | null;
  status?: string;
  docSignedDate?: unknown;
  /** When true, apply `questionnaireAnswers` to the commitment investment row. */
  questionnaireAnswersInBody?: boolean;
  questionnaireAnswers?: unknown;
  /** When true, apply `w9Form` to the commitment investment row. */
  w9FormInBody?: boolean;
  w9Form?: unknown;
  /** When true, `committed_amount` is optional (profile / questionnaire progress saves). */
  progressOnly?: boolean;
  /** When true, do not read or update `commitment_amount`. */
  skipCommittedAmount?: boolean;
  /** When true, set commitment to the posted value instead of adding to the existing total. */
  replaceCommittedAmount?: boolean;
  /** Existing investment row to continue editing. */
  investmentId?: string | null;
  /** User confirmed they want a separate investment using the same saved profile. */
  allowDuplicateProfile?: boolean;
  fundingMethodInBody?: boolean;
  fundingMethod?: string;
  investorClassInBody?: boolean;
  investorClass?: string;
  /** Encrypted `ref=` from the sponsor offering preview link. */
  referringSponsorRef?: string | null;
  /** Company selected in the investor's workspace. */
  activeOrganizationId?: string | null;
};

function normalizeCommittedAmountStored(
    raw: unknown,
    opts?: { allowZero?: boolean },
) {
    const t = String(raw ?? "")
        .trim()
        .replace(/[$,\s]/g, "");
    if (!t)
        return "";
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0)
        return "";
    if (n === 0 && !opts?.allowZero)
        return "";
    if (n <= 0 && !opts?.allowZero)
        return "";
    return String(n);
}

const INVEST_NOW_FUNDING_METHODS = new Set([
    "stripe_checkout",
    "wire_transfer",
    // Legacy saved value; new ACH/card contributions use Stripe Checkout.
    "ach",
    "check",
]);

function normalizeFundingMethodParam(raw: unknown) {
    const s = String(raw ?? "").trim();
    if (!s)
        return "";
    return INVEST_NOW_FUNDING_METHODS.has(s) ? s : "";
}
/** Persist cumulative commitment as a plain numeric string (avoids float noise). */
function formatCumulativeCommitmentStored(total: number) {
    if (!Number.isFinite(total) || total < 0)
        return "0";
    const rounded = Math.round(total * 100) / 100;
    return String(rounded);
}
const LP_COMMITMENT_PROFILE_IDS = new Set([
    "individual",
    "custodian_ira_401k",
    "joint_tenancy",
    "llc_corp_trust_etc",
]);
function normalizeLpCommitmentProfileId(raw: unknown) {
    const t = String(raw ?? "").trim();
    if (!t)
        return null;
    return LP_COMMITMENT_PROFILE_IDS.has(t) ? t : null;
}
const DOC_SIGNED_ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeDocSignedDateParam(raw: unknown) {
    if (raw === undefined)
        return { ok: true, value: undefined };
    if (raw === null)
        return { ok: true, value: null };
    const s = String(raw ?? "").trim();
    if (!s)
        return { ok: true, value: null };
    if (isDocSignedEsignPending(s) || isDocSignedEsignCompleted(s)) {
        return { ok: true, value: undefined };
    }
    if (DOC_SIGNED_ISO_DAY_RE.test(s))
        return { ok: true, value: s };
    return {
        ok: false,
        message: "Document signed date must be empty or a valid calendar date (YYYY-MM-DD).",
    };
}
function normalizeInvestmentStatusParam(raw: unknown) {
    if (raw === undefined)
        return undefined;
    const s = String(raw ?? "").trim();
    if (s.length > 400)
        return s.slice(0, 400);
    return s;
}
async function resolveEmailForContactMemberId(rawCid: unknown) {
    const cid = String(rawCid ?? "").trim();
    if (!cid)
        return "";
    const [uRow] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, cid))
        .limit(1);
    const fromUser = String(uRow?.email ?? "").trim().toLowerCase();
    if (fromUser)
        return fromUser;
    const [cRow] = await db
        .select({ email: contact.email })
        .from(contact)
        .where(sql `${contact.id}::text = ${cid}`)
        .limit(1);
    return String(cRow?.email ?? "").trim().toLowerCase();
}
const SAVED_INVESTOR_PROFILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidV4Like(s: string) {
  return SAVED_INVESTOR_PROFILE_UUID_RE.test(String(s ?? "").trim());
}
function wizardSnapshotRecord(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function custodianIraFromWizard(raw: unknown): boolean {
  const parsed = wizardSnapshotRecord(raw);
  if (!parsed) return false;
  const v = String(parsed.custodianIra ?? parsed.custodian_ira ?? "")
    .trim()
    .toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

/**
 * Commitment key for the profile the investor chose in Invest now.
 * Independent of the profile type stored when the sponsor added the investor.
 */
function commitmentKindFromSavedProfile(
  profileType: string,
  formSnapshot: unknown,
): string | null {
  const raw = String(profileType ?? "").trim();
  const t = raw.toLowerCase();
  if (!t || t === "—") return null;
  if (t === "individual") return "individual";
  if (t === "joint tenancy" || t === "joint_tenancy" || t.includes("joint"))
    return "joint_tenancy";
  const custodian =
    custodianIraFromWizard(formSnapshot) ||
    raw === "__entity_custodian_ira_401k__" ||
    (t.includes("custodian") && (t.includes("ira") || t.includes("401")));
  if (
    t === "entity" ||
    raw === "__entity_llc_corp_trust_etc__" ||
    t.includes("llc") ||
    t.includes("corp") ||
    t.includes("trust") ||
    t.includes("partnership") ||
    custodian
  ) {
    return custodian ? "custodian_ira_401k" : "llc_corp_trust_etc";
  }
  return null;
}

type SavedProfileResolve =
  | { ok: true; value: string | null; skip: boolean; kind: string | null }
  | { ok: false; message: string };
async function resolveUserInvestorProfileIdForCommit(
  viewerUserId: string,
  inBody: boolean,
  raw: string | null | undefined,
): Promise<SavedProfileResolve> {
  if (!inBody)
    return { ok: true, value: null, skip: true, kind: null } as const;
  const s = String(raw ?? "").trim();
  if (!s)
    return { ok: true, value: null, skip: false, kind: null } as const;
  if (!isUuidV4Like(s))
    return { ok: false, message: "Invalid profile name selection." };
  const [p] = await db
    .select()
    .from(userInvestorProfiles)
    .where(
      and(
        eq(userInvestorProfiles.id, s),
        eq(userInvestorProfiles.userId, viewerUserId),
      ),
    )
    .limit(1);
  if (!p) {
    return { ok: false, message: "That profile was not found on your account." };
  }
  if (p.archived) {
    return { ok: false, message: "That profile is archived. Choose an active profile or unarchive it first." };
  }
  if (p.isDraft) {
    return { ok: false, message: "Finish saving that profile before investing with it." };
  }
  const kind = commitmentKindFromSavedProfile(p.profileType, p.formSnapshot);
  if (!kind) {
    return {
      ok: false,
      message: "This profile cannot be used for an investment. Choose another profile.",
    };
  }
  return { ok: true, value: s, skip: false, kind } as const;
}
export async function applyMyInvestNowCommitmentAddon(
  params: ApplyMyInvestNowCommitmentInput
): Promise<ApplyMyInvestNowCommitmentResult> {
    const e = String(params.viewerEmailNorm ?? "").trim().toLowerCase();
    if (!e.includes("@"))
        return { ok: false, message: "Invalid viewer email" };
    const skipAmount = Boolean(params.skipCommittedAmount);
    const allowZero = Boolean(params.progressOnly);
    const incrementStr = skipAmount
        ? ""
        : normalizeCommittedAmountStored(params.committedAmount, {
              allowZero,
          });
    if (!skipAmount && !incrementStr) {
        return {
            ok: false,
            message: params.progressOnly
                ? "Committed amount must be zero or greater"
                : "Committed amount must be a number greater than 0",
        };
    }
    const increment = incrementStr ? Number(incrementStr) : 0;
    if (
        !skipAmount &&
        (!Number.isFinite(increment) ||
            (increment <= 0 && !allowZero))
    ) {
        return {
            ok: false,
            message: "Committed amount must be a number greater than 0",
        };
    }
    const fundingMethodPatch = params.fundingMethodInBody
        ? normalizeFundingMethodParam(params.fundingMethod)
        : undefined;
    if (
        params.fundingMethodInBody &&
        String(params.fundingMethod ?? "").trim() &&
        !fundingMethodPatch
    ) {
        return { ok: false, message: "Invalid funding method." };
    }
    const rawProfile = String(params.profileId ?? "").trim();
    let profileOpt = normalizeLpCommitmentProfileId(rawProfile ? rawProfile : undefined);
    if (rawProfile && !profileOpt) {
        return { ok: false, message: "Invalid investor profile." };
    }
    const statusOpt = normalizeInvestmentStatusParam(params.status);
    const docNorm = normalizeDocSignedDateParam(params.docSignedDate);
    if (!docNorm.ok) {
        return {
            ok: false,
            message: docNorm.message ?? "Document signed date is invalid.",
        };
    }
    const viewerUserId = String(params.viewerUserId ?? "").trim();
    const inBodyUip = Boolean(params.userInvestorProfileInBody);
    const sUipRes = await resolveUserInvestorProfileIdForCommit(
        viewerUserId,
        inBodyUip,
        params.userInvestorProfileId ?? null,
    );
    if (!sUipRes.ok) {
        return { ok: false, message: sUipRes.message };
    }
    const sUip = sUipRes;
    if (!sUip.skip && sUip.kind)
        profileOpt = sUip.kind;
    const referringSponsor = params.referringSponsorRef
      ? await resolveOfferingPreviewSponsorAttribution(
          params.dealId,
          params.referringSponsorRef,
        )
      : null;
    const storedInvite = await loadStoredInvestorInviteSponsor(viewerUserId);
    const addedByUserId = viewerUserId
      ? await resolveInvestNowAddedByUserId({
          dealId: params.dealId,
          investorUserId: viewerUserId,
          referringSponsorUserId: referringSponsor?.sponsorUserId,
          activeOrganizationId: params.activeOrganizationId,
        })
      : viewerUserId;
    const assignedSponsorUserId =
      addedByUserId.toLowerCase() !== viewerUserId.toLowerCase()
        ? addedByUserId
        : "";
    const keepSameOrgSponsor = async (lpRowId: string | null | undefined) => {
      if (!assignedSponsorUserId || !lpRowId) return;
      await db
        .update(dealLpInvestor)
        .set({ addedBy: assignedSponsorUserId, updatedAt: new Date() })
        .where(eq(dealLpInvestor.id, lpRowId));
    };
    const keepInviteSponsor = async (lpRowId: string | null | undefined) => {
      if (!storedInvite?.sponsorUserId || !lpRowId) return;
      await retainInviteSponsorOnLpRoster({
        lpRowId,
        viewerUserId,
        sponsorUserId: storedInvite.sponsorUserId,
      });
    };
    let questionnaireAnswersJson: string | null = null;
    if (params.questionnaireAnswersInBody) {
      try {
        const normalized = normalizeInvestorQuestionnaireAnswersInput(
          params.questionnaireAnswers,
        );
        questionnaireAnswersJson =
          serializeInvestorQuestionnaireAnswers(normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: msg };
      }
    }
    let w9FormJson: string | null = null;
    if (params.w9FormInBody) {
      try {
        const normalized = normalizeInvestorW9FormInput(params.w9Form);
        w9FormJson = serializeInvestorW9Form(normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: msg };
      }
    }
    const resolvedContact = await resolveInvestNowViewerContactOnDeal({
            dealId: params.dealId,
            viewerEmailNorm: e,
            viewerUserId,
        });
    let target = resolvedContact.lpInvestorRow;
    const targetContactMemberId = resolvedContact.contactMemberId;
    if (!targetContactMemberId) {
        return {
            ok: false,
            message:
                "Could not link your account to this deal. Sign in with your investing email and try again.",
        };
    }
    const invCandidates = await db
        .select()
        .from(dealInvestment)
        .where(and(eq(dealInvestment.dealId, params.dealId), eq(dealInvestment.contactId, targetContactMemberId)))
        .orderBy(desc(dealInvestment.createdAt));
    const scopedUip = String(params.userInvestorProfileId ?? "").trim();
    const scopedProfile = profileOpt ?? "";
    const scopedInvestmentId = String(params.investmentId ?? "").trim();
    let inv: (typeof invCandidates)[number] | undefined;
    if (scopedInvestmentId) {
        inv = invCandidates.find(
            (row) =>
                isLpInvestorRole(row.investor_role) &&
                String(row.id).trim().toLowerCase() ===
                    scopedInvestmentId.toLowerCase(),
        );
        if (!inv) {
            return {
                ok: false,
                message: "The selected investment was not found for this deal.",
            };
        }
    }
    else {
        for (const row of invCandidates) {
            if (!isLpInvestorRole(row.investor_role))
                continue;
            if (scopedUip) {
                const rowUip = String(row.userInvestorProfileId ?? "").trim();
                if (!rowUip || rowUip.toLowerCase() !== scopedUip.toLowerCase())
                    continue;
            }
            else if (scopedProfile) {
                if (String(row.profileId ?? "").trim() !== scopedProfile)
                    continue;
            }
            inv = row;
            break;
        }
    }
    const duplicateProfileInv = !scopedInvestmentId && inv ? inv : undefined;
    if (duplicateProfileInv && params.allowDuplicateProfile) {
        inv = undefined;
    }
    if (!inv && !scopedInvestmentId && !scopedUip && !scopedProfile) {
        for (const row of invCandidates) {
            if (isLpInvestorRole(row.investor_role)) {
                inv = row;
                break;
            }
        }
    }
    const now = new Date();
    if (!inv) {
        if (!profileOpt) {
            return {
                ok: false,
                message: "Investor profile is required to record your first commitment on this deal.",
            };
        }
        const icRaw =
          params.investorClassInBody && params.investorClass !== undefined
            ? String(params.investorClass).trim()
            : target?.investorClass?.trim() ?? "";
        const classRes = icRaw
            ? await resolveInvestorClassForDealInvestment(params.dealId, icRaw, {
                lpOnboardingOnly: true,
              })
            : await resolveFirstLpInvestorClassForDeal(params.dealId);
        if (!classRes.ok)
            return {
                ok: false,
                message: classRes.message ?? "Could not resolve investor class.",
            };
        const createdInv = await insertDealInvestment({
            dealId: params.dealId,
            input: {
                offeringId: "",
                contactId: targetContactMemberId,
                contactDisplayName: "",
                profileId: profileOpt,
                userInvestorProfileId: sUip.skip
                    ? undefined
                    : (sUip.value as string | null) ?? null,
                investor_role: LP_INVESTOR_ROLE_STORED,
                fundApproved: false,
                status: statusOpt !== undefined ? statusOpt : "",
                investorClass: classRes.storedInvestorClass,
                docSignedDate: docNorm.value === undefined ? null : docNorm.value,
                commitmentAmount: incrementStr || "0",
                extraContributionAmounts: [],
                documentStoragePath: null,
                fundingMethod: fundingMethodPatch ?? "",
            },
        });
        if (params.questionnaireAnswersInBody || params.w9FormInBody) {
            await db
                .update(dealInvestment)
                .set({
                  ...(params.questionnaireAnswersInBody
                    ? { investorQuestionnaireAnswersJson: questionnaireAnswersJson }
                    : {}),
                  ...(params.w9FormInBody
                    ? { investorW9FormJson: w9FormJson }
                    : {}),
                })
                .where(eq(dealInvestment.id, createdInv.id));
        }
        if (!target) {
            if (!viewerUserId) {
                return {
                    ok: false,
                    message: "Could not determine your account id for LP roster linking.",
                };
            }
            target = await upsertDealLpInvestor(params.dealId, {
                contactMemberId: targetContactMemberId,
                contactDisplayName: "",
                profileId: profileOpt,
                userInvestorProfileId: sUip.skip
                    ? undefined
                    : (sUip.value as string | null) ?? null,
                investorClass: classRes.storedInvestorClass,
                sendInvitationMail: "no",
                addedByUserId,
                emailFromClient: e,
                roleFromClient: LP_INVESTOR_TABLE_ROLE,
            });
        }
        await db
            .update(dealLpInvestor)
            .set({
            profileId: profileOpt,
            committed_amount: incrementStr,
            updatedAt: now,
            ...(!sUip.skip
                ? { userInvestorProfileId: sUip.value as string | null }
                : {}),
        })
            .where(eq(dealLpInvestor.id, target.id));
        await keepInviteSponsor(target.id);
        await keepSameOrgSponsor(target.id);
        return { ok: true };
    }
    const oldUip = String(inv.userInvestorProfileId ?? "").trim();
    const newUipFromBody = sUip.skip
        ? ""
        : String(sUip.value ?? "").trim();
    const switchingBookProfile =
        !sUip.skip &&
        Boolean(oldUip) &&
        Boolean(newUipFromBody) &&
        oldUip.toLowerCase() !== newUipFromBody.toLowerCase();
    const oldKind = normalizeLpCommitmentProfileId(
        String(inv.profileId ?? ""),
    );
    const switchingCommitmentKind = Boolean(
        profileOpt && oldKind && profileOpt !== oldKind,
    );
    const insertNewTranche = switchingBookProfile || switchingCommitmentKind;
    if (insertNewTranche) {
        const rowUip: string | null = sUip.skip
            ? (inv.userInvestorProfileId ?? null)
            : (sUip.value as string | null) ?? null;
        const rowProfileId: string = switchingCommitmentKind && profileOpt
            ? profileOpt
            : (oldKind ?? String(inv.profileId ?? "").trim());
        if (!rowProfileId.trim()) {
            return {
                ok: false,
                message: "Invalid investor profile on the existing commitment.",
            };
        }
        let roster = target;
        if (!roster) {
            if (!viewerUserId) {
                return {
                    ok: false,
                    message: "Could not determine your account id for LP roster linking.",
                };
            }
            const icRaw = inv.investorClass?.trim() ?? "";
            const classRes = icRaw
                ? await resolveInvestorClassForDealInvestment(
                    params.dealId,
                    icRaw,
                    { lpOnboardingOnly: true },
                )
                : await resolveFirstLpInvestorClassForDeal(params.dealId);
            if (!classRes.ok)
                return {
                    ok: false,
                    message: "Could not resolve investor class.",
                };
            roster = await upsertDealLpInvestor(params.dealId, {
                contactMemberId: targetContactMemberId,
                contactDisplayName: inv.contactDisplayName?.trim() ?? "",
                profileId: rowProfileId,
                userInvestorProfileId: sUip.skip
                    ? undefined
                    : (sUip.value as string | null) ?? null,
                investorClass: classRes.storedInvestorClass,
                sendInvitationMail: "no",
                addedByUserId,
                emailFromClient: e,
                roleFromClient: LP_INVESTOR_TABLE_ROLE,
            });
        }
        const insertRow: DealInvestmentInsert = {
            dealId: params.dealId,
            offeringId: String(inv.offeringId ?? "").trim(),
            contactId: targetContactMemberId,
            contactDisplayName: String(inv.contactDisplayName ?? "").trim(),
            profileId: rowProfileId,
            userInvestorProfileId: rowUip,
            investor_role: LP_INVESTOR_ROLE_STORED,
            fundApproved: false,
            status: statusOpt !== undefined ? String(statusOpt) : "",
            investorClass: String(inv.investorClass ?? "").trim() || "",
            docSignedDate:
                docNorm.value === undefined ? null : docNorm.value,
            commitmentAmount: incrementStr || "0",
            extraContributionAmounts: [],
            documentStoragePath: null,
            fundingMethod: fundingMethodPatch ?? "",
            ...(params.questionnaireAnswersInBody
              ? { investorQuestionnaireAnswersJson: questionnaireAnswersJson }
              : {}),
            ...(params.w9FormInBody ? { investorW9FormJson: w9FormJson } : {}),
        };
        try {
            await db.insert(dealInvestment).values(insertRow);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
                ok: false,
                message: `Could not record this commitment: ${msg}`,
            };
        }
        const syncedSum = await sumLpDealInvestmentCommittedForContact(
            params.dealId,
            targetContactMemberId,
        );
        await db
            .update(dealLpInvestor)
            .set({
                committed_amount: syncedSum,
                updatedAt: now,
                profileId: rowProfileId,
                userInvestorProfileId: rowUip,
            })
            .where(eq(dealLpInvestor.id, roster.id));
        await keepInviteSponsor(roster.id);
        await keepSameOrgSponsor(roster.id);
        return { ok: true };
    }
    let resolvedInvestorClass: string | undefined;
    try {
        if (params.investorClassInBody && params.investorClass !== undefined) {
            const classRes = await resolveInvestorClassForDealInvestment(
                params.dealId,
                String(params.investorClass),
                { lpOnboardingOnly: true },
            );
            if (!classRes.ok) {
                return { ok: false, message: classRes.message };
            }
            resolvedInvestorClass = classRes.storedInvestorClass;
        }
        await db.transaction(async (tx) => {
            await tx.execute(sql `SELECT 1 FROM deal_investment WHERE id = ${inv.id}::uuid FOR UPDATE`);
            const [fresh] = await tx
                .select()
                .from(dealInvestment)
                .where(eq(dealInvestment.id, inv.id))
                .limit(1);
            if (!fresh)
                throw new Error("LP_COMMITMENT_ROW_MISSING");
            const previous = committedNumericFromDealInvestmentRow(fresh);
            const newTotal = params.replaceCommittedAmount
                ? increment
                : previous + increment;
            const wasFundApproved = Boolean(fresh.fundApproved);
            const invPatch: Pick<
                DealInvestmentInsert,
                | "commitmentAmount"
                | "extraContributionAmounts"
                | "userInvestorProfileId"
                | "fundApproved"
                | "fundingMethod"
            > & {
                profileId?: string;
                status?: string;
                docSignedDate?: string | null;
            } = {
                extraContributionAmounts: [],
            };
            if (!skipAmount) {
                invPatch.commitmentAmount =
                    formatCumulativeCommitmentStored(newTotal);
            }
            if (params.fundingMethodInBody) {
                invPatch.fundingMethod = fundingMethodPatch ?? "";
            }
            // Further LP commitment after sponsor approval requires re-approval; committed total is prior + new increment.
            if (wasFundApproved) {
                invPatch.fundApproved = false;
                if (statusOpt === undefined) {
                    invPatch.status = "";
                }
            }
            if (profileOpt)
                invPatch.profileId = profileOpt;
            if (statusOpt !== undefined)
                invPatch.status = statusOpt;
            if (docNorm.value !== undefined)
                invPatch.docSignedDate = docNorm.value;
            if (!sUip.skip)
                invPatch.userInvestorProfileId = sUip.value as string | null;
            if (params.questionnaireAnswersInBody) {
                (invPatch as { investorQuestionnaireAnswersJson?: string | null })
                  .investorQuestionnaireAnswersJson = questionnaireAnswersJson;
            }
            if (params.w9FormInBody) {
                (invPatch as { investorW9FormJson?: string | null }).investorW9FormJson =
                  w9FormJson;
            }
            if (resolvedInvestorClass !== undefined) {
                (invPatch as { investorClass?: string }).investorClass =
                  resolvedInvestorClass;
            }
            await tx
                .update(dealInvestment)
                .set(invPatch)
                .where(eq(dealInvestment.id, inv.id));
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "LP_COMMITMENT_ROW_MISSING") {
            return {
                ok: false,
                message: "Could not update commitment (investment row missing).",
            };
        }
        throw e;
    }
    const [invAfterCommit] = await db
        .select({ commitmentAmount: dealInvestment.commitmentAmount })
        .from(dealInvestment)
        .where(eq(dealInvestment.id, inv.id))
        .limit(1);
    const syncedCommittedFromInvestment = String(invAfterCommit?.commitmentAmount ?? "").trim();
    if (!target) {
        if (!viewerUserId) {
            return {
                ok: false,
                message: "Could not determine your account id for LP roster linking.",
            };
        }
        const icRaw = inv.investorClass?.trim() ?? "";
        const classRes = icRaw
            ? await resolveInvestorClassForDealInvestment(params.dealId, icRaw, {
                lpOnboardingOnly: true,
              })
            : await resolveFirstLpInvestorClassForDeal(params.dealId);
        if (!classRes.ok)
            return {
                ok: false,
                message: classRes.message ?? "Could not resolve investor class.",
            };
        target = await upsertDealLpInvestor(params.dealId, {
            contactMemberId: targetContactMemberId,
            contactDisplayName: "",
            profileId: profileOpt ?? "",
            userInvestorProfileId: sUip.skip
                ? undefined
                : (sUip.value as string | null) ?? null,
            investorClass: classRes.storedInvestorClass,
            sendInvitationMail: "no",
            addedByUserId,
            emailFromClient: e,
            roleFromClient: LP_INVESTOR_TABLE_ROLE,
        });
    }
    await db
        .update(dealLpInvestor)
        .set({
        committed_amount: syncedCommittedFromInvestment,
        updatedAt: now,
        ...(profileOpt ? { profileId: profileOpt } : {}),
        ...(!sUip.skip ? { userInvestorProfileId: sUip.value as string | null } : {}),
        ...(resolvedInvestorClass !== undefined
          ? { investorClass: resolvedInvestorClass }
          : {}),
    })
        .where(eq(dealLpInvestor.id, target.id));
    await keepInviteSponsor(target.id);
    await keepSameOrgSponsor(target.id);
    return { ok: true };
}
