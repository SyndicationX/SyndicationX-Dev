import type { ContactRow } from "../../schema/contact.schema.js";
import { sendInviteSignupEmail } from "../auth/inviteEmail.service.js";
import { buildInvestorInviteLinkForUser } from "./investorInviteLink.service.js";

export function sendInvitationMailRequested(
  raw: string | null | undefined,
): boolean {
  return String(raw ?? "").trim().toLowerCase() === "yes";
}

export function contactInvitationEmailBlockReason(
  row: Pick<
    ContactRow,
    | "invitationEmailSent"
    | "isPortalUser"
    | "platformAdminOnly"
    | "status"
    | "email"
  >,
): string | null {
  if (Boolean(row.invitationEmailSent)) {
    return "An invitation email has already been sent to this contact";
  }
  if (Boolean(row.isPortalUser) || Boolean(row.platformAdminOnly)) {
    return "This contact already has a portal account";
  }
  if (String(row.status ?? "active").trim().toLowerCase() === "suspended") {
    return "Activate this contact before sending an invitation email";
  }
  const email = String(row.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    return "A valid email is required to send an invitation";
  }
  return null;
}

export function contactCanSendInvitationEmail(
  row: Pick<
    ContactRow,
    | "invitationEmailSent"
    | "isPortalUser"
    | "platformAdminOnly"
    | "status"
    | "email"
  >,
): boolean {
  return contactInvitationEmailBlockReason(row) == null;
}

/**
 * Optional portal signup invitation after creating a CRM contact.
 * Uses the same investor signup link as Invite Investor Link (`/signup?ref=…`),
 * so the person becomes an investor attributed to the sender — not a company member.
 * Does not create a pending `users` row, so the contact stays on All Contacts
 * until they complete signup.
 */
export async function sendContactInvitationEmailIfRequested(params: {
  sendInvitationMail: string;
  email: string;
  invitedByUserId: string;
  skipBecausePortalUser: boolean;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!sendInvitationMailRequested(params.sendInvitationMail)) return "skipped";
  if (params.skipBecausePortalUser) return "skipped";

  const email = params.email.trim().toLowerCase();
  if (!email.includes("@")) return "skipped";

  let inviteUrl = "";
  try {
    const link = await buildInvestorInviteLinkForUser(params.invitedByUserId);
    const baseUrl = link?.inviteUrl?.trim() ?? "";
    if (baseUrl) {
      const url = new URL(baseUrl);
      url.searchParams.set("email", email);
      inviteUrl = url.toString();
    }
  } catch (err) {
    console.warn(
      "sendContactInvitationEmailIfRequested: could not build invite",
      err,
    );
    return "failed";
  }
  if (!inviteUrl) {
    console.warn(
      "sendContactInvitationEmailIfRequested: this account cannot share an investor invite link",
    );
    return "failed";
  }

  const sent = await sendInviteSignupEmail(email, inviteUrl, "", {
    persistentLink: true,
  });
  if (!sent.ok) {
    console.warn(
      "sendContactInvitationEmailIfRequested: send failed",
      sent.error,
    );
    return "failed";
  }
  return "sent";
}
