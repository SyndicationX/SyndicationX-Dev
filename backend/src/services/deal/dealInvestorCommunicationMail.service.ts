import { and, desc, eq } from "drizzle-orm";
import emailConfig, {
  getEmailBccFromEnv,
  smtpEnvelopeForSendMail,
} from "../../functions/emailconfig.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import {
  investorCommunicationLogs,
  type DealInvestorCommunicationRecipient,
} from "../../schema/deal.schema/deal-investor-communication-mail.schema.js";
import { getUserDisplayNameById } from "../contact/contact.service.js";

export type DealInvestorCommunicationMailStatus =
  | "sent"
  | "not_sent"
  | "failed";

export interface DealInvestorCommunicationMailApiRow {
  id: string;
  subject: string;
  sendFrom: string;
  sentTo: string;
  recipientCount: number;
  recipientUsers: DealInvestorCommunicationRecipient[];
  sentAt: string;
  status: DealInvestorCommunicationMailStatus;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMailStatus(raw: string): DealInvestorCommunicationMailStatus {
  const s = raw.trim().toLowerCase();
  if (s === "sent" || s === "failed" || s === "not_sent") return s;
  return "not_sent";
}

function formatSentToLabel(
  recipients: DealInvestorCommunicationRecipient[],
): string {
  const count = recipients.length;
  if (count === 0) return "—";
  if (count === 1) {
    const name = recipients[0]?.displayName?.trim();
    return name || "1 recipient";
  }
  return `${count} recipients`;
}

function mapRowToApi(
  row: typeof investorCommunicationLogs.$inferSelect,
): DealInvestorCommunicationMailApiRow {
  const recipients = Array.isArray(row.recipientUsers)
    ? row.recipientUsers
    : [];
  const senderName = row.senderName?.trim() || "—";
  const sentAt = row.sentAt ?? row.createdAt;
  return {
    id: row.id,
    subject: row.subject?.trim() || "—",
    sendFrom: senderName,
    sentTo: formatSentToLabel(recipients),
    recipientCount: recipients.length,
    recipientUsers: recipients,
    sentAt: sentAt.toISOString(),
    status: normalizeMailStatus(row.mailStatus),
  };
}

export async function listDealInvestorCommunicationMails(
  dealId: string,
): Promise<DealInvestorCommunicationMailApiRow[]> {
  const rows = await db
    .select()
    .from(investorCommunicationLogs)
    .where(eq(investorCommunicationLogs.dealId, dealId))
    .orderBy(
      desc(investorCommunicationLogs.sentAt),
      desc(investorCommunicationLogs.createdAt),
    );
  return rows.map(mapRowToApi);
}

function parseRecipientUsers(
  raw: unknown,
): DealInvestorCommunicationRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: DealInvestorCommunicationRecipient[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const email = String(o.email ?? "").trim().toLowerCase();
    const sponsorEmail = String(o.sponsorEmail ?? o.sponsor_email ?? "")
      .trim()
      .toLowerCase();
    const requiresCosponsorRelease =
      o.requiresCosponsorRelease === true ||
      o.requires_cosponsor_release === true;
    if (!email.includes("@") && !(requiresCosponsorRelease && sponsorEmail.includes("@")))
      continue;
    const groupsRaw = Array.isArray(o.groups) ? o.groups : [];
    const groups = groupsRaw
      .map((g) => String(g).trim())
      .filter(
        (g): g is "investor" | "deal_member" =>
          g === "investor" || g === "deal_member",
      );
    const classKindRaw = String(o.classKind ?? o.class_kind ?? "").trim().toLowerCase();
    out.push({
      id: String(o.id ?? (email || sponsorEmail)).trim() || email || sponsorEmail,
      displayName: String(o.displayName ?? email).trim() || email || "Investor",
      email,
      groups: groups.length > 0 ? groups : ["investor"],
      roleLabel: String(o.roleLabel ?? "").trim() || undefined,
      classKind: classKindRaw === "gp" || classKindRaw === "lp" ? classKindRaw : undefined,
      requiresCosponsorRelease: requiresCosponsorRelease || undefined,
      sponsorName: String(o.sponsorName ?? o.sponsor_name ?? "").trim() || undefined,
      sponsorEmail: sponsorEmail.includes("@") ? sponsorEmail : undefined,
    });
  }
  const byId = new Map<string, DealInvestorCommunicationRecipient>();
  for (const r of out) {
    const key = r.id || r.email;
    const existing = byId.get(key);
    if (!existing) {
      byId.set(key, r);
      continue;
    }
    for (const g of r.groups) {
      if (!existing.groups.includes(g)) existing.groups.push(g);
    }
  }
  return [...byId.values()];
}

function normalizeAddressList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v.map((x) => String(x).trim()).filter((x) => x.includes("@")),
    ),
  ];
}

async function resolveSenderEmail(userId: string): Promise<string> {
  const [actor] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const email = actor?.email?.trim() ?? "";
  return email.includes("@") ? email : "";
}

export interface SendDealInvestorCommunicationMailInput {
  dealId: string;
  senderId: string;
  templateId?: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  cc?: string[];
  recipientUsers: DealInvestorCommunicationRecipient[];
  deliveryEmails?: string[];
}

export async function sendDealInvestorCommunicationMail(
  input: SendDealInvestorCommunicationMailInput,
): Promise<
  | { ok: true; row: DealInvestorCommunicationMailApiRow }
  | { ok: false; message: string; row?: DealInvestorCommunicationMailApiRow }
> {
  const recipients = parseRecipientUsers(input.recipientUsers);
  const delivery = normalizeAddressList(input.deliveryEmails);
  const to =
    delivery.length > 0
      ? delivery
      : [
          ...new Set(
            recipients.flatMap((r) => {
              if (r.requiresCosponsorRelease && r.sponsorEmail?.includes("@"))
                return [r.sponsorEmail];
              if (r.email.includes("@")) return [r.email];
              return [];
            }),
          ),
        ];
  const subject = input.subject.trim();
  const senderEmail = await resolveSenderEmail(input.senderId);
  const senderName = await getUserDisplayNameById(input.senderId);
  const cc = normalizeAddressList(input.cc);
  const now = new Date();

  const templateId =
    input.templateId && UUID_RE.test(input.templateId.trim())
      ? input.templateId.trim()
      : null;

  async function insertLog(mailStatus: DealInvestorCommunicationMailStatus) {
    const [inserted] = await db
      .insert(investorCommunicationLogs)
      .values({
        dealId: input.dealId,
        templateId,
        senderId: input.senderId,
        senderName: senderName || senderEmail || "—",
        subject: subject || "—",
        recipientUsers: recipients,
        mailStatus,
        sentAt: mailStatus === "sent" ? now : null,
      })
      .returning();
    return inserted ? mapRowToApi(inserted) : null;
  }

  if (to.length === 0) {
    return { ok: false, message: "At least one valid recipient is required" };
  }
  if (!subject) {
    return { ok: false, message: "Email subject is required" };
  }
  if (!senderEmail) {
    return { ok: false, message: "Sender user email is required" };
  }

  const configuredSenderAddress = String(process.env.SENDER_EMAIL_ID ?? "").trim();
  if (!configuredSenderAddress.includes("@")) {
    return {
      ok: false,
      message: "Sender email is not configured on server",
    };
  }

  const envBccRaw = getEmailBccFromEnv();
  const envBcc = Array.isArray(envBccRaw)
    ? envBccRaw.map((x) => String(x).trim()).filter((x) => x.includes("@"))
    : envBccRaw
      ? String(envBccRaw)
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.includes("@"))
      : [];
  const bcc = [...new Set([...envBcc, senderEmail].filter(Boolean))];

  try {
    const transporter = emailConfig();
    await transporter.sendMail({
      from: senderEmail,
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      replyTo: senderEmail,
      subject,
      html: input.bodyHtml || "<p></p>",
      text: input.bodyText || "",
      envelope: smtpEnvelopeForSendMail({
        fromAddress: configuredSenderAddress,
        to,
        ...(cc.length > 0 ? { cc } : {}),
        ...(bcc.length > 0 ? { bcc } : {}),
      }),
    });
    const row = await insertLog("sent");
    if (!row) {
      return { ok: false, message: "Email sent but log could not be saved" };
    }
    return { ok: true, row };
  } catch (err) {
    console.error("sendDealInvestorCommunicationMail:", err);
    const row = await insertLog("failed");
    const detail =
      err instanceof Error && err.message.trim()
        ? err.message.trim()
        : "Could not send email";
    return {
      ok: false,
      message: detail,
      row: row ?? undefined,
    };
  }
}

export async function deleteDealInvestorCommunicationMail(
  dealId: string,
  mailId: string,
): Promise<boolean> {
  const result = await db
    .delete(investorCommunicationLogs)
    .where(
      and(
        eq(investorCommunicationLogs.id, mailId),
        eq(investorCommunicationLogs.dealId, dealId),
      ),
    )
    .returning({ id: investorCommunicationLogs.id });
  return result.length > 0;
}
