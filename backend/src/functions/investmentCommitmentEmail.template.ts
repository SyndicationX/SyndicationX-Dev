import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  buildSyndicationXEmailSignatureText,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
} from "./emailSyndicationXLayout.js";

export interface InvestmentCommitmentEmailVars {
  dealName: string;
  investorDisplayName: string;
  investorEmail: string;
  sponsorDisplayName: string;
  commitmentAmount: string;
  commitmentDate: string;
  portalUrl: string;
  senderBrand: string;
  commitmentKind?: "completed" | "soft";
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function detailLines(v: InvestmentCommitmentEmailVars): string[] {
  return [
    `Deal: ${v.dealName}`,
    `Investor: ${v.investorDisplayName}`,
    `Investor email: ${v.investorEmail}`,
    `Commitment amount: ${v.commitmentAmount}`,
    `Commitment date: ${v.commitmentDate}`,
  ];
}

function detailHtml(v: InvestmentCommitmentEmailVars): string {
  const rows = [
    ["Deal", v.dealName],
    ["Investor", v.investorDisplayName],
    ["Investor email", v.investorEmail],
    ["Commitment amount", v.commitmentAmount],
    ["Commitment date", v.commitmentDate],
  ];
  const body = rows
    .map(
      ([label, value]) =>
        `<tr>
  <td style="padding:6px 12px 6px 0;font-size:14px;line-height:1.5;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;vertical-align:top;">${escHtml(label)}</td>
  <td style="padding:6px 0;font-size:14px;line-height:1.5;color:#111827;font-family:Arial,Helvetica,sans-serif;font-weight:600;">${escHtml(value)}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 8px 0;border-collapse:collapse;">${body}</table>`;
}

function buttonBlock(url: string, label: string): string {
  if (!url) {
    return `<p style="font-size:14px;line-height:1.6;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Sign in to SyndicationX to view this investment.</p>`;
  }
  return `<div style="margin:24px 0;">
  <a href="${escHtml(url)}" style="${SX_EMAIL_BUTTON_STYLE}">${escHtml(label)}</a>
</div>`;
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

export function buildInvestmentCommitmentInvestorEmailText(
  v: InvestmentCommitmentEmailVars,
): string {
  const isSoft = v.commitmentKind === "soft";
  return [
    `${isSoft ? "Soft investment commitment saved" : "Investment commitment confirmed"} — ${v.dealName} · SyndicationX`,
    "",
    v.investorDisplayName ? `Hello ${v.investorDisplayName},` : "Hello,",
    "",
    isSoft
      ? `Your soft investment commitment for ${v.dealName} has been saved. Your sponsor has also been notified.`
      : `Your investment commitment for ${v.dealName} is confirmed.`,
    "",
    ...detailLines(v),
    "",
    v.portalUrl
      ? `View your investments: ${v.portalUrl}`
      : "Sign in to SyndicationX to view your investments.",
    "",
    `This message was sent to: ${v.investorEmail}`,
    "",
    buildSyndicationXEmailSignatureText({ companyName: v.senderBrand }),
  ].join("\n");
}

export function buildInvestmentCommitmentInvestorEmailHtml(
  v: InvestmentCommitmentEmailVars,
): string {
  const isSoft = v.commitmentKind === "soft";
  const name = escHtml(v.investorDisplayName || "there");
  const deal = escHtml(v.dealName);
  const email = escHtml(v.investorEmail);
  const heading = isSoft
    ? "Soft investment commitment saved"
    : "Investment commitment confirmed";
  const message = isSoft
    ? `Your soft investment commitment for <strong>${deal}</strong> has been saved. Your sponsor has also been notified.`
    : `Your investment commitment for <strong>${deal}</strong> is confirmed.`;
  const inner = `
  <h1 style="color:#111827;font-size:26px;line-height:1.25;margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">${heading}</h1>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;">Hello ${name},</p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">${message}</p>
  ${detailHtml(v)}
  ${buttonBlock(v.portalUrl, "View your investments")}
  <p style="font-size:13px;line-height:1.5;color:${SX_EMAIL_MUTED};margin:20px 0 0 0;font-family:Arial,Helvetica,sans-serif;">This message was sent to <strong style="color:#374151;">${email}</strong>.</p>`;
  return page(`${heading} · SyndicationX`, inner, v.senderBrand);
}

export function buildInvestmentCommitmentSponsorEmailText(
  v: InvestmentCommitmentEmailVars,
): string {
  const isSoft = v.commitmentKind === "soft";
  return [
    `${isSoft ? "Investor soft commitment" : "Investor commitment"} — ${v.dealName} · SyndicationX`,
    "",
    v.sponsorDisplayName ? `Hello ${v.sponsorDisplayName},` : "Hello,",
    "",
    isSoft
      ? `${v.investorDisplayName} has made a soft investment commitment in ${v.dealName}.`
      : `${v.investorDisplayName} has committed to an investment in ${v.dealName}.`,
    "",
    ...detailLines(v),
    "",
    v.portalUrl
      ? `Open the deal: ${v.portalUrl}`
      : "Sign in to SyndicationX to review this commitment.",
    "",
    `This message was sent to the sponsor for ${v.investorDisplayName}.`,
    "",
    buildSyndicationXEmailSignatureText({ companyName: v.senderBrand }),
  ].join("\n");
}

export function buildInvestmentCommitmentSponsorEmailHtml(
  v: InvestmentCommitmentEmailVars,
): string {
  const isSoft = v.commitmentKind === "soft";
  const sponsor = escHtml(v.sponsorDisplayName || "there");
  const investor = escHtml(v.investorDisplayName);
  const deal = escHtml(v.dealName);
  const heading = isSoft
    ? "New soft investment commitment"
    : "New investment commitment";
  const message = isSoft
    ? `<strong>${investor}</strong> has made a soft investment commitment in <strong>${deal}</strong>.`
    : `<strong>${investor}</strong> has committed to an investment in <strong>${deal}</strong>.`;
  const inner = `
  <h1 style="color:#111827;font-size:26px;line-height:1.25;margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">${heading}</h1>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;">Hello ${sponsor},</p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">${message}</p>
  ${detailHtml(v)}
  ${buttonBlock(v.portalUrl, "Open the deal")}`;
  return page(`${heading} · SyndicationX`, inner, v.senderBrand);
}
