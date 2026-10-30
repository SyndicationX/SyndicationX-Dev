import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import emailConfig, {
  outgoingMailCcBcc,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import {
  buildInvestorParticipationNoticeHtml,
  buildInvestorParticipationNoticeText,
  investorParticipationNoticeSubject,
  type InvestorParticipationNoticeAction,
} from "../../functions/investorParticipationNoticeEmail.template.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { dealInvestment } from "../../schema/deal.schema/deal-investment.schema.js";
import { dealMemberRemovalLogs } from "../../schema/deal.schema/deal-member-removal-log.schema.js";
import { investorDealParticipation } from "../../schema/deal.schema/investor-deal-participation.schema.js";
import { investmentSignatures } from "../../schema/deal.schema/investment-signatures.schema.js";
import { investorCheckoutPayments, investorDistributionPayouts } from "../../schema/stripeInvestorPayments.schema.js";
import { dealInvestmentEsignIsFullyCompleted } from "../../constants/deal-investor-esign-status.js";
import type { DealInvestmentRow } from "../../schema/deal.schema/deal-investment.schema.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { resolveDealLeadSponsorFallback } from "./dealInvestment.service.js";
import { resolveDealInvestorAssociatedSponsor } from "./dealInvestorAssociatedSponsor.service.js";
import { resolveInvestNowViewerContactOnDeal } from "./dealInvestNowViewerContact.service.js";
import { resolveEmailForContactMemberId } from "./dealMemberInvitationEmail.service.js";
import { buildDealMemberInviteLandingUrl } from "./dealMemberInviteToken.service.js";

const SENDER_DISPLAY_NAME =
  process.env.SENDER_DISPLAY_NAME?.trim() || "SyndicationX";

export type InvestorParticipationMutationResult =
  | { ok: true; sponsorNotified: boolean }
  | { ok: false; status: number; message: string };

type ParticipationKind = "invested" | "soft_committed" | "draft" | "in_progress";

type SponsorTarget = { email: string; name: string };

function cleanReason(raw: string | undefined): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function commitmentAmount(row: DealInvestmentRow): number {
  const n = Number(String(row.commitmentAmount ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function isSoftCommittedStatus(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === "soft committed" || s === "soft commitment";
}

function statusLooksInvested(status: string): boolean {
  const s = status.trim().toLowerCase();
  if (!s || s === "—" || isSoftCommittedStatus(s)) return false;
  if (
    s === "open to investment" ||
    s === "open to soft commitment" ||
    s === "open to hard commitment" ||
    s.startsWith("draft") ||
    s.startsWith("coming soon") ||
    s.startsWith("waitlist") ||
    s.startsWith("closed") ||
    s.startsWith("past")
  ) {
    return false;
  }
  return (
    /funds?\s+(fully|partially)\s+received/.test(s) ||
    s === "signed" ||
    s === "counter-signed" ||
    s.startsWith("funding instructions") ||
    s.startsWith("investment started") ||
    s.startsWith("document signing") ||
    s.startsWith("inactive") ||
    s.startsWith("canceled") ||
    s === "active"
  );
}

function classifyRow(
  row: DealInvestmentRow,
  blocked: { payout: boolean; payment: boolean; signed: boolean },
): ParticipationKind {
  const esignDone = dealInvestmentEsignIsFullyCompleted({
    esignStatusJson: row.esignStatusJson,
    docSignedDate: row.docSignedDate,
    profileId: row.profileId,
  });
  const status = row.status ?? "";
  // Money already moved, or the sponsor approved the fund. A signature alone
  // does not make a soft commitment invested.
  const hardInvested =
    Boolean(row.fundApproved) ||
    blocked.payout ||
    blocked.payment ||
    statusLooksInvested(status);
  if (hardInvested) return "invested";
  if (isSoftCommittedStatus(status)) return "soft_committed";
  const invested =
    Boolean(row.commitmentCompletedAt) || esignDone || blocked.signed;
  if (invested) return "invested";
  if (row.isDraft || commitmentAmount(row) <= 0) return "draft";
  return "in_progress";
}

function profileLabel(row: DealInvestmentRow): string {
  const name = String(row.contactDisplayName ?? "").trim();
  if (name && name !== "—") return name;
  const profile = String(row.profileId ?? "").trim();
  return profile || "Profile";
}

async function loadInvestorIdentity(userId: string): Promise<{
  email: string;
  name: string;
} | null> {
  const [row] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const email = String(row?.email ?? "").trim().toLowerCase();
  if (!row || !email.includes("@")) return null;
  const full = [row.firstName, row.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return { email, name: full || row.username?.trim() || email };
}

async function ownedRows(
  dealId: string,
  viewerUserId: string,
  viewerEmail: string,
): Promise<DealInvestmentRow[]> {
  const resolved = await resolveInvestNowViewerContactOnDeal({
    dealId,
    viewerEmailNorm: viewerEmail,
    viewerUserId,
  });
  const keys = new Set<string>();
  if (viewerUserId.trim()) keys.add(viewerUserId.trim().toLowerCase());
  const contactId = String(resolved.contactMemberId ?? "").trim().toLowerCase();
  if (contactId) keys.add(contactId);

  const rows = await db
    .select()
    .from(dealInvestment)
    .where(
      and(
        eq(dealInvestment.dealId, dealId),
        isNull(dealInvestment.removedAt),
        isNull(dealInvestment.investorUnlinkedAt),
      ),
    );

  const owned: DealInvestmentRow[] = [];
  for (const row of rows) {
    const cid = String(row.contactId ?? "").trim().toLowerCase();
    if (cid && keys.has(cid)) {
      owned.push(row);
      continue;
    }
    if (!cid) continue;
    const email = await resolveEmailForContactMemberId(row.contactId);
    if (email && email === viewerEmail) owned.push(row);
  }
  return owned;
}

function commitmentFromRemovalSnapshot(
  snapshot: unknown,
  investmentId: string,
): { commitmentAmount: string; extraContributionAmounts: string[] } | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const investments = (snapshot as { investments?: unknown }).investments;
  if (!Array.isArray(investments)) return null;
  const id = investmentId.trim().toLowerCase();
  for (const item of investments) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (String(row.id ?? "").trim().toLowerCase() !== id) continue;
    const commitmentAmount = String(
      row.commitmentAmount ?? row.commitment_amount ?? "",
    ).trim();
    const extrasRaw = row.extraContributionAmounts ?? row.extra_contribution_amounts;
    const extraContributionAmounts = Array.isArray(extrasRaw)
      ? extrasRaw.map((value) => String(value ?? ""))
      : [];
    if (!commitmentAmount && extraContributionAmounts.length === 0) return null;
    return { commitmentAmount, extraContributionAmounts };
  }
  return null;
}

/** Rows already removed had their amounts cleared. Put the logged amounts back for Archives. */
async function restoreArchivedCommitmentAmounts(
  rows: DealInvestmentRow[],
): Promise<DealInvestmentRow[]> {
  const missing = rows.filter((row) => {
    const amount = String(row.commitmentAmount ?? "").trim();
    const extras = row.extraContributionAmounts ?? [];
    return !amount && extras.length === 0;
  });
  if (missing.length === 0) return rows;
  const wanted = new Set(missing.map((row) => row.id.toLowerCase()));
  const dealIds = [...new Set(missing.map((row) => row.dealId))];
  const logs = await db
    .select({
      removedSnapshot: dealMemberRemovalLogs.removedSnapshot,
    })
    .from(dealMemberRemovalLogs)
    .where(
      and(
        inArray(dealMemberRemovalLogs.dealId, dealIds),
        eq(dealMemberRemovalLogs.action, "remove_investment"),
      ),
    )
    .orderBy(desc(dealMemberRemovalLogs.createdAt));
  const restored = new Map<
    string,
    { commitmentAmount: string; extraContributionAmounts: string[] }
  >();
  for (const log of logs) {
    for (const id of wanted) {
      if (restored.has(id)) continue;
      const found = commitmentFromRemovalSnapshot(log.removedSnapshot, id);
      if (found) restored.set(id, found);
    }
  }
  return rows.map((row) => {
    const found = restored.get(row.id.toLowerCase());
    if (!found) return row;
    return { ...row, ...found };
  });
}

/**
 * Investments a sponsor or platform admin removed. Only the owning investor
 * receives these, so they can see the commitment in Archives. They cannot restore it.
 */
export async function listSponsorRemovedInvestmentsForViewer(
  dealId: string,
  viewerUserId: string,
  viewerEmail: string,
): Promise<DealInvestmentRow[]> {
  const resolved = await resolveInvestNowViewerContactOnDeal({
    dealId,
    viewerEmailNorm: viewerEmail,
    viewerUserId,
  });
  const keys = new Set<string>();
  if (viewerUserId.trim()) keys.add(viewerUserId.trim().toLowerCase());
  const contactId = String(resolved.contactMemberId ?? "").trim().toLowerCase();
  if (contactId) keys.add(contactId);

  const rows = await db
    .select()
    .from(dealInvestment)
    .where(
      and(
        eq(dealInvestment.dealId, dealId),
        eq(dealInvestment.isDraft, false),
        eq(dealInvestment.removalAction, "remove_investment"),
        isNotNull(dealInvestment.removedAt),
      ),
    );

  const owned: DealInvestmentRow[] = [];
  for (const row of rows) {
    const cid = String(row.contactId ?? "").trim().toLowerCase();
    if (cid && keys.has(cid)) {
      owned.push(row);
      continue;
    }
    if (!cid) continue;
    const email = await resolveEmailForContactMemberId(row.contactId);
    if (email && email === viewerEmail) owned.push(row);
  }
  return restoreArchivedCommitmentAmounts(owned);
}

/** Sponsor lists omit an archived commitment. The investor who archived it can still see it. */
export async function omitArchivedCommitmentsHiddenFromViewer(
  dealId: string,
  viewerUserId: string,
  viewerEmail: string,
  rows: DealInvestmentRow[],
): Promise<DealInvestmentRow[]> {
  if (!rows.some((row) => row.investorArchivedAt)) return rows;
  const owned = await ownedRows(dealId, viewerUserId, viewerEmail);
  const ownedIds = new Set(owned.map((row) => row.id));
  return rows.filter(
    (row) => !row.investorArchivedAt || ownedIds.has(row.id),
  );
}

async function blockingIds(rows: DealInvestmentRow[]): Promise<{
  payouts: Set<string>;
  payments: Set<string>;
  signed: Set<string>;
}> {
  const ids = rows.map((row) => row.id);
  const payouts = new Set<string>();
  const payments = new Set<string>();
  const signed = new Set<string>();
  if (ids.length === 0) return { payouts, payments, signed };

  const [payoutRows, paymentRows, signatureRows] = await Promise.all([
    db
      .select({ investmentId: investorDistributionPayouts.investmentId })
      .from(investorDistributionPayouts)
      .where(inArray(investorDistributionPayouts.investmentId, ids)),
    db
      .select({
        investmentId: investorCheckoutPayments.investmentId,
        status: investorCheckoutPayments.status,
      })
      .from(investorCheckoutPayments)
      .where(inArray(investorCheckoutPayments.investmentId, ids)),
    db
      .select({
        investmentId: investmentSignatures.investmentId,
        status: investmentSignatures.status,
      })
      .from(investmentSignatures)
      .where(inArray(investmentSignatures.investmentId, ids)),
  ]);

  for (const row of payoutRows) payouts.add(row.investmentId);
  for (const row of paymentRows) {
    const status = String(row.status ?? "").trim().toLowerCase();
    if (status === "succeeded" || status === "processing" || status === "paid") {
      payments.add(row.investmentId);
    }
  }
  for (const row of signatureRows) {
    const status = String(row.status ?? "").trim().toLowerCase();
    if (status === "signed" || status === "completed") signed.add(row.investmentId);
  }
  return { payouts, payments, signed };
}

function kindFor(
  row: DealInvestmentRow,
  blocked: Awaited<ReturnType<typeof blockingIds>>,
): ParticipationKind {
  return classifyRow(row, {
    payout: blocked.payouts.has(row.id),
    payment: blocked.payments.has(row.id),
    signed: blocked.signed.has(row.id),
  });
}

function dealDeleteAllowed(rows: DealInvestmentRow[], blocked: Awaited<ReturnType<typeof blockingIds>>): boolean {
  if (rows.length === 0) return false;
  let soft = 0;
  for (const row of rows) {
    const kind = kindFor(row, blocked);
    if (kind === "invested" || kind === "in_progress") return false;
    if (kind === "soft_committed") soft += 1;
  }
  return soft > 0;
}

async function upsertParticipation(
  userId: string,
  dealId: string,
  patch: { archivedAt?: Date | null; removedAt?: Date | null },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(investorDealParticipation)
    .where(
      and(
        eq(investorDealParticipation.userId, userId),
        eq(investorDealParticipation.dealId, dealId),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(investorDealParticipation).values({
      userId,
      dealId,
      archivedAt: patch.archivedAt ?? null,
      removedAt: patch.removedAt ?? null,
    });
    return;
  }
  await db
    .update(investorDealParticipation)
    .set({
      archivedAt:
        patch.archivedAt === undefined ? existing.archivedAt : patch.archivedAt,
      removedAt:
        patch.removedAt === undefined ? existing.removedAt : patch.removedAt,
    })
    .where(
      and(
        eq(investorDealParticipation.userId, userId),
        eq(investorDealParticipation.dealId, dealId),
      ),
    );
}

async function notifySponsors(params: {
  action: InvestorParticipationNoticeAction;
  dealId: string;
  investorName: string;
  investorEmail: string;
  profileName: string;
  reason: string;
  rows: DealInvestmentRow[];
}): Promise<boolean> {
  const sponsors = new Map<string, SponsorTarget>();
  for (const row of params.rows) {
    try {
      const sponsor = await resolveDealInvestorAssociatedSponsor({
        dealId: params.dealId,
        contactId: row.contactId,
        investmentId: row.id,
        investorEmail: params.investorEmail,
      });
      if (sponsor?.email) {
        sponsors.set(sponsor.email, { email: sponsor.email, name: sponsor.name });
      }
    } catch (err) {
      console.warn("investorParticipation: sponsor lookup", err);
    }
  }
  if (sponsors.size === 0) {
    try {
      const lead = await resolveDealLeadSponsorFallback(params.dealId);
      const email = String(lead.email ?? "").trim().toLowerCase();
      if (email.includes("@") && email !== params.investorEmail) {
        sponsors.set(email, {
          email,
          name: String(lead.displayName ?? "").trim() || email,
        });
      }
    } catch (err) {
      console.warn("investorParticipation: lead sponsor lookup", err);
    }
  }
  if (sponsors.size === 0) return false;

  const deal = await getAddDealFormById(params.dealId);
  const dealName = deal?.dealName?.trim() || "this deal";
  const fromAddress = process.env.SENDER_EMAIL_ID?.trim() || "";
  if (!fromAddress) {
    console.warn("investorParticipation: SENDER_EMAIL_ID is not set");
    return false;
  }

  let sent = false;
  for (const sponsor of sponsors.values()) {
    try {
      const portalUrl =
        (await buildDealMemberInviteLandingUrl(params.dealId, sponsor.email)) ||
        "";
      const vars = {
        action: params.action,
        dealName,
        investorDisplayName: params.investorName,
        investorEmail: params.investorEmail,
        sponsorDisplayName: sponsor.name,
        profileName: params.profileName,
        reason: params.reason,
        portalUrl,
        senderBrand: SENDER_DISPLAY_NAME,
      };
      const transporter = emailConfig();
      const ccBcc = outgoingMailCcBcc();
      await transporter.sendMail({
        from: { name: SENDER_DISPLAY_NAME, address: fromAddress },
        to: sponsor.email,
        ...ccBcc,
        envelope: smtpEnvelopeForSendMail({
          fromAddress,
          to: sponsor.email,
          cc: ccBcc.cc,
          bcc: ccBcc.bcc,
        }),
        subject: investorParticipationNoticeSubject(vars),
        text: buildInvestorParticipationNoticeText(vars),
        html: buildInvestorParticipationNoticeHtml(vars),
      });
      sent = true;
    } catch (err) {
      console.warn(
        "investorParticipation: sponsor email failed",
        sponsor.email,
        err,
      );
    }
  }
  return sent;
}

async function requireInvestor(userId: string): Promise<
  | { ok: true; email: string; name: string }
  | { ok: false; status: number; message: string }
> {
  const identity = await loadInvestorIdentity(userId);
  if (!identity) {
    return {
      ok: false,
      status: 400,
      message: "Your account does not have a registered email address.",
    };
  }
  return { ok: true, ...identity };
}

export async function listMyInvestorParticipation(userId: string): Promise<{
  archivedDealIds: string[];
  removedDealIds: string[];
}> {
  const rows = await db
    .select({
      dealId: investorDealParticipation.dealId,
      archivedAt: investorDealParticipation.archivedAt,
      removedAt: investorDealParticipation.removedAt,
    })
    .from(investorDealParticipation)
    .where(eq(investorDealParticipation.userId, userId));
  const archivedDealIds: string[] = [];
  const removedDealIds: string[] = [];
  for (const row of rows) {
    if (row.removedAt) removedDealIds.push(row.dealId);
    else if (row.archivedAt) archivedDealIds.push(row.dealId);
  }
  return { archivedDealIds, removedDealIds };
}

/** A new commitment brings a previously deleted deal back onto the investing list. */
export async function clearInvestorDealRemoval(
  userId: string,
  dealId: string,
): Promise<void> {
  const uid = userId.trim();
  const did = dealId.trim();
  if (!uid || !did) return;
  await db
    .update(investorDealParticipation)
    .set({ removedAt: null })
    .where(
      and(
        eq(investorDealParticipation.userId, uid),
        eq(investorDealParticipation.dealId, did),
      ),
    );
}

export async function setMyDealArchived(params: {
  userId: string;
  dealId: string;
  archived: boolean;
  reason?: string;
}): Promise<InvestorParticipationMutationResult> {
  const investor = await requireInvestor(params.userId);
  if (!investor.ok) return investor;
  const deal = await getAddDealFormById(params.dealId);
  if (!deal) return { ok: false, status: 404, message: "Deal not found." };

  if (!params.archived) {
    const [existing] = await db
      .select({ removedAt: investorDealParticipation.removedAt })
      .from(investorDealParticipation)
      .where(
        and(
          eq(investorDealParticipation.userId, params.userId),
          eq(investorDealParticipation.dealId, params.dealId),
        ),
      )
      .limit(1);
    if (existing?.removedAt) {
      return {
        ok: false,
        status: 409,
        message: "This soft commitment was deleted and cannot be restored.",
      };
    }
    await upsertParticipation(params.userId, params.dealId, { archivedAt: null });
    return { ok: true, sponsorNotified: false };
  }

  await upsertParticipation(params.userId, params.dealId, {
    archivedAt: new Date(),
    removedAt: null,
  });
  const rows = await ownedRows(params.dealId, params.userId, investor.email);
  const sponsorNotified = await notifySponsors({
    action: "archive_deal",
    dealId: params.dealId,
    investorName: investor.name,
    investorEmail: investor.email,
    profileName: "",
    reason: cleanReason(params.reason),
    rows,
  });
  return { ok: true, sponsorNotified };
}

export async function deleteMySoftCommittedDeal(params: {
  userId: string;
  dealId: string;
  reason?: string;
}): Promise<InvestorParticipationMutationResult> {
  const investor = await requireInvestor(params.userId);
  if (!investor.ok) return investor;
  const deal = await getAddDealFormById(params.dealId);
  if (!deal) return { ok: false, status: 404, message: "Deal not found." };

  const rows = await ownedRows(params.dealId, params.userId, investor.email);
  const blocked = await blockingIds(rows);
  if (!dealDeleteAllowed(rows, blocked)) {
    const invested = rows.some((row) => kindFor(row, blocked) === "invested");
    return {
      ok: false,
      status: 409,
      message: invested
        ? "Invested deals can be archived, not removed."
        : "Only a soft commitment can be removed.",
    };
  }

  const ids = rows.map((row) => row.id);
  await db.delete(dealInvestment).where(inArray(dealInvestment.id, ids));
  await upsertParticipation(params.userId, params.dealId, {
    archivedAt: null,
    removedAt: new Date(),
  });
  const sponsorNotified = await notifySponsors({
    action: "delete_deal",
    dealId: params.dealId,
    investorName: investor.name,
    investorEmail: investor.email,
    profileName: "",
    reason: cleanReason(params.reason),
    rows,
  });
  return { ok: true, sponsorNotified };
}

export async function setMyProfileArchived(params: {
  userId: string;
  dealId: string;
  investmentId: string;
  archived: boolean;
  reason?: string;
}): Promise<InvestorParticipationMutationResult> {
  const investor = await requireInvestor(params.userId);
  if (!investor.ok) return investor;
  const rows = await ownedRows(params.dealId, params.userId, investor.email);
  const wantedId = params.investmentId.trim().toLowerCase();
  const row = rows.find((item) => item.id.toLowerCase() === wantedId);
  if (!row) {
    if (!params.archived) {
      const [removed] = await db
        .select({ id: dealInvestment.id, removedAt: dealInvestment.removedAt })
        .from(dealInvestment)
        .where(
          and(
            eq(dealInvestment.id, params.investmentId.trim()),
            eq(dealInvestment.dealId, params.dealId),
            isNotNull(dealInvestment.removedAt),
          ),
        )
        .limit(1);
      if (removed) {
        return {
          ok: false,
          status: 409,
          message:
            "This investment was removed by the sponsor and cannot be restored.",
        };
      }
    }
    return { ok: false, status: 404, message: "That profile is not on this deal." };
  }

  await db
    .update(dealInvestment)
    .set({ investorArchivedAt: params.archived ? new Date() : null })
    .where(
      and(
        eq(dealInvestment.id, row.id),
        eq(dealInvestment.dealId, params.dealId),
      ),
    );

  if (!params.archived) return { ok: true, sponsorNotified: false };
  const sponsorNotified = await notifySponsors({
    action: "archive_profile",
    dealId: params.dealId,
    investorName: investor.name,
    investorEmail: investor.email,
    profileName: profileLabel(row),
    reason: cleanReason(params.reason),
    rows: [row],
  });
  return { ok: true, sponsorNotified };
}

export async function deleteMySoftCommittedProfile(params: {
  userId: string;
  dealId: string;
  investmentId: string;
  reason?: string;
}): Promise<InvestorParticipationMutationResult> {
  const investor = await requireInvestor(params.userId);
  if (!investor.ok) return investor;
  const rows = await ownedRows(params.dealId, params.userId, investor.email);
  const wantedId = params.investmentId.trim().toLowerCase();
  const row = rows.find((item) => item.id.toLowerCase() === wantedId);
  if (!row) {
    return { ok: false, status: 404, message: "That profile is not on this deal." };
  }
  const blocked = await blockingIds([row]);
  if (kindFor(row, blocked) !== "soft_committed") {
    return {
      ok: false,
      status: 409,
      message:
        kindFor(row, blocked) === "invested"
          ? "An invested profile can be archived, not removed."
          : "Only a soft-committed profile can be removed.",
    };
  }

  await db
    .delete(dealInvestment)
    .where(
      and(eq(dealInvestment.id, row.id), eq(dealInvestment.dealId, params.dealId)),
    );
  const sponsorNotified = await notifySponsors({
    action: "delete_profile",
    dealId: params.dealId,
    investorName: investor.name,
    investorEmail: investor.email,
    profileName: profileLabel(row),
    reason: cleanReason(params.reason),
    rows: [row],
  });
  return { ok: true, sponsorNotified };
}
