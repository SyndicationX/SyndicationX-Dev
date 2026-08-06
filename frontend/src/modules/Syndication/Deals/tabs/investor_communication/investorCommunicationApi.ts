import { portalAuthHeaders } from "../../../../../common/auth/portalAuthHeaders"
import { getApiV1Base } from "../../../../../common/utils/apiBaseUrl"
import {
  emailTemplateHtmlToPlainText,
  parseEmailInput,
} from "../../../../../common/features/send-mail"
import type { DealMailRecipient } from "./dealMailRecipients"
import type {
  InvestorCommunicationMailRow,
  InvestorCommunicationRecipient,
  InvestorCommunicationRecipientGroup,
} from "./investor-communication.types"

function authHeaders(): HeadersInit {
  return portalAuthHeaders()
}

function normalizeRecipient(raw: unknown): InvestorCommunicationRecipient | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const email = String(o.email ?? "").trim()
  if (!email.includes("@")) return null
  const groupsRaw = Array.isArray(o.groups) ? o.groups : []
  const groups = groupsRaw
    .map((g) => String(g).trim())
    .filter(
      (g): g is InvestorCommunicationRecipientGroup =>
        g === "investor" || g === "deal_member",
    )
  return {
    id: String(o.id ?? email).trim() || email,
    displayName: String(o.displayName ?? o.display_name ?? email).trim() || email,
    email,
    groups: groups.length > 0 ? groups : ["investor"],
    roleLabel: String(o.roleLabel ?? o.role_label ?? "—").trim() || "—",
  }
}

function normalizeRecipientUsers(raw: unknown): InvestorCommunicationRecipient[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { recipientUsers?: unknown })?.recipientUsers)
      ? (raw as { recipientUsers: unknown[] }).recipientUsers
      : []
  return list
    .map(normalizeRecipient)
    .filter((r): r is InvestorCommunicationRecipient => r != null)
}

function normalizeMailRow(raw: unknown): InvestorCommunicationMailRow | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const id = String(o.id ?? "").trim()
  if (!id) return null
  const statusRaw = String(o.status ?? o.mail_status ?? "not_sent").trim()
  const status =
    statusRaw === "sent" || statusRaw === "failed" || statusRaw === "not_sent"
      ? statusRaw
      : "not_sent"
  const recipientUsers = normalizeRecipientUsers(
    o.recipientUsers ?? o.recipient_users,
  )
  const recipientCount =
    typeof o.recipientCount === "number" && Number.isFinite(o.recipientCount)
      ? Math.max(0, Math.trunc(o.recipientCount))
      : recipientUsers.length
  const sentTo = String(o.sentTo ?? o.sent_to ?? "").trim()
  return {
    id,
    subject: String(o.subject ?? "").trim() || "—",
    sendFrom: String(o.sendFrom ?? o.send_from ?? o.sender_name ?? "").trim() || "—",
    sentTo: sentTo || (recipientCount > 0 ? `${recipientCount} recipients` : "—"),
    recipientCount,
    recipientUsers,
    sentAt: String(o.sentAt ?? o.sent_at ?? "").trim() || new Date().toISOString(),
    status,
  }
}

export async function fetchDealInvestorCommunicationMails(
  dealId: string,
): Promise<InvestorCommunicationMailRow[]> {
  const base = getApiV1Base()
  if (!base || !dealId.trim()) return []
  try {
    const res = await fetch(
      `${base}/deals/${encodeURIComponent(dealId.trim())}/investor-communication/mails`,
      { headers: { ...authHeaders() }, credentials: "include" },
    )
    const data = (await res.json().catch(() => ({}))) as { mails?: unknown }
    if (!res.ok) return []
    if (!Array.isArray(data.mails)) return []
    return data.mails
      .map(normalizeMailRow)
      .filter((r): r is InvestorCommunicationMailRow => r != null)
  } catch {
    return []
  }
}

export type PostDealInvestorCommunicationMailResult =
  | { ok: true; mail: InvestorCommunicationMailRow }
  | { ok: false; message: string; mail?: InvestorCommunicationMailRow }

export async function postDealInvestorCommunicationMail(params: {
  dealId: string
  templateId: string
  subject: string
  bodyHtml: string
  ccRaw?: string
  recipientUsers: DealMailRecipient[]
}): Promise<PostDealInvestorCommunicationMailResult> {
  const base = getApiV1Base()
  if (!base) {
    return { ok: false, message: "API is not configured." }
  }
  const cc = parseEmailInput(params.ccRaw ?? "")
  const bodyText = emailTemplateHtmlToPlainText(params.bodyHtml)
  try {
    const res = await fetch(
      `${base}/deals/${encodeURIComponent(params.dealId.trim())}/investor-communication/mails`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          templateId: params.templateId,
          subject: params.subject,
          bodyHtml: params.bodyHtml,
          bodyText,
          cc,
          recipientUsers: params.recipientUsers.map((r) => ({
            id: r.id,
            displayName: r.displayName,
            email: r.email,
            groups: r.groups,
            roleLabel: r.roleLabel,
          })),
        }),
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      message?: unknown
      mail?: unknown
      sent?: unknown
    }
    const mail = normalizeMailRow(data.mail)
    if (!res.ok || data.sent === false) {
      return {
        ok: false,
        message:
          data.message != null ? String(data.message) : "Could not send email.",
        mail: mail ?? undefined,
      }
    }
    if (!mail) {
      return { ok: false, message: "Email sent but log response was invalid." }
    }
    return { ok: true, mail }
  } catch {
    return { ok: false, message: "Unable to connect. Try again later." }
  }
}

export async function deleteDealInvestorCommunicationMail(
  dealId: string,
  mailId: string,
): Promise<boolean> {
  const base = getApiV1Base()
  if (!base || !dealId.trim() || !mailId.trim()) return false
  try {
    const res = await fetch(
      `${base}/deals/${encodeURIComponent(dealId.trim())}/investor-communication/mails/${encodeURIComponent(mailId.trim())}`,
      {
        method: "DELETE",
        headers: { ...authHeaders() },
        credentials: "include",
      },
    )
    return res.ok
  } catch {
    return false
  }
}
