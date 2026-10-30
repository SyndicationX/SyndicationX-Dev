import { useId, useState } from "react"
import { createPortal } from "react-dom"
import { Landmark, UserMinus, X } from "lucide-react"
import "./deal-member-row-actions.css"

export type InvestorRemovalAction = "remove_investment" | "remove_investor"

const REASON_MAX = 500

export function InvestorRemovalConfirmModal({
  investorName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  investorName: string
  busy: boolean
  error: string
  onClose: () => void
  onConfirm: (removal: { action: InvestorRemovalAction; reason: string }) => void
}) {
  const titleId = useId()
  const reasonId = useId()
  const [reason, setReason] = useState("")
  const canSubmit = reason.trim().length > 0 && !busy
  if (typeof document === "undefined") return null

  function submit(action: InvestorRemovalAction) {
    if (!canSubmit) return
    onConfirm({ action, reason: reason.trim() })
  }

  return createPortal(
    <div
      className="um_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="um_modal um_modal_view investor_removal_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="um_modal_head">
          <h3 id={titleId} className="um_modal_title">
            Remove {investorName}?
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
          className="investor_removal_body"
          onSubmit={(e) => {
            e.preventDefault()
          }}
        >
          <p className="investor_removal_lead">
            Choose what to remove for <strong>{investorName}</strong>.
          </p>
          <label className="investor_removal_reason" htmlFor={reasonId}>
            <span>Reason</span>
            <textarea
              id={reasonId}
              value={reason}
              maxLength={REASON_MAX}
              rows={3}
              disabled={busy}
              required
              placeholder="Why is this being removed?"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {error ? (
            <p className="um_msg_error um_modal_form_error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="investor_removal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Cancel
            </button>
            <div className="investor_removal_actions_group">
              <button
                type="button"
                className="um_btn_danger"
                disabled={!canSubmit}
                title="Remove only this investment. The investor stays on the deal."
                onClick={() => submit("remove_investment")}
              >
                <Landmark size={16} strokeWidth={2} aria-hidden />
                {busy ? "Removing…" : "Remove Investment"}
              </button>
              <button
                type="button"
                className="um_btn_danger"
                disabled={!canSubmit}
                title="Remove this investor's association with the selected investment"
                onClick={() => submit("remove_investor")}
              >
                <UserMinus size={16} strokeWidth={2} aria-hidden />
                {busy ? "Removing…" : "Remove Investor"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
