import emailConfig, { smtpEnvelopeForSendMail } from "../../functions/emailconfig.js";

function normalizeEmails(addrs: string[] | undefined): string[] {
  if (!addrs?.length) return [];
  return [
    ...new Set(
      addrs.map((x) => String(x).trim()).filter((x) => x.includes("@")),
    ),
  ];
}

function withoutAddress(addrs: string[], excludeNorm: string): string[] {
  return addrs.filter((x) => x.toLowerCase() !== excludeNorm);
}

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

/**
 * Sends one SMTP message per To address so each recipient only sees
 * their own address on To, not the rest of the selected list.
 */
export async function sendHtmlMailPerRecipient(opts: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  envelopeFrom: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  const toList = normalizeEmails(opts.to);
  if (toList.length === 0) {
    throw new Error("At least one valid recipient is required");
  }

  const ccAll = normalizeEmails(opts.cc);
  const bccAll = normalizeEmails(opts.bcc);
  const transporter = emailConfig();
  const replyTo = opts.replyTo?.trim();
  const attachments = opts.attachments ?? [];

  for (const recipient of toList) {
    const recNorm = recipient.toLowerCase();
    const cc = withoutAddress(ccAll, recNorm);
    const bcc = withoutAddress(bccAll, recNorm).filter(
      (x) => !cc.some((c) => c.toLowerCase() === x.toLowerCase()),
    );

    await transporter.sendMail({
      from: opts.from,
      to: recipient,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      ...(replyTo ? { replyTo } : {}),
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      envelope: smtpEnvelopeForSendMail({
        fromAddress: opts.envelopeFrom,
        to: recipient,
        ...(cc.length > 0 ? { cc } : {}),
        ...(bcc.length > 0 ? { bcc } : {}),
      }),
    });
  }
}
