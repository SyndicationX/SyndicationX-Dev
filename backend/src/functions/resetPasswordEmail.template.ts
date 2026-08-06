import {
  buildSyndicationXEmailAuthFooterHtml,
  buildSyndicationXEmailBrandHeaderHtml,
  SX_EMAIL_BUTTON_STYLE,
  SX_EMAIL_MUTED,
  SX_EMAIL_PAGE_BG,
  SX_EMAIL_PRIMARY,
} from "./emailSyndicationXLayout.js";

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** HTML body for the password-reset email (inline styles for common clients). */
export function buildResetPasswordEmailHtml(resetLink: string): string {
  const safeHref = escAttr(resetLink);
  const header = buildSyndicationXEmailBrandHeaderHtml();
  const authFooter = buildSyndicationXEmailAuthFooterHtml();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset password · SyndicationX</title>
</head>
<body style="margin:0;padding:0;background:${SX_EMAIL_PAGE_BG};font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
<div style="max-width:600px;margin:24px auto;padding:32px 28px;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
  ${header}
  <p style="margin:0 0 6px 0;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${SX_EMAIL_MUTED};font-family:Arial,Helvetica,sans-serif;">Account security</p>
  <h1 style="color:${SX_EMAIL_PRIMARY};font-size:22px;line-height:1.25;margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-weight:700;">Reset your password</h1>
  <p style="font-size:16px;line-height:1.55;color:#1e293b;margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;">We received a request to reset the password for your SyndicationX account. Use the button below to choose a new password.</p>
  <div style="margin:24px 0;">
    <a href="${safeHref}" style="${SX_EMAIL_BUTTON_STYLE}">Reset password</a>
  </div>
  <p style="font-size:15px;line-height:1.55;color:#475569;margin:0;font-family:Arial,Helvetica,sans-serif;">This link expires in <strong>1 hour</strong>. If you didn’t ask for this, you can safely ignore this email.</p>
  ${authFooter}
</div>
</body>
</html>`;
}
