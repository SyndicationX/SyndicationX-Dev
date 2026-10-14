import { and, desc, eq, isNull } from "drizzle-orm";
import emailConfig, {
  outgoingMailCcBcc,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import {
  buildInvestmentCommitmentInvestorEmailHtml,
  buildInvestmentCommitmentInvestorEmailText,
  buildInvestmentCommitmentSponsorEmailHtml,
  buildInvestmentCommitmentSponsorEmailText,
  type InvestmentCommitmentEmailVars,
} from "../../functions/investmentCommitmentEmail.template.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { dealInvestment } from "../../schema/deal.schema/deal-investment.schema.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { isLpInvestorRole } from "./dealInvestment.service.js";
import { resolveDealInvestorAssociatedSponsor } from "./dealInvestorAssociatedSponsor.service.js";
import { buildDealMemberInviteLandingUrl } from "./dealMemberInviteToken.service.js";
import { resolveInvestNowViewerContactOnDeal } from "./dealInvestNowViewerContact.service.js";

const SENDER_DISPLAY_NAME =
  process.env.SENDER_DISPLAY_NAME?.trim() || "SyndicationX";

type MailIdentity = {
  email: string;
  name: string;
};

export type InvestmentCommitmentEmailResult =
  | {
      ok: true;
      investmentId: string;
      investorEmailSent: boolean;
      sponsorEmailSent: boolean;
      investorEmailSkipped: boolean;
      sponsorEmailSkipped: boolean;
    }
  | { ok: false; status: number; message: string };

function formatCommitmentAmount(raw: string): string | null {
  const n = Number(String(raw ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function formatCommitmentDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(value);
}

function displayNameFromUser(row: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string;
}): string {
  const full = [row.firstName, row.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (full) return full;
  const username = row.username?.trim();
  if (username) return username;
  return row.email;
}

async function loadRegisteredUser(
  userId: string,
): Promise<MailIdentity | null> {
  const id = userId.trim();
  if (!id) return null;
  const [row] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const email = String(row?.email ?? "").trim().toLowerCase();
  if (!row || !email.includes("@")) return null;
  return {
    email,
    name: displayNameFromUser({ ...row, email }),
  };
}

async function sendCommitmentMail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const to = params.to.trim().toLowerCase();
  if (!to.includes("@")) {
    return { ok: false, error: new Error("Invalid recipient email") };
  }
  const fromAddress = process.env.SENDER_EMAIL_ID?.trim() || "";
  if (!fromAddress) {
    return {
      ok: false,
      error: new Error(
        "SENDER_EMAIL_ID is not set in backend/.env.local",
      ),
    };
  }
  try {
    const transporter = emailConfig();
    const ccBcc = outgoingMailCcBcc();
    await transporter.sendMail({
      from: { name: SENDER_DISPLAY_NAME, address: fromAddress },
      to,
      ...ccBcc,
      envelope: smtpEnvelopeForSendMail({
        fromAddress,
        to,
        cc: ccBcc.cc,
        bcc: ccBcc.bcc,
      }),
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function claimInvestorSend(investmentId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const rows = await db
    .update(dealInvestment)
    .set({ commitmentInvestorEmailSentAt: claimedAt })
    .where(
      and(
        eq(dealInvestment.id, investmentId),
        isNull(dealInvestment.commitmentInvestorEmailSentAt),
      ),
    )
    .returning({ sentAt: dealInvestment.commitmentInvestorEmailSentAt });
  return rows[0]?.sentAt ?? null;
}

async function claimSponsorSend(investmentId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const rows = await db
    .update(dealInvestment)
    .set({ commitmentSponsorEmailSentAt: claimedAt })
    .where(
      and(
        eq(dealInvestment.id, investmentId),
        isNull(dealInvestment.commitmentSponsorEmailSentAt),
      ),
    )
    .returning({ sentAt: dealInvestment.commitmentSponsorEmailSentAt });
  return rows[0]?.sentAt ?? null;
}

async function releaseInvestorSend(
  investmentId: string,
  claimedAt: Date,
): Promise<void> {
  await db
    .update(dealInvestment)
    .set({ commitmentInvestorEmailSentAt: null })
    .where(
      and(
        eq(dealInvestment.id, investmentId),
        eq(dealInvestment.commitmentInvestorEmailSentAt, claimedAt),
      ),
    );
}

async function releaseSponsorSend(
  investmentId: string,
  claimedAt: Date,
): Promise<void> {
  await db
    .update(dealInvestment)
    .set({ commitmentSponsorEmailSentAt: null })
    .where(
      and(
        eq(dealInvestment.id, investmentId),
        eq(dealInvestment.commitmentSponsorEmailSentAt, claimedAt),
      ),
    );
}

/**
 * After Invest Now Finish: email the investor and their sponsor once per investment.
 * Amount, name, and date come from stored records. A failed send is logged and the
 * claim is released so a later Finish can retry that recipient only.
 */
export async function sendInvestmentCommitmentNotifications(params: {
  dealId: string;
  viewerUserId: string;
  viewerEmailNorm: string;
  investmentId?: string;
  commitmentKind?: "completed" | "soft";
}): Promise<InvestmentCommitmentEmailResult> {
  const dealId = params.dealId.trim();
  const viewerUserId = params.viewerUserId.trim();
  const viewerEmail = params.viewerEmailNorm.trim().toLowerCase();
  if (!dealId || !viewerUserId || !viewerEmail.includes("@")) {
    return { ok: false, status: 400, message: "Invalid investor account." };
  }

  const investorUser = await loadRegisteredUser(viewerUserId);
  if (!investorUser) {
    console.warn(
      "investmentCommitmentEmail: investor has no registered email",
      viewerUserId,
    );
    return {
      ok: false,
      status: 400,
      message: "Your account does not have a registered email address.",
    };
  }

  const resolved = await resolveInvestNowViewerContactOnDeal({
    dealId,
    viewerEmailNorm: investorUser.email,
    viewerUserId,
  });
  const contactId = resolved.contactMemberId.trim();
  if (!contactId) {
    return {
      ok: false,
      status: 404,
      message: "No investment commitment was found for this deal.",
    };
  }

  const rows = await db
    .select()
    .from(dealInvestment)
    .where(
      and(
        eq(dealInvestment.dealId, dealId),
        eq(dealInvestment.contactId, contactId),
      ),
    )
    .orderBy(desc(dealInvestment.createdAt));

  const requestedId = String(params.investmentId ?? "").trim().toLowerCase();
  const lpRows = rows.filter((row) => isLpInvestorRole(row.investor_role));
  const investment = requestedId
    ? lpRows.find((row) => row.id.toLowerCase() === requestedId)
    : lpRows.find((row) => formatCommitmentAmount(row.commitmentAmount));
  if (!investment) {
    return {
      ok: false,
      status: 404,
      message: "No investment commitment was found for this deal.",
    };
  }

  const amountLabel = formatCommitmentAmount(investment.commitmentAmount);
  if (!amountLabel) {
    console.warn(
      "investmentCommitmentEmail: missing commitment amount",
      investment.id,
    );
    return {
      ok: false,
      status: 400,
      message: "This investment does not have a commitment amount yet.",
    };
  }

  const commitmentKind = params.commitmentKind ?? "completed";
  if (commitmentKind === "completed" && !investment.commitmentCompletedAt) {
    await db
      .update(dealInvestment)
      .set({ commitmentCompletedAt: new Date() })
      .where(
        and(
          eq(dealInvestment.id, investment.id),
          isNull(dealInvestment.commitmentCompletedAt),
        ),
      );
  }
  const [fresh] = await db
    .select({
      commitmentCompletedAt: dealInvestment.commitmentCompletedAt,
      contactDisplayName: dealInvestment.contactDisplayName,
    })
    .from(dealInvestment)
    .where(eq(dealInvestment.id, investment.id))
    .limit(1);
  const commitmentDate = fresh?.commitmentCompletedAt ?? new Date();
  const storedName = String(fresh?.contactDisplayName ?? "").trim();
  const investorName =
    storedName && storedName !== "—" ? storedName : investorUser.name;

  const deal = await getAddDealFormById(dealId);
  const dealName = deal?.dealName?.trim() || "this deal";
  const portalUrl =
    (await buildDealMemberInviteLandingUrl(dealId, investorUser.email)) || "";
  const vars: InvestmentCommitmentEmailVars = {
    dealName,
    investorDisplayName: investorName,
    investorEmail: investorUser.email,
    sponsorDisplayName: "",
    commitmentAmount: amountLabel,
    commitmentDate: formatCommitmentDate(commitmentDate),
    portalUrl,
    senderBrand: SENDER_DISPLAY_NAME,
    commitmentKind,
  };

  let investorEmailSent = false;
  let investorEmailSkipped = false;
  const investorClaim = await claimInvestorSend(investment.id);
  if (!investorClaim) {
    investorEmailSkipped = true;
  } else {
    const result = await sendCommitmentMail({
      to: investorUser.email,
      subject:
        commitmentKind === "soft"
          ? `Your soft investment commitment — ${dealName}`
          : `Your investment commitment — ${dealName}`,
      text: buildInvestmentCommitmentInvestorEmailText(vars),
      html: buildInvestmentCommitmentInvestorEmailHtml(vars),
    });
    if (result.ok) {
      investorEmailSent = true;
    } else {
      console.warn(
        "investmentCommitmentEmail: investor send failed",
        investment.id,
        investorUser.email,
        result.error,
      );
      await releaseInvestorSend(investment.id, investorClaim);
    }
  }

  let sponsorEmailSent = false;
  let sponsorEmailSkipped = false;
  const sponsor = await resolveDealInvestorAssociatedSponsor({
    dealId,
    contactId,
    investmentId: investment.id,
    investorEmail: investorUser.email,
  });
  if (!sponsor) {
    console.warn(
      "investmentCommitmentEmail: no sponsor email for investment",
      investment.id,
    );
  } else {
    const sponsorClaim = await claimSponsorSend(investment.id);
    if (!sponsorClaim) {
      sponsorEmailSkipped = true;
    } else {
      const sponsorVars = {
        ...vars,
        sponsorDisplayName: sponsor.name,
        portalUrl:
          (await buildDealMemberInviteLandingUrl(dealId, sponsor.email)) ||
          portalUrl,
      };
      const result = await sendCommitmentMail({
        to: sponsor.email,
        subject:
          commitmentKind === "soft"
            ? `Investor soft commitment — ${dealName}`
            : `Investor commitment — ${dealName}`,
        text: buildInvestmentCommitmentSponsorEmailText(sponsorVars),
        html: buildInvestmentCommitmentSponsorEmailHtml(sponsorVars),
      });
      if (result.ok) {
        sponsorEmailSent = true;
      } else {
        console.warn(
          "investmentCommitmentEmail: sponsor send failed",
          investment.id,
          sponsor.email,
          result.error,
        );
        await releaseSponsorSend(investment.id, sponsorClaim);
      }
    }
  }

  return {
    ok: true,
    investmentId: investment.id,
    investorEmailSent,
    sponsorEmailSent,
    investorEmailSkipped,
    sponsorEmailSkipped,
  };
}
