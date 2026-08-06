import {
  isDealMembersTabRole,
  isLpInvestorRole,
} from "../constants/investor-profile"
import type { DealInvestorRow } from "../types/deal-investors.types"

export type SponsorPickerOption = { id: string; label: string }

/** True when the row is a deal roster sponsor (Lead / Admin / Co-sponsor), not an LP investor pick. */
export function isDealSponsorRosterRow(row: DealInvestorRow): boolean {
  if (isDealMembersTabRole(row.investorRole)) return true
  for (const label of row.memberRoleLabels ?? []) {
    if (isDealMembersTabRole(label)) return true
  }
  return false
}

/** Investors tab rows eligible for Shared With (deal LPs only; no sponsors / deal members). */
export function filterLpInvestorsForDocumentSharedWith(
  rows: DealInvestorRow[],
): DealInvestorRow[] {
  return rows.filter((r) => {
    if (!r.id.trim()) return false
    if (isDealSponsorRosterRow(r)) return false
    const role = r.investorRole?.trim()
    if (role && role !== "—" && !isLpInvestorRole(role) && isDealMembersTabRole(role)) {
      return false
    }
    return true
  })
}

/**
 * Portal `users.id` for a sponsor roster row — matches `addedByUserId` on LP rows they added.
 */
export function resolveSponsorPortalUserId(
  member: DealInvestorRow,
  lpInvestors: DealInvestorRow[],
): string | null {
  const contactId = member.contactId?.trim()
  if (contactId) {
    const cidLower = contactId.toLowerCase()
    if (
      lpInvestors.some(
        (i) => i.addedByUserId?.trim().toLowerCase() === cidLower,
      )
    ) {
      return contactId
    }
  }

  const memberName = member.displayName?.trim()
  if (memberName && memberName !== "—") {
    for (const inv of lpInvestors) {
      const adderName = inv.addedByDisplayName?.trim()
      const uid = inv.addedByUserId?.trim()
      if (adderName === memberName && uid) return uid
    }
  }

  return contactId || null
}

/** Sponsor users on the deal roster (for “Sponsor investors” Shared With). */
export function buildSponsorUserPickerOptions(
  sponsorRoster: DealInvestorRow[],
  lpInvestors: DealInvestorRow[],
): SponsorPickerOption[] {
  const out: SponsorPickerOption[] = []
  const seen = new Set<string>()

  for (const m of sponsorRoster) {
    if (!isDealSponsorRosterRow(m)) continue
    const userId = resolveSponsorPortalUserId(m, lpInvestors)?.trim()
    if (!userId) continue
    const key = userId.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const name = m.displayName?.trim() || "—"
    const email =
      m.userEmail?.trim() && m.userEmail !== "—" ? m.userEmail.trim() : ""
    out.push({
      id: userId,
      label: email ? `${name} (${email})` : name,
    })
  }

  return out.sort((a, b) =>
    a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
  )
}

export function lpInvestorsAddedBySponsorUserId(
  sponsorUserId: string,
  lpInvestors: DealInvestorRow[],
): DealInvestorRow[] {
  const key = sponsorUserId.trim().toLowerCase()
  if (!key) return []
  return lpInvestors.filter(
    (i) => i.addedByUserId?.trim().toLowerCase() === key,
  )
}

export function buildSponsorPickerOptions(
  members: DealInvestorRow[],
): SponsorPickerOption[] {
  return members
    .map((m) => {
      const id = m.id?.trim() || ""
      const name = m.displayName?.trim() || "—"
      const email =
        m.userEmail?.trim() && m.userEmail !== "—" ? m.userEmail.trim() : ""
      if (!id) return null
      return {
        id,
        label: email ? `${name} (${email})` : name,
      }
    })
    .filter((x): x is SponsorPickerOption => x != null)
}

/** Shared With menu heading for sponsor-scoped LP audience. */
export const SPONSOR_USER_INVESTORS_MENU_LABEL = "Sponsor user investors"

export function sponsorAudienceSearchBlob(
  sponsorUserIds: string[],
  options: SponsorPickerOption[],
): string {
  const parts: string[] = ["sponsor user investors"]
  for (const id of sponsorUserIds) {
    const o = options.find((x) => x.id === id)
    if (o?.label) parts.push(o.label)
  }
  return parts.join(" ")
}
