/**
 * Shared SyndicationX transactional email chrome
 * Outlook / Edge / Gmail compatible version
 */

export const SX_EMAIL_PRIMARY = "#00477a";

/** Primary action button */
export const SX_EMAIL_BUTTON_STYLE = `
  background-color:${SX_EMAIL_PRIMARY};
  color:#ffffff;
  padding:14px 28px;
  border-radius:8px;
  text-decoration:none;
  font-weight:600;
  font-size:15px;
  display:inline-block;
  border:0;
`;

/** Subtle secondary text */
export const SX_EMAIL_MUTED = "#64748b";

/** Card / page background */
export const SX_EMAIL_PAGE_BG = "#f4f6f8";

/**
 * IMPORTANT:
 * Use a stable PUBLIC image URL for emails.
 * Avoid hashed frontend build assets when possible.
 */
const EMAIL_LOGO_PATH =
  "https://syndicationx.com/assets/sx_logo_width_reduced-BOPxOxjB.png";

/**
 * Escape URL for safe HTML attribute usage
 */
function escapeAttrUrl(u: string): string {
  return u
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build logo block
 * Table layout used for Outlook / Edge compatibility
 */
export function buildSyndicationXEmailLogoImgHtml(): string {
  try {
    const override = process.env.EMAIL_LOGO_URL?.trim();

    const src = override || EMAIL_LOGO_PATH;

    console.log("====================================");
    console.log("EMAIL LOGO DEBUG");
    console.log("override =====>", override);
    console.log("EMAIL_LOGO_PATH =====>", EMAIL_LOGO_PATH);
    console.log("final src =====>", src);
    console.log("====================================");

    if (!src) {
      console.log("Logo src missing");
      return "";
    }

    const html = `
<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
>
  <tr>
    <td align="center" style="padding:20px 0 10px 0;">

      <img
        src="${escapeAttrUrl(src)}"
        alt="SyndicationX"
        width="220"
        border="0"
        style="
          display:block;
          width:220px;
          height:auto;
          border:0;
          outline:none;
          text-decoration:none;
        "
      />

    </td>
  </tr>
</table>`;

    console.log("Generated logo HTML =====>");
    console.log(html);

    return html;
  } catch (error) {
    console.error("Error generating email logo HTML =====>", error);
    return "";
  }
}

/**
 * Brand header
 */
export function buildSyndicationXEmailBrandHeaderHtml(): string {
  const html = `
<div
  style="
    margin:0 0 22px 0;
    padding-bottom:18px;
    border-bottom:1px solid #e2e8f0;
  "
>
  <span
    style="
      font-family:Arial,Helvetica,sans-serif;
      font-size:20px;
      font-weight:700;
      color:${SX_EMAIL_PRIMARY};
      letter-spacing:-0.03em;
    "
  >
    SyndicationX
  </span>
</div>`;

  console.log("Brand header HTML =====>");
  console.log(html);

  return html;
}

/**
 * Standard footer
 */
export function buildSyndicationXEmailFooterHtml(
  senderBrandEsc: string
): string {
  const logo = buildSyndicationXEmailLogoImgHtml();

  const html = `
<p
  style="
    font-size:14px;
    line-height:1.5;
    color:${SX_EMAIL_MUTED};
    margin-top:28px;
    padding-top:20px;
    border-top:1px solid #f1f5f9;
    font-family:Arial,Helvetica,sans-serif;
  "
>
  — ${senderBrandEsc}
</p>

${logo}

<p
  style="
    font-size:11px;
    line-height:1.45;
    color:#94a3b8;
    margin:16px 0 0 0;
    font-family:Arial,Helvetica,sans-serif;
    text-align:center;
  "
>
  You received this email because of activity on SyndicationX.
</p>`;

  console.log("Footer HTML =====>");
  console.log(html);

  return html;
}

/**
 * Auth footer
 */
export function buildSyndicationXEmailAuthFooterHtml(): string {
  const logo = buildSyndicationXEmailLogoImgHtml();

  const html = `
<p
  style="
    font-size:16px;
    line-height:1.5;
    color:#1e293b;
    margin-top:28px;
    padding-top:20px;
    border-top:1px solid #f1f5f9;
    font-family:Arial,Helvetica,sans-serif;
  "
>
  Thanks,
  <br />

  <span
    style="
      color:#475569;
      font-weight:600;
    "
  >
    The SyndicationX team
  </span>
</p>

${logo}

<p
  style="
    font-size:11px;
    line-height:1.45;
    color:#94a3b8;
    margin:16px 0 0 0;
    font-family:Arial,Helvetica,sans-serif;
    text-align:center;
  "
>
  © 2026 SyndicationX · All rights reserved
</p>`;

  console.log("Auth footer HTML =====>");
  console.log(html);

  return html;
}