import emailConfig, {
  outgoingMailCcBcc,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import {
  buildDealFundApprovedEmailHtml,
  buildDealFundApprovedSponsorEmailHtml,
  buildDealFundApprovedSponsorEmailText,
  buildDealFundApprovedEmailText,
} from "../../functions/dealFundApprovedEmail.template.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { resolveDealInvestorAssociatedSponsor } from "./dealInvestorAssociatedSponsor.service.js";
import { buildDealMemberInviteLandingUrl } from "./dealMemberInviteToken.service.js";
import { resolveEmailForContactMemberId } from "./dealMemberInvitationEmail.service.js";

const SENDER_DISPLAY_NAME =
  process.env.SENDER_DISPLAY_NAME?.trim() || "SyndicationX";

function defaultSubject(dealName: string): string {
  const custom = process.env.DEAL_FUND_APPROVED_SUBJECT?.trim();
  if (custom) return custom.replace(/\{dealName\}/g, dealName);
  return `Fund approved for ${dealName}`;
}

async function sendFundedMail(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const fromAddress = process.env.SENDER_EMAIL_ID?.trim() || "";
  if (!fromAddress) {
    console.warn("sendDealFundApprovedNotification: SENDER_EMAIL_ID not set");
    return;
  }
  const transporter = emailConfig();
  const ccBcc = outgoingMailCcBcc();
  await transporter.sendMail({
    from: { name: SENDER_DISPLAY_NAME, address: fromAddress },
    to: input.to,
    ...ccBcc,
    envelope: smtpEnvelopeForSendMail({
      fromAddress,
      to: input.to,
      cc: ccBcc.cc,
      bcc: ccBcc.bcc,
    }),
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

export async function sendDealFundApprovedNotification(input: {
  dealId: string
  contactId: string
  contactDisplayName: string
}): Promise<void> {
  const dealId = input.dealId.trim();
  const contactId = input.contactId.trim();
  if (!dealId || !contactId) return;

  const to = await resolveEmailForContactMemberId(contactId);
  if (!to) {
    console.warn(
      "sendDealFundApprovedNotification: no email for contact",
      contactId,
    );
    return;
  }

  const deal = await getAddDealFormById(dealId);
  const dealName = deal?.dealName?.trim() || "this deal";
  const investorDisplayName = input.contactDisplayName.trim();
  const portalUrl =
    (await buildDealMemberInviteLandingUrl(dealId, to)) || "";

  try {
    const vars = {
      dealName,
      investorDisplayName,
      investorEmail: to,
      portalDealUrl: portalUrl,
      senderBrand: SENDER_DISPLAY_NAME,
    };

    await sendFundedMail({
      to,
      subject: defaultSubject(dealName),
      text: buildDealFundApprovedEmailText(vars),
      html: buildDealFundApprovedEmailHtml(vars),
    });
  } catch (error: unknown) {
    console.warn("sendDealFundApprovedNotification: investor send failed", error);
  }

  try {
    const sponsor = await resolveDealInvestorAssociatedSponsor({
      dealId,
      contactId,
      investorEmail: to,
    });
    if (!sponsor) {
      console.warn(
        "sendDealFundApprovedNotification: no sponsor email for contact",
        contactId,
      );
      return;
    }
    const sponsorPortalUrl =
      (await buildDealMemberInviteLandingUrl(dealId, sponsor.email)) ||
      portalUrl;
    const sponsorVars = {
      dealName,
      investorDisplayName,
      investorEmail: to,
      sponsorDisplayName: sponsor.name,
      portalDealUrl: sponsorPortalUrl,
      senderBrand: SENDER_DISPLAY_NAME,
    };
    await sendFundedMail({
      to: sponsor.email,
      subject: `Investor funded — ${dealName}`,
      text: buildDealFundApprovedSponsorEmailText(sponsorVars),
      html: buildDealFundApprovedSponsorEmailHtml(sponsorVars),
    });
  } catch (error: unknown) {
    console.warn("sendDealFundApprovedNotification: sponsor send failed", error);
  }
}
