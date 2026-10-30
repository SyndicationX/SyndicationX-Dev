import { ArrowLeft, Plus, X } from "lucide-react"
import { Link } from "react-router-dom"
import "@/modules/Syndication/usermanagement/user_management.css"

export function CoSponsorCompanyRequiredAlert({
  onDismiss,
}: {
  onDismiss?: () => void
}) {
  return (
    <div
      className="um_modal_overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss?.()
      }}
    >
      <div
        className="um_modal um_modal_view"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cosponsor-company-required-title"
      >
        <div className="um_modal_head">
          <h2 id="cosponsor-company-required-title" className="um_modal_title">
            Add Company
          </h2>
          {onDismiss ? (
            <button
              type="button"
              className="um_modal_close"
              onClick={onDismiss}
              aria-label="Close"
            >
              <X size={20} strokeWidth={2} aria-hidden />
            </button>
          ) : null}
        </div>
        <p className="um_modal_desc cosponsor_company_required_message">
          Add a company to open this deal.
        </p>
        <div className="um_modal_actions">
          {onDismiss ? (
            <button
              type="button"
              className="um_btn_secondary"
              onClick={onDismiss}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Close
            </button>
          ) : (
            <Link className="um_btn_secondary" to="/deals">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden />
              Back to deals
            </Link>
          )}
          <Link
            className="um_btn_primary"
            to="/account/company"
            onClick={() => onDismiss?.()}
          >
            <Plus size={16} strokeWidth={2} aria-hidden />
            Add Company
          </Link>
        </div>
      </div>
    </div>
  )
}
