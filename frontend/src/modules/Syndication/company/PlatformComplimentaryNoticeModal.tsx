import { BadgeDollarSign, CircleCheck, X } from "lucide-react"
import { useEffect, useId } from "react"
import { createPortal } from "react-dom"
import { platformSaasBillingStartDisplay } from "../Deals/utils/saasBillingStartDate"
import "../Deals/components/deal-stage-change-modal.css"

export function PlatformComplimentaryNoticeModal({
  open,
  onClose,
  untilDisplay,
}: {
  open: boolean
  onClose: () => void
  untilDisplay?: string | null
}) {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener("keydown", onKey)
    }
  }, [open, onClose])

  const until = untilDisplay?.trim() || platformSaasBillingStartDisplay()

  if (!open) return null

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="deal_stage_modal deal_stage_modal--saas_paywall"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap" aria-hidden>
            <BadgeDollarSign size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Monthly billing</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              No payment needed yet
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="deal_stage_modal_body">
          <span className="deal_stage_modal_badge">Complimentary</span>
          <p className="deal_stage_modal_desc">
            The platform is complimentary until {until}. Payment is not required
            yet.
          </p>
          <p className="deal_stage_modal_desc" style={{ marginTop: "0.65rem" }}>
            Every feature stays open until that date, including Capital Raising
            and Asset Managing deals. Payment opens on that date.
          </p>
        </div>

        <footer className="deal_stage_modal_actions">
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
            onClick={onClose}
          >
            <CircleCheck size={16} strokeWidth={2} aria-hidden />
            OK
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
