import { getSessionUserEmail } from "@/common/auth/sessionUserEmail"
import {
  getLpInvestorDealIdsFromSession,
  isLpInvestorSessionUser,
  isPlatformAdmin,
} from "@/common/auth/roleUtils"
import { fetchPlatformSignupNotifications } from "./fetchPlatformSignupNotifications"
import { getMergedInvestmentListRows } from "@/modules/Investing/pages/investments/investmentsRuntimeData"
import {
  fetchDealInvestors,
  fetchDealMembers,
  fetchDealMyEsignDocuments,
  fetchDealsList,
} from "@/modules/Syndication/Deals/api/dealsApi"
import { esignCategoryLabel } from "@/modules/Syndication/Deals/utils/esignTemplateCategories"
import { investorRowIsFundApproved } from "@/modules/Syndication/Deals/utils/dealInvestorTableDisplay"
import type { DealInvestorRow } from "@/modules/Syndication/Deals/types/deal-investors.types"
import {
  dealRowSupportsRosterApiPrefetch,
  filterDealListRowsVisibleToInvestors,
  resolveViewerInvestingDealRoles,
  viewerDealNeedsOnboarding,
} from "@/modules/Investing/utils/investingViewerDealScope"
import {
  allInvestorsInvestorPhaseComplete,
  investorRowAwaitingSponsorCounterSign,
  investorRowCommittedNumeric,
  investorRowInvestorPhaseSigned,
  investorRowLatestEsignSignedAt,
  investorRowMatchesViewerEmail,
  investorEsignWasSent,
} from "@/modules/Syndication/Deals/utils/investorEsignStatus"
import { parseMoneyDigits } from "@/modules/Syndication/Deals/utils/offeringMoneyFormat"
import type { PortalNotification } from "../types/notification.types"
import { mapWithConcurrency } from "../utils/mapWithConcurrency"

function capitalizeFirst(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1)
}

function isoOrNow(iso: string | null | undefined): string {
  const t = iso?.trim()
  if (!t) return new Date().toISOString()
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

type NotificationDraft = Omit<PortalNotification, "read">

function viewerMatchingDealRows(
  rows: DealInvestorRow[],
  viewerEmail: string,
): DealInvestorRow[] {
  return rows.filter((r) => investorRowMatchesViewerEmail(r, viewerEmail))
}

function latestInviteTimestamp(
  rows: DealInvestorRow[],
  fallback?: string | null,
): string {
  let best: string | null = null
  let bestMs = -1
  for (const row of rows) {
    const iso = row.investedAtIso?.trim()
    if (!iso) continue
    const ms = Date.parse(iso)
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms
      best = iso
    }
  }
  return isoOrNow(best ?? fallback)
}

/** Alert when the signed-in user was invited to a deal (email sent or LP roster invite). */
async function collectDealInvitationNotifications(
  out: NotificationDraft[],
): Promise<void> {
  const viewerEmail = getSessionUserEmail().trim().toLowerCase()
  if (!viewerEmail) return

  const deals = filterDealListRowsVisibleToInvestors(
    await fetchDealsList({ includeParticipantDeals: true }),
  ).slice(0, 24)

  if (deals.length === 0) return

  await mapWithConcurrency(deals, 4, async (deal) => {
    const dealId = deal.id.trim()
    if (!dealId || !dealRowSupportsRosterApiPrefetch(deal)) return

    const dealName = deal.dealName?.trim() || "Deal"
    const [investorsPayload, membersPayload] = await Promise.all([
      fetchDealInvestors(dealId),
      fetchDealMembers(dealId),
    ])

    const investorMatches = viewerMatchingDealRows(
      investorsPayload.investors,
      viewerEmail,
    )
    const memberMatches = viewerMatchingDealRows(
      membersPayload.members,
      viewerEmail,
    )
    const allMatches = [...investorMatches, ...memberMatches]

    const invitationMailSent = allMatches.some(
      (r) => r.invitationMailSent === true,
    )
    const invitedAsLp = viewerDealNeedsOnboarding(
      investorsPayload,
      viewerEmail,
    )

    if (!invitationMailSent && !invitedAsLp) return

    const roles = resolveViewerInvestingDealRoles(
      membersPayload.members,
      investorsPayload.investors,
      viewerEmail,
      investorsPayload,
    )
    const sponsorLabels = roles.sponsorRoleLabels
    const createdAt = latestInviteTimestamp(allMatches, deal.createdAt)

    let href: string
    let message: string

    if (sponsorLabels.length > 0 && !invitedAsLp) {
      href = `/deals/${encodeURIComponent(dealId)}`
      message =
        sponsorLabels.length === 1
          ? `You've been invited to ${dealName} as ${sponsorLabels[0]}. Open the deal workspace to get started.`
          : `You've been invited to ${dealName} (${sponsorLabels.join(", ")}). Open the deal workspace to get started.`
    } else if (invitedAsLp) {
      href = `/investing/investments/${encodeURIComponent(dealId)}`
      message = `You've been invited to participate in ${dealName} as an investor. Complete onboarding to review the offering and invest.`
    } else {
      href = `/investing/investments/${encodeURIComponent(dealId)}`
      message = `You've been invited to participate in ${dealName}. Sign in to review the offering and next steps.`
    }

    out.push({
      id: `deal-invite:${dealId}`,
      title: "You've been invited to a deal",
      message,
      category: "deal",
      createdAt,
      href,
    })
  })
}

async function collectLpInvestorNotifications(
  out: NotificationDraft[],
): Promise<void> {
  const viewerEmail = getSessionUserEmail().trim().toLowerCase()
  if (!viewerEmail) return

  const investments = await getMergedInvestmentListRows()
  const active = investments.filter((r) => !r.archived)
  const dealMeta = new Map<string, { name: string }>()
  for (const row of active) {
    const dealId = (row.dealId ?? row.id ?? "").trim()
    if (!dealId) continue
    dealMeta.set(dealId, {
      name: row.investmentName?.trim() || row.offeringName?.trim() || "Investment",
    })
  }

  const dealIds = [...dealMeta.keys()].slice(0, 24)
  if (dealIds.length === 0) return

  await mapWithConcurrency(dealIds, 4, async (dealId) => {
    const dealName = dealMeta.get(dealId)?.name ?? "Investment"
    const [esign, investorsPayload] = await Promise.all([
      fetchDealMyEsignDocuments(dealId),
      fetchDealInvestors(dealId),
    ])

    const pendingDocs = esign.documents.filter(
      (d) => d.status !== "signed" && d.signatureRequestId?.trim(),
    )
    const canSignNow =
      esign.sequentialSignTurnOpen !== false && pendingDocs.length > 0

    if (canSignNow) {
      for (const doc of pendingDocs) {
        const docLabel = capitalizeFirst(doc.name || "Document")
        const categoryLabel = doc.categoryId
          ? esignCategoryLabel(doc.categoryId)
          : ""
        out.push({
          id: `esign-pending:${dealId}:${doc.fileId}`,
          title: "Documents ready to sign",
          message: categoryLabel
            ? `${docLabel} (${categoryLabel}) on ${dealName} is ready for your signature.`
            : `${docLabel} on ${dealName} is ready for your signature.`,
          category: "document",
          createdAt: isoOrNow(esign.sentAt),
          href: `/investing/investments/${encodeURIComponent(dealId)}?tab=documents`,
        })
      }
    }

    if (esign.completedAt?.trim()) {
      out.push({
        id: `esign-sponsor-signed:${dealId}`,
        title: "Documents fully executed",
        message: `Your sponsor counter-signed eSign documents on ${dealName}. They are available in Offering Documents.`,
        category: "document",
        createdAt: isoOrNow(esign.completedAt),
        href: `/investing/investments/${encodeURIComponent(dealId)}?tab=documents`,
      })
    }

    for (const inv of investorsPayload.investors) {
      if (!investorRowMatchesViewerEmail(inv, viewerEmail)) continue
      const committed = investorRowCommittedNumeric(inv)
      if (committed <= 0) continue
      if (investorRowIsFundApproved(inv)) continue
      const amount = parseMoneyDigits(String(inv.committed ?? ""))
      const amountLabel = Number.isFinite(amount) && amount > 0
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 0,
          }).format(amount)
        : null
      out.push({
        id: `fund-approval-lp:${dealId}:${inv.id}`,
        title: "Investment pending approval",
        message: amountLabel
          ? `Your ${amountLabel} commitment on ${dealName} is awaiting sponsor fund approval.`
          : `Your commitment on ${dealName} is awaiting sponsor fund approval.`,
        category: "investment",
        createdAt: isoOrNow(inv.fundApprovedAtIso ?? inv.signedDate),
        href: `/investing/investments/${encodeURIComponent(dealId)}`,
      })
    }
  })
}

function formatInvestorWhoPhrase(investors: { displayName?: string | null }[]): string {
  const names = investors
    .map((inv) => inv.displayName?.trim())
    .filter((n) => n && n !== "—")
    .slice(0, 2)
  const extra = investors.length - names.length
  if (names.length === 0) {
    return `${investors.length} investor${investors.length === 1 ? "" : "s"}`
  }
  if (extra > 0) return `${names.join(", ")} and ${extra} more`
  return names.join(" and ")
}

async function collectSponsorNotifications(
  out: NotificationDraft[],
): Promise<void> {
  const deals = (await fetchDealsList({ includeParticipantDeals: true }))
    .filter((d) => !d.archived)
    .slice(0, 20)

  if (deals.length === 0) return

  await mapWithConcurrency(deals, 4, async (deal) => {
    const dealId = deal.id.trim()
    if (!dealId) return
    const dealName = deal.dealName?.trim() || "Deal"
    const payload = await fetchDealInvestors(dealId)
    const investors = payload.investors

    const allInvestorsSigned = allInvestorsInvestorPhaseComplete(investors)

    const investorSigned = investors.filter((inv) => {
      if (investorRowCommittedNumeric(inv) <= 0) return false
      if (!investorEsignWasSent(inv)) return false
      return investorRowInvestorPhaseSigned(inv)
    })

    if (investorSigned.length > 0 && !allInvestorsSigned) {
      const who = formatInvestorWhoPhrase(investorSigned)
      const latestSigned = investorSigned
        .map(investorRowLatestEsignSignedAt)
        .map((t) => t?.trim())
        .filter((t): t is string => Boolean(t))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      out.push({
        id: `esign-investor-signed:${dealId}`,
        title: "Investor signed eSign documents",
        message: `${who} signed on ${dealName}. Remaining investors must sign before documents appear for your counter-signature (sequential workflow).`,
        category: "document",
        createdAt: isoOrNow(latestSigned),
        href: `/deals/${encodeURIComponent(dealId)}?tab=investors`,
      })
    }

    const awaitingCounterSign = investors.filter((inv) => {
      if (investorRowCommittedNumeric(inv) <= 0) return false
      return investorRowAwaitingSponsorCounterSign(inv)
    })
    if (awaitingCounterSign.length > 0 && allInvestorsSigned) {
      const who = formatInvestorWhoPhrase(awaitingCounterSign)
      const latestSigned = awaitingCounterSign
        .map(investorRowLatestEsignSignedAt)
        .map((t) => t?.trim())
        .filter((t): t is string => Boolean(t))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      out.push({
        id: `esign-counter-sign:${dealId}`,
        title: "Investor signed — your signature needed",
        message: `${who} signed e-sign documents on ${dealName}. Open Documents to counter-sign.`,
        category: "document",
        createdAt: isoOrNow(latestSigned),
        href: `/deals/${encodeURIComponent(dealId)}?tab=documents`,
      })
    }

    const pendingFund = investors.filter((inv) => {
      const committed = investorRowCommittedNumeric(inv)
      return committed > 0 && !investorRowIsFundApproved(inv)
    })
    if (pendingFund.length === 0) return

    const who = formatInvestorWhoPhrase(pendingFund)
    out.push({
      id: `fund-approval-sponsor:${dealId}`,
      title: "Fund approval needed",
      message: `${who} on ${dealName} ${pendingFund.length === 1 ? "needs" : "need"} fund approval.`,
      category: "deal",
      createdAt: isoOrNow(
        pendingFund[0]?.fundApprovedAtIso ?? pendingFund[0]?.signedDate,
      ),
      href: `/deals/${encodeURIComponent(dealId)}?tab=investors`,
    })
  })
}

/**
 * Builds in-app notifications from live deal / investor / e-sign APIs for the signed-in user.
 */
async function collectPlatformAdminSignupNotifications(
  out: NotificationDraft[],
): Promise<void> {
  if (!isPlatformAdmin()) return
  const signupNotes = await fetchPlatformSignupNotifications()
  out.push(...signupNotes)
}

function viewerHasLpNotificationScope(): boolean {
  if (isLpInvestorSessionUser()) return true
  return getLpInvestorDealIdsFromSession().length > 0
}

export async function fetchPortalNotifications(): Promise<NotificationDraft[]> {
  const out: NotificationDraft[] = []
  const isLpOnly = isLpInvestorSessionUser()

  await collectDealInvitationNotifications(out)

  if (isLpOnly) {
    await Promise.all([
      collectLpInvestorNotifications(out),
      collectPlatformAdminSignupNotifications(out),
    ])
  } else {
    const tasks: Promise<void>[] = [
      collectSponsorNotifications(out),
      collectPlatformAdminSignupNotifications(out),
    ]
    if (viewerHasLpNotificationScope()) {
      tasks.push(collectLpInvestorNotifications(out))
    }
    await Promise.all(tasks)
  }

  const byId = new Map<string, NotificationDraft>()
  for (const n of out) {
    if (!byId.has(n.id)) byId.set(n.id, n)
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}
