import type { LucideIcon } from "lucide-react"
import {
  Activity,
  BadgeCheck,
  Briefcase,
  Calendar,
  CalendarCheck,
  CircleDollarSign,
  DollarSign,
  IdCard,
  Landmark,
  Mail,
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
import { CardCompactAmount } from "../../../../../common/components/card-compact-amount/CardCompactAmount"
import { TabsScrollStrip } from "../../../../../common/components/tabs-scroll-strip/TabsScrollStrip"
import { ViewReadonlyField } from "../../../../../common/components/ViewReadonlyField"
import { formatDateDdMmmYyyy } from "../../../../../common/utils/formatDateDisplay"
import { investorRoleLabel } from "../../constants/investor-profile"
import {
  dealInvestorStatusDisplayLabel,
  investorFundedColumnLabel,
} from "../../utils/dealInvestorTableDisplay"
import { displayInvestorCommittedAmount } from "../../utils/offeringMoneyFormat"
import { investorSignedColumnDisplay } from "../../utils/investorEsignStatus"
import type { DealInvestorClass } from "../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import "../../../usermanagement/user_management.css"
import "../../deals-list.css"
import "../../deal-investors-tab.css"
import "../deal_members/add-investment/add_deal_modal.css"

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
  /** When set, adds a Distribution section with this-run payment details. */
  distributionContext?: DealInvestorViewDistributionContext | null
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
} = { id: "distribution", label: "Distribution", Icon: CircleDollarSign }

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
  const named = String(row.userInvestorProfileName ?? "").trim()
  if (named) return named
  return displayOrDash(row.entitySubtitle)
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

function moneyFieldValue(v: number | undefined | null) {
  if (v == null || !Number.isFinite(v)) return "—"
  return <CardCompactAmount amount={v} />
}

function displayRateOrDash(v: number | undefined | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return "—"
  return `${v.toFixed(2)}%`
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
  initialSectionTab,
}: DealInvestorViewModalProps) {
  const hasDistribution = distributionContext != null
  const sectionTabs = useMemo(() => {
    if (!hasDistribution) return BASE_INVESTOR_VIEW_SECTION_TABS
    return [...BASE_INVESTOR_VIEW_SECTION_TABS, DISTRIBUTION_VIEW_SECTION_TAB]
  }, [hasDistribution])

  const defaultTab: InvestorViewSectionTab =
    initialSectionTab ??
    (hasDistribution ? "distribution" : "investor")

  const [sectionTab, setSectionTab] =
    useState<InvestorViewSectionTab>(defaultTab)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<
    Partial<Record<InvestorViewSectionTab, HTMLElement | null>>
  >({})
  const ignoreScrollSpyUntilRef = useRef(0)

  useEffect(() => {
    if (!row) return
    setSectionTab(
      initialSectionTab ??
        (hasDistribution ? "distribution" : "investor"),
    )
    ignoreScrollSpyUntilRef.current = 0
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [row, onClose, hasDistribution, initialSectionTab])

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
  }, [row, syncActiveTabFromScroll, hasDistribution])

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
    if (!row || !hasDistribution) return
    const id = requestAnimationFrame(() => {
      scrollToSection(
        initialSectionTab ?? "distribution",
      )
    })
    return () => cancelAnimationFrame(id)
  }, [row, hasDistribution, initialSectionTab, scrollToSection])

  if (row == null) return null

  const investorRow = row
  const invClass = resolveInvestorClassDisplay(
    investorRow,
    investorClasses,
    dealAllClassNamesLine,
  )
  const investedAmount = displayInvestorCommittedAmount(investorRow)
  const dist = distributionContext

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
              className="um_modal_title add_contact_modal_title"
            >
              Investor details
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
                  value={displayOrDash(investorRow.userEmail)}
                />
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
                  label="Investment profile"
                  value={investmentProfileLabel(investorRow)}
                />
                <ViewReadonlyField
                  Icon={Shield}
                  label="Self accredited"
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
                  Icon={User}
                  label="Sponsor name"
                  value={displayOrDash(investorRow.addedByDisplayName)}
                />
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
                  label="Entity Ownership %"
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

            {dist ? (
              <section
                ref={(el) => {
                  sectionRefs.current.distribution = el
                }}
                className="add_contact_section deal_inv_view_section"
                role="tabpanel"
                id="deal-inv-view-panel-distribution"
                aria-labelledby="deal-inv-view-tab-distribution"
              >
                <h3 className="deal_inv_view_section_label">Distribution</h3>
                <div className="um_view_grid">
                  <ViewReadonlyField
                    Icon={CircleDollarSign}
                    label="Distribution"
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
                    Icon={DollarSign}
                    label="Cash distributed (run)"
                    value={moneyFieldValue(
                      (() => {
                        const n = Number(
                          String(dist.distributionAmount ?? "").replace(
                            /[^0-9.-]/g,
                            "",
                          ),
                        )
                        return Number.isFinite(n) ? n : null
                      })(),
                    )}
                  />
                  <ViewReadonlyField
                    Icon={Landmark}
                    label="Waterfall"
                    value={displayOrDash(dist.waterfallSource)}
                  />
                  <ViewReadonlyField
                    Icon={Tag}
                    label="Class"
                    value={displayOrDash(dist.className)}
                  />
                  <ViewReadonlyField
                    Icon={DollarSign}
                    label="Capital"
                    value={moneyFieldValue(dist.capital)}
                  />
                  <ViewReadonlyField
                    Icon={Percent}
                    label="% of class"
                    value={
                      dist.percentOfClass != null &&
                      Number.isFinite(dist.percentOfClass)
                        ? `${Number(dist.percentOfClass).toFixed(2)}%`
                        : "—"
                    }
                  />
                  <ViewReadonlyField
                    Icon={DollarSign}
                    label="Payment"
                    value={moneyFieldValue(dist.payment)}
                  />
                  <ViewReadonlyField
                    Icon={DollarSign}
                    label="Preferred due"
                    value={moneyFieldValue(dist.required)}
                  />
                  <ViewReadonlyField
                    Icon={DollarSign}
                    label="Unpaid"
                    value={moneyFieldValue(dist.unpaid)}
                  />
                  <ViewReadonlyField
                    Icon={Percent}
                    label="Annual rate"
                    value={displayRateOrDash(dist.annualRatePct)}
                  />
                  <ViewReadonlyField
                    Icon={Calendar}
                    label="Accrual days"
                    value={
                      dist.days != null && Number.isFinite(dist.days)
                        ? String(dist.days)
                        : "—"
                    }
                  />
                  <ViewReadonlyField
                    Icon={Landmark}
                    label="ACH status"
                    value={displayOrDash(dist.achStatus || "not sent")}
                  />
                  <ViewReadonlyField
                    Icon={Calendar}
                    label="ACH initiated"
                    value={
                      dist.achInitiatedAt
                        ? formatDateDdMmmYyyy(dist.achInitiatedAt)
                        : "—"
                    }
                  />
                  <ViewReadonlyField
                    Icon={CalendarCheck}
                    label="ACH paid"
                    value={
                      dist.achPaidAt
                        ? formatDateDdMmmYyyy(dist.achPaidAt)
                        : "—"
                    }
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
