import { useState, type ReactNode } from "react"
import { UserMinus, X } from "lucide-react"
import { createPortal } from "react-dom"
import "./user_management.css"

const REMOVE_CONFIRM_TEXT = "REMOVE"

export function MemberRemoveConfirmModal({
  memberName,
  busy,
  error,
  onClose,
  onConfirm,
  message,
  submitLabel = "Remove",
  busyLabel = "Removing…",
}: {
  memberName: string
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: () => void
  /** Replaces the organization-member explanation. Layout stays the same. */
  message?: ReactNode
  submitLabel?: string
  busyLabel?: string
}) {
  const [confirmText, setConfirmText] = useState("")
  const canConfirm = confirmText.trim() === REMOVE_CONFIRM_TEXT
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
        className="um_modal um_modal_view um_member_remove_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="um-remove-member-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="um_modal_head">
          <h3 id="um-remove-member-title" className="um_modal_title">
            Are you sure?
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
        <p className="um_member_remove_warning">
          This action cannot be undone. Read this before you continue.
        </p>
        <form
          className="um_member_remove_body"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canConfirm || busy) return
            onConfirm()
          }}
        >
          <p className="um_member_remove_message">
            {message ?? (
              <>
                This will remove <strong>{memberName}</strong> from this
                organization. They will leave the Members list and show on All
                Contacts.
              </>
            )}
          </p>
          <label className="um_field um_member_remove_confirm_field">
            <span>
              Type <strong>{REMOVE_CONFIRM_TEXT}</strong> to confirm.
            </span>
            <input
              className="um_member_remove_confirm_input"
              value={confirmText}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              placeholder={REMOVE_CONFIRM_TEXT}
              onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
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
            <button
              type="submit"
              className="um_btn_danger"
              disabled={busy || !canConfirm}
            >
              <UserMinus size={16} strokeWidth={2} aria-hidden />
              {busy ? busyLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
