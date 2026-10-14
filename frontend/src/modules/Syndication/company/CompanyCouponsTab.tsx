import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import {
  BadgePercent,
  Ban,
  Building2,
  DollarSign,
  Loader2,
  Plus,
  Search,
  Ticket,
  X,
} from "lucide-react"
import {
  DataTable,
  type DataTableColumn,
} from "../../../common/components/data-table/DataTable"
import { TabsScrollStrip } from "../../../common/components/tabs-scroll-strip/TabsScrollStrip"
import { cardCompactAmountOrDash } from "../../../common/components/card-compact-amount/CardCompactAmount"
import { ToolStyleCard } from "../../../common/components/tool-style-card/ToolStyleCard"
import { toast } from "../../../common/components/Toast"
import { formatCount } from "@/common/utils/formatCount"
import "../Deals/components/deal-stage-change-modal.css"
import {
  createPlatformCoupon,
  deactivatePlatformCoupon,
  fetchPlatformCoupons,
  fetchPlatformCouponUsage,
  type OrgCouponUsage,
  type OrgCouponUse,
  type PlatformCouponRow,
} from "./companyCouponsApi"

type CouponSection = "created" | "used"

function moneyLabel(
  percentOff: number | null,
  amountOffCents: number | null,
  currency: string | null,
): string {
  if (percentOff != null) return `${percentOff}% off`
  if (amountOffCents != null) {
    const amount = (amountOffCents / 100).toLocaleString(undefined, {
      style: "currency",
      currency: (currency ?? "usd").toUpperCase(),
    })
    return `${amount} off`
  }
  return "—"
}

function durationLabel(row: PlatformCouponRow): string {
  if (row.duration === "forever") return "Forever"
  if (row.duration === "repeating") {
    const months = row.durationInMonths ?? 0
    return months === 1 ? "1 month" : `${months} months`
  }
  return "Once"
}

function formatDay(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function codeLabel(row: PlatformCouponRow): string {
  const codes = row.promotionCodes.map((c) => c.code).filter(Boolean)
  return codes.length ? codes.join(", ") : "—"
}

function usdFromCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

function DeactivateCouponModal({
  label,
  busy,
  onCancel,
  onConfirm,
}: {
  label: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()

  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener("keydown", onKey)
    }
  }, [busy, onCancel])

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="deal_stage_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap cp_coupon_deactivate_icon" aria-hidden>
            <Ban size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Coupons</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              Deactivate coupon
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="deal_stage_modal_body">
          <p className="deal_stage_modal_desc">
            Deactivate <strong>{label}</strong>? It stays in coupon history and can no longer be redeemed.
          </p>
        </div>
        <footer className="deal_stage_modal_actions">
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--cancel"
            disabled={busy}
            onClick={onCancel}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            className="deal_stage_modal_btn cp_coupon_deactivate_confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            <Ban size={16} strokeWidth={2} aria-hidden />
            {busy ? "Deactivating…" : "Deactivate"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export function CompanyCouponsTab() {
  const [section, setSection] = useState<CouponSection>("created")
  const [rows, setRows] = useState<PlatformCouponRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [deactivatingId, setDeactivatingId] = useState("")
  const [deactivateTarget, setDeactivateTarget] = useState<PlatformCouponRow | null>(null)
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent")
  const [discountValue, setDiscountValue] = useState("")
  const [duration, setDuration] = useState<"once" | "repeating" | "forever">("once")
  const [durationInMonths, setDurationInMonths] = useState("3")
  const [maxRedemptions, setMaxRedemptions] = useState("")
  const [redeemBy, setRedeemBy] = useState("")

  const [orgs, setOrgs] = useState<OrgCouponUsage[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState("")
  const [usageLoaded, setUsageLoaded] = useState(false)
  const [usageTruncated, setUsageTruncated] = useState(false)
  const [usageQuery, setUsageQuery] = useState("")
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    const result = await fetchPlatformCoupons()
    if (!result.ok) {
      setError(result.message)
      setRows([])
    } else {
      setRows(result.coupons)
    }
    setLoading(false)
  }, [])

  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    setUsageError("")
    const result = await fetchPlatformCouponUsage()
    if (!result.ok) {
      setUsageError(result.message)
      setOrgs([])
    } else {
      setOrgs(result.organizations)
      setUsageTruncated(result.truncated)
    }
    setUsageLoaded(true)
    setUsageLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (section !== "used" || usageLoaded) return
    void loadUsage()
  }, [section, usageLoaded, loadUsage])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    const value = Number(discountValue)
    if (!name.trim() || !code.trim() || !Number.isFinite(value) || value <= 0) {
      toast.error("Enter a name, code, and discount.")
      return
    }
    setSaving(true)
    const result = await createPlatformCoupon({
      name: name.trim(),
      code: code.trim(),
      discountType,
      percentOff: discountType === "percent" ? value : undefined,
      amountOff: discountType === "amount" ? value : undefined,
      duration,
      durationInMonths:
        duration === "repeating" ? Number(durationInMonths) : undefined,
      maxRedemptions: maxRedemptions.trim() ? Number(maxRedemptions) : undefined,
      redeemBy: redeemBy.trim() || undefined,
    })
    setSaving(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    toast.success("Coupon created. Customers can enter the code at checkout.")
    setName("")
    setCode("")
    setDiscountValue("")
    setMaxRedemptions("")
    setRedeemBy("")
    setRows((prev) => [result.coupon, ...prev.filter((row) => row.id !== result.coupon.id)])
  }

  async function onDeactivate(row: PlatformCouponRow) {
    setDeactivatingId(row.id)
    const result = await deactivatePlatformCoupon(row.id)
    setDeactivatingId("")
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    setDeactivateTarget(null)
    toast.success("Coupon deactivated.")
    setRows((prev) =>
      prev.map((item) =>
        item.id === row.id
          ? {
              ...item,
              valid: false,
              promotionCodes: item.promotionCodes.map((promo) => ({
                ...promo,
                active: false,
              })),
            }
          : item,
      ),
    )
  }

  const activeCount = rows.filter((row) => row.valid).length
  const redeemedCount = rows.reduce((sum, row) => sum + row.timesRedeemed, 0)
  const usageRedemptions = orgs.reduce((sum, org) => sum + org.redemptions, 0)
  const usageSaved = orgs.reduce((sum, org) => sum + org.savedCents, 0)

  const historyColumns = useMemo<DataTableColumn<PlatformCouponRow>[]>(
    () => [
      {
        id: "code",
        header: "Code",
        sortValue: (row) => codeLabel(row),
        cell: (row) => <span className="cp_coupon_code">{codeLabel(row)}</span>,
      },
      {
        id: "name",
        header: "Name",
        sortValue: (row) => row.name ?? "",
        cell: (row) => row.name?.trim() || "—",
      },
      {
        id: "discount",
        header: "Discount",
        sortValue: (row) => row.percentOff ?? row.amountOffCents ?? 0,
        cell: (row) => moneyLabel(row.percentOff, row.amountOffCents, row.currency),
      },
      {
        id: "duration",
        header: "Duration",
        sortValue: (row) => row.duration,
        cell: (row) => durationLabel(row),
      },
      {
        id: "created",
        header: "Created",
        sortValue: (row) => row.createdAt ?? "",
        cell: (row) => formatDay(row.createdAt),
      },
      {
        id: "redeemed",
        header: "Redeemed",
        align: "right",
        sortValue: (row) => row.timesRedeemed,
        cell: (row) =>
          row.maxRedemptions != null
            ? `${row.timesRedeemed} / ${row.maxRedemptions}`
            : String(row.timesRedeemed),
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => (row.valid ? 1 : 0),
        cell: (row) => (
          <span
            className={`cp_billing_invoice_status ${
              row.valid
                ? "cp_billing_invoice_status--paid"
                : "cp_billing_invoice_status--overdue"
            }`}
          >
            {row.valid ? "Active" : "Inactive"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: (row) =>
          row.valid ? (
            <button
              type="button"
              className="um_btn_secondary cp_coupon_row_deactivate"
              disabled={deactivatingId === row.id}
              onClick={() => setDeactivateTarget(row)}
            >
              <Ban size={14} strokeWidth={2} aria-hidden />
              {deactivatingId === row.id ? "Deactivating…" : "Deactivate"}
            </button>
          ) : null,
      },
    ],
    [deactivatingId],
  )

  const filteredOrgs = useMemo(() => {
    const q = usageQuery.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(
      (org) =>
        org.name.toLowerCase().includes(q) ||
        org.coupons.some(
          (coupon) =>
            coupon.code.toLowerCase().includes(q) ||
            (coupon.name ?? "").toLowerCase().includes(q),
        ),
    )
  }, [orgs, usageQuery])

  const usageColumns = useMemo<DataTableColumn<OrgCouponUse>[]>(
    () => [
      {
        id: "code",
        header: "Code",
        sortValue: (row) => row.code,
        cell: (row) => <span className="cp_coupon_code">{row.code}</span>,
      },
      {
        id: "name",
        header: "Coupon",
        sortValue: (row) => row.name ?? "",
        cell: (row) => row.name?.trim() || "—",
      },
      {
        id: "discount",
        header: "Discount",
        sortValue: (row) => row.percentOff ?? row.amountOffCents ?? 0,
        cell: (row) => moneyLabel(row.percentOff, row.amountOffCents, row.currency),
      },
      {
        id: "redemptions",
        header: "Uses",
        align: "right",
        sortValue: (row) => row.redemptions,
        cell: (row) => formatCount(row.redemptions),
      },
      {
        id: "saved",
        header: "Saved",
        align: "right",
        sortValue: (row) => row.savedCents,
        cell: (row) => cardCompactAmountOrDash(usdFromCents(row.savedCents)),
      },
      {
        id: "lastUsed",
        header: "Last used",
        sortValue: (row) => row.lastUsedAt ?? "",
        cell: (row) => formatDay(row.lastUsedAt),
      },
    ],
    [],
  )

  const orgColumns = useMemo<DataTableColumn<OrgCouponUsage>[]>(
    () => [
      {
        id: "name",
        header: "Organization",
        sortValue: (row) => row.name.toLowerCase(),
        thClassName: "deals_col_deal_name",
        tdClassName: "um_td_user deals_col_deal_name",
        cell: (row) => {
          const open = expandedOrgId === row.id
          return (
            <div className="deals_list_name_cell cp_billing_deal_name_cell">
              <div className="um_user_avatar_ring cp_company_avatar" aria-hidden>
                <Building2 size={18} strokeWidth={2} />
              </div>
              <div className="deals_list_name_text">
                <span
                  className={`cp_billing_org_name_btn${open ? " cp_billing_org_name_btn--open" : ""}`}
                >
                  {row.name}
                </span>
              </div>
            </div>
          )
        },
      },
      {
        id: "coupons",
        header: "Coupons",
        align: "right",
        sortValue: (row) => row.coupons.length,
        cell: (row) => formatCount(row.coupons.length),
      },
      {
        id: "redemptions",
        header: "Uses",
        align: "right",
        sortValue: (row) => row.redemptions,
        cell: (row) => formatCount(row.redemptions),
      },
      {
        id: "saved",
        header: "Saved",
        align: "right",
        sortValue: (row) => row.savedCents,
        cell: (row) => cardCompactAmountOrDash(usdFromCents(row.savedCents)),
      },
    ],
    [expandedOrgId],
  )

  return (
    <div className="cp_settings_billing_tab cp_coupons_tab">
      <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer cp_billing_subtabs_outer">
        <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
          <div
            className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
            role="tablist"
            aria-label="Coupon sections"
          >
            <button
              type="button"
              id="cp-coupon-subtab-created"
              role="tab"
              aria-selected={section === "created"}
              aria-controls="cp-coupon-panel-created"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                section === "created" ? " um_members_tab_active" : ""
              }`}
              onClick={() => setSection("created")}
            >
              <Ticket
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Created
              </span>
            </button>
            <button
              type="button"
              id="cp-coupon-subtab-used"
              role="tab"
              aria-selected={section === "used"}
              aria-controls="cp-coupon-panel-used"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                section === "used" ? " um_members_tab_active" : ""
              }`}
              onClick={() => setSection("used")}
            >
              <Building2
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Used
              </span>
            </button>
          </div>
        </TabsScrollStrip>
      </div>

      <div
        id="cp-coupon-panel-created"
        role="tabpanel"
        aria-labelledby="cp-coupon-subtab-created"
        hidden={section !== "created"}
        className="cp_billing_subtab_panel"
      >
        <section className="cp_billing_kpi_metrics" aria-label="Coupon totals">
          <ToolStyleCard
            variant="metric"
            icon={Ticket}
            title="Coupons"
            loading={loading}
            description={formatCount(rows.length)}
          />
          <ToolStyleCard
            variant="metric"
            icon={BadgePercent}
            title="Active"
            loading={loading}
            description={formatCount(activeCount)}
          />
          <ToolStyleCard
            variant="metric"
            icon={DollarSign}
            title="Redemptions"
            loading={loading}
            description={formatCount(redeemedCount)}
          />
        </section>

        <section className="cp_coupons_panel">
          <header className="cp_billing_payment_methods_head">
            <div>
              <h2 className="cp_billing_payment_methods_title">New coupon</h2>
              <p className="cp_billing_payment_methods_lead">
                Customers enter the code when they pay for a deal.
              </p>
            </div>
          </header>
          <form className="cp_coupons_create" onSubmit={(e) => void onCreate(e)}>
            <label className="cp_coupons_field">
              Name
              <input
                className="cp_coupons_input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="Launch discount"
                required
              />
            </label>
            <label className="cp_coupons_field">
              Code
              <input
                className="cp_coupons_input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                maxLength={40}
                placeholder="LAUNCH20"
                required
              />
            </label>
            <label className="cp_coupons_field">
              Discount
              <span className="cp_coupons_discount">
                <select
                  className="cp_coupons_input"
                  value={discountType}
                  onChange={(e) =>
                    setDiscountType(e.target.value === "amount" ? "amount" : "percent")
                  }
                >
                  <option value="percent">Percent</option>
                  <option value="amount">Amount (USD)</option>
                </select>
                <input
                  className="cp_coupons_input"
                  inputMode="decimal"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "percent" ? "20" : "50"}
                  required
                />
              </span>
            </label>
            <label className="cp_coupons_field">
              Duration
              <select
                className="cp_coupons_input"
                value={duration}
                onChange={(e) =>
                  setDuration(
                    e.target.value === "forever" || e.target.value === "repeating"
                      ? e.target.value
                      : "once",
                  )
                }
              >
                <option value="once">Once</option>
                <option value="repeating">Repeating</option>
                <option value="forever">Forever</option>
              </select>
            </label>
            {duration === "repeating" ? (
              <label className="cp_coupons_field">
                Months
                <input
                  className="cp_coupons_input"
                  inputMode="numeric"
                  value={durationInMonths}
                  onChange={(e) => setDurationInMonths(e.target.value)}
                  required
                />
              </label>
            ) : null}
            <label className="cp_coupons_field">
              Max redemptions
              <input
                className="cp_coupons_input"
                inputMode="numeric"
                value={maxRedemptions}
                onChange={(e) => setMaxRedemptions(e.target.value)}
                placeholder="Unlimited"
              />
            </label>
            <label className="cp_coupons_field">
              Redeem by
              <input
                className="cp_coupons_input"
                type="date"
                value={redeemBy}
                onChange={(e) => setRedeemBy(e.target.value)}
              />
            </label>
            <div className="cp_coupons_submit">
              <button type="submit" className="um_btn_primary" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 size={16} className="cp_coupons_spin" aria-hidden />
                    Creating…
                  </>
                ) : (
                  <>
                    <Plus size={16} strokeWidth={2} aria-hidden />
                    Create coupon
                  </>
                )}
              </button>
            </div>
          </form>
        </section>

        {error ? (
          <p className="cp_billing_payment_methods_error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="cp_coupons_history">
          <header className="cp_billing_payment_methods_head">
            <div>
              <h2 className="cp_billing_payment_methods_title">Coupon history</h2>
              <p className="cp_billing_payment_methods_lead">
                Active and deactivated coupons. Deactivated codes stay here and cannot be redeemed.
              </p>
            </div>
          </header>
          <div className="cp_billing_invoices_table_wrap deal_inv_table_panel">
      <DataTable
        columns={historyColumns}
        rows={rows}
        getRowKey={(row) => row.id}
        emptyLabel={loading ? "Loading coupons…" : "No coupons yet."}
        isLoading={loading}
        visualVariant="members"
        membersTableClassName="um_table_members deal_inv_table cp_coupons_table"
        membersShell="default"
        forceHorizontalScroll={false}
        floatingHorizontalScroll={false}
        initialSort={{ columnId: "created", direction: "desc" }}
      />
      {deactivateTarget ? (
        <DeactivateCouponModal
          label={
            codeLabel(deactivateTarget) === "—"
              ? deactivateTarget.name?.trim() || "this coupon"
              : codeLabel(deactivateTarget)
          }
          busy={deactivatingId === deactivateTarget.id}
          onCancel={() => {
            if (deactivatingId) return
            setDeactivateTarget(null)
          }}
          onConfirm={() => void onDeactivate(deactivateTarget)}
        />
      ) : null}
          </div>
        </section>
      </div>

      <div
        id="cp-coupon-panel-used"
        role="tabpanel"
        aria-labelledby="cp-coupon-subtab-used"
        hidden={section !== "used"}
        className="cp_billing_subtab_panel"
      >
        <section className="cp_billing_kpi_metrics" aria-label="Coupon usage totals">
          <ToolStyleCard
            variant="metric"
            icon={Building2}
            title="Organizations"
            loading={usageLoading}
            description={formatCount(orgs.length)}
          />
          <ToolStyleCard
            variant="metric"
            icon={Ticket}
            title="Uses"
            loading={usageLoading}
            description={formatCount(usageRedemptions)}
          />
          <ToolStyleCard
            variant="metric"
            icon={DollarSign}
            title="Saved"
            loading={usageLoading}
            description={cardCompactAmountOrDash(usdFromCents(usageSaved))}
          />
        </section>

        <div
          className="um_toolbar um_toolbar_export_then_search cp_billing_deal_search_toolbar"
          role="search"
        >
          <div className="um_search_wrap">
            <Search className="um_search_icon" size={18} aria-hidden />
            <input
              type="search"
              className="um_search_input"
              value={usageQuery}
              onChange={(e) => setUsageQuery(e.target.value)}
              placeholder="Search organizations or codes…"
              aria-label="Search organizations or coupon codes"
            />
          </div>
        </div>

        {usageError ? (
          <p className="cp_billing_payment_methods_error" role="alert">
            {usageError}
          </p>
        ) : null}
        {usageTruncated ? (
          <p className="cp_billing_subtitle cp_coupons_note">
            Showing coupon use from the most recent invoices.
          </p>
        ) : null}

        <div className="cp_billing_invoices_table_wrap deal_inv_table_panel">
          <DataTable
            columns={orgColumns}
            rows={filteredOrgs}
            getRowKey={(row) => row.id}
            emptyLabel={
              usageLoading
                ? "Loading coupon use…"
                : "No organizations have used a coupon yet."
            }
            isLoading={usageLoading}
            visualVariant="members"
            membersTableClassName="um_table_members deal_inv_table cp_billing_orgs_table"
            membersShell="default"
            initialSort={{ columnId: "name", direction: "asc" }}
            onBodyRowClick={(row) =>
              setExpandedOrgId((current) => (current === row.id ? null : row.id))
            }
            getRowClassName={(row) =>
              expandedOrgId === row.id ? "cp_billing_deal_row_expanded" : ""
            }
            renderExpandedContent={(row) =>
              expandedOrgId === row.id ? (
                <div className="cp_billing_org_deals">
                  <DataTable
                    columns={usageColumns}
                    rows={row.coupons}
                    getRowKey={(coupon) => `${coupon.couponId}:${coupon.code}`}
                    emptyLabel="No coupons"
                    visualVariant="members"
                    membersTableClassName="um_table_members deal_inv_table cp_billing_org_deals_table"
                    membersShell="plain"
                    stickyFirstColumn={false}
                    forceHorizontalScroll={false}
                    floatingHorizontalScroll={false}
                    initialSort={{ columnId: "code", direction: "asc" }}
                  />
                </div>
              ) : null
            }
          />
        </div>
      </div>
    </div>
  )
}
