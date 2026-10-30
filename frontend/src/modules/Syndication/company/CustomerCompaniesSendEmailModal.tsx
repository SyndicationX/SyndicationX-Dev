import { Eye, Info, Mail, Pencil, Plus, Send, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import { toast } from "../../../common/components/Toast"
import { SESSION_BEARER_KEY } from "../../../common/auth/sessionKeys"
import {
  getCurrentSessionUserEmail,
  openSendMailDraft,
  parseEmailInput,
} from "../../../common/features/send-mail"
import { getApiV1Base } from "../../../common/utils/apiBaseUrl"
import {
  loadEmailTemplates,
  type EmailTemplateRow,
} from "../contacts/emailTemplatesStorage"
import {
  SendMailEmailPreviewModal,
  type SendMailEmailPreviewPayload,
} from "../contacts/components/SendMailEmailPreviewModal"
import { isOrgStaffPortalRole } from "../usermanagement/memberAdminShared"

export type CustomerEmailTarget = {
  id: string
  name: string
}

type Props = {
  companies: CustomerEmailTarget[]
  onClose: () => void
  onSent: () => void
}

function memberEmail(row: Record<string, unknown>): string {
  const email = String(row.email ?? "").trim()
  return email.includes("@") ? email : ""
}

function memberIsActive(row: Record<string, unknown>): boolean {
  const status = String(row.userStatus ?? "").trim().toLowerCase()
  return status !== "inactive" && status !== "suspended"
}

async function loadMemberEmails(
  companies: CustomerEmailTarget[],
): Promise<string[]> {
  const base = getApiV1Base()
  const token = sessionStorage.getItem(SESSION_BEARER_KEY)
  if (!base || !token) throw new Error("Not signed in.")
  const lists = await Promise.all(
    companies.map(async (company) => {
      const res = await fetch(
        `${base}/users?organizationId=${encodeURIComponent(company.id)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        },
      )
      const data = (await res.json().catch(() => ({}))) as {
        users?: unknown
        message?: string
      }
      if (!res.ok) {
        throw new Error(data.message || `Could not load members for ${company.name}.`)
      }
      const users = Array.isArray(data.users) ? data.users : []
      return users.flatMap((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return []
        const record = row as Record<string, unknown>
        if (!isOrgStaffPortalRole(record.role) || !memberIsActive(record)) return []
        const email = memberEmail(record)
        return email ? [email] : []
      })
    }),
  )
  return [...new Set(lists.flat())]
}

export function CustomerCompaniesSendEmailModal({
  companies,
  onClose,
  onSent,
}: Props) {
  const navigate = useNavigate()
  const [templates, setTemplates] = useState<EmailTemplateRow[]>([])
  const [templateId, setTemplateId] = useState("")
  const [cc, setCc] = useState("")
  const [emails, setEmails] = useState<string[]>([])
  const [loadingEmails, setLoadingEmails] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [preview, setPreview] = useState<SendMailEmailPreviewPayload | null>(null)
  const senderEmail = useMemo(() => getCurrentSessionUserEmail(), [])
  const template = templates.find((row) => row.id === templateId) ?? null
  const companyLabel =
    companies.length === 1
      ? companies[0]?.name || "this company"
      : `${companies.length} companies`

  const close = useCallback(() => {
    if (sending) return
    onClose()
  }, [onClose, sending])

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || sending) return
      if (confirming) {
        setConfirming(false)
        return
      }
      close()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener("keydown", onKey)
    }
  }, [close, confirming, sending])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadingEmails(true)
      setLoadError("")
      try {
        const [rows, recipients] = await Promise.all([
          loadEmailTemplates(),
          loadMemberEmails(companies),
        ])
        if (cancelled) return
        const active = rows.filter((row) => !row.archived)
        setTemplates(active)
        setTemplateId((prev) =>
          prev && active.some((row) => row.id === prev) ? prev : (active[0]?.id ?? ""),
        )
        setEmails(recipients)
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Could not load members.")
        }
      } finally {
        if (!cancelled) setLoadingEmails(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [companies])

  function openPreview(mode: "view" | "edit") {
    if (!template) {
      toast.error("Template required", "Choose an email template first.")
      return
    }
    if (emails.length === 0) {
      toast.error("No email recipients", "These companies have no members with an email.")
      return
    }
    setPreview({
      templateId: template.id,
      templateName: template.name,
      templateArchived: Boolean(template.archived),
      createdBy: template.createdBy,
      createdAt: template.createdAt,
      subject: template.subject,
      bodyHtml: template.body,
      toEmails: emails,
      ccEmails: parseEmailInput(cc),
      attachment: template.attachment,
      startInEditMode: mode === "edit",
    })
  }

  async function send() {
    if (!template) {
      toast.error("Template required", "Choose an email template first.")
      return
    }
    setSending(true)
    try {
      const result = await openSendMailDraft({
        to: emails,
        ccRaw: cc,
        templateSubject: template.subject,
        templateBodyHtml: template.body,
        templateAttachment: template.attachment,
        senderEmail,
      })
      if (!result.ok) {
        toast.error("Could not send email", result.message)
        return
      }
      toast.success(
        "Email sent",
        `Sent to ${emails.length} member${emails.length === 1 ? "" : "s"}.`,
      )
      onSent()
    } finally {
      setSending(false)
    }
  }

  return createPortal(
    <div
      className="um_modal_overlay contacts_suspend_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        className="um_modal contacts_suspend_modal cp_company_members_send_mail_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-companies-send-mail-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="um_modal_head">
          <h3
            id="customer-companies-send-mail-title"
            className="um_modal_title um_title_with_icon"
          >
            <Mail
              className="um_title_icon contacts_suspend_title_icon contacts_suspend_title_icon_info"
              size={22}
              strokeWidth={2}
              aria-hidden
            />
            <span>Send email to organization members</span>
          </h3>
          <button
            type="button"
            className="um_modal_close"
            aria-label="Close"
            onClick={close}
            disabled={sending}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <p className="contacts_suspend_modal_desc contacts_suspend_modal_desc_info">
          <Info
            className="contacts_suspend_modal_desc_icon"
            size={18}
            strokeWidth={2}
            aria-hidden
          />
          <span>
            This sends to active members of <strong>{companyLabel}</strong>
            {loadingEmails
              ? "."
              : emails.length === 0
                ? ". No members with an email were found."
                : `. ${emails.length} recipient${emails.length === 1 ? "" : "s"}.`}
          </span>
        </p>
        {loadError ? (
          <p className="um_msg_error" role="alert">
            {loadError}
          </p>
        ) : null}
        <div className="um_field contacts_suspend_reason_field">
          <label className="um_field_label_row" htmlFor="customer-companies-send-mail-cc">
            <span>CC</span>
          </label>
          <input
            id="customer-companies-send-mail-cc"
            type="text"
            className="um_input"
            placeholder="email1@domain.com, email2@domain.com"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            disabled={sending}
          />
        </div>
        <div className="um_field contacts_suspend_reason_field">
          <label
            className="um_field_label_row"
            htmlFor="customer-companies-send-mail-template"
          >
            <span>Email template</span>
          </label>
          <div className="contacts_send_mail_template_select_row">
            <select
              id="customer-companies-send-mail-template"
              className="um_field_select contacts_send_mail_template_select"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={sending || loadingEmails}
            >
              {templates.length === 0 ? (
                <option value="">No active templates</option>
              ) : null}
              {templates.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            {template ? (
              <>
                <button
                  type="button"
                  className="contacts_send_mail_template_edit_btn"
                  aria-label="View"
                  title="View"
                  onClick={() => openPreview("view")}
                >
                  <Eye size={16} strokeWidth={2} aria-hidden />
                </button>
                <button
                  type="button"
                  className="contacts_send_mail_template_edit_btn"
                  aria-label="Edit"
                  title="Edit"
                  onClick={() => openPreview("edit")}
                >
                  <Pencil size={16} strokeWidth={2} aria-hidden />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="contacts_send_mail_template_edit_btn"
              aria-label="New template"
              title="New template"
              onClick={() => navigate("/contacts/email-templates/new")}
            >
              <Plus size={16} strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>
        <div className="um_modal_actions contacts_suspend_modal_actions">
          <button
            type="button"
            className="um_btn_secondary"
            onClick={close}
            disabled={sending}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Close
          </button>
          <button
            type="button"
            className="um_btn_primary"
            disabled={!template || emails.length === 0 || sending || loadingEmails}
            onClick={() => setConfirming(true)}
          >
            <Send size={16} strokeWidth={2} aria-hidden />
            Send
          </button>
        </div>
      </div>
      {confirming ? (
        <div
          className="um_modal cp_company_members_send_mail_confirm_modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="customer-companies-send-mail-confirm-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="um_modal_head">
            <h3
              id="customer-companies-send-mail-confirm-title"
              className="um_modal_title um_title_with_icon"
            >
              <Send
                className="um_title_icon contacts_suspend_title_icon contacts_suspend_title_icon_info"
                size={22}
                strokeWidth={2}
                aria-hidden
              />
              <span>Confirm send</span>
            </h3>
            <button
              type="button"
              className="um_modal_close"
              aria-label="Close"
              onClick={() => setConfirming(false)}
              disabled={sending}
            >
              <X size={20} strokeWidth={2} aria-hidden />
            </button>
          </div>
          <p className="contacts_suspend_modal_desc contacts_suspend_modal_desc_info">
            <Info
              className="contacts_suspend_modal_desc_icon"
              size={18}
              strokeWidth={2}
              aria-hidden
            />
            <span>
              Send the <strong>{template?.name ?? "selected"}</strong> template to{" "}
              <strong>{emails.length}</strong> member
              {emails.length === 1 ? "" : "s"} at <strong>{companyLabel}</strong>?
            </span>
          </p>
          <div className="um_modal_actions contacts_suspend_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={() => setConfirming(false)}
              disabled={sending}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Go back
            </button>
            <button
              type="button"
              className="um_btn_primary"
              disabled={sending}
              onClick={() => void send()}
            >
              <Send size={16} strokeWidth={2} aria-hidden />
              {sending ? "Sending…" : "Confirm send"}
            </button>
          </div>
        </div>
      ) : null}
      <SendMailEmailPreviewModal
        preview={preview}
        onClose={() => setPreview(null)}
        onSaved={(patch) => {
          setPreview((current) =>
            current ? { ...current, ...patch, startInEditMode: false } : null,
          )
          void loadEmailTemplates().then((rows) => {
            setTemplates(rows.filter((row) => !row.archived))
          })
        }}
      />
    </div>,
    document.body,
  )
}
