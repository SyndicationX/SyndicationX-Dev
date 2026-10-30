import { CircleCheck, Clock3, Eye } from "lucide-react"
import { FormTooltip } from "../../../../../common/components/form-tooltip/FormTooltip"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import {
  investorRowShowsEsignStatusLink,
  investorSignedColumnDisplay,
  resolveInvestorRowEsignStatus,
} from "../../utils/investorEsignStatus"

export interface DealInvestorSignedCellProps {
  row: DealInvestorRow
  onOpenEsignStatus?: (row: DealInvestorRow) => void
}

type SignedTone = "done" | "viewed" | "sent"

function signedTone(display: string): SignedTone | null {
  const value = display.trim().toLowerCase()
  if (!value || value === "—") return null
  if (value === "sent" || value === "pending") return "sent"
  if (value === "viewed") return "viewed"
  return "done"
}

function signedColumnHover(display: string): string | null {
  const value = display.trim().toLowerCase()
  if (value === "signed") {
    return "The investor signed. Waiting for the sponsor to counter-sign."
  }
  if (value === "completed") {
    return "The investor and the sponsor have both signed."
  }
  return null
}

function SignedStatusIcon({ tone }: { tone: SignedTone }) {
  const props = { size: 12, strokeWidth: 2, "aria-hidden": true as const }
  if (tone === "sent") return <Clock3 {...props} />
  if (tone === "viewed") return <Eye {...props} />
  return <CircleCheck {...props} />
}

export function DealInvestorSignedCell({
  row,
  onOpenEsignStatus,
}: DealInvestorSignedCellProps) {
  const display = investorSignedColumnDisplay(row)
  const hasEsignWorkflow =
    Boolean(resolveInvestorRowEsignStatus(row)?.sentAt?.trim()) ||
    investorRowShowsEsignStatusLink(row)
  const clickable = hasEsignWorkflow && Boolean(onOpenEsignStatus)

  if (import.meta.env.DEV && display === "—" && row.docSignedDateIso) {
    console.debug("[DealInvestorSignedCell] row has docSignedDateIso but column is —", {
      id: row.id,
      docSignedDateIso: row.docSignedDateIso,
      signedDate: row.signedDate,
      esignStatus: row.esignStatus,
      esignStatusBundleJson: row.esignStatusBundleJson?.slice?.(0, 80),
    })
  }

  const tone = signedTone(display)
  if (!tone) {
    return <span className="deal_inv_signed_empty">—</span>
  }

  const hover = signedColumnHover(display)
  const className = `deal_inv_signed_pill deal_inv_signed_pill--${tone}`
  const label = (
    <>
      <span className="deal_inv_signed_pill_icon">
        <SignedStatusIcon tone={tone} />
      </span>
      <span className="deal_inv_signed_pill_label">{display}</span>
    </>
  )

  const pill = (
    <span
      className={className}
      onClick={
        clickable
          ? (e) => {
              e.stopPropagation()
              e.preventDefault()
              const targetRow = row
              queueMicrotask(() => onOpenEsignStatus?.(targetRow))
            }
          : undefined
      }
    >
      {label}
    </span>
  )

  if (!hover) return pill

  return (
    <FormTooltip
      triggerMode="inline"
      nativeButtonTrigger={false}
      openOnHover
      placement="top"
      panelAlign="start"
      className="deal_inv_signed_hover_root"
      label={hover}
      content={<p className="deal_inv_signed_hover">{hover}</p>}
    >
      {pill}
    </FormTooltip>
  )
}
