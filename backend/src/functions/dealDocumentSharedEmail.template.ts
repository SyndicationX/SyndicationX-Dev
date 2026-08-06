import {
  buildSyndicationXEmailBrandHeaderHtml,
  buildSyndicationXEmailFooterHtml,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
  SX_EMAIL_PRIMARY,
} from "./emailSyndicationXLayout.js";

export interface DealDocumentSharedTemplateVars {
  dealName: string;
  memberDisplayName: string;
  memberEmail: string;
  documentNames: string[];
  senderBrand: string;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function documentListHtml(names: string[]): string {
  if (names.length === 0) {
    return "<p>A document on this deal was shared with you.</p>";
  }
  const items = names
    .map((n) => `<li style="margin:0 0 6px;">${escHtml(n)}</li>`)
    .join("");
  return `<ul style="margin:8px 0 0;padding-left:20px;">${items}</ul>`;
}

function documentListText(names: string[]): string {
  if (names.length === 0) return "A document on this deal was shared with you.";
  return names.map((n) => `• ${n}`).join("\n");
}

export function buildDealDocumentSharedEmailText(
  v: DealDocumentSharedTemplateVars,
): string {
  const lines = [
    `Document shared — ${v.dealName} · SyndicationX`,
    "",
    v.memberDisplayName ? `Hello ${v.memberDisplayName},` : "Hello,",
    "",
    "A document on this deal was shared with you:",
    documentListText(v.documentNames),
    "",
    "Sign in to SyndicationX to view the deal documents.",
    "",
    `This message was sent to: ${v.memberEmail}`,
    "",
    `— ${v.senderBrand}`,
  ];
  return lines.join("\n");
}

export function buildDealDocumentSharedEmailHtml(
  v: DealDocumentSharedTemplateVars,
): string {
  const greeting = v.memberDisplayName
    ? `Hello ${escHtml(v.memberDisplayName)},`
    : "Hello,";
  const deal = escHtml(v.dealName);
  const email = escHtml(v.memberEmail);
  const brand = escHtml(v.senderBrand);
  const brandHeader = buildSyndicationXEmailBrandHeaderHtml();
  const footer = buildSyndicationXEmailFooterHtml(brand);
  const docWord = v.documentNames.length === 1 ? "document" : "documents";
  const verb = v.documentNames.length === 1 ? "was" : "were";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Document shared</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<div style="max-width:600px;margin:24px auto;padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
  ${brandHeader}
  <h1 style="color:${SX_EMAIL_PRIMARY};font-size:22px;line-height:1.25;margin:0 0 18px 0;font-weight:700;">Document shared with you</h1>
  <p style="font-size:16px;line-height:1.55;margin:0 0 12px 0;">${greeting}</p>
  <p style="font-size:15px;line-height:1.55;color:${SX_EMAIL_MUTED};margin:0 0 8px 0;">
    The following ${docWord} on <strong>${deal}</strong> ${verb} shared with you:
  </p>
  ${documentListHtml(v.documentNames)}
  <p style="font-size:14px;line-height:1.5;color:${SX_EMAIL_MUTED};margin:20px 0 0 0;">
    Sign in to SyndicationX to open the deal and view your documents.
  </p>
  <p style="font-size:13px;line-height:1.5;color:${SX_EMAIL_MUTED};margin:20px 0 0 0;">
    This message was sent to <strong style="color:#475569;">${email}</strong>.
  </p>
  ${footer}
</div>
</body>
</html>`;
}
