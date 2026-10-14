import { Flag, Loader2, Save, X } from "lucide-react"
import { useEffect, useId, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import { ModalDropdownSelect } from "@/common/components/dropdown-select/ModalDropdownSelect"
import type { FeedbackItem, FeedbackPriority } from "./types"
import { FEEDBACK_PRIORITY_OPTIONS } from "./types"
import "../Syndication/usermanagement/user_management.css"
import "./feedback.css"

export function FeedbackPriorityModal({
  open,
  item,
  submitting = false,
  onClose,
  onSave,
}: {
  open: boolean
  item: FeedbackItem | null
  submitting?: boolean
  onClose: () => void
  onSave: (priority: FeedbackPriority) => void
}) {
  const titleId = useId()
  const [priority, setPriority] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setPriority(item?.priority ?? "")
    setError(null)
  }, [open, item?.id, item?.priority])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, submitting, onClose])

  if (!open || !item || typeof document === "undefined") return null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!priority) {
      setError("Select a priority.")
      return
    }
    setError(null)
    onSave(priority as FeedbackPriority)
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
        className="um_modal feedback_priority_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="um_modal_head">
          <h3 id={titleId} className="um_modal_title um_title_with_icon">
            <Flag size={20} aria-hidden />
            Set priority
          </h3>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <form className="feedback_form" onSubmit={handleSubmit}>
          {error ? <p className="feedback_form_error">{error}</p> : null}
          <p className="feedback_priority_context">
            {item.username || "—"} · {item.pageLabel || "—"}
            {item.subPageLabel ? ` / ${item.subPageLabel}` : ""}
          </p>
          <label className="feedback_field">
            <span className="feedback_field_label">
              <Flag
                className="um_field_label_icon"
                size={17}
                strokeWidth={2}
                aria-hidden
              />
              <span>Priority</span>
            </span>
            <ModalDropdownSelect
              ariaLabel="Priority"
              value={priority}
              onChange={setPriority}
              disabled={submitting}
              placeholder="Select a priority"
              options={FEEDBACK_PRIORITY_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
            />
          </label>
          <div className="um_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={onClose}
              disabled={submitting}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Cancel
            </button>
            <button
              type="submit"
              className="um_btn_primary"
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 size={16} className="feedback_spin" aria-hidden />
              ) : (
                <Save size={16} strokeWidth={2} aria-hidden />
              )}
              {submitting ? "Saving…" : "Save priority"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
