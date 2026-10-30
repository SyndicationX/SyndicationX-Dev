import emailConfig, {
  outgoingMailCcBcc,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import {
  buildDealEsignStageNotificationEmailHtml,
  buildDealEsignStageNotificationEmailText,
  dealEsignStageNotificationSubject,
} from "../../functions/dealEsignStageNotification.template.js";
import {
  findEsignSendBySignatureRequestId,
  parseEsignStatusBundle,
  type StoredDealInvestorEsignSend,
} from "../../constants/deal-investor-esign-status.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { buildDealMemberInviteLandingUrl } from "./dealMemberInviteToken.service.js";
import { resolveDealInvestorAssociatedSponsor } from "./dealInvestorAssociatedSponsor.service.js";
import {
  listDealEsignInvestorQueue,
  resolveInvestorDocumentAudienceIds,
  findQueueEntryForEsignTarget,
} from "./dealSequentialEsignWorkflow.service.js";
import {
  readInvestorEsignStatusJson,
  resolveEsignTargetForInvestorRowId,
  updateDealInvestorEsignSend,
  type InvestorEsignRowTarget,
} from "./dealMemberEsignStatus.service.js";
import { resolveEmailForContactMemberId } from "./dealMemberInvitationEmail.service.js";
import { listDealSponsorSignerOptions } from "./dealEsignSigningWorkflow.service.js";
import {
  getSignFlowDocument,
  signFlowPendingSponsorSignAudience,
} from "../esign/signflow.service.js";

const SENDER_DISPLAY_NAME =
  process.env.SENDER_DISPLAY_NAME?.trim() || "SyndicationX";

async function sendStageEmail(params: {
  toEmail: string;
  recipientDisplayName: string;
  dealName: string;
  documentNames: string[];
  investorDisplayName?: string;
  portalDealUrl?: string;
  stage:
    | "investor_signed"
    | "sponsor_signed"
    | "investor_turn_to_sign"
    | "sponsor_turn_to_sign";
}): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const to = params.toEmail.trim().toLowerCase();
  if (!to.includes("@")) {
    return { ok: false, error: new Error("Invalid recipient email") };
  }

  try {
    const transporter = emailConfig();
    const fromAddress = process.env.SENDER_EMAIL_ID?.trim() || "";
    if (!fromAddress) {
      return {
        ok: false,
        error: new Error("SENDER_EMAIL_ID is not configured"),
      };
    }

    const templateVars = {
      dealName: params.dealName,
      recipientDisplayName: params.recipientDisplayName,
      recipientEmail: to,
      documentNames: params.documentNames,
      investorDisplayName: params.investorDisplayName,
      senderBrand: SENDER_DISPLAY_NAME,
      portalDealUrl: params.portalDealUrl,
      stage: params.stage,
    };
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
      subject: dealEsignStageNotificationSubject(templateVars),
      text: buildDealEsignStageNotificationEmailText(templateVars),
      html: buildDealEsignStageNotificationEmailHtml(templateVars),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function documentNamesFromSend(send: StoredDealInvestorEsignSend): string[] {
  return (send.documents ?? [])
    .map((d) => d.name.trim())
    .filter(Boolean);
}

async function resolveInvestorEmailForTarget(
  dealId: string,
  target: InvestorEsignRowTarget,
): Promise<{ email: string; displayName: string } | null> {
  const queue = await listDealEsignInvestorQueue(dealId);
  const entry = await findQueueEntryForEsignTarget(dealId, queue, target);
  if (entry?.email?.includes("@")) {
    return { email: entry.email.trim().toLowerCase(), displayName: entry.displayName };
  }

  const ids = await resolveInvestorDocumentAudienceIds(dealId, target);
  for (const id of ids) {
    const resolved = await resolveEmailForContactMemberId(id);
    const email = resolved?.trim().toLowerCase();
    if (email?.includes("@")) {
      return { email, displayName: entry?.displayName ?? email };
    }
  }
  return null;
}

function sponsorDealDocumentsUrl(dealId: string): string {
  const origin = (
    process.env.FRONTEND_URL?.trim() ||
    process.env.BASE_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  if (!origin) return "";
  return `${origin}/deals/${encodeURIComponent(dealId)}?tab=documents`;
}

/** Email the lead sponsor from SyndicationX when they can sign now. */
export async function notifySponsorDocumentsReadyToSign(params: {
  dealId: string;
  sponsorEmail: string;
  sponsorName: string;
  dealName: string;
  documentNames: string[];
}): Promise<void> {
  const result = await sendStageEmail({
    toEmail: params.sponsorEmail,
    recipientDisplayName: params.sponsorName,
    dealName: params.dealName,
    documentNames: params.documentNames,
    portalDealUrl: sponsorDealDocumentsUrl(params.dealId),
    stage: "sponsor_turn_to_sign",
  });
  if (!result.ok) {
    console.warn("notifySponsorDocumentsReadyToSign:", result.error);
  }
}

/** Notify this investor's deal-associated sponsor when the investor signs. */
export async function notifySponsorsOfInvestorEsignSigned(params: {
  dealId: string;
  target: InvestorEsignRowTarget;
  signatureRequestId: string;
}): Promise<void> {
  const dealId = params.dealId.trim();
  const sigId = params.signatureRequestId.trim();
  if (!dealId || !sigId) return;

  const raw = await readInvestorEsignStatusJson(dealId, params.target);
  const bundle = parseEsignStatusBundle(raw);
  const send = bundle
    ? findEsignSendBySignatureRequestId(bundle, sigId)
    : null;
  if (!send?.signedAt?.trim()) return;
  if (send.sponsorNotifiedAtInvestorSigned?.trim()) return;

  const deal = await getAddDealFormById(dealId);
  const dealName = deal?.dealName?.trim() || "Deal";
  const queue = await listDealEsignInvestorQueue(dealId);
  const entry = queue.find(
    (e) =>
      e.target.table === params.target.table &&
      e.target.id === params.target.id,
  );
  const investorName = entry?.displayName?.trim() || "Investor";
  const docNames = documentNamesFromSend(send);

  const audienceIds = await resolveInvestorDocumentAudienceIds(
    dealId,
    params.target,
  );
  const portalUrl = sponsorDealDocumentsUrl(dealId);
  const notify = new Map<string, string>();
  try {
    const doc = await getSignFlowDocument(sigId);
    const audience = signFlowPendingSponsorSignAudience(doc);
    if (audience.openToAnySponsor) {
      const sponsors = await listDealSponsorSignerOptions(dealId);
      for (const sponsor of sponsors) {
        notify.set(sponsor.email, sponsor.name);
      }
    }
    for (const email of audience.namedEmails) {
      if (!notify.has(email)) notify.set(email, email);
    }
  } catch (err) {
    console.warn("notifySponsorsOfInvestorEsignSigned audience:", err);
  }
  if (notify.size === 0) {
    const sponsor = await resolveDealInvestorAssociatedSponsor({
      dealId,
      contactId: audienceIds[0] ?? params.target.id,
      investmentId: params.target.id,
      investorEmail: entry?.email,
    });
    if (sponsor?.email) notify.set(sponsor.email, sponsor.name);
  }
  if (notify.size === 0) return;
  let notified = false;
  for (const [toEmail, recipientDisplayName] of notify) {
    const result = await sendStageEmail({
      toEmail,
      recipientDisplayName,
      dealName,
      documentNames: docNames,
      investorDisplayName: investorName,
      portalDealUrl: portalUrl,
      stage: "investor_signed",
    });
    if (result.ok) notified = true;
    else console.warn("notifySponsorsOfInvestorEsignSigned:", result.error);
  }
  if (notified) {
    await updateDealInvestorEsignSend(dealId, params.target, sigId, (current) => ({
      ...current,
      sponsorNotifiedAtInvestorSigned: new Date().toISOString(),
    }));
  }
}

/** Notify investor when sponsor counter-signs their document. */
export async function notifyInvestorOfSponsorEsignSigned(params: {
  dealId: string;
  target: InvestorEsignRowTarget;
  signatureRequestId: string;
}): Promise<void> {
  const dealId = params.dealId.trim();
  const sigId = params.signatureRequestId.trim();
  if (!dealId || !sigId) return;

  const raw = await readInvestorEsignStatusJson(dealId, params.target);
  const bundle = parseEsignStatusBundle(raw);
  const send = bundle
    ? findEsignSendBySignatureRequestId(bundle, sigId)
    : null;
  if (!send?.completedAt?.trim()) return;
  if (send.investorNotifiedAtSponsorSigned?.trim()) return;

  const investor = await resolveInvestorEmailForTarget(dealId, params.target);
  if (!investor?.email) return;

  const deal = await getAddDealFormById(dealId);
  const dealName = deal?.dealName?.trim() || "Deal";
  const portalUrl =
    (await buildDealMemberInviteLandingUrl(dealId, investor.email)) || "";
  const docNames = documentNamesFromSend(send);

  const result = await sendStageEmail({
    toEmail: investor.email,
    recipientDisplayName: investor.displayName,
    dealName,
    documentNames: docNames,
    portalDealUrl: portalUrl,
    stage: "sponsor_signed",
  });

  if (result.ok) {
    await updateDealInvestorEsignSend(dealId, params.target, sigId, (current) => ({
      ...current,
      investorNotifiedAtSponsorSigned: new Date().toISOString(),
    }));
  } else {
    console.warn("notifyInvestorOfSponsorEsignSigned:", result.error);
  }
}

/**
 * No investor-to-investor queue. Each investor can sign as soon as their
 * document is sent; the original send email is the invitation to sign.
 */
export async function notifySequentialInvestorsSignTurnAvailable(
  _dealId: string,
): Promise<void> {
  return;
}

/** Run stage notifications after esign sync for one target. */
export async function runEsignStageNotificationsForTarget(
  dealId: string,
  target: InvestorEsignRowTarget,
): Promise<void> {
  const raw = await readInvestorEsignStatusJson(dealId, target);
  const bundle = parseEsignStatusBundle(raw);
  if (!bundle?.sends.length) return;

  for (const send of bundle.sends) {
    const sigId = send.signatureRequestId?.trim();
    if (!sigId) continue;
    if (send.signedAt?.trim() && !send.sponsorNotifiedAtInvestorSigned?.trim()) {
      await notifySponsorsOfInvestorEsignSigned({
        dealId,
        target,
        signatureRequestId: sigId,
      });
    }
    if (
      send.completedAt?.trim() &&
      !send.investorNotifiedAtSponsorSigned?.trim()
    ) {
      await notifyInvestorOfSponsorEsignSigned({
        dealId,
        target,
        signatureRequestId: sigId,
      });
    }
  }

  await notifySequentialInvestorsSignTurnAvailable(dealId);
}

export async function resolveEsignTargetFromInvestorRowId(
  dealId: string,
  investorRowId: string,
): Promise<InvestorEsignRowTarget | null> {
  return resolveEsignTargetForInvestorRowId(dealId, investorRowId);
}
