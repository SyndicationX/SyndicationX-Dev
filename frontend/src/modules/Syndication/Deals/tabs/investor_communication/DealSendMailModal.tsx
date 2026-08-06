import {
  Eye,
  Info,
  ListChecks,
  Loader2,
  Mail,
  Pencil,
  Plus,
  Send,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  getCurrentSessionUserEmail,
  parseEmailInput,
} from "../../../../../common/features/send-mail"
import { toast } from "../../../../../common/components/Toast"
import {
  fetchDealInvestors,
  fetchDealMembers,
} from "../../api/dealsApi"
import {
  loadEmailTemplates,
  type EmailTemplateRow,
} from "../../../contacts/emailTemplatesStorage"
import {
  SendMailEmailPreviewModal,
  type SendMailEmailPreviewPayload,
} from "../../../contacts/components/SendMailEmailPreviewModal"
import {
  groupLabelForDealMailRecipient,
  mergeDealInvestorsAndMembersToRecipients,
  type DealMailRecipient,
} from "./dealMailRecipients"
import { postDealInvestorCommunicationMail } from "./investorCommunicationApi"
import type { InvestorCommunicationMailRow } from "./investor-communication.types"
import "../../../contacts/contacts.css"
import "../../../usermanagement/user_management.css"
import "./investor_communication.css"

export interface DealSendMailModalProps {
  dealId: string
  open: boolean
  onClose: () => void
  onSent?: (mail: InvestorCommunicationMailRow) => void
  /** Pre-select recipients by email when opening (e.g. resend from mail log). */
  initialRecipientEmails?: string[]
}

export function DealSendMailModal({
  dealId,
  open,
  onClose,
  onSent,
  initialRecipientEmails,
}: DealSendMailModalProps) {
  const navigate = useNavigate()
  const [loadingRecipients, setLoadingRecipients] = useState(false)
  const [recipients, setRecipients] = useState<DealMailRecipient[]>([])
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<
    Set<string>
  >(() => new Set())
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateRow[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [sendMailCc, setSendMailCc] = useState("")
  const [sendMailEmailPreview, setSendMailEmailPreview] =
    useState<SendMailEmailPreviewPayload | null>(null)
  const [sending, setSending] = useState(false)

  const senderEmail = useMemo(() => getCurrentSessionUserEmail(), [])

  const selectedRecipients = useMemo(
    () => recipients.filter((r) => selectedRecipientIds.has(r.id)),
    [recipients, selectedRecipientIds],
  )

  const selectedTemplate = useMemo(
    () => emailTemplates.find((t) => t.id === selectedTemplateId) ?? null,
    [emailTemplates, selectedTemplateId],
  )

  const allRecipientsSelected =
    recipients.length > 0 &&
    recipients.every((r) => selectedRecipientIds.has(r.id))

  useEffect(() => {
    if (!open || !dealId.trim()) return
    let cancelled = false
    setLoadingRecipients(true)
    setSelectedRecipientIds(new Set())
    const preselectEmails = new Set(
      (initialRecipientEmails ?? [])
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@")),
    )
    void (async () => {
      const [templates, invPayload, membersResult] = await Promise.all([
        loadEmailTemplates(),
        fetchDealInvestors(dealId.trim(), { lpInvestorsOnly: true }),
        fetchDealMembers(dealId.trim()),
      ])
      if (cancelled) return
      const merged = mergeDealInvestorsAndMembersToRecipients(
        invPayload.investors,
        membersResult.members,
      )
      setRecipients(merged)
      const ids =
        preselectEmails.size > 0
          ? merged
              .filter((r) => preselectEmails.has(r.email.trim().toLowerCase()))
              .map((r) => r.id)
          : merged.map((r) => r.id)
      setSelectedRecipientIds(new Set(ids))
      const active = templates.filter((t) => !t.archived)
      setEmailTemplates(active)
      setSelectedTemplateId((prev) =>
        prev && active.some((t) => t.id === prev)
          ? prev
          : (active[0]?.id ?? ""),
      )
      setSendMailCc("")
      setSendMailEmailPreview(null)
      setLoadingRecipients(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, dealId, initialRecipientEmails])

  const closeModal = useCallback(() => {
    if (sending) return
    setSendMailEmailPreview(null)
    onClose()
  }, [onClose, sending])

  const goNewTemplateFromSendMail = useCallback(() => {
    navigate("/contacts/email-templates/new")
  }, [navigate])

  const openSendMailEmailPreview = useCallback(
    (mode: "view" | "edit") => {
      const template = emailTemplates.find((t) => t.id === selectedTemplateId)
      if (!template) {
        toast.error("Template required", "Choose an email template first.")
        return
      }
      const emails = [
        ...new Set(
          selectedRecipients
            .map((r) => r.email.trim())
            .filter((e) => e.includes("@")),
        ),
      ]
      if (emails.length === 0) {
        toast.error(
          "No email recipients",
          "Select investors or deal members with a valid email.",
        )
        return
      }
      setSendMailEmailPreview({
        templateId: template.id,
        templateName: template.name,
        templateArchived: Boolean(template.archived),
        createdBy: template.createdBy,
        createdAt: template.createdAt,
        subject: template.subject,
        bodyHtml: template.body,
        toEmails: emails,
        ccEmails: parseEmailInput(sendMailCc),
        attachment: template.attachment,
        startInEditMode: mode === "edit",
      })
    },
    [emailTemplates, selectedRecipients, selectedTemplateId, sendMailCc],
  )

  const handleSendMailPreviewSaved = useCallback(
    (patch: { subject: string; bodyHtml: string }) => {
      setSendMailEmailPreview((p) =>
        p ? { ...p, ...patch, startInEditMode: false } : null,
      )
      void loadEmailTemplates().then((rows) => {
        setEmailTemplates(rows.filter((t) => !t.archived))
      })
    },
    [],
  )

  const handleSend = useCallback(async () => {
    const emails = [
      ...new Set(
        selectedRecipients
          .map((r) => r.email.trim())
          .filter((e) => e.includes("@")),
      ),
    ]
    if (emails.length === 0) {
      toast.error(
        "No email recipients",
        "Select investors or deal members with a valid email.",
      )
      return
    }
    const template = emailTemplates.find((t) => t.id === selectedTemplateId)
    if (!template) {
      toast.error("Template required", "Choose an email template first.")
      return
    }
    const previewSubject = sendMailEmailPreview?.subject?.trim()
    const previewBody = sendMailEmailPreview?.bodyHtml
    const subject = previewSubject || template.subject
    const bodyHtml = previewBody ?? template.body

    setSending(true)
    const result = await postDealInvestorCommunicationMail({
      dealId,
      templateId: template.id,
      subject,
      bodyHtml,
      ccRaw: sendMailCc,
      recipientUsers: selectedRecipients,
    })
    setSending(false)
    if (!result.ok) {
      toast.error("Could not send email", result.message)
      if (result.mail) onSent?.(result.mail)
      return
    }
    onSent?.(result.mail)
    toast.success("Email sent", "Message was sent and logged for this deal.")
    closeModal()
  }, [
    closeModal,
    dealId,
    emailTemplates,
    onSent,
    selectedRecipients,
    selectedTemplateId,
    sendMailCc,
    sendMailEmailPreview,
    senderEmail,
  ])

  function toggleRecipient(id: string) {
    setSelectedRecipientIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAllRecipients() {
    setSelectedRecipientIds((prev) => {
      if (recipients.every((r) => prev.has(r.id))) return new Set()
      return new Set(recipients.map((r) => r.id))
    })
  }

  if (!open) return null

  return (
    <>
      <div
        className="um_modal_overlay contacts_suspend_overlay"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal()
        }}
      >
        <div
          className="um_modal contacts_suspend_modal deal_inv_comm_send_mail_modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deal-inv-comm-send-mail-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="um_modal_head">
            <h3
              id="deal-inv-comm-send-mail-title"
              className="um_modal_title um_title_with_icon"
            >
              <Mail
                className="um_title_icon contacts_suspend_title_icon contacts_suspend_title_icon_info"
                size={22}
                strokeWidth={2}
                aria-hidden
              />
              <span>Send email</span>
            </h3>
            <button
              type="button"
              className="um_modal_close"
              aria-label="Close"
              disabled={sending}
              onClick={closeModal}
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
              {loadingRecipients
                ? "Loading investors and deal members for this deal…"
                : `Sending to ${selectedRecipients.length} selected recipient${
                    selectedRecipients.length === 1 ? "" : "s"
                  } on this deal.`}
            </span>
          </p>

          {/* <div className="um_field contacts_suspend_reason_field deal_inv_comm_recipients_field"> */}
          <div className="contacts_suspend_reason_field deal_inv_comm_recipients_field">
            <label className="um_field_label_row deal_inv_comm_recipients_label">
              <span>To — investors &amp; deal members on this deal</span>
            </label>
            {loadingRecipients ? (
              <p className="deal_inv_comm_recipients_loading" role="status">
                <Loader2
                  size={18}
                  strokeWidth={2}
                  className="deal_inv_comm_recipients_spinner"
                  aria-hidden
                />
                Loading recipients…
              </p>
            ) : recipients.length === 0 ? (
              <p className="deal_inv_comm_recipient_empty" role="status">
                No investors or deal members on this deal have an email address.
              </p>
            ) : (
              <div className="deal_inv_comm_recipient_panel">
                <div className="deal_inv_comm_recipient_panel_head">
                  <span className="deal_inv_comm_recipient_panel_title">
                    Recipients
                  </span>
                  <span className="deal_inv_comm_recipient_panel_count">
                    {selectedRecipients.length} of {recipients.length} selected
                  </span>
                </div>
                <label className="deal_inv_comm_recipient_select_all">
                  <input
                    type="checkbox"
                    checked={allRecipientsSelected}
                    onChange={toggleSelectAllRecipients}
                    aria-label="Select all recipients on this deal"
                  />
                  <span>
                    <ListChecks size={14} strokeWidth={2} aria-hidden />
                    Select all
                  </span>
                </label>
                <ul
                  className="deal_inv_comm_recipient_list"
                  aria-label="Deal investors and members"
                >
                  {recipients.map((r) => (
                    <li key={r.id} className="deal_inv_comm_recipient_item">
                      <label className="deal_inv_comm_recipient_row">
                        <input
                          type="checkbox"
                          className="deal_inv_comm_recipient_cb"
                          checked={selectedRecipientIds.has(r.id)}
                          onChange={() => toggleRecipient(r.id)}
                          aria-label={`Select ${r.displayName}`}
                        />
                        <span className="deal_inv_comm_recipient_content">
                          <span className="deal_inv_comm_recipient_line">
                            <span
                              className="deal_inv_comm_recipient_name"
                              title={r.displayName}
                            >
                              {r.displayName}
                            </span>
                            <span className="deal_inv_comm_recipient_badge">
                              {groupLabelForDealMailRecipient(r)}
                            </span>
                          </span>
                          <span className="deal_inv_comm_recipient_subline">
                            <span
                              className="deal_inv_comm_recipient_email"
                              title={r.email}
                            >
                              {r.email}
                            </span>
                            {r.roleLabel !== "—" ? (
                              <span className="deal_inv_comm_recipient_role">
                                {r.roleLabel}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="um_field contacts_suspend_reason_field">
            <label
              className="um_field_label_row"
              htmlFor="deal-inv-comm-send-mail-cc"
            >
              <span>CC</span>
            </label>
            <input
              id="deal-inv-comm-send-mail-cc"
              type="text"
              className="um_input"
              placeholder="email1@domain.com, email2@domain.com"
              value={sendMailCc}
              onChange={(e) => setSendMailCc(e.target.value)}
              disabled={sending}
            />
          </div>

          <div className="um_field contacts_suspend_reason_field">
            <div className="contacts_send_mail_template_head">
              <label
                className="um_field_label_row"
                htmlFor="deal-inv-comm-send-mail-template"
              >
                <span>Email template</span>
              </label>
            </div>
            <div className="contacts_send_mail_template_select_row">
              <select
                id="deal-inv-comm-send-mail-template"
                className="um_field_select contacts_send_mail_template_select"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                disabled={sending || loadingRecipients}
              >
                {emailTemplates.length === 0 ? (
                  <option value="">No active templates</option>
                ) : null}
                {emailTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
              {selectedTemplate ? (
                <>
                  <button
                    type="button"
                    className="contacts_send_mail_template_edit_btn"
                    aria-label="View"
                    title="View"
                    onClick={() => openSendMailEmailPreview("view")}
                  >
                    <Eye size={16} strokeWidth={2} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="contacts_send_mail_template_edit_btn"
                    aria-label="Edit"
                    title="Edit"
                    onClick={() => openSendMailEmailPreview("edit")}
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
                onClick={goNewTemplateFromSendMail}
              >
                <Plus size={16} strokeWidth={2} aria-hidden />
              </button>
            </div>
            {emailTemplates.length === 0 ? (
              <p className="um_hint" role="status">
                Create an email template first in Email Templates.
              </p>
            ) : null}
          </div>

          <div className="um_modal_actions contacts_suspend_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={closeModal}
              disabled={sending}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Close
            </button>
            <button
              type="button"
              className="um_btn_primary"
              disabled={
                sending ||
                loadingRecipients ||
                !selectedTemplateId ||
                selectedRecipients.length === 0
              }
              onClick={() => void handleSend()}
            >
              {sending ? (
                <>
                  Sending…
                  <Loader2
                    size={16}
                    strokeWidth={2}
                    className="deal_inv_comm_recipients_spinner"
                    aria-hidden
                  />
                </>
              ) : (
                <>
                  <Send size={16} strokeWidth={2} aria-hidden />
                  Send
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <SendMailEmailPreviewModal
        preview={sendMailEmailPreview}
        onClose={() => setSendMailEmailPreview(null)}
        onSaved={handleSendMailPreviewSaved}
      />
    </>
  )
}
