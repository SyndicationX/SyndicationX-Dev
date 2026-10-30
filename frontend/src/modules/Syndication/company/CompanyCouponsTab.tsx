import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import {
  Activity,
  BadgePercent,
  Ban,
  Building2,
  CircleOff,
  Copy,
  DollarSign,
  LayoutGrid,
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
import { FormTooltip } from "../../../common/components/form-tooltip/FormTooltip"
import { toast } from "../../../common/components/Toast"
import { formatCount } from "@/common/utils/formatCount"
import { formatDateDdMmmYyyy } from "../../../common/utils/formatDateDisplay"
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
type CouponStatusFilter = "all" | "active" | "inactive"

function moneyLabel(
  percentOff: number | null,
  amountOffCents: number | null,
  currency: string | null,
): string {
  if (percentOff != null) {
    const percent = percentOff.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    return `${percent}% off`
  }
  if (amountOffCents != null) {
    const dollars = amountOffCents / 100
    const amount = Number.isInteger(dollars)
      ? dollars.toLocaleString("en-US", {
          style: "currency",
          currency: (currency ?? "usd").toUpperCase(),
          maximumFractionDigits: 0,
        })
      : dollars.toLocaleString("en-US", {
          style: "currency",
          currency: (currency ?? "usd").toUpperCase(),
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })
    return `${amount} off`
  }
  return "—"
}

function durationLabel(row: PlatformCouponRow): string {
  if (row.duration === "forever") return "Forever"
  if (row.duration === "repeating") {
    const total = row.durationInMonths ?? 0
    const years = Math.floor(total / 12)
    const months = total % 12
    const parts: string[] = []
    if (years === 1) parts.push("1 year")
    else if (years > 1) parts.push(`${years} years`)
    if (months === 1) parts.push("1 month")
    else if (months > 1) parts.push(`${months} months`)
    return parts.length ? parts.join(", ") : "Repeating"
  }
  return "Once"
}

function formatDay(iso: string | null): string {
  return formatDateDdMmmYyyy(iso)
}

function codeLabel(row: PlatformCouponRow): string {
  const codes = row.promotionCodes.map((c) => c.code).filter(Boolean)
  return codes.length ? codes.join(", ") : "—"
}

function couponCodes(row: PlatformCouponRow): string[] {
  const seen = new Set<string>()
  const codes: string[] = []
  for (const code of row.promotionCodes.map((c) => c.code.trim()).filter(Boolean)) {
    const key = code.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    codes.push(code)
  }
  return codes
}

async function copyCouponCode(code: string) {
  const value = code.trim()
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    toast.success("Coupon code copied")
  } catch {
    toast.error("Could not copy the coupon code.")
  }
}

function CouponCodeCell({ codes }: { codes: string[] }) {
  const visible = codes.map((code) => code.trim()).filter(Boolean)
  if (!visible.length) return <span className="cp_coupon_code">—</span>
  return (
    <span className="cp_coupon_codes">
      {visible.map((code) => (
        <span key={code} className="cp_coupon_code_row">
          <span className="cp_coupon_code">{code}</span>
          <button
            type="button"
            className="cp_coupon_copy"
            aria-label={`Copy coupon code ${code}`}
            onClick={(event) => {
              event.stopPropagation()
              void copyCouponCode(code)
            }}
          >
            <Copy size={14} strokeWidth={2} aria-hidden />
          </button>
        </span>
      ))}
    </span>
  )
}

function usdFromCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** Whole-dollar coupon amount, shown with USD thousands separators. */
function formatUsdWhole(raw: string): string {
  const digits = (raw.split(".")[0] ?? "")
    .replace(/\D/g, "")
    .replace(/^0+(?=\d)/, "")
  if (!digits) return ""
  return Number(digits).toLocaleString("en-US")
}

const PERCENT_LIMIT_ERROR = "Percent off can be from 0.01% to 100%."

function discountNumber(raw: string): number {
  return Math.round(Number(raw.replace(/,/g, "")) * 100) / 100
}

/** Local calendar date for `<input type="date">`. */
function localDateInputValue(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
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
  const durationId = useId()
  const discountTypeId = useId()
  const maxRedemptionsId = useId()
  const [section, setSection] = useState<CouponSection>("created")
  const [rows, setRows] = useState<PlatformCouponRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [deactivatingId, setDeactivatingId] = useState("")
  const [deactivateTarget, setDeactivateTarget] = useState<PlatformCouponRow | null>(null)
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [nameError, setNameError] = useState("")
  const [codeError, setCodeError] = useState("")
  const [discountError, setDiscountError] = useState("")
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent")
  const [discountValue, setDiscountValue] = useState("")
  const [duration, setDuration] = useState<"once" | "repeating" | "forever">("once")
  const [durationMonths, setDurationMonths] = useState("")
  const [durationYears, setDurationYears] = useState("")
  const [maxRedemptions, setMaxRedemptions] = useState("1")
  const [redeemBy, setRedeemBy] = useState("")
  const [redeemByError, setRedeemByError] = useState("")

  const [orgs, setOrgs] = useState<OrgCouponUsage[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState("")
  const [usageLoaded, setUsageLoaded] = useState(false)
  const [usageTruncated, setUsageTruncated] = useState(false)
  const [usageQuery, setUsageQuery] = useState("")
  const [usagePage, setUsagePage] = useState(1)
  const [usagePageSize, setUsagePageSize] = useState(10)
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<CouponStatusFilter>("all")
  const [historyQuery, setHistoryQuery] = useState("")
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(10)

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
    const value = discountNumber(discountValue)
    if (!name.trim() || !code.trim() || !Number.isFinite(value) || value <= 0) {
      toast.error("Enter a name, coupon code, and discount.")
      return
    }
    if (discountType === "amount" && !Number.isInteger(value)) {
      toast.error("Amount off must be a whole number.")
      return
    }
    if (discountType === "percent" && value > 100) {
      setDiscountError(PERCENT_LIMIT_ERROR)
      toast.error(PERCENT_LIMIT_ERROR)
      return
    }
    setDiscountError("")
    const repeatMonths = Number(durationMonths || "0")
    const repeatYears = Number(durationYears || "0")
    const durationInMonths = repeatYears * 12 + repeatMonths
    if (
      duration === "repeating" &&
      (!Number.isInteger(durationInMonths) || durationInMonths < 1)
    ) {
      toast.error("Enter how many months or years the discount repeats.")
      return
    }
    const parsedMax = Number(maxRedemptions)
    if (maxRedemptions.trim() && !(Number.isInteger(parsedMax) && parsedMax > 0)) {
      toast.error("Max redemptions must be a positive whole number.")
      return
    }
    const maxUses = maxRedemptions.trim() ? parsedMax : 1
    if (!redeemBy.trim()) {
      setRedeemByError("Enter a redeem-by date.")
      toast.error("Enter a redeem-by date.")
      return
    }
    if (redeemBy < localDateInputValue()) {
      setRedeemByError("Redeem-by date cannot be in the past.")
      toast.error("Redeem-by date cannot be in the past.")
      return
    }
    setRedeemByError("")
    const nameKey = name.trim().toLowerCase()
    const codeKey = code.trim().toLowerCase()
    const nameTaken = rows.some(
      (row) => (row.name ?? "").trim().toLowerCase() === nameKey,
    )
    const codeTaken = rows.some((row) =>
      row.promotionCodes.some((promo) => promo.code.trim().toLowerCase() === codeKey),
    )
    const duplicateMessage = nameTaken
      ? "That name is already in use."
      : "That coupon code is already in use."
    setNameError(nameTaken ? "That name is already in use." : "")
    setCodeError(codeTaken ? "That coupon code is already in use." : "")
    if (nameTaken || codeTaken) {
      toast.error(duplicateMessage)
      return
    }
    setNameError("")
    setCodeError("")
    setSaving(true)
    const result = await createPlatformCoupon({
      name: name.trim(),
      code: code.trim(),
      discountType,
      ...(discountType === "amount" ? { amountOff: value } : { percentOff: value }),
      duration,
      durationInMonths: duration === "repeating" ? durationInMonths : undefined,
      maxRedemptions: maxUses,
      redeemBy: redeemBy.trim() || undefined,
    })
    setSaving(false)
    if (!result.ok) {
      if (result.message === "That name is already in use.") setNameError(result.message)
      if (result.message === "That coupon code is already in use.") setCodeError(result.message)
      toast.error(result.message)
      return
    }
    toast.success("Coupon created. Customers can enter the code at checkout.")
    setNameError("")
    setCodeError("")
    setDiscountError("")
    setRedeemByError("")
    setName("")
    setCode("")
    setDiscountValue("")
    setDurationMonths("")
    setDurationYears("")
    setMaxRedemptions("1")
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
  const inactiveCount = rows.length - activeCount

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    return rows.filter((row) => {
      if (statusFilter === "active" && !row.valid) return false
      if (statusFilter === "inactive" && row.valid) return false
      if (!q) return true
      const haystack = [
        codeLabel(row),
        row.name ?? "",
        moneyLabel(row.percentOff, row.amountOffCents, row.currency),
        durationLabel(row),
        row.valid ? "active" : "inactive",
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [rows, statusFilter, historyQuery])

  const historyTotalPages = Math.max(
    1,
    Math.ceil(filteredHistory.length / historyPageSize),
  )
  const historyPageSafe = Math.min(historyPage, historyTotalPages)

  useEffect(() => {
    if (historyPage > historyTotalPages) setHistoryPage(historyTotalPages)
  }, [historyPage, historyTotalPages])
  const usageRedemptions = orgs.reduce((sum, org) => sum + org.redemptions, 0)
  const usageSaved = orgs.reduce((sum, org) => sum + org.savedCents, 0)

  const couponSerialById = useMemo(() => {
    const inTab = rows.filter((row) => {
      if (statusFilter === "active") return row.valid
      if (statusFilter === "inactive") return !row.valid
      return true
    })
    const ordered = [...inTab].sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0
      if (aTime !== bTime) return aTime - bTime
      return a.id.localeCompare(b.id)
    })
    const serial = new Map<string, number>()
    ordered.forEach((row, index) => serial.set(row.id, index + 1))
    return serial
  }, [rows, statusFilter])

  const historyColumns = useMemo<DataTableColumn<PlatformCouponRow>[]>(
    () => [
      {
        id: "sno",
        header: "S.No",
        align: "center",
        colWidth: "3.75rem",
        thClassName: "cp_coupon_sno_col",
        tdClassName: "cp_coupon_sno_col um_td_numeric",
        cell: (row) => couponSerialById.get(row.id) ?? "—",
      },
      {
        id: "code",
        header: "Coupon code",
        sortValue: (row) => codeLabel(row),
        cell: (row) => <CouponCodeCell codes={couponCodes(row)} />,
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
        cell: (row) => {
          const label = moneyLabel(row.percentOff, row.amountOffCents, row.currency)
          if (label === "—") return label
          return (
            <span className="cp_billing_invoice_status cp_billing_invoice_status--open cp_coupon_discount_badge">
              {label}
            </span>
          )
        },
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
        align: "center",
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
    [deactivatingId, couponSerialById],
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

  const usageTotalPages = Math.max(
    1,
    Math.ceil(filteredOrgs.length / usagePageSize),
  )
  const usagePageSafe = Math.min(usagePage, usageTotalPages)

  useEffect(() => {
    if (usagePage > usageTotalPages) setUsagePage(usageTotalPages)
  }, [usagePage, usageTotalPages])

  const usageColumns = useMemo<DataTableColumn<OrgCouponUse>[]>(
    () => [
      {
        id: "code",
        header: "Coupon code",
        sortValue: (row) => row.code,
        cell: (row) => <CouponCodeCell codes={[row.code]} />,
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
            icon={CircleOff}
            title="Inactive"
            loading={loading}
            description={formatCount(inactiveCount)}
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
              <span>
                Name
                <span className="cp_coupons_required" aria-hidden>
                  *
                </span>
              </span>
              <input
                className="cp_coupons_input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameError("")
                }}
                maxLength={40}
                placeholder="Launch discount"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "cp-coupon-name-error" : undefined}
                required
              />
              {nameError ? (
                <p id="cp-coupon-name-error" className="cp_coupons_field_error" role="alert">
                  {nameError}
                </p>
              ) : null}
            </label>
            <label className="cp_coupons_field">
              <span>
                Coupon code
                <span className="cp_coupons_required" aria-hidden>
                  *
                </span>
              </span>
              <input
                className="cp_coupons_input"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase())
                  setCodeError("")
                }}
                maxLength={40}
                placeholder="LAUNCH20"
                aria-invalid={codeError ? true : undefined}
                aria-describedby={codeError ? "cp-coupon-code-error" : undefined}
                required
              />
              {codeError ? (
                <p id="cp-coupon-code-error" className="cp_coupons_field_error" role="alert">
                  {codeError}
                </p>
              ) : null}
            </label>
            <div className="cp_coupons_field">
              <label htmlFor={discountTypeId}>
                Discount
                <span className="cp_coupons_required" aria-hidden>
                  *
                </span>
              </label>
              <select
                id={discountTypeId}
                className="cp_coupons_input"
                value={discountType}
                onChange={(e) => {
                  const next = e.target.value === "amount" ? "amount" : "percent"
                  setDiscountType(next)
                  setDiscountError("")
                  if (next === "amount") {
                    setDiscountValue(formatUsdWhole(discountValue))
                    return
                  }
                  const numeric = discountNumber(discountValue)
                  if (Number.isFinite(numeric) && numeric > 100) {
                    setDiscountValue("100")
                    setDiscountError(PERCENT_LIMIT_ERROR)
                  }
                }}
              >
                <option value="percent">Percent</option>
                <option value="amount">Amount</option>
              </select>
            </div>
            <label className="cp_coupons_field">
              <span>
                {discountType === "amount" ? "Amount ($)" : "Percent (%)"}
                <span className="cp_coupons_required" aria-hidden>
                  *
                </span>
              </span>
              <input
                className="cp_coupons_input"
                type="text"
                inputMode={discountType === "amount" ? "numeric" : "decimal"}
                autoComplete="off"
                value={discountValue}
                onChange={(e) => {
                  if (discountType === "amount") {
                    setDiscountError("")
                    setDiscountValue(formatUsdWhole(e.target.value))
                    return
                  }
                  const cleaned = e.target.value.replace(/[^\d.]/g, "")
                  if (!cleaned) {
                    setDiscountError("")
                    setDiscountValue("")
                    return
                  }
                  const dot = cleaned.indexOf(".")
                  const normalized =
                    dot === -1
                      ? cleaned
                      : `${cleaned.slice(0, dot)}.${cleaned.slice(dot + 1).replace(/\./g, "")}`
                  const [whole = "", fraction = ""] = normalized.split(".")
                  const hasDot = normalized.includes(".")
                  const next = hasDot
                    ? `${whole}.${fraction.slice(0, 2)}`
                    : whole
                  const numeric = Number(next)
                  if (!Number.isFinite(numeric)) return
                  if (numeric > 100) {
                    setDiscountError(PERCENT_LIMIT_ERROR)
                    return
                  }
                  setDiscountError("")
                  setDiscountValue(next)
                }}
                placeholder={discountType === "amount" ? "1,000" : "10.00"}
                aria-invalid={discountError ? true : undefined}
                aria-describedby={discountError ? "cp-coupon-discount-error" : undefined}
                required
              />
              {discountError ? (
                <p id="cp-coupon-discount-error" className="cp_coupons_field_error" role="alert">
                  {discountError}
                </p>
              ) : null}
            </label>
            <div className="cp_coupons_field">
              <span className="cp_coupons_field_label">
                <label htmlFor={durationId}>
                  Duration
                  <span className="cp_coupons_required" aria-hidden>
                    *
                  </span>
                </label>
                <FormTooltip
                  label="What duration means"
                  content={
                    <div className="cp_coupons_info_tip">
                      <p>Once applies the discount to a single payment.</p>
                      <p>
                        Repeating keeps it for the months you enter, then the
                        deal bills the full price.
                      </p>
                      <p>Forever keeps the discount in place.</p>
                    </div>
                  }
                />
              </span>
              <select
                id={durationId}
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
            </div>
            <div className="cp_coupons_duration">
              {/*
              <label className="cp_coupons_field">
                <span>
                  Years
                  {duration === "repeating" ? (
                    <span className="cp_coupons_required" aria-hidden>
                      *
                    </span>
                  ) : null}
                </span>
                <input
                  className="cp_coupons_input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={durationYears}
                  disabled={duration !== "repeating"}
                  onChange={(e) =>
                    setDurationYears(e.target.value.replace(/\D/g, "").slice(0, 2))
                  }
                  placeholder="0"
                />
              </label>
              */}
              <label className="cp_coupons_field">
                <span>
                  Months
                  {duration === "repeating" ? (
                    <span className="cp_coupons_required" aria-hidden>
                      *
                    </span>
                  ) : null}
                </span>
                <input
                  className="cp_coupons_input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={durationMonths}
                  disabled={duration !== "repeating"}
                  onChange={(e) =>
                    setDurationMonths(e.target.value.replace(/\D/g, "").slice(0, 3))
                  }
                  placeholder="0"
                />
              </label>
            </div>
            <div className="cp_coupons_field">
              <span className="cp_coupons_field_label">
                <label htmlFor={maxRedemptionsId}>Max redemptions</label>
                <FormTooltip
                  label="What max redemptions means"
                  content={
                    <p className="cp_coupons_info_tip">
                      The most times this coupon can be used. Only a positive
                      whole number is allowed. A blank field is saved as 1 use.
                      After that number is reached, the coupon can no longer be
                      applied.
                    </p>
                  }
                />
              </span>
              <input
                id={maxRedemptionsId}
                className="cp_coupons_input"
                inputMode="numeric"
                value={maxRedemptions}
                onChange={(e) =>
                  setMaxRedemptions(e.target.value.replace(/\D/g, ""))
                }
                placeholder="1"
              />
            </div>
            <label className="cp_coupons_field">
              <span>
                Redeem by
                <span className="cp_coupons_required" aria-hidden>
                  *
                </span>
              </span>
              <input
                className="cp_coupons_input"
                type="date"
                value={redeemBy}
                min={localDateInputValue()}
                onChange={(e) => {
                  const next = e.target.value
                  if (next && next < localDateInputValue()) {
                    setRedeemBy("")
                    setRedeemByError("Redeem-by date cannot be in the past.")
                    return
                  }
                  setRedeemByError("")
                  setRedeemBy(next)
                }}
                aria-invalid={redeemByError ? true : undefined}
                aria-describedby={redeemByError ? "cp-coupon-redeem-by-error" : undefined}
                required
              />
              {redeemByError ? (
                <p id="cp-coupon-redeem-by-error" className="cp_coupons_field_error" role="alert">
                  {redeemByError}
                </p>
              ) : null}
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
          <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer cp_coupons_status_tabs">
            <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
              <div
                className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
                role="tablist"
                aria-label="Filter coupons by status"
              >
                {(
                  [
                    ["all", "All", LayoutGrid, rows.length],
                    ["active", "Active", Activity, activeCount],
                    ["inactive", "Inactive", CircleOff, inactiveCount],
                  ] as const
                ).map(([id, label, Icon, count]) => (
                  <button
                    key={id}
                    type="button"
                    id={`cp-coupon-status-${id}`}
                    role="tab"
                    aria-selected={statusFilter === id}
                    aria-label={`${label}, ${formatCount(count)}`}
                    className={`um_members_tab deals_tabs_tab um_segmented_tab${
                      statusFilter === id ? " um_members_tab_active" : ""
                    }`}
                    onClick={() => {
                      setStatusFilter(id)
                      setHistoryPage(1)
                    }}
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
                    <span className="deals_tabs_count" aria-hidden>
                      ({formatCount(count)})
                    </span>
                  </button>
                ))}
              </div>
            </TabsScrollStrip>
          </div>
          <div
            className="um_toolbar um_toolbar_export_then_search cp_billing_deal_search_toolbar"
            role="search"
          >
            <div className="um_search_wrap">
              <Search className="um_search_icon" size={18} aria-hidden />
              <input
                type="search"
                className="um_search_input"
                value={historyQuery}
                onChange={(e) => {
                  setHistoryQuery(e.target.value)
                  setHistoryPage(1)
                }}
                placeholder="Search"
                aria-label="Search coupons"
              />
            </div>
          </div>
          <div className="cp_billing_invoices_table_wrap deal_inv_table_panel">
      <DataTable
        columns={historyColumns}
        rows={loading ? [] : filteredHistory}
        getRowKey={(row) => row.id}
        emptyLabel={
          loading
            ? "Loading coupons…"
            : rows.length === 0
              ? "No coupons yet."
              : "No coupons match this filter."
        }
        isLoading={loading}
        visualVariant="members"
        membersTableClassName="um_table_members deal_inv_table cp_coupons_table"
        membersShell="default"
        forceHorizontalScroll={false}
        floatingHorizontalScroll={false}
        initialSort={{ columnId: "created", direction: "desc" }}
        pagination={
          !loading && filteredHistory.length > 0
            ? {
                page: historyPageSafe,
                pageSize: historyPageSize,
                totalItems: filteredHistory.length,
                onPageChange: setHistoryPage,
                onPageSizeChange: (nextSize) => {
                  setHistoryPageSize(nextSize)
                  setHistoryPage(1)
                },
                ariaLabel: "Coupon history pagination",
              }
            : undefined
        }
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
              onChange={(e) => {
                setUsageQuery(e.target.value)
                setUsagePage(1)
                setExpandedOrgId(null)
              }}
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
            rows={usageLoading ? [] : filteredOrgs}
            getRowKey={(row) => row.id}
            emptyLabel={
              usageLoading
                ? "Loading coupon use…"
                : orgs.length === 0
                  ? "No organizations have used a coupon yet."
                  : "No organizations match your search."
            }
            isLoading={usageLoading}
            visualVariant="members"
            membersTableClassName="um_table_members deal_inv_table cp_billing_orgs_table"
            membersShell="default"
            initialSort={{ columnId: "name", direction: "asc" }}
            pagination={
              !usageLoading && filteredOrgs.length > 0
                ? {
                    page: usagePageSafe,
                    pageSize: usagePageSize,
                    totalItems: filteredOrgs.length,
                    onPageChange: setUsagePage,
                    onPageSizeChange: (nextSize) => {
                      setUsagePageSize(nextSize)
                      setUsagePage(1)
                    },
                    ariaLabel: "Coupon usage pagination",
                  }
                : undefined
            }
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
