import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
  SX_EMAIL_PRIMARY,
} from "./emailSyndicationXLayout.js";

export interface DealEsignStageNotificationTemplateVars {
  dealName: string;
  recipientDisplayName: string;
  recipientEmail: string;
  documentNames: string[];
  investorDisplayName?: string;
  senderBrand: string;
  portalDealUrl?: string;
  stage: "investor_signed" | "sponsor_signed" | "investor_turn_to_sign";
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

function stageSubject(v: DealEsignStageNotificationTemplateVars): string {
  const deal = v.dealName.trim() || "Deal";
  if (v.stage === "investor_signed") {
    return `Investor signed eSign documents — ${deal}`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `Your documents are ready to sign — ${deal}`;
  }
  return `Your signed documents are ready — ${deal}`;
}

function stageLeadHtml(v: DealEsignStageNotificationTemplateVars): string {
  const deal = escHtml(v.dealName.trim() || "this deal");
  const investor = escHtml(v.investorDisplayName?.trim() || "An investor");
  if (v.stage === "investor_signed") {
    return `<p style="margin:0 0 16px;"><strong>${investor}</strong> completed their investor signature on <strong>${deal}</strong>. Review and counter-sign in the deal Documents tab when all investors have signed (sequential workflow).</p>`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `<p style="margin:0 0 16px;">Your e-sign documents for <strong>${deal}</strong> are ready for your signature. Sign in to the investor portal to complete your subscription documents.</p>`;
  }
  return `<p style="margin:0 0 16px;">Your sponsor counter-signed your eSign documents for <strong>${deal}</strong>. The fully executed documents are now available in your offering documents.</p>`;
}

function stageLeadText(v: DealEsignStageNotificationTemplateVars): string {
  const deal = v.dealName.trim() || "this deal";
  const investor = v.investorDisplayName?.trim() || "An investor";
  if (v.stage === "investor_signed") {
    return `${investor} completed their investor signature on ${deal}. Review and counter-sign in the deal Documents tab when all investors have signed (sequential workflow).`;
  }
  if (v.stage === "investor_turn_to_sign") {
    return `Your e-sign documents for ${deal} are ready for your signature. Sign in to the investor portal to complete your subscription documents.`;
  }
  return `Your sponsor counter-signed your eSign documents for ${deal}. The fully executed documents are now available in your offering documents.`;
}

export function buildDealEsignStageNotificationEmailHtml(
  v: DealEsignStageNotificationTemplateVars,
): string {
  const name = v.recipientDisplayName.trim() || "there";
  const brandPlain = v.senderBrand.trim() || "SyndicationX";
  const brand = escHtml(brandPlain);
  const portalUrl = escHtml(v.portalDealUrl?.trim() ?? "");
  const cta = portalUrl
    ? `<p style="margin:24px 0 0;text-align:center;">
         <a href="${portalUrl}" style="${SX_EMAIL_BUTTON_STYLE}">Open deal</a>
       </p>`
    : "";
  const docsBlock = documentListHtml(v.documentNames);

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Inter,Segoe UI,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:32px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;">
        ${buildSyndicationXEmailBrandHeaderHtml()}
        <tr><td style="padding:28px 32px;color:${SX_EMAIL_PRIMARY};font-size:15px;line-height:1.55;">
          <p style="margin:0 0 16px;">Hi ${escHtml(name)},</p>
          ${stageLeadHtml(v)}
          ${docsBlock}
          ${cta}
          <p style="margin:24px 0 0;font-size:13px;color:${SX_EMAIL_MUTED};">
            This message was sent to ${escHtml(v.recipientEmail.trim())}.
          </p>
        </td></tr>
        ${buildSyndicationXEmailFooterHtml(brandPlain)}
      </table>
    </td></tr>
  </table>
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
    `— ${v.senderBrand.trim() || "SyndicationX"}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export { stageSubject as dealEsignStageNotificationSubject };
