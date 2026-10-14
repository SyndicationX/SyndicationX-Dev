import { eq, sql } from "drizzle-orm";
import emailConfig, {
  outgoingMailCcBcc,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import {
  type DealInvitationSource,
  buildDealMemberInvitationEmailHtml,
  buildDealMemberInvitationEmailText,
} from "../../functions/dealMemberInvitationEmail.template.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { contact } from "../../schema/contact.schema.js";
import { getAddDealFormById } from "./dealForm.service.js";
import { buildDealMemberInviteLandingUrl } from "./dealMemberInviteToken.service.js";

const SENDER_DISPLAY_NAME =
  process.env.SENDER_DISPLAY_NAME?.trim() || "SyndicationX";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultSubject(
  dealName: string,
  source: DealInvitationSource,
  dealMemberRoleLabel: string,
  accountExists: boolean,
): string {
  const custom = process.env.DEAL_MEMBER_INVITE_SUBJECT?.trim();
  if (custom) return custom.replace(/\{dealName\}/g, dealName);
  if (accountExists && source !== "investor") {
    const r = dealMemberRoleLabel.trim();
    if (r && r !== "—") {
      return `You were added to ${dealName} as ${r} — sign in`;
    }
    return `You were added to ${dealName} — sign in`;
  }
  if (source === "investor") {
    return `You're invited to ${dealName} as an investor`;
  }
  const r = dealMemberRoleLabel.trim();
  if (r && r !== "—") {
    return `You're invited to ${dealName} — ${r}`;
  }
  return `You're invited to ${dealName} (deal team)`;
}

/**
 * Resolves an email for a `contact_id` / portal user id stored on `deal_investment`.
 */
function normalizeRecipientEmail(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim().toLowerCase();
  return t.includes("@") ? t : null;
}

export async function resolveEmailForContactMemberId(
  contactMemberId: string,
  contactEmailFallback?: string | null,
): Promise<string | null> {
  const fromClient = normalizeRecipientEmail(contactEmailFallback);
  if (fromClient) return fromClient;

  const id = contactMemberId.trim();
  if (!id) return null;
  const asEmail = normalizeRecipientEmail(id);
  if (asEmail) return asEmail;
  if (!UUID_RE.test(id)) return null;

  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const fromUser = normalizeRecipientEmail(u?.email);
  if (fromUser) return fromUser;

  const [c] = await db
    .select({ email: contact.email })
    .from(contact)
    .where(eq(contact.id, id))
    .limit(1);
  const fromContact = normalizeRecipientEmail(c?.email);
  if (fromContact) return fromContact;

  return null;
}

function addressList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : value.split(/[,;]/);
  return raw
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.includes("@"));
}

function mergeAddressLists(
  ...lists: Array<string | string[] | undefined>
): string | string[] | undefined {
  const merged = [...new Set(lists.flatMap(addressList))];
  if (merged.length === 0) return undefined;
  if (merged.length === 1) return merged[0];
  return merged;
}

async function resolveEmailForUserId(
  userId: string | null | undefined,
): Promise<string | null> {
  const id = String(userId ?? "").trim();
  if (!UUID_RE.test(id)) return null;
  const [u] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return normalizeRecipientEmail(u?.email);
}

export interface SendDealMemberInvitationParams {
  dealId: string
  toEmail: string
  memberDisplayName?: string
  /**
   * `investor` — from Investors tab; `deal_member` — from Deal members (email names the tab Role).
   */
  invitationSource: DealInvitationSource
  /** Shown in subject/body when `invitationSource` is `deal_member`. */
  dealMemberRoleLabel: string
  /** Extra recipients, such as the user who saved the lead-sponsor change. */
  ccEmails?: string[]
}

export async function sendDealMemberInvitationEmail(
  params: SendDealMemberInvitationParams,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const to = params.toEmail.trim().toLowerCase();
  if (!to.includes("@")) {
    return { ok: false, error: new Error("Invalid recipient email") };
  }

  const deal = await getAddDealFormById(params.dealId);
  const dealName = deal?.dealName?.trim() || "this deal";
  const memberDisplayName = params.memberDisplayName?.trim() || "";
  const invitationSource = params.invitationSource;
  const dealMemberRoleLabel = (params.dealMemberRoleLabel ?? "").trim();
  const portalUrl =
    (await buildDealMemberInviteLandingUrl(params.dealId, to)) || "";
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(trim(${users.email})) = ${to}`)
    .limit(1);
  const accountExists = Boolean(existingUser);

  try {
    const transporter = emailConfig();
    const fromAddress = process.env.SENDER_EMAIL_ID?.trim() || "";
    if (!fromAddress) {
      return {
        ok: false,
        error: new Error(
          "SENDER_EMAIL_ID must be set (configure SMTP in .env.local).",
        ),
      };
    }

    const ccBcc = outgoingMailCcBcc();
    const alsoTo = (params.ccEmails ?? []).filter((email) => email !== to);
    const toField = alsoTo.length > 0 ? [to, ...alsoTo] : to;
    const cc = mergeAddressLists(ccBcc.cc);
    const html = buildDealMemberInvitationEmailHtml({
      dealName,
      memberDisplayName,
      memberEmail: to,
      portalDealUrl: portalUrl,
      senderBrand: SENDER_DISPLAY_NAME,
      invitationSource,
      dealMemberRoleLabel,
      accountExists,
    });
    const text = buildDealMemberInvitationEmailText({
      dealName,
      memberDisplayName,
      memberEmail: to,
      portalDealUrl: portalUrl,
      senderBrand: SENDER_DISPLAY_NAME,
      invitationSource,
      dealMemberRoleLabel,
      accountExists,
    });

    await transporter.sendMail({
      from: {
        name: SENDER_DISPLAY_NAME,
        address: fromAddress,
      },
      to: toField,
      ...(cc ? { cc } : {}),
      ...(ccBcc.bcc ? { bcc: ccBcc.bcc } : {}),
      envelope: smtpEnvelopeForSendMail({
        fromAddress,
        to: toField,
        cc,
        bcc: ccBcc.bcc,
      }),
      subject: defaultSubject(
        dealName,
        invitationSource,
        dealMemberRoleLabel,
        accountExists,
      ),
      text,
      html,
    });
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

/** After saving an investment: notify the investor by email when the form asked for it. */
export async function sendDealMemberInviteForInvestmentIfRequested(input: {
  dealId: string
  contactId: string
  contactDisplayName: string
  sendInvitationMail: string
  dealMemberRole?: string
  /** From Add Member / investment form when the UI already has the address. */
  contactEmail?: string | null
  /**
   * `deal_member` when saving via Deal Members (`deal_member` upsert);
   * `investor` for LP Investors tab / investor-framed invites.
   */
  invitationSource?: DealInvitationSource
  /**
   * When editing the lead sponsor, also copy the user who saved the change.
   * Used only when that person is the lead sponsor on this save (no replacement).
   */
  ccUserId?: string | null
}): Promise<void> {
  if (String(input.sendInvitationMail).toLowerCase() !== "yes") return;
  const to = await resolveEmailForContactMemberId(
    input.contactId,
    input.contactEmail,
  );
  if (!to) {
    console.warn(
      "sendDealMemberInviteForInvestmentIfRequested: no email for contact",
      input.contactId,
    );
    return;
  }
  const rawRole = String(input.dealMemberRole ?? "").trim();
  const invitationSource =
    input.invitationSource ??
    (rawRole ? "deal_member" : "investor");
  const ccEmail = await resolveEmailForUserId(input.ccUserId);
  const result = await sendDealMemberInvitationEmail({
    dealId: input.dealId,
    toEmail: to,
    memberDisplayName: input.contactDisplayName,
    invitationSource,
    dealMemberRoleLabel:
      invitationSource === "deal_member" ? rawRole : "",
    ccEmails: ccEmail && ccEmail !== to ? [ccEmail] : [],
  });
  if (!result.ok) {
    console.warn(
      "sendDealMemberInviteForInvestmentIfRequested: send failed",
      result.error,
    );
    return;
  }
  const { markDealMemberInvitationMailSent } = await import(
    "./dealMember.service.js"
  );
  await markDealMemberInvitationMailSent(input.dealId, {
    contactMemberId: input.contactId,
    toEmail: to,
  });
}

function sameRosterContact(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = String(a ?? "").trim().toLowerCase();
  const right = String(b ?? "").trim().toLowerCase();
  return Boolean(left) && left === right;
}

async function resolveDisplayNameForContactMemberId(
  contactMemberId: string,
): Promise<string> {
  const id = contactMemberId.trim();
  if (!UUID_RE.test(id)) return "";

  const [u] = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  const fromUser = [u?.firstName, u?.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (fromUser) return fromUser;

  const [c] = await db
    .select({
      fullName: contact.fullName,
      firstName: contact.firstName,
      lastName: contact.lastName,
    })
    .from(contact)
    .where(eq(contact.id, id))
    .limit(1);
  const fromFull = String(c?.fullName ?? "").trim();
  if (fromFull) return fromFull;
  return [c?.firstName, c?.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * When a platform admin assigns a new Lead Sponsor, email that person.
 * On edit, mail is sent only when the form's notify question is Yes.
 * Skipped when that choice already emailed the same contact.
 * The user who saved the change is copied on the lead-sponsor message.
 */
export async function sendNewLeadSponsorInvitationIfAssigned(input: {
  dealId: string
  newLeadSponsorContactId: string | null | undefined
  alreadyNotifiedContactId?: string | null
  alreadyNotified: boolean
  /** Edit saves: do not email a replacement lead sponsor unless the question is Yes. */
  requireNotifyChoice?: boolean
  /** Portal user who saved the edit; copied when the lead-sponsor email is sent. */
  ccUserId?: string | null
}): Promise<void> {
  const contactId = String(input.newLeadSponsorContactId ?? "").trim();
  if (!contactId) return;
  if (input.requireNotifyChoice && !input.alreadyNotified) return;
  if (
    input.alreadyNotified &&
    sameRosterContact(contactId, input.alreadyNotifiedContactId)
  ) {
    return;
  }

  const to = await resolveEmailForContactMemberId(contactId);
  if (!to) {
    console.warn(
      "sendNewLeadSponsorInvitationIfAssigned: no email for contact",
      contactId,
    );
    return;
  }
  const memberDisplayName = await resolveDisplayNameForContactMemberId(contactId);
  const ccEmail = await resolveEmailForUserId(input.ccUserId);
  const result = await sendDealMemberInvitationEmail({
    dealId: input.dealId,
    toEmail: to,
    memberDisplayName,
    invitationSource: "deal_member",
    dealMemberRoleLabel: "Lead Sponsor",
    ccEmails: ccEmail && ccEmail !== to ? [ccEmail] : [],
  });
  if (!result.ok) {
    console.warn(
      "sendNewLeadSponsorInvitationIfAssigned: send failed",
      result.error,
    );
    return;
  }
  const { markDealMemberInvitationMailSent } = await import(
    "./dealMember.service.js"
  );
  await markDealMemberInvitationMailSent(input.dealId, {
    contactMemberId: contactId,
    toEmail: to,
  });
}
