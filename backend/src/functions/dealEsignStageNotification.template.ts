import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  buildSyndicationXEmailSignatureText,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
} from "./emailSyndicationXLayout.js";

export interface DealEsignStageNotificationTemplateVars {
  dealName: string;
  recipientDisplayName: string;
  recipientEmail: string;
  documentNames: string[];
  investorDisplayName?: string;
  senderBrand: string;
  portalDealUrl?: string;
  stage:
    | "investor_signed"
    | "sponsor_signed"
    | "investor_turn_to_sign"
    | "sponsor_turn_to_sign";
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function documentListHtml(names: string[]): string {
  if (names.length === 0) return "";
  const items = names
    .map((n) => `<li style="margin:0 0 6px;">${escHtml(n)}</li>`)
    .join("");
  return `<ul style="margin:8px 0 0;padding-left:20px;">${items}</ul>`;
}

function documentListText(names: string[]): string {
  if (names.length === 0) return "";
  return names.map((n) => `• ${n}`).join("\n");
}

function documentTitleFrom(v: DealEsignStageNotificationTemplateVars): string {
  const names = v.documentNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 1) return names[0]!;
  if (names.length > 1) return names.join(", ");
  return v.dealName.trim() || "Document";
}

function stageSubject(v: DealEsignStageNotificationTemplateVars): string {
  const deal = v.dealName.trim() || "Deal";
  if (v.stage === "investor_signed") {
    const investor = v.investorDisplayName?.trim() || "Investor";
    return `${investor} signed — please counter-sign: ${documentTitleFrom(v)}`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `Your documents are ready to sign — ${deal}`;
  }
  if (v.stage === "sponsor_turn_to_sign") {
    return `Documents are ready for your signature — ${deal}`;
  }
  return `Your signed documents are ready — ${deal}`;
}

function stageHeadline(v: DealEsignStageNotificationTemplateVars): string {
  if (v.stage === "investor_signed") return "Investor signature completed";
  if (v.stage === "investor_turn_to_sign") return "Your documents are ready to sign";
  if (v.stage === "sponsor_turn_to_sign") return "Documents are ready for your signature";
  return "Your signed documents are ready";
}

function stageLeadHtml(v: DealEsignStageNotificationTemplateVars): string {
  const deal = escHtml(v.dealName.trim() || "this deal");
  const investor = escHtml(v.investorDisplayName?.trim() || "An investor");
  if (v.stage === "investor_signed") {
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111827;"><strong>${investor}</strong> completed their investor signature on <strong>${deal}</strong>. Review and counter-sign their document in the deal Documents tab.</p>`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111827;">Your e-sign documents for <strong>${deal}</strong> are ready for your signature. Sign in to the investor portal to complete your subscription documents.</p>`;
  }
  if (v.stage === "sponsor_turn_to_sign") {
    return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111827;">eSign documents for <strong>${deal}</strong> are ready for your signature. Open the deal in SyndicationX and sign from the Documents tab.</p>`;
  }
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#111827;">Your sponsor counter-signed your eSign documents for <strong>${deal}</strong>. The fully executed documents are now available in your offering documents.</p>`;
}

function stageLeadText(v: DealEsignStageNotificationTemplateVars): string {
  const deal = v.dealName.trim() || "this deal";
  const investor = v.investorDisplayName?.trim() || "An investor";
  if (v.stage === "investor_signed") {
    return `${investor} completed their investor signature on ${deal}. Review and counter-sign their document in the deal Documents tab.`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `Your e-sign documents for ${deal} are ready for your signature. Sign in to the investor portal to complete your subscription documents.`;
  }
  if (v.stage === "sponsor_turn_to_sign") {
    return `eSign documents for ${deal} are ready for your signature. Open the deal in SyndicationX and sign from the Documents tab.`;
  }
  return `Your sponsor counter-signed your eSign documents for ${deal}. The fully executed documents are now available in your offering documents.`;
}

export function buildDealEsignStageNotificationEmailHtml(
  v: DealEsignStageNotificationTemplateVars,
): string {
  const name = v.recipientDisplayName.trim() || "there";
  const brandPlain = v.senderBrand.trim() || "SyndicationX";
  const portalUrl = escHtml(v.portalDealUrl?.trim() ?? "");
  const cta = portalUrl
    ? `<div style="margin:24px 0;">
         <a href="${portalUrl}" style="${SX_EMAIL_BUTTON_STYLE}">Open deal</a>
       </div>`
    : "";
  const docsBlock = documentListHtml(v.documentNames);

  /*
  // PREVIOUS nested-table card chrome retained for reference — replaced with outreach-style layout
  */

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(stageSubject(v))}</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#111827;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px;">
  ${buildSyndicationXEmailBrandHeaderHtml()}
  <h1 style="color:#111827;font-size:26px;line-height:1.25;margin:0 0 18px 0;font-weight:700;">${escHtml(stageHeadline(v))}</h1>
  <p style="margin:0 0 12px;font-size:16px;line-height:1.6;">Hi ${escHtml(name)},</p>
  ${stageLeadHtml(v)}
  ${docsBlock}
  ${cta}
  <p style="margin:20px 0 0;font-size:13px;color:${SX_EMAIL_MUTED};">
    This message was sent to ${escHtml(v.recipientEmail.trim())}.
  </p>
  ${buildSyndicationXEmailFooterHtml(brandPlain)}
</div>
</body>
</html>`;
}

export function buildDealEsignStageNotificationEmailText(
  v: DealEsignStageNotificationTemplateVars,
): string {
  const name = v.recipientDisplayName.trim() || "there";
  const lines = [
    `${stageSubject(v)} · ${v.senderBrand.trim() || "SyndicationX"}`,
    "",
    `Hi ${name},`,
    "",
    stageLeadText(v),
    "",
    documentListText(v.documentNames),
    "",
    v.portalDealUrl?.trim() ? `Open deal: ${v.portalDealUrl.trim()}` : "",
    "",
    buildSyndicationXEmailSignatureText({
      companyName: v.senderBrand.trim() || "SyndicationX",
    }),
  ].filter(Boolean);
  return lines.join("\n");
}

export { stageSubject as dealEsignStageNotificationSubject };
