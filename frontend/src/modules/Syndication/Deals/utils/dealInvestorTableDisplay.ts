import {
  ADD_MEMBER_DRAFT_ROW_ID,
  investorRowShowsDraftBadge,
} from "../tabs/deal_members/add-investment/addMemberDraftInvestorRow"
import type { DealInvestorRow } from "../types/deal-investors.types"
import { formatDateDdMmmYyyy } from "../../../../common/utils/formatDateDisplay"
import {
  INVESTMENT_STATUS_APPROVE_FUND,
  investmentStatusLabel,
  resolveInvestmentStatusSelectValue,
} from "../constants/investment-status"

/**
 * Status column: avoid repeating "Draft" when the row is already marked as draft
 * (badge / draft row).
 */
/** Stored removal status is `Removed`; the tables and filters say Investment removed. */
export function formatStoredInvestmentStatus(status: string): string {
  const s = String(status ?? "").trim()
  if (s.toLowerCase() === "removed") return "Investment removed"
  return s
}

export function dealInvestorStatusForTable(row: DealInvestorRow): string {
  if (row.id === ADD_MEMBER_DRAFT_ROW_ID) return "—"
  const s = String(row.status ?? "").trim()
  if (!s || s === "—") return "—"
  const draftContext = investorRowShowsDraftBadge(row)
  if (draftContext && s.toLowerCase() === "draft") return "—"
  if (row.sponsorRemoved || s.toLowerCase() === "removed") return "Investment removed"
  return s
}

/**
 * Status for display: maps stored DB/API values (e.g. `Signed`, `Soft committed`)
 * to the same labels used in Add Investment, when applicable.
 */
export function dealInvestorStatusDisplayLabel(row: DealInvestorRow): string {
  const t = dealInvestorStatusForTable(row)
  if (t === "—") return "—"
  return investmentStatusLabel(t)
}

/** True when sponsor “Approve fund” has been applied or funds are complete (matches workflow status). */
export function investorRowIsFundApproved(row: DealInvestorRow): boolean {
  if (row.id === ADD_MEMBER_DRAFT_ROW_ID) return false
  if (typeof row.fundApproved === "boolean") return row.fundApproved
  const raw = String(row.status ?? "").trim()
  if (!raw || raw === "—") return false
  const normalized = resolveInvestmentStatusSelectValue(raw) || raw
  if (normalized === INVESTMENT_STATUS_APPROVE_FUND) return true
  if (normalized === "Funds fully received (complete)") return true
  return false
}

/** Datatable / export under the Funded column: Funded vs Not Funded (same logic as `investorRowIsFundApproved`). */
export function investorFundedColumnLabel(row: DealInvestorRow): string {
  return investorRowIsFundApproved(row) ? "Funded" : "Not Funded"
}

/** Funded date column: calendar day of fund approval, or an em dash. */
export function investorFundedDateLabel(row: DealInvestorRow): string {
  if (!investorRowIsFundApproved(row)) return "—"
  const iso = String(row.fundApprovedAtIso ?? "").trim()
  if (!iso) return "—"
  return formatDateDdMmmYyyy(iso)
}
