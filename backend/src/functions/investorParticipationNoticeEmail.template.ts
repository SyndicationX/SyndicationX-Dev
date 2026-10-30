import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  buildSyndicationXEmailSignatureText,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
} from "./emailSyndicationXLayout.js";

export type InvestorParticipationNoticeAction =
  | "archive_deal"
  | "delete_deal"
  | "archive_profile"
  | "delete_profile";

export interface InvestorParticipationNoticeVars {
  action: InvestorParticipationNoticeAction;
  dealName: string;
  investorDisplayName: string;
  investorEmail: string;
  sponsorDisplayName: string;
  profileName: string;
  reason: string;
  portalUrl: string;
  senderBrand: string;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function actionCopy(v: InvestorParticipationNoticeVars): {
  subject: string;
  heading: string;
  messageText: string;
  messageHtml: string;
} {
  const investor = v.investorDisplayName || "An investor";
  const deal = v.dealName || "a deal";
  const profile = v.profileName.trim();
  switch (v.action) {
    case "archive_deal":
      return {
        subject: `Investor archived a deal — ${deal}`,
        heading: "Investor archived a deal",
        messageText: `${investor} archived ${deal} in their investing list. The commitment is still on the deal.`,
        messageHtml: `<strong>${escHtml(investor)}</strong> archived <strong>${escHtml(deal)}</strong> in their investing list. The commitment is still on the deal.`,
      };
    case "delete_deal":
      return {
        subject: `Investor removed a soft commitment — ${deal}`,
        heading: "Soft commitment removed",
        messageText: `${investor} removed their soft commitment on ${deal}. It has been removed from the deal.`,
        messageHtml: `<strong>${escHtml(investor)}</strong> removed their soft commitment on <strong>${escHtml(deal)}</strong>. It has been removed from the deal.`,
      };
    case "archive_profile":
      return {
        subject: `Investor archived a profile — ${deal}`,
        heading: "Investor archived a profile",
        messageText: `${investor} archived ${profile || "a profile"} on ${deal}. That commitment is no longer on the deal unless they restore the profile.`,
        messageHtml: `<strong>${escHtml(investor)}</strong> archived <strong>${escHtml(profile || "a profile")}</strong> on <strong>${escHtml(deal)}</strong>. That commitment is no longer on the deal unless they restore the profile.`,
      };
    case "delete_profile":
      return {
        subject: `Investor removed a profile commitment — ${deal}`,
        heading: "Profile commitment removed",
        messageText: `${investor} removed their soft commitment for ${profile || "a profile"} on ${deal}. That profile commitment has been removed from the deal.`,
        messageHtml: `<strong>${escHtml(investor)}</strong> removed their soft commitment for <strong>${escHtml(profile || "a profile")}</strong> on <strong>${escHtml(deal)}</strong>. That profile commitment has been removed from the deal.`,
      };
  }
}

function page(title: string, inner: string, brand: string): string {
  const header = buildSyndicationXEmailBrandHeaderHtml();
  const footer = buildSyndicationXEmailFooterHtml(escHtml(brand));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;">
  ${header}
  ${inner}
  ${footer}
</div>
</body>
</html>`;
}

export function buildInvestorParticipationNoticeText(
  v: InvestorParticipationNoticeVars,
): string {
  const copy = actionCopy(v);
  const lines = [
    `${copy.heading} · SyndicationX`,
    "",
    v.sponsorDisplayName ? `Hello ${v.sponsorDisplayName},` : "Hello,",
    "",
    copy.messageText,
    "",
    `Deal: ${v.dealName}`,
    `Investor: ${v.investorDisplayName}`,
    `Investor email: ${v.investorEmail}`,
  ];
  if (v.profileName.trim()) lines.push(`Profile: ${v.profileName.trim()}`);
  if (v.reason.trim()) lines.push(`Reason: ${v.reason.trim()}`);
  lines.push(
    "",
    v.portalUrl
      ? `Open the deal: ${v.portalUrl}`
      : "Sign in to SyndicationX to review this deal.",
    "",
    buildSyndicationXEmailSignatureText({ companyName: v.senderBrand }),
  );
  return lines.join("\n");
}

export function buildInvestorParticipationNoticeHtml(
  v: InvestorParticipationNoticeVars,
): string {
  const copy = actionCopy(v);
  const sponsor = escHtml(v.sponsorDisplayName || "there");
  const reason = v.reason.trim()
    ? `<p style="font-size:14px;line-height:1.6;color:#111827;margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;"><span style="color:${SX_EMAIL_MUTED};">Reason:</span> ${escHtml(v.reason.trim())}</p>`
    : "";
  const profile = v.profileName.trim()
    ? `<p style="font-size:14px;line-height:1.6;color:#111827;margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;"><span style="color:${SX_EMAIL_MUTED};">Profile:</span> <strong>${escHtml(v.profileName.trim())}</strong></p>`
    : "";
  const button = v.portalUrl
    ? `<div style="margin:24px 0;"><a href="${escHtml(v.portalUrl)}" style="${SX_EMAIL_BUTTON_STYLE}">Open the deal</a></div>`
    : `<p style="font-size:14px;line-height:1.6;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Sign in to SyndicationX to review this deal.</p>`;
  const inner = `
  <h1 style="color:#111827;font-size:26px;line-height:1.25;margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">${escHtml(copy.heading)}</h1>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;">Hello ${sponsor},</p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">${copy.messageHtml}</p>
  <p style="font-size:14px;line-height:1.6;color:#111827;margin:8px 0 0 0;font-family:Arial,Helvetica,sans-serif;"><span style="color:${SX_EMAIL_MUTED};">Investor:</span> <strong>${escHtml(v.investorDisplayName)}</strong> (${escHtml(v.investorEmail)})</p>
  ${profile}
  ${reason}
  ${button}`;
  return page(`${copy.heading} · SyndicationX`, inner, v.senderBrand);
}

export function investorParticipationNoticeSubject(
  v: InvestorParticipationNoticeVars,
): string {
  return actionCopy(v).subject;
}
