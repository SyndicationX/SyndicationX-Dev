import { EMAIL_UNAVAILABLE_LABEL } from "../../../../../common/utils/displayEmail"
import { ADD_MEMBER_DRAFT_ROW_ID } from "../deal_members/add-investment/addMemberDraftInvestorRow"
import {
  isDealMembersTabRole,
  isGeneralPartnerRole,
  isLpInvestorRole,
  investorRoleLabel,
} from "../../constants/investor-profile"
import type { DealInvestorClass } from "../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import {
  isGpInvestorClass,
  isLpInvestorClass,
} from "../../utils/investorClassOverviewFields"

export type DealMailRecipientGroup = "investor" | "deal_member"
export type InvestorClassKind = "lp" | "gp"

export interface DealMailRecipient {
  id: string
  displayName: string
  email: string
  groups: DealMailRecipientGroup[]
  roleLabel: string
  classKind: InvestorClassKind
  className: string
  sponsorKey: string
  sponsorName: string
  sponsorEmail: string
  addedByUserId: string
  addedByIsCoSponsor: boolean
  requiresCosponsorRelease: boolean
  /** Yes-intercept co-sponsor LPs: lead mail goes to co-sponsor and those LPs. */
  includeCoSponsorOnSend: boolean
  sourceRowId: string
  sourceKind: "investor" | "member"
  /** Investor or cosponsor has an address that can actually receive the mail. */
  canDeliver: boolean
}

export interface DealMailLpSponsorGroup {
  key: string
  sponsorName: string
  sponsorEmail: string
  isCosponsor: boolean
  requiresRelease: boolean
  intercept: "yes" | "no" | null
  recipients: DealMailRecipient[]
}

export interface DealMailRecipientTree {
  gps: DealMailRecipient[]
  lps: DealMailRecipient[]
  sponsors: DealMailRecipient[]
  lpGroups: DealMailLpSponsorGroup[]
}

export interface BuildDealMailRecipientsInput {
  investors: DealInvestorRow[]
  classes: DealInvestorClass[]
  viewerUserId?: string
  viewerEmail?: string
}

const NONE_SPONSOR_KEY = "none"
const LEAD_ADMIN_GROUP_LABEL = "Lead / Admin LPs"
const NO_COSPONSOR_GROUP_LABEL = "No cosponsor"

function usableEmail(raw: unknown): string {
  const email = String(raw ?? "").trim()
  if (!email.includes("@")) return ""
  if (email.toLowerCase() === EMAIL_UNAVAILABLE_LABEL.toLowerCase()) return ""
  return email
}

function roleLabelForRow(row: DealInvestorRow): string {
  const fromLabels = row.memberRoleLabels
    ?.map((s) => investorRoleLabel(String(s ?? "").trim()))
    .filter((s) => s && s !== "—")
  if (fromLabels?.length) return fromLabels.join(", ")
  const role = String(row.investorRole ?? "").trim()
  if (!role || role === "—") return "—"
  return investorRoleLabel(role)
}

function groupLabel(groups: DealMailRecipientGroup[]): string {
  const hasInv = groups.includes("investor")
  const hasMem = groups.includes("deal_member")
  if (hasInv && hasMem) return "Investor & general partner"
  if (hasInv) return "Investor"
  if (hasMem) return "General Partner"
  return "—"
}

export function groupLabelForDealMailRecipient(r: {
  groups: DealMailRecipientGroup[]
}): string {
  return groupLabel(r.groups)
}

function matchInvestorClass(
  row: DealInvestorRow,
  classes: DealInvestorClass[],
): DealInvestorClass | null {
  const raw = String(row.investorClass ?? "").trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  return (
    classes.find(
      (c) =>
        c.id.trim().toLowerCase() === lower ||
        c.name.trim().toLowerCase() === lower,
    ) ?? null
  )
}

export function classKindForInvestorRow(
  row: DealInvestorRow,
  classes: DealInvestorClass[],
): InvestorClassKind {
  const matched = matchInvestorClass(row, classes)
  if (matched) {
    if (isGpInvestorClass(matched)) return "gp"
    if (isLpInvestorClass(matched)) return "lp"
  }
  const className = String(row.investorClass ?? "").trim().toLowerCase()
  if (/\bgp\b|general partner/.test(className)) return "gp"
  if (/\blp\b|limited partner/.test(className)) return "lp"
  if (isGeneralPartnerRole(row.investorRole)) return "gp"
  if (
    isDealMembersTabRole(row.investorRole) &&
    !isLpInvestorRole(row.investorRole)
  )
    return "gp"
  return "lp"
}

function sponsorKeyForRow(row: DealInvestorRow): string {
  const uid = String(row.addedByUserId ?? "").trim().toLowerCase()
  if (uid) return `uid:${uid}`
  const email = usableEmail(row.addedByEmail)
  if (email) return `em:${email.toLowerCase()}`
  const name = String(row.addedByDisplayName ?? "").trim()
  if (name && name !== "—") return `nm:${name.toLowerCase()}`
  return NONE_SPONSOR_KEY
}

function sponsorNameForRow(row: DealInvestorRow, isCosponsor: boolean): string {
  const name = String(row.addedByDisplayName ?? "").trim()
  if (name && name !== "—") return name
  const email = usableEmail(row.addedByEmail)
  if (email) return email
  if (isCosponsor) return "Co-sponsor"
  if (sponsorKeyForRow(row) === NONE_SPONSOR_KEY) return NO_COSPONSOR_GROUP_LABEL
  return LEAD_ADMIN_GROUP_LABEL
}

function viewerOwnsSponsor(
  row: DealInvestorRow,
  viewerUserId: string,
  viewerEmail: string,
): boolean {
  const uid = String(row.addedByUserId ?? "").trim().toLowerCase()
  if (viewerUserId && uid && uid === viewerUserId) return true
  const email = usableEmail(row.addedByEmail).toLowerCase()
  if (viewerEmail && email && email === viewerEmail) return true
  return false
}

function roleIsLeadSponsor(role: string): boolean {
  return role.trim().toLowerCase() === "lead sponsor"
}

function roleIsAdminSponsor(role: string): boolean {
  return role.trim().toLowerCase() === "admin sponsor"
}

function roleIsCoSponsor(role: string): boolean {
  const t = role.trim().toLowerCase()
  return t === "co-sponsor" || t === "co sponsor"
}

function roleIsRosterSponsor(role: string): boolean {
  return (
    roleIsLeadSponsor(role) || roleIsAdminSponsor(role) || roleIsCoSponsor(role)
  )
}

function memberRoles(row: DealInvestorRow): string[] {
  const out: string[] = []
  const role = String(row.investorRole ?? "").trim()
  if (role && role !== "—") out.push(role)
  for (const lab of row.memberRoleLabels ?? []) {
    const t = String(lab ?? "").trim()
    if (t && t !== "—") out.push(t)
  }
  return out
}

function rowIsRosterSponsor(row: DealInvestorRow): boolean {
  return memberRoles(row).some(roleIsRosterSponsor)
}

function rowIsCoSponsorMember(row: DealInvestorRow): boolean {
  return memberRoles(row).some(roleIsCoSponsor)
}

/** Recipient holds a Lead Sponsor, Admin sponsor, or Co-sponsor role on this deal. */
export function isSponsorMailRecipient(recipient: {
  roleLabel: string
}): boolean {
  return recipient.roleLabel.split(",").some(roleIsRosterSponsor)
}

function isClassBGeneralPartnerClassName(className: string): boolean {
  const n = className.trim().toLowerCase()
  if (!n) return false
  if (/\bclass\s*b\b/.test(n)) return true
  if (n.includes("general partner")) return true
  if (/\bgp\b/.test(n)) return true
  return false
}

/** Class B / GP-class investors only — not admin or co-sponsors. */
export function isClassBGeneralPartnerMailRecipient(
  recipient: DealMailRecipient,
): boolean {
  if (isSponsorMailRecipient(recipient)) return false
  if (isClassBGeneralPartnerClassName(recipient.className)) return true
  const role = recipient.roleLabel.trim().toLowerCase()
  return role === "general partner" || role === "team member"
}

function sortByName(a: DealMailRecipient, b: DealMailRecipient): number {
  return a.displayName.localeCompare(b.displayName, undefined, {
    sensitivity: "base",
  })
}

export function buildDealMailRecipients({
  investors,
  classes,
  viewerUserId = "",
  viewerEmail = "",
}: BuildDealMailRecipientsInput): DealMailRecipient[] {
  const viewerId = viewerUserId.trim().toLowerCase()
  const viewerEm = viewerEmail.trim().toLowerCase()
  const out: DealMailRecipient[] = []

  for (const row of investors) {
    if (row.id === ADD_MEMBER_DRAFT_ROW_ID) continue
    const email = usableEmail(row.userEmail)
    const classKind = classKindForInvestorRow(row, classes)
    const isCosponsor =
      row.addedByIsCoSponsorOnDeal === true ||
      row.addedByCoSponsorEmailIntercept === "yes" ||
      row.addedByCoSponsorEmailIntercept === "no"
    const intercept = row.addedByCoSponsorEmailIntercept === "no" ? "no" : "yes"
    const holdAtCoSponsor = isCosponsor && intercept === "no"
    const includeCoSponsorOnSend = isCosponsor && intercept === "yes"
    const requiresCosponsorRelease =
      classKind === "lp" &&
      holdAtCoSponsor &&
      !viewerOwnsSponsor(row, viewerId, viewerEm)
    const hideLpEmailFromViewer =
      classKind === "lp" &&
      isCosponsor &&
      !viewerOwnsSponsor(row, viewerId, viewerEm)
    const sponsorEmail = usableEmail(row.addedByEmail)
    const canDeliver = Boolean(
      (!hideLpEmailFromViewer && email) ||
        (requiresCosponsorRelease && sponsorEmail) ||
        includeCoSponsorOnSend,
    )

    const displayName =
      row.displayName?.trim() ||
      row.userDisplayName?.trim() ||
      (hideLpEmailFromViewer ? "" : email) ||
      "Investor"
    const className = String(row.investorClass ?? "").trim()
    out.push({
      id: `investor-${row.id}-${email || sponsorKeyForRow(row) || row.id}`,
      displayName,
      email: hideLpEmailFromViewer ? "" : email,
      groups: ["investor"],
      roleLabel: roleLabelForRow(row),
      classKind,
      className,
      sponsorKey: sponsorKeyForRow(row),
      sponsorName: sponsorNameForRow(row, isCosponsor),
      sponsorEmail,
      addedByUserId: String(row.addedByUserId ?? "").trim(),
      addedByIsCoSponsor: isCosponsor,
      requiresCosponsorRelease,
      includeCoSponsorOnSend:
        classKind === "lp" &&
        includeCoSponsorOnSend &&
        !viewerOwnsSponsor(row, viewerId, viewerEm),
      sourceRowId: row.id,
      sourceKind: "investor",
      canDeliver,
    })
  }

  return out.sort(sortByName)
}

export function groupDealMailRecipients(
  recipients: DealMailRecipient[],
): DealMailRecipientTree {
  const sponsors = recipients
    .filter(isSponsorMailRecipient)
    .sort(sortByName)
  const gps = recipients
    .filter(isClassBGeneralPartnerMailRecipient)
    .sort(sortByName)
  const lps = recipients
    .filter(
      (r) =>
        r.classKind === "lp" &&
        !isSponsorMailRecipient(r) &&
        !isClassBGeneralPartnerMailRecipient(r),
    )
    .sort(sortByName)
  const bySponsor = new Map<string, DealMailLpSponsorGroup>()

  for (const r of lps) {
    const existing = bySponsor.get(r.sponsorKey)
    if (existing) {
      existing.recipients.push(r)
      if (r.sponsorEmail && !existing.sponsorEmail)
        existing.sponsorEmail = r.sponsorEmail
      if (r.requiresCosponsorRelease) existing.requiresRelease = true
      if (r.requiresCosponsorRelease) existing.intercept = "no"
      else if (r.includeCoSponsorOnSend && existing.intercept !== "no")
        existing.intercept = "yes"
      continue
    }
    bySponsor.set(r.sponsorKey, {
      key: r.sponsorKey,
      sponsorName:
        r.addedByIsCoSponsor || r.sponsorKey === NONE_SPONSOR_KEY
          ? r.sponsorName
          : r.sponsorName || LEAD_ADMIN_GROUP_LABEL,
      sponsorEmail: r.sponsorEmail,
      isCosponsor: r.addedByIsCoSponsor,
      requiresRelease: r.requiresCosponsorRelease,
      intercept: r.requiresCosponsorRelease
        ? "no"
        : r.includeCoSponsorOnSend
          ? "yes"
          : null,
      recipients: [r],
    })
  }

  const lpGroups = [...bySponsor.values()].sort((a, b) => {
    if (a.requiresRelease !== b.requiresRelease)
      return a.requiresRelease ? 1 : -1
    if (a.key === NONE_SPONSOR_KEY) return 1
    if (b.key === NONE_SPONSOR_KEY) return -1
    return a.sponsorName.localeCompare(b.sponsorName, undefined, {
      sensitivity: "base",
    })
  })

  return { gps, lps, sponsors, lpGroups }
}

export function deliveryEmailsForRecipients(
  selected: DealMailRecipient[],
): string[] {
  const emails: string[] = []
  for (const r of selected) {
    if (r.requiresCosponsorRelease) {
      if (r.sponsorEmail.includes("@")) emails.push(r.sponsorEmail)
      continue
    }
    if (r.addedByIsCoSponsor && r.classKind === "lp") {
      if (r.includeCoSponsorOnSend || r.requiresCosponsorRelease) {
        if (r.sponsorEmail.includes("@")) emails.push(r.sponsorEmail)
        continue
      }
    }
    if (r.email.includes("@")) emails.push(r.email)
    if (r.includeCoSponsorOnSend && r.sponsorEmail.includes("@")) {
      emails.push(r.sponsorEmail)
    }
  }
  return [...new Set(emails.map((e) => e.trim().toLowerCase()))]
}

export function mergeDealInvestorRowsForMail(
  lpInvestors: DealInvestorRow[],
  allInvestors: DealInvestorRow[],
): DealInvestorRow[] {
  const byId = new Map<string, DealInvestorRow>()
  for (const row of allInvestors) {
    if (!row.id || row.id === ADD_MEMBER_DRAFT_ROW_ID) continue
    byId.set(row.id, row)
  }
  for (const row of lpInvestors) {
    if (!row.id || row.id === ADD_MEMBER_DRAFT_ROW_ID) continue
    byId.set(row.id, row)
  }
  return [...byId.values()]
}

/** Positions of recipients that are the same person as this roster row. */
function listedRecipientIndexes(
  recipients: DealMailRecipient[],
  row: DealInvestorRow,
): number[] {
  const email = usableEmail(row.userEmail).toLowerCase()
  const contactId = String(row.contactId ?? "").trim().toLowerCase()
  const out: number[] = []
  recipients.forEach((r, i) => {
    if (email && r.email.trim().toLowerCase() === email) out.push(i)
    else if (contactId && r.sourceRowId.trim().toLowerCase() === contactId)
      out.push(i)
    else if (r.sourceRowId && r.sourceRowId === row.id) out.push(i)
  })
  return out
}

function rosterSponsorFallbackName(row: DealInvestorRow): string {
  for (const role of memberRoles(row)) {
    if (roleIsLeadSponsor(role)) return "Lead sponsor"
    if (roleIsAdminSponsor(role)) return "Admin sponsor"
    if (roleIsCoSponsor(role)) return "Co-sponsor"
  }
  return "Sponsor"
}

function withRosterSponsorRole(
  recipient: DealMailRecipient,
  row: DealInvestorRow,
): DealMailRecipient {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const label of [roleLabelForRow(row), recipient.roleLabel]) {
    for (const part of label.split(",")) {
      const t = part.trim()
      if (!t || t === "—") continue
      const key = t.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      labels.push(t)
    }
  }
  const rosterEmail = usableEmail(row.userEmail)
  return {
    ...recipient,
    roleLabel: labels.length > 0 ? labels.join(", ") : "—",
    groups: recipient.groups.includes("deal_member")
      ? recipient.groups
      : [...recipient.groups, "deal_member"],
    /**
     * A sponsor's own address is already on the General Partners roster, so mail reaches
     * them directly instead of being held for whoever added their commitment. Any
     * co-sponsor copy on that commitment still applies.
     */
    ...(rosterEmail
      ? {
          email: rosterEmail,
          requiresCosponsorRelease: false,
          canDeliver: true,
        }
      : {}),
  }
}

/**
 * Deal roster sponsors (Lead Sponsor, Admin sponsor, Co-sponsor) belong on the Sponsors
 * tab even when they also hold a commitment on the deal. The roster role is stamped onto
 * their existing investor line so they stop being grouped by investor class, and any
 * further commitment rows for the same person collapse into that one line.
 */
export function appendDealRosterSponsorsAsRecipients(
  recipients: DealMailRecipient[],
  members: DealInvestorRow[],
): DealMailRecipient[] {
  const out = [...recipients]
  const collapsed = new Set<number>()
  for (const row of members) {
    if (row.id === ADD_MEMBER_DRAFT_ROW_ID) continue
    if (!rowIsRosterSponsor(row)) continue
    const matches = listedRecipientIndexes(out, row).filter(
      (i) => !collapsed.has(i),
    )
    const [keep, ...duplicates] = matches
    if (keep !== undefined) {
      out[keep] = withRosterSponsorRole(out[keep]!, row)
      for (const i of duplicates) collapsed.add(i)
      continue
    }
    const email = usableEmail(row.userEmail)
    const displayName =
      row.displayName?.trim() ||
      row.userDisplayName?.trim() ||
      email ||
      rosterSponsorFallbackName(row)
    out.push({
      id: `member-${row.id}-${email || row.id}`,
      displayName,
      email,
      groups: ["deal_member"],
      roleLabel: roleLabelForRow(row),
      classKind: "gp",
      className: String(row.investorClass ?? "").trim(),
      sponsorKey: sponsorKeyForRow(row),
      sponsorName: displayName,
      sponsorEmail: email,
      addedByUserId: String(row.addedByUserId ?? "").trim(),
      addedByIsCoSponsor: rowIsCoSponsorMember(row),
      requiresCosponsorRelease: false,
      includeCoSponsorOnSend: false,
      sourceRowId: row.id,
      sourceKind: "member",
      canDeliver: Boolean(email),
    })
  }
  return out.filter((_, i) => !collapsed.has(i)).sort(sortByName)
}

export function defaultDealMailRecipientIds(
  recipients: DealMailRecipient[],
  opts: { preselectEmails?: string[] } = {},
): Set<string> {
  const preselect = new Set(
    (opts.preselectEmails ?? [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  )
  if (preselect.size === 0) return new Set()
  return new Set(
    recipients
      .filter((r) => {
        const email = r.email.trim().toLowerCase()
        const sponsor = r.sponsorEmail.trim().toLowerCase()
        return (
          (email && preselect.has(email)) ||
          (sponsor && preselect.has(sponsor))
        )
      })
      .map((r) => r.id),
  )
}

export function mergeDealInvestorsAndMembersToRecipients(
  investors: DealInvestorRow[],
  members: DealInvestorRow[] = [],
): DealMailRecipient[] {
  return appendDealRosterSponsorsAsRecipients(
    buildDealMailRecipients({ investors, classes: [] }),
    members,
  )
}

/** Co-sponsor send picker: only LPs this viewer added — never lead/admin GPs or their LPs. */
export function filterDealMailRecipientsForCoSponsorViewer(
  recipients: DealMailRecipient[],
  opts: { viewerUserId?: string; viewerEmail?: string },
): DealMailRecipient[] {
  const viewerId = String(opts.viewerUserId ?? "").trim().toLowerCase()
  const viewerEm = String(opts.viewerEmail ?? "").trim().toLowerCase()
  return recipients.filter((r) => {
    if (r.classKind !== "lp") return false
    const uid = r.addedByUserId.trim().toLowerCase()
    if (viewerId && uid && uid === viewerId) return true
    const sponsor = r.sponsorEmail.trim().toLowerCase()
    if (viewerEm && sponsor && sponsor === viewerEm) return true
    return false
  })
}
