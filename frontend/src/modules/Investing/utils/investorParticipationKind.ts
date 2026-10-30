import type { DealInvestorRow } from "@/modules/Syndication/Deals/types/deal-investors.types"
import { investorRowCommittedAmountNumeric } from "@/modules/Syndication/Deals/utils/offeringMoneyFormat"

export type InvestorParticipationKind =
  | "invested"
  | "soft_committed"
  | "draft"
  | "in_progress"

function isSoftCommittedStatus(status: string): boolean {
  const s = status.trim().toLowerCase()
  return s === "soft committed" || s === "soft commitment"
}

function statusLooksInvested(status: string): boolean {
  const s = status.trim().toLowerCase()
  if (!s || s === "—" || isSoftCommittedStatus(s)) return false
  if (
    s === "open to investment" ||
    s === "open to soft commitment" ||
    s === "open to hard commitment" ||
    s.startsWith("draft") ||
    s.startsWith("coming soon") ||
    s.startsWith("waitlist") ||
    s.startsWith("closed") ||
    s.startsWith("past")
  ) {
    return false
  }
  return (
    /funds?\s+(fully|partially)\s+received/.test(s) ||
    s === "signed" ||
    s === "counter-signed" ||
    s.startsWith("funding instructions") ||
    s.startsWith("investment started") ||
    s.startsWith("document signing") ||
    s.startsWith("inactive") ||
    s.startsWith("canceled") ||
    s === "active"
  )
}

export function isInvestorCommitmentRow(row: DealInvestorRow): boolean {
  const kind = row.investorKind
  return kind !== "lp_roster" && kind !== "member_roster"
}

export function investorParticipationKind(
  row: Pick<
    DealInvestorRow,
    "status" | "fundApproved" | "commitmentCompletedAtIso" | "esignStatus"
  > & { committed?: string },
): InvestorParticipationKind {
  const status = String(row.status ?? "")
  const completed = Boolean(
    String(row.commitmentCompletedAtIso ?? "").trim() &&
      String(row.commitmentCompletedAtIso ?? "").trim() !== "—",
  )
  const esignDone = Boolean(
    String(row.esignStatus?.completedAt ?? "").trim() &&
      String(row.esignStatus?.completedAt ?? "").trim() !== "—",
  )
  if (row.fundApproved === true || statusLooksInvested(status)) return "invested"
  if (isSoftCommittedStatus(status)) return "soft_committed"
  if (completed || esignDone) return "invested"
  const amount = investorRowCommittedAmountNumeric(row as DealInvestorRow)
  if (!(amount > 0)) return "draft"
  return "in_progress"
}

/** Soft-committed deals can be deleted. Invested or in-progress deals cannot. */
export function viewerCanDeleteInvestingDeal(rows: DealInvestorRow[]): boolean {
  const mine = rows.filter(isInvestorCommitmentRow)
  if (mine.length === 0) return false
  let soft = 0
  for (const row of mine) {
    const kind = investorParticipationKind(row)
    if (kind === "invested" || kind === "in_progress") return false
    if (kind === "soft_committed") soft += 1
  }
  return soft > 0
}
