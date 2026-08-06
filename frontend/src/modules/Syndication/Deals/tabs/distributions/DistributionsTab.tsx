import {
  ArrowRight,
  BarChart3,
  CircleHelp,
  Download,
  // Percent,
  Search,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../common/components/data-table/DataTable"
import { TableCompactAmountCell } from "../../../../../common/components/card-compact-amount/CardCompactAmount"
import { TabsScrollStrip } from "../../../../../common/components/tabs-scroll-strip/TabsScrollStrip"
import { fetchDealInvestors } from "../../api/dealsApi"
import {
  // clearPriorDistributions,
  deletePriorDistribution,
  fetchDistributionSetup,
} from "../../distribution-setup/api/distributionSetupApi"
import type {
  DistributionSetupClass,
  PriorDistributionRecord,
} from "../../distribution-setup/types/distribution-setup.types"
import { ExportSelectableRowsModal } from "../../components/ExportSelectableRowsModal"
import { BulkDeleteReasonModal } from "../../../../../common/components/bulk-delete-reason-modal/BulkDeleteReasonModal"
import "../../../../../common/components/bulk-delete-reason-modal/bulk-delete-reason-modal.css"
import { toast } from "../../../../../common/components/Toast"
import type { DealInvestorRow } from "../../types/deal-investors.types"
// import { DistributionFeeTab } from "./DistributionFeeTab"
import { DistributionRowActions } from "./DistributionRowActions"
import { downloadDistributionsExportCsv } from "./utils/distributionsExportCsv"
import { sanitizePriorDistributions } from "./utils/investorPreferredAllocation"
import {
  computeDistributionListMetrics,
  deductsFromDisplayLabel,
  distributionDisplayName,
  formatPaymentDateLabel,
  formatPeriodDatesLabel,
  sourceDisplayLabel,
  typeDisplayLabel,
  type DistributionListMetrics,
} from "./utils/distributionListDisplay"
import "../../../usermanagement/user_management.css"
import "../../deals-list.css"
import "./distributions-tab.css"

type DistributionsSubTab = "distributions" | "distribution_fee"

type DistributionsTabProps = {
  dealId: string
  dealName?: string
}

type CompletedDistributionRow = PriorDistributionRecord & {
  metrics: DistributionListMetrics
}

function formatMoneyPlain(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Deal Detail → Distributions: portal-style list (Woodland Ridge reference).
 */
export function DistributionsTab({ dealId, dealName }: DistributionsTabProps) {
  const id = dealId.trim()
  const navigate = useNavigate()
  const classSetupHref = `/deals/${encodeURIComponent(id)}/class-setup`
  const distributionSetupHref = `/deals/${encodeURIComponent(id)}/distribution-setup`
  const returnState = { returnTab: "distributions" as const }

  const [activeSubTab, setActiveSubTab] =
    useState<DistributionsSubTab>("distributions")
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [priorDistributions, setPriorDistributions] = useState<
    PriorDistributionRecord[]
  >([])
  const [classes, setClasses] = useState<DistributionSetupClass[]>([])
  const [investors, setInvestors] = useState<DealInvestorRow[]>([])
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [exportOpen, setExportOpen] = useState(false)
  const [resolvedDealName, setResolvedDealName] = useState(dealName ?? "")
  // const [clearing, setClearing] = useState(false)
  const [deleteTarget, setDeleteTarget] =
    useState<PriorDistributionRecord | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const openDetails = useCallback(
    (row: PriorDistributionRecord) => {
      navigate(
        `/deals/${encodeURIComponent(id)}/distributions/${encodeURIComponent(row.id)}`,
      )
    },
    [id, navigate],
  )

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setLoadError(null)
    try {
      const [bundle, invPack] = await Promise.all([
        fetchDistributionSetup(id),
        fetchDealInvestors(id, { lpInvestorsOnly: false }),
      ])
      setPriorDistributions(
        sanitizePriorDistributions(bundle.priorDistributions ?? []),
      )
      setClasses(bundle.classes ?? [])
      setInvestors(invPack.investors ?? [])
      if (bundle.dealName?.trim()) setResolvedDealName(bundle.dealName.trim())
    } catch (err) {
      setPriorDistributions([])
      setClasses([])
      setInvestors([])
      setLoadError(
        err instanceof Error ? err.message : "Could not load distributions.",
      )
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const rows: CompletedDistributionRow[] = useMemo(
    () =>
      [...priorDistributions]
        .sort((a, b) => {
          const da = (a.paymentDate || a.date).localeCompare(
            b.paymentDate || b.date,
          )
          if (da !== 0) return -da
          return b.date.localeCompare(a.date)
        })
        .map((p) => ({
          ...p,
          metrics: computeDistributionListMetrics({
            row: p,
            investors,
            classes,
          }),
        })),
    [priorDistributions, investors, classes],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const hay = [
        distributionDisplayName(r),
        r.name ?? "",
        r.date,
        r.amount,
        sourceDisplayLabel(r.source),
        typeDisplayLabel(r),
        deductsFromDisplayLabel(r),
        r.period ?? "",
        r.notes ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [rows, query])

  useEffect(() => {
    setPage(1)
  }, [filtered.length, query])

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: filtered.length,
      onPageChange: setPage,
      onPageSizeChange: (n: number) => {
        setPageSize(n)
        setPage(1)
      },
      ariaLabel: "Distributions table pagination",
    }),
    [page, pageSize, filtered.length],
  )

  const totals = useMemo(() => {
    let paid = 0
    let unpaid = 0
    for (const r of filtered) {
      paid += r.metrics.paid
      unpaid += r.metrics.unpaid
    }
    return { paid, unpaid }
  }, [filtered])

  const exportRows = useMemo(
    () =>
      filtered.map((r) => ({
        key: r.id,
        label: distributionDisplayName(r),
        meta: `${formatPaymentDateLabel(r.metrics.paymentDate)} · ${sourceDisplayLabel(r.source)}`,
        searchText: [
          distributionDisplayName(r),
          r.date,
          r.amount,
          sourceDisplayLabel(r.source),
          r.notes ?? "",
        ]
          .join(" ")
          .toLowerCase(),
      })),
    [filtered],
  )

  const handleExport = useCallback(
    (selectedKeys: string[]) => {
      const keySet = new Set(selectedKeys)
      const selected = filtered.filter((r) => keySet.has(r.id))
      downloadDistributionsExportCsv({
        rows: selected,
        dealName: resolvedDealName || dealName,
      })
      setExportOpen(false)
    },
    [filtered, resolvedDealName, dealName],
  )

  // const handleClearAll = useCallback(async () => {
  //   if (!id || clearing) return
  //   const ok = window.confirm(
  //     "Clear all completed distributions for this deal?\n\nThis removes the test/history rows only. Class Setup and Distribution Setup (waterfall) are kept.",
  //   )
  //   if (!ok) return
  //   setClearing(true)
  //   try {
  //     const saved = await clearPriorDistributions(id)
  //     setPriorDistributions(
  //       sanitizePriorDistributions(saved.priorDistributions ?? []),
  //     )
  //     toast.success(
  //       "Distributions cleared",
  //       "Complete Q1 / Q2 again from Distribution Setup with the correct dates.",
  //     )
  //   } catch (err) {
  //     toast.error(
  //       "Could not clear",
  //       err instanceof Error ? err.message : "Try again.",
  //     )
  //   } finally {
  //     setClearing(false)
  //   }
  // }, [id, clearing])

  const openEditSetup = useCallback(
    (row: PriorDistributionRecord) => {
      if (!id) return
      navigate(
        `/deals/${encodeURIComponent(id)}/distribution-setup?editDistributionId=${encodeURIComponent(row.id)}`,
        { state: { returnTab: "distributions" as const } },
      )
    },
    [id, navigate],
  )

  const handleExportOne = useCallback(
    (row: PriorDistributionRecord) => {
      downloadDistributionsExportCsv({
        rows: [row],
        dealName: resolvedDealName || dealName,
      })
      toast.success("Exported", `“${distributionDisplayName(row)}” downloaded.`)
    },
    [resolvedDealName, dealName],
  )

  const handleDeleteOne = useCallback((row: PriorDistributionRecord) => {
    setDeleteTarget(row)
  }, [])

  const confirmDeleteOne = useCallback(
    async (reason: string) => {
      if (!id || !deleteTarget) return
      setDeleteBusy(true)
      try {
        const saved = await deletePriorDistribution(id, deleteTarget.id, {
          reason,
        })
        setPriorDistributions(
          sanitizePriorDistributions(saved.priorDistributions ?? []),
        )
        setDeleteTarget(null)
        toast.success("Distribution deleted")
      } catch (err) {
        toast.error(
          "Could not delete",
          err instanceof Error ? err.message : "Try again.",
        )
      } finally {
        setDeleteBusy(false)
      }
    },
    [id, deleteTarget],
  )

  // Visibility toggle — commented out for now
  // const setVisible = useCallback((distributionId: string, next: boolean) => {
  //   setPriorDistributions((prev) =>
  //     prev.map((p) =>
  //       p.id === distributionId ? { ...p, visible: next } : p,
  //     ),
  //   )
  // }, [])

  const columns: DataTableColumn<CompletedDistributionRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: "Distribution name",
        colWidth: "12rem",
        thClassName: "deal_dist_th_name",
        tdClassName: "deal_dist_td_name",
        sortValue: (row) => distributionDisplayName(row).toLowerCase(),
        cell: (row) => (
          <button
            type="button"
            className="deal_dist_name_link"
            onClick={(e) => {
              e.stopPropagation()
              openDetails(row)
            }}
          >
            {distributionDisplayName(row)}
          </button>
        ),
      },
      {
        id: "source",
        header: "Source",
        colWidth: "9.5rem",
        thClassName: "deal_dist_th_source",
        tdClassName: "deal_dist_td_source",
        sortValue: (row) => sourceDisplayLabel(row.source),
        cell: (row) => sourceDisplayLabel(row.source),
      },
      {
        id: "type",
        header: (
          <span className="deal_dist_th_with_help">
            Type
            <span
              className="deal_dist_help_icon_wrap"
              title="Preferred return uses capital × rate × days ÷ 365 (actual/365)."
            >
              <CircleHelp
                size={14}
                strokeWidth={2}
                className="deal_dist_help_icon"
                aria-hidden
              />
            </span>
          </span>
        ),
        colWidth: "9.5rem",
        thClassName: "deal_dist_th_type",
        tdClassName: "deal_dist_td_type",
        sortValue: (row) => typeDisplayLabel(row),
        cell: (row) => typeDisplayLabel(row),
      },
      {
        id: "deducts",
        header: (
          <span className="deal_dist_th_with_help">
            Deducts from
            <span
              className="deal_dist_help_icon_wrap"
              title="Cash paid reduces accrued preferred due for the period."
            >
              <CircleHelp
                size={14}
                strokeWidth={2}
                className="deal_dist_help_icon"
                aria-hidden
              />
            </span>
          </span>
        ),
        colWidth: "11rem",
        thClassName: "deal_dist_th_deducts",
        tdClassName: "deal_dist_td_deducts",
        sortValue: (row) => deductsFromDisplayLabel(row),
        cell: (row) => deductsFromDisplayLabel(row),
      },
      {
        id: "payments",
        header: (
          <span className="deal_dist_payments_head">
            <span className="deal_dist_payments_head_title">
              Distribution payments
            </span>
            <span className="deal_dist_payments_head_meta">
              Total paid out: {formatMoneyPlain(totals.paid)}
              <br />
              Total unpaid: {formatMoneyPlain(totals.unpaid)}
            </span>
          </span>
        ),
        align: "right",
        colWidth: "11rem",
        thClassName: "deals_th_align_right deal_dist_th_payments",
        tdClassName:
          "um_td_numeric deals_td_align_right deal_dist_td_payments",
        sortValue: (row) => row.metrics.paid,
        cell: (row) => (
          <div className="deal_dist_pay_card" title="Paid (share of preferred due)">
            <span className="deal_dist_pay_card_amt">
              <TableCompactAmountCell amount={String(row.metrics.paid)} />
            </span>
            <span className="deal_dist_pay_card_pct">
              (
              {row.metrics.paidPctOfRequired > 100.5
                ? "—"
                : `${row.metrics.paidPctOfRequired.toFixed(2)}%`}
              )
            </span>
          </div>
        ),
      },
      {
        id: "period",
        header: "Period dates",
        colWidth: "12rem",
        thClassName: "deal_dist_th_period",
        tdClassName: "deal_dist_td_period",
        sortValue: (row) => row.metrics.periodStart,
        cell: (row) =>
          formatPeriodDatesLabel(
            row.metrics.periodStart,
            row.metrics.periodEnd,
          ),
      },
      {
        id: "paymentDate",
        header: "Payment date",
        colWidth: "8.5rem",
        thClassName: "deal_dist_th_paydate",
        tdClassName: "deal_dist_td_paydate",
        sortValue: (row) => row.metrics.paymentDate,
        cell: (row) => formatPaymentDateLabel(row.metrics.paymentDate),
      },
      {
        id: "actions",
        header: "Actions",
        align: "center",
        colWidth: "5.5rem",
        thClassName: "um_th_actions deal_dist_th_actions",
        tdClassName: "um_td_actions deal_inv_td_actions deal_dist_td_actions",
        cell: (row) => (
          <DistributionRowActions
            rowLabel={distributionDisplayName(row)}
            onEdit={() => openEditSetup(row)}
            onExport={() => handleExportOne(row)}
            onDelete={() => handleDeleteOne(row)}
          />
        ),
      },
      // {
      //   id: "visibility",
      //   ...
      // },
    ],
    [
      openDetails,
      totals.paid,
      totals.unpaid,
      openEditSetup,
      handleExportOne,
      handleDeleteOne,
    ],
  )

  const emptyLabel = loading
    ? "Loading distributions…"
    : loadError
      ? loadError
      : query.trim()
        ? "No distributions match your search."
        : "No completed distributions yet. Complete a run in Distribution Setup to see it here."

  return (
    <div className="deal_dist_tab_shell">
      <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer deal_dist_subtabs_outer">
        <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
          <div
            className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row deal_dist_subtabs_row"
            role="tablist"
            aria-label="Distribution sections"
          >
            <button
              type="button"
              id="deal-dist-subtab-distributions"
              role="tab"
              aria-selected={activeSubTab === "distributions"}
              aria-controls="deal-dist-panel-distributions"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                activeSubTab === "distributions" ? " um_members_tab_active" : ""
              }`}
              onClick={() => setActiveSubTab("distributions")}
            >
              <BarChart3
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Distributions
              </span>
            </button>
            {/* <button
              type="button"
              id="deal-dist-subtab-fee"
              role="tab"
              aria-selected={activeSubTab === "distribution_fee"}
              aria-controls="deal-dist-panel-fee"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                activeSubTab === "distribution_fee"
                  ? " um_members_tab_active"
                  : ""
              }`}
              onClick={() => setActiveSubTab("distribution_fee")}
            >
              <Percent
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Distribution Fee
              </span>
            </button> */}
          </div>
        </TabsScrollStrip>
      </div>

      <div
        id="deal-dist-panel-distributions"
        role="tabpanel"
        aria-labelledby="deal-dist-subtab-distributions"
        hidden={activeSubTab !== "distributions"}
        className="deal_dist_subtab_panel"
      >
        {activeSubTab === "distributions" ? (
          <div
            className="deal_dist_tab"
            role="region"
            aria-label="Classes and distributions"
          >
            <div className="um_panel um_members_tab_panel deals_list_table_panel deals_list_card_surface deal_inv_table_panel deal_dist_panel">
              <div
                className="um_toolbar um_toolbar_export_then_search deal_dist_toolbar"
                role="toolbar"
                aria-label="Distribution setup"
              >
                <div className="deal_dist_toolbar_copy">
                  <h2 className="deal_dist_heading">Distributions</h2>
                </div>
                <div className="um_toolbar_actions deal_dist_toolbar_actions">
                  {/* <button
                    type="button"
                    className="um_toolbar_export_btn"
                    disabled={loading || filtered.length === 0 || clearing}
                    onClick={() => void handleClearAll()}
                    aria-label="Clear all distributions"
                    title="Remove all completed distribution rows for this deal (keeps waterfall setup)"
                  >
                    <span>{clearing ? "Clearing…" : "Clear all"}</span>
                  </button> */}
                  <button
                    type="button"
                    className="um_toolbar_export_btn"
                    disabled={loading || filtered.length === 0}
                    onClick={() => setExportOpen(true)}
                    aria-label="Export distributions"
                  >
                    <Download size={18} strokeWidth={2} aria-hidden />
                    <span>Export</span>
                  </button>
                  <Link
                    to={classSetupHref}
                    state={returnState}
                    className="um_toolbar_export_btn"
                  >
                    Class Setup
                  </Link>
                  <Link
                    to={distributionSetupHref}
                    state={returnState}
                    className="um_btn_primary deals_list_add_link"
                  >
                    Distribution Setup
                    <ArrowRight size={16} strokeWidth={2} aria-hidden />
                  </Link>
                </div>
                <div className="um_search_wrap deal_dist_search">
                  <Search className="um_search_icon" size={18} aria-hidden />
                  <input
                    type="search"
                    className="um_search_input"
                    placeholder="Search by name, source, period…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search distributions"
                  />
                </div>
              </div>

              <DataTable
                visualVariant="members"
                membersTableClassName="um_table_members deal_inv_table deal_dist_table deal_dist_portal_table"
                columns={columns}
                rows={loading ? [] : filtered}
                getRowKey={(row) => row.id}
                emptyLabel={emptyLabel}
                initialSort={{ columnId: "paymentDate", direction: "desc" }}
                onBodyRowClick={(row) => openDetails(row)}
                getRowClassName={() => "deal_dist_table_row"}
                stickyFirstColumn
                forceHorizontalScroll
                pagination={pagination}
              />
            </div>

            <ExportSelectableRowsModal
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              title="Export distributions"
              hint="Choose which completed distribution runs to include in the Excel/CSV file."
              searchPlaceholder="Search runs…"
              searchAriaLabel="Search export rows"
              listAriaLabel="Distributions to export"
              rows={exportRows}
              onExportExcel={handleExport}
            />

            <BulkDeleteReasonModal
              open={deleteTarget != null}
              title="Delete distribution?"
              description={
                deleteTarget
                  ? `Remove “${distributionDisplayName(deleteTarget)}” from this deal? This cannot be undone.`
                  : "Remove this distribution? This cannot be undone."
              }
              reasonLabel="Reason for deletion"
              reasonPlaceholder="e.g. Created in error, duplicate run, wrong period…"
              busy={deleteBusy}
              onClose={() => {
                if (!deleteBusy) setDeleteTarget(null)
              }}
              onConfirm={confirmDeleteOne}
            />
          </div>
        ) : null}
      </div>

      {/* <div
        id="deal-dist-panel-fee"
        role="tabpanel"
        aria-labelledby="deal-dist-subtab-fee"
        hidden={activeSubTab !== "distribution_fee"}
        className="deal_dist_subtab_panel"
      >
        {activeSubTab === "distribution_fee" ? (
          <DistributionFeeTab dealId={id} dealName={resolvedDealName} />
        ) : null}
      </div> */}
    </div>
  )
}
