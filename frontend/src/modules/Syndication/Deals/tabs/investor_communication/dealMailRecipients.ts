import { investorRoleLabel } from "../../constants/investor-profile"
import { ADD_MEMBER_DRAFT_ROW_ID } from "../deal_members/add-investment/addMemberDraftInvestorRow"
import type { DealInvestorRow } from "../../types/deal-investors.types"

export type DealMailRecipientGroup = "investor" | "deal_member"

export interface DealMailRecipient {
  id: string
  displayName: string
  email: string
  groups: DealMailRecipientGroup[]
  roleLabel: string
}

function roleLabelForRow(row: DealInvestorRow): string {
  const fromLabels = row.memberRoleLabels
    ?.map((s) => String(s ?? "").trim())
    .filter((s) => s && s !== "—")
  if (fromLabels?.length) return fromLabels.join(", ")
  const role = String(row.investorRole ?? "").trim()
  if (!role || role === "—") return "—"
  return investorRoleLabel(role)
}

function groupLabel(groups: DealMailRecipientGroup[]): string {
  const hasInv = groups.includes("investor")
  const hasMem = groups.includes("deal_member")
  if (hasInv && hasMem) return "Investor & member"
  if (hasInv) return "Investor"
  if (hasMem) return "Deal member"
  return "—"
}

export function groupLabelForDealMailRecipient(r: DealMailRecipient): string {
  return groupLabel(r.groups)
}

export function mergeDealInvestorsAndMembersToRecipients(
  investors: DealInvestorRow[],
  members: DealInvestorRow[],
): DealMailRecipient[] {
  const byEmail = new Map<string, DealMailRecipient>()

  function add(row: DealInvestorRow, group: DealMailRecipientGroup) {
    if (row.id === ADD_MEMBER_DRAFT_ROW_ID) return
    const email = String(row.userEmail ?? "").trim()
    if (!email.includes("@")) return
    const key = email.toLowerCase()
    const displayName =
      row.displayName?.trim() ||
      row.userDisplayName?.trim() ||
      email
    const roleLabel = roleLabelForRow(row)
    const existing = byEmail.get(key)
    if (existing) {
      if (!existing.groups.includes(group)) existing.groups.push(group)
      if (existing.displayName === email && displayName !== email) {
        existing.displayName = displayName
      }
      return
    }
    byEmail.set(key, {
      id: `${group}-${row.id}-${key}`,
      displayName,
      email,
      groups: [group],
      roleLabel,
    })
  }

  for (const row of investors) add(row, "investor")
  for (const row of members) add(row, "deal_member")

  return [...byEmail.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "base",
    }),
  )
}
