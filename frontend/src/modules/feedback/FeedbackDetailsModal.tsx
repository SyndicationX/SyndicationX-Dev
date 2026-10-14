import { ViewReadonlyField } from "@/common/components/ViewReadonlyField"
import { displayEmail } from "@/common/utils/displayEmail"
import { formatDateDdMmmYyyy } from "@/common/utils/formatDateDisplay"
import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileText,
  Flag,
  Hash,
  LayoutGrid,
  List,
  Loader2,
  Mail,
  MessageSquareText,
  Shield,
  User,
  UserCheck,
  X,
} from "lucide-react"
import { useEffect, useId, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import "../Syndication/usermanagement/user_management.css"
import type {
  FeedbackItem,
  FeedbackReviewAction,
  FeedbackStatus,
} from "./types"
import { feedbackPriorityLabel, feedbackUserRoleLabel } from "./types"
import "./feedback.css"

function formatDateTime(raw: string | null | undefined): string {
  if (!raw?.trim()) return "—"
  const date = formatDateDdMmmYyyy(raw)
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return date
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  return `${date} ${time}`
}

function StatusCell({ status }: { status: FeedbackStatus }) {
  const tone =
    status === "Resolved"
      ? "um_status_dot_active"
      : status === "Reviewed"
        ? "um_status_dot_invited"
        : "um_status_dot_invited"
  return (
    <span className="um_status_cell">
      <span className={`um_status_dot ${tone}`} />
      <span className="um_status_label">{status}</span>
    </span>
  )
}

export function FeedbackDetailsModal({
  open,
  item,
  mode,
  submitting = false,
  onClose,
  onAction,
}: {
  open: boolean
  item: FeedbackItem | null
  mode: "review" | "view"
  submitting?: boolean
  onClose: () => void
  onAction?: (action: FeedbackReviewAction, adminResponse: string) => void
}) {
  const titleId = useId()
  const notesId = useId()
  const [notes, setNotes] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNotes(item?.adminResponse ?? "")
    setError(null)
  }, [open, item?.id, item?.adminResponse])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, submitting, onClose])

  if (!open || !item || typeof document === "undefined") return null

  const reviewMode = mode === "review"
  const canMarkReviewed = reviewMode && item.status === "Pending"
  const canMarkResolved = reviewMode && item.status !== "Resolved"

  function handleAction(action: FeedbackReviewAction) {
    const trimmed = notes.trim()
    if (action === "resolved" && trimmed.length < 3) {
      setError("Enter review comments before marking as resolved.")
      return
    }
    setError(null)
    onClose()
    onAction?.(action, trimmed)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (canMarkReviewed) handleAction("reviewed")
    else if (canMarkResolved) handleAction("resolved")
  }

  return createPortal(
    <div
      className="um_modal_overlay portal_modal_z_boost"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <div
        className="um_modal um_modal_view feedback_details_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="um_modal_head">
          <h3 id={titleId} className="um_modal_title">
            {reviewMode ? "Review feedback" : "Feedback details"}
          </h3>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <form
          className="feedback_details_form"
          onSubmit={handleSubmit}
        >
          <div className="feedback_details_scroll">
            {error ? <p className="feedback_form_error">{error}</p> : null}

            <div className="um_view_grid feedback_details_grid">
              <ViewReadonlyField
                Icon={Hash}
                label="S.No"
                value={item.feedbackNo > 0 ? String(item.feedbackNo) : "—"}
              />
              <ViewReadonlyField
                Icon={User}
                label="Submitted by"
                value={item.username || "—"}
              />
              <ViewReadonlyField
                Icon={Mail}
                label="Email"
                value={displayEmail(item.userEmail)}
              />
              <ViewReadonlyField
                Icon={Shield}
                label="Role"
                value={feedbackUserRoleLabel(item.userRole)}
              />
              <ViewReadonlyField
                Icon={LayoutGrid}
                label="Page"
                value={item.pageLabel || "—"}
              />
              <ViewReadonlyField
                Icon={List}
                label="Sub page / Tab"
                value={item.subPageLabel || "—"}
              />
              {item.priority ? (
                <ViewReadonlyField
                  Icon={Flag}
                  label="Priority"
                  value={feedbackPriorityLabel(item.priority)}
                />
              ) : null}
              {item.feedbackType ? (
                <ViewReadonlyField
                  Icon={ClipboardList}
                  label="Feedback Type"
                  value={item.feedbackType}
                />
              ) : null}
              <ViewReadonlyField
                Icon={CalendarClock}
                label="Submitted"
                value={formatDateTime(item.createdAt)}
              />
              <ViewReadonlyField
                Icon={ClipboardList}
                label="Status"
                value={<StatusCell status={item.status} />}
              />
              {item.reviewedByName ? (
                <ViewReadonlyField
                  Icon={UserCheck}
                  label="Reviewed by"
                  value={item.reviewedByName}
                />
              ) : null}
              {item.reviewedAt ? (
                <ViewReadonlyField
                  Icon={CalendarClock}
                  label="Reviewed date"
                  value={formatDateTime(item.reviewedAt)}
                />
              ) : null}
              {item.resolvedAt ? (
                <ViewReadonlyField
                  Icon={CalendarClock}
                  label="Resolved date"
                  value={formatDateTime(item.resolvedAt)}
                  fieldClassName={
                    item.reviewedByName && item.reviewedAt
                      ? "um_view_field_span_full"
                      : undefined
                  }
                />
              ) : null}
              <ViewReadonlyField
                Icon={FileText}
                label="Original feedback"
                value={item.description?.trim() || "—"}
                fieldClassName="um_view_field_span_full feedback_view_field_multiline"
              />
              {reviewMode ? (
                <div className="um_view_field um_view_field_span_full feedback_view_field_multiline">
                  <div className="um_view_field_head">
                    <MessageSquareText
                      className="um_view_field_icon"
                      size={18}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                    <label htmlFor={notesId} className="um_view_field_label">
                      Review comments
                    </label>
                  </div>
                  <textarea
                    id={notesId}
                    className="um_field_textarea feedback_review_textarea"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={5}
                    maxLength={8000}
                    disabled={submitting}
                    placeholder="Describe the review or how the issue was resolved…"
                  />
                </div>
              ) : item.adminResponse ? (
                <ViewReadonlyField
                  Icon={MessageSquareText}
                  label="Review comments"
                  value={item.adminResponse}
                  fieldClassName="um_view_field_span_full feedback_view_field_multiline"
                />
              ) : null}
            </div>
          </div>

          <div className="um_modal_actions um_modal_actions_view feedback_details_footer">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={onClose}
              disabled={submitting}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              {reviewMode ? "Cancel" : "Close"}
            </button>
            {reviewMode ? (
              <>
                {canMarkReviewed ? (
                  <button
                    type="button"
                    className="um_btn_secondary"
                    disabled={submitting}
                    onClick={() => handleAction("reviewed")}
                  >
                    {submitting ? (
                      <Loader2 size={16} className="feedback_spin" aria-hidden />
                    ) : (
                      <ClipboardList size={16} strokeWidth={2} aria-hidden />
                    )}
                    Mark as Reviewed
                  </button>
                ) : null}
                {canMarkResolved ? (
                  <button
                    type="button"
                    className="um_btn_primary"
                    disabled={submitting}
                    onClick={() => handleAction("resolved")}
                  >
                    {submitting ? (
                      <Loader2 size={16} className="feedback_spin" aria-hidden />
                    ) : (
                      <CheckCircle2 size={16} strokeWidth={2} aria-hidden />
                    )}
                    Mark as Resolved
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
