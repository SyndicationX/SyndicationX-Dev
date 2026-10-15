import type { LucideIcon } from "lucide-react"
import {
  Activity,
  BadgeCheck,
  Briefcase,
  Building2,
  Calendar,
  CalendarCheck,
  CircleDollarSign,
  DollarSign,
  IdCard,
  Mail,
  Phone,
  Percent,
  Pencil,
  Shield,
  Tag,
  User,
  UserRound,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link } from "react-router-dom"
import {
  CardCompactAmount,
  TableCompactAmountCell,
} from "../../../../../common/components/card-compact-amount/CardCompactAmount"
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../common/components/data-table/DataTable"
import { TabsScrollStrip } from "../../../../../common/components/tabs-scroll-strip/TabsScrollStrip"
import { isPlatformAdmin } from "@/common/auth/roleUtils"
import { ViewReadonlyField } from "../../../../../common/components/ViewReadonlyField"
import { formatDateDdMmmYyyy } from "../../../../../common/utils/formatDateDisplay"
import { RedactedPill } from "../../../../../common/components/redacted-pill/RedactedPill"
import {
  displayEmail,
  displayPhone,
  isPrivacyRedacted,
} from "../../../../../common/utils/displayEmail"
import { fetchDistributionPayouts } from "@/modules/Investing/api/stripeInvestorPaymentsApi"
import { fetchDealInvestors } from "../../api/dealsApi"
import { fetchDistributionSetup } from "../../distribution-setup/api/distributionSetupApi"
import {
  dealInvestorProfileDisplayName,
  investorRoleLabel,
} from "../../constants/investor-profile"
import {
  dealInvestorStatusDisplayLabel,
  investorFundedColumnLabel,
} from "../../utils/dealInvestorTableDisplay"
import { displayInvestorCommittedAmount } from "../../utils/offeringMoneyFormat"
import { investorSignedColumnDisplay } from "../../utils/investorEsignStatus"
import { parseStoredClassPercent } from "../distributions/utils/investorDistributionAllocation"
import type { DealInvestorClass } from "../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import {
  buildInvestorDistributionHistory,
  buildInvestorPaymentMatchKeys,
  payoutMatchesInvestor,
  type InvestorDistHistoryRow,
} from "./investorDistributionHistory"
import "../../../usermanagement/user_management.css"
import "../../deals-list.css"
import "../../deal-investors-tab.css"
import "../deal_members/add-investment/add_deal_modal.css"
import "../distributions/distributions-tab.css"

/** Optional this-run distribution snapshot (Distribution Details → View). */
export interface DealInvestorViewDistributionContext {
  distributionName?: string
  distributionDate?: string
  distributionAmount?: string
  waterfallSource?: string
  className?: string
  capital?: number
  percentOfClass?: number
  payment?: number
  required?: number
  unpaid?: number
  annualRatePct?: number
  days?: number
  achStatus?: string
  achInitiatedAt?: string | null
  achPaidAt?: string | null
  achFailureMessage?: string | null
}

type InvestorViewSectionTab =
  | "investor"
  | "profile"
  | "investment"
  | "distribution"

interface DealInvestorViewModalProps {
  row: DealInvestorRow | null
  onClose: () => void
  investorClasses: DealInvestorClass[]
  /** Comma-separated class names for the deal when the row has no assigned class */
  dealAllClassNamesLine: string
  /** When omitted, the Edit button is hidden (e.g. Distribution Details). */
  onEdit?: (row: DealInvestorRow) => void
  /** When set, shows this-run payment snapshot above the history list. */
  distributionContext?: DealInvestorViewDistributionContext | null
  /** Deal id — loads compact distribution history in the Distributions tab. */
  dealId?: string | null
  /** Initial section when the modal opens (defaults to investor, or distribution when context is set). */
  initialSectionTab?: InvestorViewSectionTab
}

const BASE_INVESTOR_VIEW_SECTION_TABS: Array<{
  id: InvestorViewSectionTab
  label: string
  Icon: LucideIcon
}> = [
  { id: "investor", label: "Investor", Icon: UserRound },
  { id: "profile", label: "Profile", Icon: IdCard },
  { id: "investment", label: "Investment", Icon: Briefcase },
]

const DISTRIBUTION_VIEW_SECTION_TAB: {
  id: InvestorViewSectionTab
  label: string
  Icon: LucideIcon
} = { id: "distribution", label: "Distributions", Icon: CircleDollarSign }

function achStatusSlug(status: string): string {
  const raw = status.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return raw || "not-sent"
}

function achStatusLabel(status: string): string {
  const slug = achStatusSlug(status)
  const labels: Record<string, string> = {
    "not-sent": "Not sent",
    pending: "Pending",
    processing: "Processing",
    paid: "Paid",
    transferred: "Transferred",
    failed: "Failed",
    canceled: "Canceled",
    cancelled: "Canceled",
    reversed: "Reversed",
  }
  if (labels[slug]) return labels[slug]
  return status
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function achStatusTone(status: string): string {
  const slug = achStatusSlug(status)
  if (slug === "paid" || slug === "transferred") return "success"
  if (slug === "processing" || slug === "pending") return "info"
  if (slug === "failed" || slug === "canceled" || slug === "cancelled" || slug === "reversed")
    return "danger"
  return "neutral"
}

function displayOrDash(v: string | null | undefined): string {
  const t = String(v ?? "").trim()
  if (!t || t === "—") return "—"
  return t
}

function displayPctOrDash(v: string | null | undefined): string {
  const t = String(v ?? "").trim()
  if (!t || t === "—") return "—"
  const n = Number(t.replace(/[^0-9.-]/g, ""))
  if (!Number.isFinite(n)) return t
  return `${n.toFixed(2)}%`
}

function ownershipPercentLabel(row: DealInvestorRow): string {
  const n =
    parseStoredClassPercent(row.percentOfClassDistributions) ??
    parseStoredClassPercent(row.percentOfClassOwnership)
  if (n == null) return "—"
  return `${(Math.round(n * 100) / 100).toFixed(2)}%`
}

function resolveInvestorClassDisplay(
  row: DealInvestorRow,
  classes: DealInvestorClass[],
  dealLine: string,
): string {
  const raw = (row.investorClass ?? "").trim()
  if (raw) {
    const byId = classes.find((c) => c.id === raw)
    if (byId) {
      const name = byId.name.trim()
      return name || byId.id
    }
    return raw
  }
  const fallback = dealLine.trim()
  return fallback || "—"
}

function investmentProfileLabel(row: DealInvestorRow): string {
  return dealInvestorProfileDisplayName(row)
}

function countersignedDisplay(row: DealInvestorRow): string {
  const completed = String(row.esignStatus?.completedAt ?? "").trim()
  if (completed) return formatDateDdMmmYyyy(completed)
  return "—"
}

function datePlacedDisplay(row: DealInvestorRow): string {
  const iso = String(row.investedAtIso ?? "").trim()
  if (iso) return formatDateDdMmmYyyy(iso)
  return "—"
}

function normId(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
}

function normEmail(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
}

/**
 * Read-only investor details — section tabs under the title.
 * Clicking a tab scrolls to that section; scrolling updates the active tab.
 */
export function DealInvestorViewModal({
  row,
  onClose,
  investorClasses,
  dealAllClassNamesLine,
  onEdit,
  distributionContext = null,
  dealId = null,
  initialSectionTab,
}: DealInvestorViewModalProps) {
  const dealIdTrimmed = String(dealId ?? "").trim()
  const hasThisRun = distributionContext != null
  const showDistributionsTab = Boolean(dealIdTrimmed) || hasThisRun

  const sectionTabs = useMemo(() => {
    if (!showDistributionsTab) return BASE_INVESTOR_VIEW_SECTION_TABS
    return [...BASE_INVESTOR_VIEW_SECTION_TABS, DISTRIBUTION_VIEW_SECTION_TAB]
  }, [showDistributionsTab])

  const preferDistributionsTab = Boolean(dealIdTrimmed) || hasThisRun
  const defaultTab: InvestorViewSectionTab =
    initialSectionTab ?? (preferDistributionsTab ? "distribution" : "investor")

  const [sectionTab, setSectionTab] =
    useState<InvestorViewSectionTab>(defaultTab)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRows, setHistoryRows] = useState<InvestorDistHistoryRow[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<
    Partial<Record<InvestorViewSectionTab, HTMLElement | null>>
  >({})
  const ignoreScrollSpyUntilRef = useRef(0)

  useEffect(() => {
    if (!row) return
    setSectionTab(
      initialSectionTab ??
        (preferDistributionsTab ? "distribution" : "investor"),
    )
    ignoreScrollSpyUntilRef.current = 0
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [row, onClose, preferDistributionsTab, initialSectionTab])

  useEffect(() => {
    if (!row || !dealIdTrimmed) {
      setHistoryRows([])
      setHistoryLoading(false)
      return
    }
    let cancelled = false
    setHistoryLoading(true)
    void Promise.all([
      fetchDistributionSetup(dealIdTrimmed),
      fetchDealInvestors(dealIdTrimmed, { lpInvestorsOnly: false }),
    ])
      .then(async ([bundle, invPack]) => {
        if (cancelled) return
        const dealInvestors = invPack.investors ?? []
        // Prefer the investment row for this person when the clicked row is LP roster.
        const matchInvestor =
          dealInvestors.find(
            (r) =>
              r.investorKind !== "lp_roster" &&
              (normId(r.id) === normId(row.id) ||
                (normId(r.contactId) &&
                  normId(r.contactId) === normId(row.contactId)) ||
                (normEmail(r.userEmail) &&
                  normEmail(r.userEmail) === normEmail(row.userEmail))),
          ) ?? row
        const history = buildInvestorDistributionHistory({
          investor: matchInvestor,
          priorDistributions: bundle.priorDistributions ?? [],
          dealInvestors,
          classes: bundle.classes ?? [],
        })
        const matchKeys = buildInvestorPaymentMatchKeys({
          investor: matchInvestor,
          dealInvestors,
        })
        const distIds = [
          ...new Set(
            history
              .map((h) => h.distributionId.trim())
              .filter((id) => id.length > 0),
          ),
        ]
        const payoutByDist = new Map<string, string>()
        await Promise.all(
          distIds.map(async (distId) => {
            try {
              const list = await fetchDistributionPayouts(
                dealIdTrimmed,
                distId,
              )
              const hit = list.find((p) =>
                payoutMatchesInvestor(matchKeys, p.investmentId),
              )
              payoutByDist.set(distId, hit?.status?.trim() || "not sent")
            } catch {
              payoutByDist.set(distId, "not sent")
            }
          }),
        )
        if (cancelled) return
        setHistoryRows(
          history.map((h) => ({
            ...h,
            achStatus: payoutByDist.get(h.distributionId) ?? h.achStatus,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setHistoryRows([])
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [row, dealIdTrimmed])

  const syncActiveTabFromScroll = useCallback(() => {
    if (Date.now() < ignoreScrollSpyUntilRef.current) return
    const root = scrollRef.current
    if (!root) return

    const rootTop = root.getBoundingClientRect().top
    const marker = rootTop + Math.min(72, root.clientHeight * 0.25)
    let active: InvestorViewSectionTab = sectionTabs[0]?.id ?? "investor"

    for (const { id } of sectionTabs) {
      const section = sectionRefs.current[id]
      if (!section) continue
      if (section.getBoundingClientRect().top <= marker) active = id
    }

    setSectionTab((prev) => (prev === active ? prev : active))
  }, [sectionTabs])

  useEffect(() => {
    if (!row) return
    const root = scrollRef.current
    if (!root) return

    syncActiveTabFromScroll()
    root.addEventListener("scroll", syncActiveTabFromScroll, { passive: true })
    return () => root.removeEventListener("scroll", syncActiveTabFromScroll)
  }, [row, syncActiveTabFromScroll, showDistributionsTab])

  const scrollToSection = useCallback((id: InvestorViewSectionTab) => {
    const root = scrollRef.current
    const section = sectionRefs.current[id]
    if (!root || !section) return
    setSectionTab(id)
    ignoreScrollSpyUntilRef.current = Date.now() + 600
    const nextTop =
      root.scrollTop +
      (section.getBoundingClientRect().top - root.getBoundingClientRect().top)
    root.scrollTo({ top: Math.max(0, nextTop), behavior: "smooth" })
  }, [])

  useEffect(() => {
    if (!row || !preferDistributionsTab) return
    const id = requestAnimationFrame(() => {
      scrollToSection(initialSectionTab ?? "distribution")
    })
    return () => cancelAnimationFrame(id)
  }, [row, preferDistributionsTab, initialSectionTab, scrollToSection])

  const historyColumns: DataTableColumn<InvestorDistHistoryRow>[] = useMemo(
    () => [
      {
        id: "distributionName",
        header: "Distribution name",
        colWidth: "11rem",
        sortValue: (r) => r.distributionName.toLowerCase(),
        cell: (r) =>
          dealIdTrimmed && r.distributionId ? (
            <Link
              to={`/deals/${encodeURIComponent(dealIdTrimmed)}/distributions/${encodeURIComponent(r.distributionId)}`}
              className="deals_table_name_link deal_dist_row_link"
              onClick={(e) => e.stopPropagation()}
            >
              {r.distributionName}
            </Link>
          ) : (
            r.distributionName
          ),
      },
      {
        id: "date",
        header: "Date",
        colWidth: "7.5rem",
        sortValue: (r) => r.dateSort,
        cell: (r) => r.date,
      },
      {
        id: "achStatus",
        header: "ACH status",
        colWidth: "8rem",
        sortValue: (r) => r.achStatus.toLowerCase(),
        cell: (r) => {
          const status = r.achStatus || "not sent"
          const slug = achStatusSlug(status)
          const tone = achStatusTone(status)
          return (
            <span
              className={`deal_dist_ach_badge deal_dist_ach_badge--${tone} is-${slug}`}
            >
              {achStatusLabel(status)}
            </span>
          )
        },
      },
      {
        id: "type",
        header: "Type",
        colWidth: "8.5rem",
        sortValue: (r) => r.type.toLowerCase(),
        cell: (r) => r.type,
      },
      {
        id: "payment",
        header: "Payment",
        align: "right",
        colWidth: "7.5rem",
        thClassName: "deals_th_align_right",
        tdClassName: "um_td_numeric deals_td_align_right",
        sortValue: (r) => r.payment,
        cell: (r) => <TableCompactAmountCell amount={r.payment} />,
      },
    ],
    [dealIdTrimmed],
  )

  const totalDistributed = useMemo(
    () =>
      historyRows.reduce(
        (sum, r) => sum + (Number.isFinite(r.payment) ? r.payment : 0),
        0,
      ),
    [historyRows],
  )

  if (row == null) return null

  const investorRow = row
  const invClass = resolveInvestorClassDisplay(
    investorRow,
    investorClasses,
    dealAllClassNamesLine,
  )
  const investedAmount = displayInvestorCommittedAmount(investorRow)

  function handleEdit() {
    onEdit?.(investorRow)
    onClose()
  }

  return createPortal(
    <div
      className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost"
      role="presentation"
    >
      <div
        className="um_modal um_modal_view deals_add_inv_modal_panel add_contact_panel deal_inv_investor_view_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deal-inv-investor-view-title"
      >
        <div className="um_modal_head add_contact_modal_head">
          <div className="add_contact_modal_head_main">
            <h2
              id="deal-inv-investor-view-title"
              className="um_modal_title add_contact_modal_title deal_inv_view_modal_title"
            >
              <span>Investor details</span>
              {displayOrDash(investorRow.displayName) !== "—" ? (
                <span className="deal_inv_view_title_investor_name">
                  {displayOrDash(investorRow.displayName)}
                </span>
              ) : null}
            </h2>
          </div>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </div>

        <div className="deals_add_inv_modal_form deal_inv_view_form">
          <div className="deals_add_inv_section_tabs_outer um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer deal_inv_view_section_tabs">
            <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
              <div
                className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row deals_add_inv_section_tabs_row"
                role="tablist"
                aria-label="Investor detail sections"
              >
                {sectionTabs.map(({ id, label, Icon }) => {
                  const selected = sectionTab === id
                  return (
                    <button
                      key={id}
                      type="button"
                      id={`deal-inv-view-tab-${id}`}
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`deal-inv-view-panel-${id}`}
                      className={`um_members_tab deals_tabs_tab um_segmented_tab${
                        selected ? " um_members_tab_active" : ""
                      }`}
                      onClick={() => scrollToSection(id)}
                    >
                      <Icon
                        className="deals_tabs_icon um_segmented_tab_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                      <span className="deals_tabs_label um_segmented_tab_label">
                        {label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </TabsScrollStrip>
          </div>

          <div
            ref={scrollRef}
            className="deals_add_inv_modal_scroll deal_inv_view_body"
          >
            <section
              ref={(el) => {
                sectionRefs.current.investor = el
              }}
              className="add_contact_section deal_inv_view_section"
              role="tabpanel"
              id="deal-inv-view-panel-investor"
              aria-labelledby="deal-inv-view-tab-investor"
            >
              <h3 className="deal_inv_view_section_label">Investor</h3>
              <div className="um_view_grid">
                <ViewReadonlyField
                  Icon={UserRound}
                  label="Investor name"
                  value={displayOrDash(investorRow.displayName)}
                />
                <ViewReadonlyField
                  Icon={Mail}
                  label="Email address"
                  value={
                    isPrivacyRedacted(investorRow.userEmail) ? (
                      <RedactedPill />
                    ) : (
                      displayEmail(investorRow.userEmail)
                    )
                  }
                />
                {String(investorRow.userPhone ?? "").trim() ? (
                  <ViewReadonlyField
                    Icon={Phone}
                    label="Phone number"
                    value={
                      isPrivacyRedacted(investorRow.userPhone) ? (
                        <RedactedPill />
                      ) : (
                        displayPhone(investorRow.userPhone)
                      )
                    }
                  />
                ) : null}
                <ViewReadonlyField
                  Icon={User}
                  label="Username"
                  value={displayOrDash(investorRow.userDisplayName)}
                />
              </div>
            </section>

            <section
              ref={(el) => {
                sectionRefs.current.profile = el
              }}
              className="add_contact_section deal_inv_view_section"
              role="tabpanel"
              id="deal-inv-view-panel-profile"
              aria-labelledby="deal-inv-view-tab-profile"
            >
              <h3 className="deal_inv_view_section_label">Profile</h3>
              <div className="um_view_grid">
                <ViewReadonlyField
                  Icon={IdCard}
                  label="Profile name"
                  value={investmentProfileLabel(investorRow)}
                />
                <ViewReadonlyField
                  Icon={Shield}
                  label="Accreditation"
                  value={displayOrDash(investorRow.selfAccredited)}
                />
                <ViewReadonlyField
                  Icon={BadgeCheck}
                  label="Verified accreditation"
                  fieldClassName="deals_deal_view_field_full"
                  value={displayOrDash(investorRow.verifiedAccLabel)}
                />
              </div>
            </section>

            <section
              ref={(el) => {
                sectionRefs.current.investment = el
              }}
              className="add_contact_section deal_inv_view_section"
              role="tabpanel"
              id="deal-inv-view-panel-investment"
              aria-labelledby="deal-inv-view-tab-investment"
            >
              <h3 className="deal_inv_view_section_label">Investment</h3>
              <div className="um_view_grid">
                <ViewReadonlyField
                  Icon={Briefcase}
                  label="Role"
                  value={investorRoleLabel(investorRow.investorRole ?? "")}
                />
                <ViewReadonlyField
                  Icon={Activity}
                  label="Investment status"
                  value={dealInvestorStatusDisplayLabel(investorRow)}
                />
                <ViewReadonlyField
                  Icon={Tag}
                  label="Investor class"
                  value={invClass}
                />
                <ViewReadonlyField
                  Icon={Building2}
                  label="Sponsor name"
                  value={displayOrDash(
                    String(investorRow.addedByCompanyName ?? "")
                      .split("||")
                      .map((part) => part.trim())
                      .filter((part) => part && part !== "—")
                      .join(", "),
                  )}
                />
                {isPlatformAdmin() ? (
                  <ViewReadonlyField
                    Icon={User}
                    label="Sponsor"
                    value={displayOrDash(
                      String(investorRow.addedByDisplayName ?? "")
                        .split("||")
                        .map((part) => part.trim())
                        .filter((part) => part && part !== "—")
                        .join(", "),
                    )}
                  />
                ) : null}
                <ViewReadonlyField
                  Icon={BadgeCheck}
                  label="Fund approval"
                  value={investorFundedColumnLabel(investorRow)}
                />
                <ViewReadonlyField
                  Icon={DollarSign}
                  label="Invested amount"
                  value={<CardCompactAmount amount={investedAmount} />}
                />
                <ViewReadonlyField
                  Icon={DollarSign}
                  label="Committed"
                  value={<CardCompactAmount amount={investorRow.committed} />}
                />
                <ViewReadonlyField
                  Icon={Calendar}
                  label="Date placed"
                  value={datePlacedDisplay(investorRow)}
                />
                <ViewReadonlyField
                  Icon={Percent}
                  label="Percent of class (ownership)"
                  value={displayPctOrDash(investorRow.percentOfClassOwnership)}
                />
                <ViewReadonlyField
                  Icon={Percent}
                  label="Percent of class (distributions)"
                  value={displayPctOrDash(
                    investorRow.percentOfClassDistributions,
                  )}
                />
                <ViewReadonlyField
                  Icon={Percent}
                  label="Entity Ownership"
                  value={displayPctOrDash(investorRow.entityOwnershipPercent)}
                />
                <ViewReadonlyField
                  Icon={Percent}
                  label="Distribution Allocation %"
                  value={displayPctOrDash(
                    investorRow.distributionAllocationPercent,
                  )}
                />
                <ViewReadonlyField
                  Icon={Calendar}
                  label="Document signed on"
                  value={investorSignedColumnDisplay(investorRow)}
                />
                <ViewReadonlyField
                  Icon={CalendarCheck}
                  label="Document countersigned on"
                  value={countersignedDisplay(investorRow)}
                />
                <ViewReadonlyField
                  Icon={Calendar}
                  label="Received / funded date"
                  value={formatDateDdMmmYyyy(investorRow.fundedDate)}
                />
              </div>
            </section>

            {showDistributionsTab ? (
              <section
                ref={(el) => {
                  sectionRefs.current.distribution = el
                }}
                className="add_contact_section deal_inv_view_section"
                role="tabpanel"
                id="deal-inv-view-panel-distribution"
                aria-labelledby="deal-inv-view-tab-distribution"
              >
                <h3 className="deal_inv_view_section_label">Distributions</h3>

                <div className="deal_dist_summary deal_inv_view_dist_summary">
                  <div className="deal_dist_summary_item">
                    <span className="deal_dist_summary_label">Ownership %</span>
                    <span className="deal_dist_summary_value">
                      {ownershipPercentLabel(investorRow)}
                    </span>
                  </div>
                  <div className="deal_dist_summary_item">
                    <span className="deal_dist_summary_label">
                      Invested amount
                    </span>
                    <span className="deal_dist_summary_value deal_dist_summary_value_money">
                      <TableCompactAmountCell amount={investedAmount} />
                    </span>
                  </div>
                  <div className="deal_dist_summary_item">
                    <span className="deal_dist_summary_label">
                      Total distributed
                    </span>
                    <span className="deal_dist_summary_value deal_dist_summary_value_money">
                      {historyLoading ? (
                        "—"
                      ) : (
                        <TableCompactAmountCell amount={totalDistributed} />
                      )}
                    </span>
                  </div>
                </div>

                {/* This-run snapshot hidden — history table is enough for now.
                {dist ? (
                  <div className="um_view_grid deal_inv_view_dist_this_run">
                    <ViewReadonlyField
                      Icon={CircleDollarSign}
                      label="This distribution"
                      value={displayOrDash(dist.distributionName)}
                    />
                    <ViewReadonlyField
                      Icon={Calendar}
                      label="Distribution date"
                      value={
                        dist.distributionDate
                          ? formatDateDdMmmYyyy(dist.distributionDate)
                          : "—"
                      }
                    />
                    <ViewReadonlyField
                      Icon={Tag}
                      label="Class"
                      value={displayOrDash(dist.className)}
                    />
                    <ViewReadonlyField
                      Icon={DollarSign}
                      label="Payment (this run)"
                      value={moneyFieldValue(dist.payment)}
                    />
                    <ViewReadonlyField
                      Icon={Landmark}
                      label="ACH status"
                      value={displayOrDash(dist.achStatus || "not sent")}
                    />
                    {dist.achFailureMessage ? (
                      <ViewReadonlyField
                        Icon={Activity}
                        label="ACH failure"
                        fieldClassName="deals_deal_view_field_full"
                        value={dist.achFailureMessage}
                      />
                    ) : null}
                  </div>
                ) : null}
                */}

                <div className="deal_inv_view_dist_history">
                  <p className="deal_inv_view_dist_history_label">
                    Distribution history
                  </p>
                  <DataTable
                    visualVariant="members"
                    membersTableClassName="um_table_members deal_inv_table deal_dist_table deal_inv_view_dist_table"
                    columns={historyColumns}
                    rows={historyLoading ? [] : historyRows}
                    getRowKey={(r) => r.key}
                    emptyLabel={
                      historyLoading
                        ? "Loading distributions…"
                        : "No distributions for this investor on this deal yet."
                    }
                    initialSort={{ columnId: "date", direction: "desc" }}
                  />
                </div>
              </section>
            ) : null}
          </div>

          <div className="um_modal_actions add_contact_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Close
            </button>
            {onEdit ? (
              <div className="add_contact_modal_actions_trailing">
                <button
                  type="button"
                  className="um_btn_primary"
                  onClick={handleEdit}
                >
                  <Pencil size={16} strokeWidth={2} aria-hidden />
                  Edit
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
