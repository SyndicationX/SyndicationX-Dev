import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  buildSyndicationXEmailSignatureText,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
} from "./emailSyndicationXLayout.js";

export interface DealBillingStartAlertTemplateVars {
  dealName: string;
  billingStartDisplay: string;
  portalBillingUrl: string;
  senderBrand: string;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildDealBillingStartAlertEmailText(
  v: DealBillingStartAlertTemplateVars,
): string {
  const lines = [
    `Billing start date for ${v.dealName} · SyndicationX`,
    "",
    "Hello,",
    "",
    `${v.dealName} is complimentary until ${v.billingStartDisplay}.`,
    "After that date, SaaS billing is due so the deal stays open to view and edit.",
    v.portalBillingUrl
      ? `Review billing: ${v.portalBillingUrl}`
      : "Sign in to SyndicationX → Settings → Billing to review this deal.",
    "",
    buildSyndicationXEmailSignatureText({ companyName: v.senderBrand }),
  ];
  return lines.join("\n");
}

export function buildDealBillingStartAlertEmailHtml(
  v: DealBillingStartAlertTemplateVars,
): string {
  const deal = escHtml(v.dealName);
  const start = escHtml(v.billingStartDisplay);
  const brand = escHtml(v.senderBrand);
  const url = v.portalBillingUrl;
  const href = escHtml(url);
  const buttonBlock = url
    ? `<div style="margin:24px 0;">
  <a href="${href}" style="${SX_EMAIL_BUTTON_STYLE}">Review billing</a>
</div>`
    : `<p style="font-size:14px;line-height:1.6;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Sign in to SyndicationX, open Settings → Billing, and review this deal.</p>`;

  const header = buildSyndicationXEmailBrandHeaderHtml();
  const footer = buildSyndicationXEmailFooterHtml(brand);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Billing start date · SyndicationX</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;">
  ${header}
  <h1 style="color:#111827;font-size:26px;line-height:1.25;margin:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">Billing start date set</h1>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;"><strong>${deal}</strong> is complimentary until <strong>${start}</strong>.</p>
  <p style="font-size:16px;line-height:1.6;color:#111827;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">After that date, SaaS billing is due so the deal stays open to view and edit.</p>
  ${buttonBlock}
  ${footer}
</div>
</body>
</html>`;
}
