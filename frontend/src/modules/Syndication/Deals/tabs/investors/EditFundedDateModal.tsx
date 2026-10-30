import { useState } from "react"
import { createPortal } from "react-dom"
import { Calendar, X } from "lucide-react"
import "../../../usermanagement/user_management.css"

function todayDateInputValue(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function EditFundedDateModal({
  investorName,
  busy,
  error,
  onClose,
  onSave,
}: {
  investorName: string
  busy: boolean
  error: string
  onClose: () => void
  onSave: (date: string) => void
}) {
  const [date, setDate] = useState(todayDateInputValue)
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      className="um_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="um_modal um_modal_view edit_funded_date_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-funded-date-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="um_modal_head">
          <h3 id="edit-funded-date-title" className="um_modal_title">
            Funded date
          </h3>
          <button
            type="button"
            className="um_modal_close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>
        <form
          className="um_member_remove_body"
          onSubmit={(e) => {
            e.preventDefault()
            if (!date || busy) return
            onSave(date)
          }}
        >
          <p className="um_member_remove_message">
            Set the funded date for <strong>{investorName}</strong>.
          </p>
          <label className="um_field edit_funded_date_field">
            <span>Funded date</span>
            <input
              type="date"
              value={date}
              required
              disabled={busy}
              autoFocus
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          {error ? (
            <p className="um_msg_error um_modal_form_error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="um_modal_actions add_contact_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Cancel
            </button>
            <button type="submit" className="um_btn_primary" disabled={busy || !date}>
              <Calendar size={16} strokeWidth={2} aria-hidden />
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
