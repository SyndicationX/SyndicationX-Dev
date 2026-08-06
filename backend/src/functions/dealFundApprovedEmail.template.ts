import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
  SX_EMAIL_PRIMARY,
} from "./emailSyndicationXLayout.js";

export interface DealFundApprovedTemplateVars {
  dealName: string;
  investorDisplayName: string;
  investorEmail: string;
  portalDealUrl: string;
  senderBrand: string;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDealFundApprovedEmailText(
  v: DealFundApprovedTemplateVars,
): string {
  const lines = [
    `Fund approved — ${v.dealName} · SyndicationX`,
    "",
    v.investorDisplayName ? `Hello ${v.investorDisplayName},` : "Hello,",
    "",
    `The sponsor has approved the fund for your investment in ${v.dealName}.`,
    v.portalDealUrl
      ? `View the deal on SyndicationX: ${v.portalDealUrl}`
      : "Sign in to SyndicationX to view details.",
    "",
    `This message was sent to: ${v.investorEmail}`,
    "",
    `— ${v.senderBrand}`,
  ];
  return lines.join("\n");
}

export function buildDealFundApprovedEmailHtml(
  v: DealFundApprovedTemplateVars,
): string {
  const deal = escHtml(v.dealName);
  const name = escHtml(v.investorDisplayName || "there");
  const email = escHtml(v.investorEmail);
  const brand = escHtml(v.senderBrand);
  const url = v.portalDealUrl;
  const href = escHtml(url);
  const buttonBlock = url
    ? `<div style="margin:24px 0;">
  <a href="${href}" style="${SX_EMAIL_BUTTON_STYLE}">View deal on SyndicationX</a>
</div>`
    : `<p style="font-size:14px;line-height:1.55;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Sign in to SyndicationX to view this deal.</p>`;

  const header = buildSyndicationXEmailBrandHeaderHtml();
  const footer = buildSyndicationXEmailFooterHtml(brand);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fund approved · SyndicationX</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<div style="max-width:600px;margin:24px auto;padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
  ${header}
  <p style="margin:0 0 6px 0;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Investor update</p>
  <h1 style="color:${SX_EMAIL_PRIMARY};font-size:22px;line-height:1.25;margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">Fund approved</h1>
  <p style="font-size:16px;line-height:1.55;color:#1e293b;margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;">Hello ${name},</p>
  <p style="font-size:16px;line-height:1.55;color:#1e293b;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">The sponsor has approved the fund for your investment in <strong>${deal}</strong>. Open SyndicationX to review documents and next steps.</p>
  ${buttonBlock}
  <p style="font-size:13px;line-height:1.5;color:${SX_EMAIL_MUTED};margin:20px 0 0 0;font-family:Arial,Helvetica,sans-serif;">This message was sent to <strong style="color:#475569;">${email}</strong>.</p>
  ${footer}
</div>
</body>
</html>`;
}
