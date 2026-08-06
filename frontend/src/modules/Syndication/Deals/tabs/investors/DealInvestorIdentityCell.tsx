import { FilePenLine } from "lucide-react"
import type { DealInvestorRow } from "../../types/deal-investors.types"

function investorInitials(r: DealInvestorRow): string {
  const name = String(r.displayName ?? "").trim()
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2)
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (name.length >= 2) return name.slice(0, 2).toUpperCase()
  const sub = String(r.entitySubtitle ?? "").trim()
  if (sub.length >= 2) return sub.slice(0, 2).toUpperCase()
  return "?"
}

export function DealInvestorIdentityCell({
  row,
  isDraft,
  onNameClick,
}: {
  row: DealInvestorRow
  isDraft?: boolean
  /** When set, the investor name opens details (e.g. view popup). */
  onNameClick?: (row: DealInvestorRow) => void
}) {
  const initials = investorInitials(row)
  const displayName = String(row.displayName ?? "").trim() || "—"
  const email = String(row.userEmail ?? "").trim()
  const line2 = email || String(row.entitySubtitle ?? "").trim() || "—"
  const line2Title =
    email && row.entitySubtitle?.trim()
      ? `${email} · ${row.entitySubtitle.trim()}`
      : line2 !== "—"
        ? line2
        : undefined

  const isClickable = Boolean(onNameClick && displayName !== "—")
  const nameClass = `deal_inv_identity_line1${
    displayName === "—" ? " um_status_muted" : ""
  }${isClickable ? " deal_inv_identity_name_btn" : ""}`

  return (
    <div className="deal_inv_identity_cell">
      <div className="um_user_avatar_ring" aria-hidden>
        <span className="um_user_initials">{initials}</span>
      </div>
      <div className="deal_inv_identity_text">
        <div className="deal_inv_identity_line1_row">
          {isClickable ? (
            <button
              type="button"
              className={nameClass}
              title={`View details for ${displayName}`}
              aria-label={`View details for ${displayName}`}
              onClick={(e) => {
                e.stopPropagation()
                onNameClick?.(row)
              }}
            >
              {displayName}
            </button>
          ) : (
            <span
              className={nameClass}
              title={displayName !== "—" ? displayName : undefined}
            >
              {displayName}
            </span>
          )}
          {isDraft ? (
            <span
              className="deals_list_draft_icon deals_list_draft_icon--draft"
              title="Unsaved draft"
            >
              <FilePenLine size={14} strokeWidth={2} aria-hidden />
              <span className="deals_list_sr_only">Draft</span>
            </span>
          ) : null}
        </div>
        <span
          className={`deal_inv_identity_line2 deal_inv_identity_ellipsis${
            line2 === "—" ? " um_status_muted" : ""
          }`}
          title={line2Title}
        >
          {line2}
        </span>
      </div>
    </div>
  )
}
