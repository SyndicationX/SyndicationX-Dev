import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import {
  BadgeDollarSign,
  Briefcase,
  Building2,
  Calendar,
  Check,
  CreditCard,
  DollarSign,
  ExternalLink,
  Info,
  Loader2,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  ShieldCheck,
  WalletCards,
  CircleDot,
  ChevronDown,
  Trash2,
  X,
} from "lucide-react";
import {
  DataTable,
  type DataTableColumn,
} from "../../../common/components/data-table/DataTable";
import { TabsScrollStrip } from "../../../common/components/tabs-scroll-strip/TabsScrollStrip";
import {
  fetchCompanyBillingDeals,
  fetchCompanyBillingInvoices,
  fetchPlatformBillingDeals,
  fetchPlatformOrganizationBilling,
  fetchCompanyBillingPaymentMethods,
  fetchCompanyBillingStatus,
  openCompanyBillingPortal,
  payCompanyBillingWithSavedMethod,
  startCompanyBillingCheckout,
  type BillingCouponPreview,
  startCompanyBillingSetupIntent,
  releaseCompanyBillingPayment,
  syncCompanyBillingCheckout,
  syncCompanyBillingPayment,
  syncCompanyBillingPaymentMethods,
  updateCompanyDealBillingCycle,
  updateCompanyDealBillingStartDate,
  normalizeBillingDealId,
  type BillingSetupIntentSession,
  type BillingOrganizationOption,
  type CompanyBillingInvoice,
  type CompanyBillingPaymentMethod,
  type CompanyBillingStatus,
  type CompanyDealBillingRow,
} from "./companyBillingApi";
import { BillingPaymentElementModal } from "./BillingPaymentElementModal";
import { BillingCouponModal } from "./BillingCouponModal";
import { BillingPayMethodModal } from "./BillingPayMethodModal";
import { PlatformComplimentaryNoticeModal } from "./PlatformComplimentaryNoticeModal";
import { isCompanyAdmin, isPlatformAdmin } from "../../../common/auth/roleUtils";
import { dealStageLabel } from "../dealsDashboardUtils";
import { formatDealListDateDisplay } from "../Deals/dealsListDisplay";
import { dealStageChipCompactClassName } from "../Deals/utils/dealStageChip";
import { DealAvatarIconRing } from "../../../common/components/entity-avatar/EntityAvatarNameCell";
import { ToolStyleCard } from "../../../common/components/tool-style-card/ToolStyleCard";
import { cardCompactAmountOrDash } from "../../../common/components/card-compact-amount/CardCompactAmount";
import { formatCount } from "@/common/utils/formatCount";
import { parseMoneyDigits } from "../Deals/utils/offeringMoneyFormat";
import {
  dealSaasBillingHasStarted,
  formatSaasBillingStartIsoDisplay,
  platformSaasBillingHasStarted,
} from "../Deals/utils/saasBillingStartDate";
import { toast } from "../../../common/components/Toast";
import { getDefaultBccFromEnv } from "../../../common/features/send-mail";
import "../Deals/components/deal-stage-change-modal.css";

type BillingSubTab = "pricing" | "deals" | "payment-methods" | "payment-history";
type InvoiceRow = CompanyBillingInvoice;
type SeatBand = "5" | "10" | "10plus";

function dealRowIsPayable(row: CompanyDealBillingRow): boolean {
  if (row.archived) return false;
  return row.payable === true || row.billable === true;
}

function dealRowCheckoutAllowed(row: CompanyDealBillingRow): boolean {
  if (!dealRowIsPayable(row)) return false;
  if (!dealSaasBillingHasStarted(row.saasBillingStartsAt)) return false;
  return true;
}

function dealCanSavePaymentMethodForFutureBilling(
  row: CompanyDealBillingRow,
): boolean {
  return (
    dealRowIsPayable(row) &&
    !dealIsNotBilled(row) &&
    saasBillingStartIsInFuture(row)
  );
}

function formatPlanPrice(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  });
}

function couponPrice(
  listPrice: number,
  coupon: BillingCouponPreview | null,
): number {
  if (!coupon) return listPrice;
  if (coupon.percentOff != null) {
    return Math.max(0, Math.round(listPrice * (100 - coupon.percentOff)) / 100);
  }
  if (coupon.amountOffCents != null) {
    return Math.max(0, Math.round(listPrice * 100 - coupon.amountOffCents) / 100);
  }
  return listPrice;
}

type DealTier = {
  id: "starter" | "running" | "growth";
  name: string;
  dealSize: string;
  companyUsers: number;
  featured: boolean;
  enabled: boolean;
  prices: Record<SeatBand, { monthly: number; annual: number }>;
};

const PRICE_ENV_HINT: Record<
  DealTier["id"],
  Record<SeatBand, { monthly: string; annual: string }>
> = {
  starter: {
    "5": {
      monthly: "STARTER_5_MONTH_PRICING",
      annual: "STARTER_5_YEARLY_PRICING",
    },
    "10": {
      monthly: "STARTER_10_MONTH_PRICING",
      annual: "STARTER_10_YEARLY_PRICING",
    },
    "10plus": {
      monthly: "STARTER_10_PLUS_MONTH_PRICING",
      annual: "STARTER_10_PLUS_YEARLY_PRICING",
    },
  },
  running: {
    "5": {
      monthly: "RUNNING_5_MONTH_PRICING",
      annual: "RUNNING_5_YEARLY_PRICING",
    },
    "10": {
      monthly: "RUNNING_10_MONTH_PRICING",
      annual: "RUNNING_10_YEARLY_PRICING",
    },
    "10plus": {
      monthly: "RUNNING_10_PLUS_MONTH_PRICING",
      annual: "RUNNING_10_PLUS_YEARLY_PRICING",
    },
  },
  growth: {
    "5": {
      monthly: "GROWTH_5_MONTH_PRICING",
      annual: "GROWTH_5_YEARLY_PRICING",
    },
    "10": {
      monthly: "GROWTH_10_MONTH_PRICING",
      annual: "GROWTH_10_YEARLY_PRICING",
    },
    "10plus": {
      monthly: "GROWTH_10_PLUS_MONTH_PRICING",
      annual: "GROWTH_10_PLUS_YEARLY_PRICING",
    },
  },
};

const CUSTOM_PLAN_CONTACT_TO = "support@syndicationx.com";
const CUSTOM_PLAN_CONTACT_SUBJECT = "Custom plan inquiry – SyndicationX";

function customPlanContactHref(bcc: string[]): string {
  const q = new URLSearchParams();
  const uniqueBcc = [...new Set(bcc.map((x) => x.trim()).filter((x) => x.includes("@")))];
  if (uniqueBcc.length > 0) q.set("bcc", uniqueBcc.join(","));
  q.set("subject", CUSTOM_PLAN_CONTACT_SUBJECT);
  return `mailto:${CUSTOM_PLAN_CONTACT_TO}?${q.toString()}`;
}

const EXTRA_COMPANY_USER_FEE_DOLLARS = 10;
const EXTRA_CO_GP_ANNUAL_MONTHS = 10;

const DEAL_TIERS: DealTier[] = [
  {
    id: "starter",
    name: "Starter",
    dealSize: "Up to $3M equity",
    companyUsers: 1,
    featured: true,
    enabled: true,
    prices: {
      "5": { monthly: 149, annual: 1490 },
      "10": { monthly: 169, annual: 1690 },
      "10plus": { monthly: 189, annual: 1890 },
    },
  },
  {
    id: "running",
    name: "Running",
    dealSize: "Up to $5M deal",
    companyUsers: 2,
    featured: false,
    enabled: true,
    prices: {
      "5": { monthly: 199, annual: 1990 },
      "10": { monthly: 229, annual: 2190 },
      "10plus": { monthly: 249, annual: 2490 },
    },
  },
  {
    id: "growth",
    name: "Growth",
    dealSize: "Up to $10M deal",
    companyUsers: 3,
    featured: false,
    enabled: true,
    prices: {
      "5": { monthly: 249, annual: 2490 },
      "10": { monthly: 269, annual: 2690 },
      "10plus": { monthly: 289, annual: 2890 },
    },
  },
];

const CO_SPONSOR_OPTIONS: readonly { id: SeatBand; label: string }[] = [
  { id: "5", label: "5" },
  { id: "10", label: "10" },
  { id: "10plus", label: "10+" },
];

/** 1–5 co-sponsors use the 5 package, 6–10 the 10 package, 11+ the 10+ package. */
function seatBandForCoSponsors(count: number): SeatBand {
  const n = Math.floor(Number(count) || 0);
  if (n >= 11) return "10plus";
  if (n >= 6) return "10";
  return "5";
}

/** Table row for the package: 5th price, 10th price, or 12th price. */
function includedCoSponsorsForSeat(seat: SeatBand): number {
  if (seat === "10plus") return 12;
  if (seat === "10") return 10;
  return 5;
}

/** 1–5 → 5th price, 6–10 → 10th price, 11+ → 12th price. */
function pricingCountForCoSponsors(count: number): number {
  return includedCoSponsorsForSeat(seatBandForCoSponsors(count));
}

/** Previous monthly price by co-sponsor count 1–12. Shown struck through. */
const CO_GP_MONTHLY_WAS: Record<DealTier["id"], readonly number[]> = {
  starter: [490, 490, 490, 490, 490, 515, 540, 540, 540, 540, 565, 590],
  running: [649, 649, 649, 649, 649, 674, 699, 724, 724, 724, 749, 774],
  growth: [749, 749, 749, 749, 749, 774, 799, 799, 799, 799, 824, 849],
};

/** Previous annual price by co-sponsor count 1–12. Shown struck through. */
const CO_GP_ANNUAL_WAS: Record<DealTier["id"], readonly number[]> = {
  starter: [4900, 4900, 4900, 4900, 4900, 5150, 5400, 5400, 5400, 5400, 5650, 5900],
  running: [6490, 6490, 6490, 6490, 6490, 6740, 6990, 6990, 6990, 6990, 7490, 7740],
  growth: [7490, 7490, 7490, 7490, 7490, 7740, 7990, 7990, 7990, 7990, 8240, 8490],
};

/** Monthly price by co-sponsor count 1–12. Index 0 is 1 co-sponsor. */
const CO_GP_MONTHLY: Record<DealTier["id"], readonly number[]> = {
  starter: [149, 149, 149, 149, 149, 159, 169, 169, 169, 169, 179, 189],
  running: [199, 199, 199, 199, 199, 209, 219, 229, 229, 229, 239, 249],
  growth: [249, 249, 249, 249, 249, 259, 269, 269, 269, 269, 279, 289],
};

/** Annual price by co-sponsor count 1–12. */
const CO_GP_ANNUAL: Record<DealTier["id"], readonly number[]> = {
  starter: [1490, 1490, 1490, 1490, 1490, 1590, 1690, 1690, 1690, 1690, 1790, 1890],
  running: [1990, 1990, 1990, 1990, 1990, 2090, 2190, 2190, 2190, 2190, 2390, 2490],
  growth: [2490, 2490, 2490, 2490, 2490, 2590, 2690, 2690, 2690, 2690, 2790, 2890],
};

function coGpsForCatalog(
  coGpCount: number | null | undefined,
  seat: SeatBand,
): number {
  if (seat === "5" || seat === "10" || seat === "10plus") {
    return includedCoSponsorsForSeat(seat);
  }
  const n = Number(coGpCount);
  if (Number.isFinite(n) && n > 0) return pricingCountForCoSponsors(n);
  return 5;
}

function priceFromTable(
  table: Record<DealTier["id"], readonly number[]>,
  tierId: DealTier["id"],
  coGpCount: number,
): number {
  const index = pricingCountForCoSponsors(coGpCount) - 1;
  return table[tierId][index];
}

function coSponsorRangeLabel(seat: SeatBand): string {
  if (seat === "10plus") return "10+ co-sponsors";
  if (seat === "10") return "6 to 10 co-sponsors";
  return "1 to 5 co-sponsors";
}

function coSponsorPackageCopy(seat: SeatBand): string {
  const included = includedCoSponsorsForSeat(seat);
  if (seat === "10plus") {
    return `Includes up to ${included} co-sponsors. Each co-sponsor beyond 12 is $10.`;
  }
  return `Includes ${coSponsorRangeLabel(seat)}.`;
}

function planPrice(
  tierId: DealTier["id"],
  cycle: "monthly" | "annually",
  coGpCount: number,
): number {
  const table = cycle === "monthly" ? CO_GP_MONTHLY : CO_GP_ANNUAL;
  return priceFromTable(table, tierId, coGpCount);
}

function previousPlanPrice(
  tierId: DealTier["id"],
  cycle: "monthly" | "annually",
  coGpCount: number,
): number {
  const table = cycle === "monthly" ? CO_GP_MONTHLY_WAS : CO_GP_ANNUAL_WAS;
  return priceFromTable(table, tierId, coGpCount);
}

const DEFAULT_DATE_FROM = "";
const DEFAULT_DATE_TO = "";

function formatPaymentHistoryDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${m}-${d}-${y}`;
}

function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoToDateInputValue(iso: string | null | undefined): string {
  const raw = String(iso ?? "").trim();
  const ymd = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (ymd) return ymd[1];
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString().slice(0, 10);
}

/** YYYY-MM-DD for today's UTC calendar day — used as min on billing start date. */
function utcTodayYmd(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isBillingStartDateInThePast(ymd: string, nowMs = Date.now()): boolean {
  const chosen = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chosen)) return false;
  return chosen < utcTodayYmd(nowMs);
}

function invoiceStatusClassName(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "paid") return "cp_billing_invoice_status cp_billing_invoice_status--paid";
  if (normalized === "open") return "cp_billing_invoice_status cp_billing_invoice_status--open";
  if (normalized === "overdue") {
    return "cp_billing_invoice_status cp_billing_invoice_status--overdue";
  }
  if (normalized === "void") return "cp_billing_invoice_status cp_billing_invoice_status--void";
  return "cp_billing_invoice_status";
}

function billingPlanLabel(planId: string | null | undefined): string {
  const id = String(planId ?? "").trim().toLowerCase();
  if (!id) return "—";
  const tier = DEAL_TIERS.find((t) => t.id === id);
  if (tier) return tier.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Unpaid deals follow the current offering size. A paid subscription keeps its plan. */
function dealPlanId(
  row: Pick<CompanyDealBillingRow, "planId" | "suggestedPlanId" | "billed">,
): string | null {
  const suggested = String(row.suggestedPlanId ?? "").trim();
  if (!row.billed && suggested) return suggested;
  const paid = String(row.planId ?? "").trim();
  if (paid) return paid;
  return suggested || null;
}

function suggestedPlanIdForDeal(
  row: Pick<CompanyDealBillingRow, "suggestedPlanId"> | undefined,
): DealTier["id"] {
  const raw = String(row?.suggestedPlanId ?? "")
    .trim()
    .toLowerCase();
  if (raw === "starter" || raw === "running" || raw === "growth") return raw;
  return "starter";
}

function billingCycleLabel(cycle: string | null | undefined): string {
  const c = String(cycle ?? "").trim().toLowerCase();
  if (c === "annual" || c === "annually" || c === "yearly") return "Annual";
  if (c === "monthly") return "Monthly";
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : "—";
}

function BillingCycleConfirmModal({
  row,
  nextCycle,
  confirming,
  onConfirm,
  onCancel,
}: {
  row: CompanyDealBillingRow;
  nextCycle: "monthly" | "annually";
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const planId = String(dealPlanId(row) ?? "").trim().toLowerCase();
  const tier =
    DEAL_TIERS.find((t) => planId === t.id || planId.startsWith(`${t.id}_`)) ??
    DEAL_TIERS[0];
  const annual = nextCycle === "annually";
  const seat = catalogSeatBand(row);
  const coGps = coGpsForCatalog(row.coGpCount, seat);
  const price = planPrice(tier.id, nextCycle, coGps);
  const previousPrice = previousPlanPrice(tier.id, nextCycle, coGps);
  const priceSuffix = annual ? "/yr" : "/mo";
  const fromLabel =
    billingCycleSelectValue(row.billingCycle) === "annually"
      ? "yearly"
      : billingCycleSelectValue(row.billingCycle) === "monthly"
        ? "monthly"
        : "the current cycle";
  const toLabel = annual ? "yearly" : "monthly";
  const dealName = row.dealName.trim() || "this deal";

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !confirming) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [confirming, onCancel]);

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !confirming) onCancel();
      }}
    >
      <div
        className="deal_stage_modal deal_stage_modal--saas_paywall deal_stage_modal--billing_cycle"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap" aria-hidden>
            <BadgeDollarSign size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Payment cycle</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              Confirm {toLabel} billing
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            disabled={confirming}
            onClick={onCancel}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="deal_stage_modal_body">
          <p className="deal_stage_modal_desc">
            Switch {dealName} from {fromLabel} to {toLabel}? Review the plan
            price below, then confirm to update the payment cycle.
          </p>
          <div
            className={`cp_billing_plan_card cp_billing_cycle_confirm_card${
              tier.featured ? " cp_billing_plan_card_featured" : ""
            }`}
          >
            {tier.featured ? (
              <span className="cp_billing_plan_badge">Most popular</span>
            ) : (
              <span className="cp_billing_plan_badge">Available now</span>
            )}
            <h4 className="cp_billing_plan_name">{tier.name}</h4>
            <p className="cp_billing_plan_tagline">{tier.dealSize}</p>
            <div className="cp_billing_plan_price">
              <div className="cp_billing_plan_price_main">
                {previousPrice !== price ? (
                  <span className="cp_billing_plan_price_was">
                    ${formatPlanPrice(previousPrice)}
                  </span>
                ) : null}
                <span className="cp_billing_plan_price_amount">
                  ${formatPlanPrice(price)}
                </span>
                <span className="cp_billing_plan_price_suffix">
                  {priceSuffix}
                </span>
              </div>
              {annual ? (
                <p className="cp_billing_plan_price_perk">2 months free</p>
              ) : null}
              <p className="cp_billing_plan_price_calc">
                {annual ? "Billed yearly" : "Billed monthly"} · ACH or credit
                card
              </p>
            </div>
            <ul className="cp_billing_plan_features">
              <li>
                <Check size={16} aria-hidden="true" />
                <span>{tier.dealSize}</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>
                  {coSponsorPackageCopy(seat)}
                </span>
              </li>
            </ul>
          </div>
        </div>

        <footer className="deal_stage_modal_actions">
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--cancel"
            disabled={confirming}
            onClick={onCancel}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
            disabled={confirming}
            onClick={onConfirm}
          >
            {confirming ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="deals_create_btn_spin"
                  aria-hidden
                />
                Updating…
              </>
            ) : (
              <>
                <Check size={16} strokeWidth={2} aria-hidden />
                Confirm {toLabel}
              </>
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function BillingDealStartDateModal({
  row,
  saving,
  onSave,
  onCancel,
}: {
  row: CompanyDealBillingRow;
  saving: boolean;
  onSave: (ymd: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const minDate = utcTodayYmd();
  const [value, setValue] = useState(() =>
    isoToDateInputValue(row.saasBillingStartsAt),
  );
  const [dateError, setDateError] = useState("");
  const dealName = row.dealName.trim() || "this deal";
  const pastDate = Boolean(value) && isBillingStartDateInThePast(value);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel, saving]);

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div
        className="deal_stage_modal deal_stage_modal--saas_paywall"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap" aria-hidden>
            <Calendar size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Deal billing</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              Set billing start date
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            disabled={saving}
            onClick={onCancel}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="deal_stage_modal_body">
          <p className="deal_stage_modal_desc">
            Choose when SaaS billing starts for {dealName}. Until this date the
            deal stays complimentary. After it, the lead sponsor must pay to
            keep the deal open.
          </p>
          <label className="cp_billing_start_field">
            <span>Billing start date</span>
            <input
              type="date"
              className="cp_billing_filter_input"
              value={value}
              min={minDate}
              disabled={saving}
              aria-invalid={pastDate || undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setDateError("");
              }}
            />
          </label>
          {dateError || pastDate ? (
            <p className="deal_saas_paywall_error" role="alert">
              {dateError || "Billing start date cannot be in the past."}
            </p>
          ) : null}
        </div>

        <footer className="deal_stage_modal_actions">
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--cancel"
            disabled={saving}
            onClick={onCancel}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
            disabled={saving || !value || pastDate}
            onClick={() => {
              if (!value) return;
              if (isBillingStartDateInThePast(value)) {
                setDateError("Billing start date cannot be in the past.");
                return;
              }
              onSave(value);
            }}
          >
            {saving ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="deals_create_btn_spin"
                  aria-hidden
                />
                Saving…
              </>
            ) : (
              <>
                <Check size={16} strokeWidth={2} aria-hidden />
                Save date
              </>
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function dealBillingCompanyId(
  row: CompanyDealBillingRow,
  fallbackCompanyId: string,
): string {
  const id = String(row.companyId ?? "").trim();
  return id || fallbackCompanyId;
}

function dealOrganizationLabel(row: CompanyDealBillingRow): string {
  return String(row.companyName ?? "").trim() || "—";
}

type BillingOrganizationTableRow = {
  id: string;
  name: string;
  deals: CompanyDealBillingRow[];
  billedCount: number;
  totalPaidCents: number;
  totalPaid: string;
};

function billingCycleSelectValue(
  cycle: string | null | undefined,
): "monthly" | "annually" | "" {
  const c = String(cycle ?? "").trim().toLowerCase();
  if (c === "annual" || c === "annually" || c === "yearly") return "annually";
  if (c === "monthly") return "monthly";
  return "";
}

function catalogSeatBand(row: CompanyDealBillingRow): SeatBand {
  if (row.seatBand === "10" || row.seatBand === "10plus" || row.seatBand === "5") {
    return row.seatBand;
  }
  return "5";
}

function catalogPlanAmountDollars(row: CompanyDealBillingRow): number | null {
  if (dealIsNotBilled(row)) return null;
  const id = String(dealPlanId(row) ?? "").trim().toLowerCase();
  const tier = DEAL_TIERS.find((t) => t.id === id);
  if (!tier) return null;
  const cycle = String(row.billingCycle ?? "").trim().toLowerCase();
  const annual =
    cycle === "annual" || cycle === "annually" || cycle === "yearly";
  const seat = catalogSeatBand(row);
  return planPrice(
    tier.id,
    annual ? "annually" : "monthly",
    coGpsForCatalog(row.coGpCount, seat),
  );
}

function catalogPlanAmountLabel(row: CompanyDealBillingRow): string {
  const price = catalogPlanAmountDollars(row);
  return price == null ? "—" : `$${formatPlanPrice(price)}`;
}

function latestInvoiceAmountForDeal(
  invoices: CompanyBillingInvoice[],
  dealId: string,
): string | null {
  const match = invoices
    .filter((inv) => inv.dealId === dealId && Boolean(inv.amount?.trim()))
    .sort((a, b) => String(b.invoiceDate).localeCompare(String(a.invoiceDate)));
  const amount = match[0]?.amount?.trim();
  return amount || null;
}

function resolvedIncludedCoGps(deal: CompanyDealBillingRow): number | null {
  const seatBand = catalogSeatBand(deal);
  if (seatBand === "10plus") return 12;
  if (seatBand === "10") return 10;
  if (seatBand === "5") return 5;
  const fromApi = Number(deal.includedCoGps);
  if (Number.isFinite(fromApi) && fromApi > 0) return fromApi;
  return 5;
}

function extraCoGpDetail(deal: CompanyDealBillingRow): {
  count: number;
  included: number | null;
  extra: number;
  paid: number;
  dueDollars: number;
  paidDollars: number;
} {
  const count = Math.max(0, Number(deal.coGpCount ?? 0) || 0);
  const paid = Math.max(0, Number(deal.extraCompanyUsersPaid ?? 0) || 0);
  const included = resolvedIncludedCoGps(deal);
  const extra =
    included == null
      ? Math.max(0, Number(deal.extraCompanyUsersDue ?? 0) || 0)
      : Math.max(0, count - included);
  const due = Math.max(
    extra,
    Math.max(0, Number(deal.extraCompanyUsersDue ?? 0) || 0),
  );
  const annual = /annual|year/i.test(String(deal.billingCycle ?? ""));
  const perExtra = annual
    ? EXTRA_COMPANY_USER_FEE_DOLLARS * EXTRA_CO_GP_ANNUAL_MONTHS
    : EXTRA_COMPANY_USER_FEE_DOLLARS;
  return {
    count,
    included,
    extra: due,
    paid,
    dueDollars: due * perExtra,
    paidDollars: paid * perExtra,
  };
}

function extraCompanyUserAmountParts(
  row: CompanyDealBillingRow,
): { paidLabel: string | null; dueLabel: string | null } {
  if (dealIsNotBilled(row)) {
    return { paidLabel: null, dueLabel: null };
  }
  const detail = extraCoGpDetail(row);
  return {
    paidLabel:
      detail.paid > 0
        ? `$${detail.paidDollars} extra Co-Sponsor${detail.paid === 1 ? "" : "s"}`
        : null,
    dueLabel:
      detail.extra > 0
        ? `$${detail.dueDollars} extra Co-Sponsor${detail.extra === 1 ? "" : "s"} due`
        : null,
  };
}

function dealAmountSearchText(
  row: CompanyDealBillingRow,
  invoices: CompanyBillingInvoice[],
): string {
  if (dealIsNotBilled(row)) return "—";
  const extra = extraCompanyUserAmountParts(row);
  return [
    latestInvoiceAmountForDeal(
      invoices.filter((inv) => inv.billingScope !== "extra_company_user"),
      row.id,
    ) ?? catalogPlanAmountLabel(row),
    extra.paidLabel,
    extra.dueLabel,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatBillingDollars(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

function BillingAmountBreakdown({
  total,
  base,
  extra,
  period,
}: {
  total: number | null;
  base: number | null;
  extra: number;
  period: string;
}) {
  if (total == null) return <span>—</span>;
  const showBreakdown = base != null && extra > 0;
  return (
    <span className="cp_billing_amount_stack">
      <span className="cp_billing_amount_total">
        {formatBillingDollars(total)}
        {period}
      </span>
      {showBreakdown ? (
        <span className="cp_billing_amount_extra">
          <span>{formatBillingDollars(base)} deal price</span>
          <span>+ {formatBillingDollars(extra)} extra users</span>
        </span>
      ) : null}
    </span>
  );
}

function DealAmountCell({
  row,
}: {
  row: CompanyDealBillingRow;
  invoices: CompanyBillingInvoice[];
}) {
  if (dealIsNotBilled(row)) {
    return <span>—</span>;
  }
  const base = catalogPlanAmountDollars(row);
  const extra = extraCoGpDetail(row);
  const annual = /annual|year/i.test(String(row.billingCycle ?? ""));
  const period = annual ? "/yr" : "/mo";
  const extraDollars = extra.extra > 0 ? extra.dueDollars : 0;
  const total = base == null ? null : base + extraDollars;
  if (total == null) {
    return <span>{catalogPlanAmountLabel(row)}</span>;
  }
  return (
    <BillingAmountBreakdown
      total={total}
      base={base}
      extra={extraDollars}
      period={period}
    />
  );
}

function dealAmountLabel(
  row: CompanyDealBillingRow,
  invoices: CompanyBillingInvoice[],
): string {
  return dealAmountSearchText(row, invoices);
}

function saasBillingStartIsInFuture(row: CompanyDealBillingRow): boolean {
  return !dealSaasBillingHasStarted(row.saasBillingStartsAt);
}

function dealIsNotBilled(row: CompanyDealBillingRow): boolean {
  const stage = (row.dealStage ?? "").trim().toLowerCase();
  return (
    Boolean(row.archived) ||
    row.billable === false ||
    stage === "draft" ||
    stage === "liquidated"
  );
}

function dealBillingStatusLabel(row: CompanyDealBillingRow): string {
  const s = String(row.subscriptionStatus ?? "").trim().toLowerCase();
  const failed =
    s === "past_due" || s === "unpaid" || s === "incomplete";
  const onPaidCycle =
    row.billed || s === "active" || s === "trialing";
  if (onPaidCycle) {
    return failed ? "Payment failed" : "Paid";
  }
  if (failed) return "Payment failed";
  // Complimentary window, or stages that are never billed (draft / archived / liquidated).
  if (saasBillingStartIsInFuture(row) || dealIsNotBilled(row)) {
    return "Free";
  }
  return "Pending";
}

function dealBillingStatusTitle(row: CompanyDealBillingRow): string | undefined {
  const label = dealBillingStatusLabel(row);
  if (label === "Paid") return "Paid for the current billing period.";
  if (label === "Payment failed") {
    return "Payment failed for the current billing period.";
  }
  if (label === "Pending") return "Payment is pending for this billing period.";
  if (label !== "Free") return undefined;
  if (dealIsNotBilled(row)) {
    return "Draft, archived, and liquidated deals are complimentary.";
  }
  return `Complimentary until ${formatSaasBillingStartIsoDisplay(row.saasBillingStartsAt)}`;
}

function dealBillingStatusClassName(row: CompanyDealBillingRow): string {
  const label = dealBillingStatusLabel(row);
  if (label === "Paid") return invoiceStatusClassName("paid");
  if (label === "Free") return invoiceStatusClassName("paid");
  if (label === "Payment failed") return invoiceStatusClassName("overdue");
  if (label === "Pending") return invoiceStatusClassName("open");
  return invoiceStatusClassName("void");
}

function dealBillingSettingsLocked(
  row: CompanyDealBillingRow,
  nowMs = Date.now(),
): boolean {
  const status = String(row.subscriptionStatus ?? "").trim().toLowerCase();
  const paid = row.billed || status === "active" || status === "trialing";
  if (!paid) return false;
  if (!row.nextBillingDate) return true;
  const nextBillingMs = Date.parse(row.nextBillingDate);
  return !Number.isFinite(nextBillingMs) || nextBillingMs > nowMs;
}

function dealBillingSettingsLockedTitle(
  row: CompanyDealBillingRow,
): string {
  return row.nextBillingDate
    ? `Locked until the next billing date, ${formatDealListDateDisplay(row.nextBillingDate)}.`
    : "Locked during the current paid billing period.";
}

function invoiceMatchesFilters(
  row: InvoiceRow,
  status: string,
  from: string,
  to: string,
): boolean {
  if (status && row.status.toLowerCase() !== status.toLowerCase()) {
    return false;
  }
  const invoiceDate = parseIsoDate(row.invoiceDate);
  const fromDate = parseIsoDate(from);
  const toDate = parseIsoDate(to);
  if (invoiceDate && fromDate && invoiceDate < fromDate) return false;
  if (invoiceDate && toDate && invoiceDate > toDate) return false;
  return true;
}

function formatPaymentMethodLabel(pm: CompanyBillingPaymentMethod): string {
  const type = (pm.type || "").trim().toLowerCase();
  const isBank =
    type === "us_bank_account" || type === "bank_account" || type === "ach";
  const brand = (pm.brand || (isBank ? "Bank account" : pm.type) || "Card").trim();
  const titled = brand.charAt(0).toUpperCase() + brand.slice(1);
  const last4 = pm.last4 ? `···· ${pm.last4}` : pm.stripePaymentMethodId;
  const exp =
    !isBank && pm.expMonth && pm.expYear
      ? ` · Exp ${String(pm.expMonth).padStart(2, "0")}/${pm.expYear}`
      : "";
  const holder = pm.billingName?.trim();
  return holder
    ? `${titled} ${last4}${exp} · ${holder}`
    : `${titled} ${last4}${exp}`;
}

function BillingPricingPanel({
  billingCycle,
  onBillingCycleChange,
  companyId,
  billingStatus,
  onStatusRefresh,
  initialDealId,
  initialDealName,
  allowPayment = true,
}: {
  billingCycle: "monthly" | "annually";
  onBillingCycleChange: (cycle: "monthly" | "annually") => void;
  companyId: string;
  billingStatus: CompanyBillingStatus | null;
  onStatusRefresh: () => void;
  initialDealId?: string;
  initialDealName?: string;
  allowPayment?: boolean;
}) {
  const navigate = useNavigate();
  const wizardMode =
    allowPayment && Boolean((initialDealId ?? "").trim());
  const [seatBand, setSeatBand] = useState<SeatBand | null>("5");
  const [wizardCycle, setWizardCycle] = useState<"monthly" | "annually" | null>(
    null,
  );
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [complimentaryNoticeOpen, setComplimentaryNoticeOpen] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<BillingCouponPreview | null>(null);
  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [payableDeals, setPayableDeals] = useState<CompanyDealBillingRow[]>([]);
  const [selectedDealId, setSelectedDealId] = useState(initialDealId ?? "");
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [payModalPlanId, setPayModalPlanId] = useState<DealTier["id"] | null>(
    null,
  );
  const [payModalMethods, setPayModalMethods] = useState<
    CompanyBillingPaymentMethod[]
  >([]);
  const [payModalLoading, setPayModalLoading] = useState(false);
  const [payModalBusy, setPayModalBusy] = useState<"saved" | "stripe" | null>(
    null,
  );
  const [payModalError, setPayModalError] = useState("");
  const [extraCompanyUsers, setExtraCompanyUsers] = useState(0);
  const [salesBcc, setSalesBcc] = useState<string[]>([]);
  const payOnceRef = useRef(false);
  const contactSalesHref = useMemo(
    () => customPlanContactHref(salesBcc),
    [salesBcc],
  );

  useEffect(() => {
    let cancelled = false;
    void getDefaultBccFromEnv().then((list) => {
      if (!cancelled) setSalesBcc(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const platformAdmin = isPlatformAdmin();
    if (!platformAdmin && !companyId) {
      setPayableDeals([]);
      setSelectedDealId("");
      return;
    }
    let cancelled = false;
    void (platformAdmin
      ? fetchPlatformBillingDeals()
      : fetchCompanyBillingDeals(companyId)
    ).then((result) => {
      if (cancelled || !result.ok) return;
      const preferred = (initialDealId ?? "").trim();
      const preferredLc = preferred.toLowerCase();
      let payable = result.deals.filter(
        (row) =>
          dealRowIsPayable(row) &&
          (!row.billed || row.needsCoGpUpgrade === true),
      );
      if (preferredLc) {
        const focused = result.deals.find(
          (row) => row.id.trim().toLowerCase() === preferredLc,
        );
        if (
          focused &&
          dealRowIsPayable(focused) &&
          !payable.some((row) => row.id === focused.id)
        ) {
          payable = [focused, ...payable];
        }
      }
      setPayableDeals(payable);
      setSelectedDealId((current) => {
        if (preferred) {
          const focused = payable.find(
            (row) => row.id.trim().toLowerCase() === preferredLc,
          );
          return focused?.id ?? preferred;
        }
        if (current && payable.some((row) => row.id === current)) return current;
        return payable[0]?.id ?? "";
      });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, billingStatus?.billedDealCount, initialDealId]);

  const selectedDeal = payableDeals.find((row) => row.id === selectedDealId);
  const payCompanyId = selectedDeal
    ? dealBillingCompanyId(selectedDeal, companyId)
    : companyId;
  const dealDisplayName =
    selectedDeal?.dealName.trim() ||
    (initialDealName ?? "").trim() ||
    (wizardMode ? "this deal" : "");
  const canManageBilling = billingStatus?.canManage === true;
  const cycleSelected = wizardMode ? wizardCycle != null : true;
  const seatsSelected = seatBand != null;
  const membersEnabled = wizardMode
    ? Boolean(selectedDealId) && cycleSelected
    : true;
  const planCardsEnabled = wizardMode
    ? membersEnabled && seatsSelected
    : true;
  const displayCycle: "monthly" | "annually" =
    (wizardMode ? wizardCycle : billingCycle) ?? "monthly";
  const displaySeat: SeatBand = seatBand ?? "5";
  const appropriatePlanId = suggestedPlanIdForDeal(selectedDeal);

  useEffect(() => {
    const count = Math.max(0, Number(selectedDeal?.coGpCount ?? 0) || 0);
    if (seatBand === "5" || seatBand === "10") {
      const included = seatBand === "10" ? 10 : 5;
      setExtraCompanyUsers(Math.max(0, count - included));
      return;
    }
    if (seatBand === "10plus") {
      setExtraCompanyUsers(Math.max(0, count - 12));
      return;
    }
    const due = Math.max(0, Number(selectedDeal?.extraCompanyUsersDue ?? 0) || 0);
    setExtraCompanyUsers(due);
  }, [
    selectedDeal?.id,
    selectedDeal?.coGpCount,
    selectedDeal?.extraCompanyUsersDue,
    seatBand,
  ]);

  useEffect(() => {
    if (!wizardMode || !selectedDeal) return;
    const cycle = billingCycleSelectValue(selectedDeal.billingCycle);
    if (cycle === "monthly" || cycle === "annually") {
      setWizardCycle(cycle);
    }
    const count = Number(selectedDeal.coGpCount);
    if (Number.isFinite(count) && count >= 1) {
      setSeatBand(seatBandForCoSponsors(count));
      return;
    }
    const currentSeat = selectedDeal.seatBand;
    if (currentSeat === "10plus" || currentSeat === "10" || currentSeat === "5") {
      setSeatBand(currentSeat);
      return;
    }
    setSeatBand("5");
  }, [
    wizardMode,
    selectedDeal,
    selectedDeal?.id,
    selectedDeal?.billingCycle,
    selectedDeal?.coGpCount,
    selectedDeal?.seatBand,
  ]);

  const activePlanId = billingStatus?.planId?.trim().toLowerCase() ?? "";
  const subStatus =
    billingStatus?.subscriptionStatus?.trim().toLowerCase() ?? "none";
  const isPaid =
    subStatus === "active" ||
    subStatus === "trialing";
  const hasPaymentIssue =
    Boolean(billingStatus?.lastPaymentError) ||
    subStatus === "past_due" ||
    subStatus === "unpaid" ||
    subStatus === "incomplete";

  const planKey = (tierId: string) => tierId;

  const planReady = (tierId: DealTier["id"]): boolean => {
    const row = billingStatus?.plansConfigured.find((p) => p.id === tierId);
    if (!row) return false;
    const seatRow = row.seats?.find((s) => s.seatBand === displaySeat);
    if (seatRow) {
      return displayCycle === "monthly"
        ? seatRow.monthlyReady
        : seatRow.annualReady;
    }
    return displayCycle === "monthly" ? row.monthlyReady : row.annualReady;
  };

  const handleChoosePlan = async (tierId: DealTier["id"]) => {
    setActionError("");
    if (selectedDeal ? !dealRowCheckoutAllowed(selectedDeal) : !platformSaasBillingHasStarted()) {
      setComplimentaryNoticeOpen(true);
      return;
    }
    if (!allowPayment) {
      setActionError(
        "Open pricing from a Capital Raising or Asset Managing deal to pay.",
      );
      return;
    }
    if (!payCompanyId) {
      setActionError("No company workspace selected.");
      return;
    }
    if (!selectedDealId) {
      setActionError(
        "Select a deal to pay monthly SaaS for. Billing starts when the deal is raising capital or asset managing.",
      );
      return;
    }
    if (wizardMode && !wizardCycle) {
      setActionError("Choose monthly or yearly billing first.");
      return;
    }
    if (!seatBand) {
      setActionError("Choose how many Co-Sponsors you need first.");
      return;
    }
    if (wizardMode && tierId !== appropriatePlanId) {
      setActionError(
        `${billingPlanLabel(appropriatePlanId)} is the plan for this deal.`,
      );
      return;
    }
    if (!billingStatus?.configured) {
      setActionError(
        "Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env.local.",
      );
      return;
    }
    if (!planReady(tierId)) {
      const envHint =
        displayCycle === "monthly"
          ? PRICE_ENV_HINT[tierId][displaySeat].monthly
          : PRICE_ENV_HINT[tierId][displaySeat].annual;
      const tierName =
        DEAL_TIERS.find((t) => t.id === tierId)?.name ?? tierId;
      setActionError(
        `Stripe Price for ${tierName} / ${displaySeat} seats (${displayCycle}) is not set. Check ${envHint} in backend/.env.local.`,
      );
      return;
    }
    setBusyPlanId(null);
    setPayModalPlanId(tierId);
    setPayModalError("");
    setPayModalBusy(null);
    setPayModalOpen(true);
    setPayModalLoading(true);
    setPayModalMethods([]);
    payOnceRef.current = false;
    void fetchCompanyBillingPaymentMethods(payCompanyId).then((result) => {
      setPayModalLoading(false);
      if (!result.ok) {
        setPayModalMethods([]);
        return;
      }
      setPayModalMethods(result.paymentMethods);
    });
  };

  const closePayModal = () => {
    if (payModalBusy) return;
    setPayModalOpen(false);
    setPayModalPlanId(null);
    setPayModalError("");
  };

  const handlePayInStripe = async () => {
    if (!payModalPlanId || payOnceRef.current) return;
    payOnceRef.current = true;
    setPayModalError("");
    setPayModalBusy("stripe");
    const result = await startCompanyBillingCheckout(
      payCompanyId,
      payModalPlanId,
      displayCycle,
      displaySeat,
      selectedDealId,
      extraCompanyUsers,
      appliedCoupon?.code,
    );
    if (!result.ok) {
      payOnceRef.current = false;
      setPayModalBusy(null);
      setPayModalError(result.message);
      return;
    }
    window.location.assign(result.url);
  };

  const handlePayWithSavedMethod = async (paymentMethodId: string) => {
    if (!payModalPlanId || payOnceRef.current) return;
    payOnceRef.current = true;
    setPayModalError("");
    setPayModalBusy("saved");
    const result = await payCompanyBillingWithSavedMethod(
      payCompanyId,
      payModalPlanId,
      displayCycle,
      displaySeat,
      selectedDealId,
      paymentMethodId,
      extraCompanyUsers,
      appliedCoupon?.code,
    );
    if (!result.ok) {
      payOnceRef.current = false;
      setPayModalBusy(null);
      setPayModalError(result.message);
      return;
    }
    const paidDealId = result.paidDealId || selectedDealId;
    if (paidDealId) {
      navigate(`/deals/${encodeURIComponent(paidDealId)}`, { replace: true });
      return;
    }
    setPayModalBusy(null);
    setPayModalOpen(false);
    onStatusRefresh();
  };

  const handleManageBilling = async () => {
    setActionError("");
    if (!companyId) {
      setActionError("No company workspace selected.");
      return;
    }
    setPortalBusy(true);
    const result = await openCompanyBillingPortal(companyId);
    setPortalBusy(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    window.location.assign(result.url);
  };

  return (
    <>
      <div className="cp_billing_header">
        <h3 className="cp_settings_billing_tab_title">Billing</h3>
        <p className="cp_billing_subtitle">
          {allowPayment
            ? "Pay when the deal is raising capital or asset managing — "
            : "Review plans here, then open a Capital Raising or Asset Managing deal to pay. "}
          <span className="cp_billing_deal_lead_free">
            Draft and Archived are free.
          </span>{" "}
          Monthly or yearly by card or ACH. Each co-sponsor beyond 12 is $10.
          Contact us for deals over $10M.
        </p>
      </div>

      {billingStatus ? (
        <div
          className="cp_billing_outstanding_banner"
          role="status"
          aria-live="polite"
          style={{
            marginBottom: "1rem",
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span className="cp_billing_outstanding_icon" aria-hidden="true">
            <Check size={14} strokeWidth={2.5} />
          </span>
          <p style={{ margin: 0, flex: 1 }}>
            {hasPaymentIssue ? (
              <>
                Payment issue
                {billingStatus.subscriptionStatus
                  ? ` (${billingStatus.subscriptionStatus})`
                  : ""}
                {": "}
                {billingStatus.lastPaymentError ||
                  "Update your payment method via Manage billing."}
                {billingStatus.lastPaymentFailedAt
                  ? ` · Failed ${new Date(billingStatus.lastPaymentFailedAt).toLocaleString()}`
                  : ""}
              </>
            ) : isPaid ? (
              <>
                Current plan: <strong>{activePlanId || "Paid"}</strong>
                {billingStatus.billingCycle
                  ? ` (${billingStatus.billingCycle})`
                  : ""}
                {" · "}
                Status: {billingStatus.subscriptionStatus}
                {billingStatus.currentPeriodEnd
                  ? ` · Renews ${new Date(billingStatus.currentPeriodEnd).toLocaleDateString()}`
                  : ""}
              </>
            ) : (
              <>
                No active subscription
                {billingStatus.configured
                  ? billingStatus.testMode
                    ? " (Stripe test mode)."
                    : "."
                  : " — Stripe is not configured yet."}
                {billingStatus.configured && !billingStatus.webhookConfigured
                  ? " Set STRIPE_WEBHOOK_SECRET (from stripe listen)."
                  : ""}
              </>
            )}
          </p>
          {isPaid || billingStatus.hasCustomer || hasPaymentIssue ? (
            canManageBilling ? (
            <button
              type="button"
              className="um_btn_secondary"
              style={{ flexShrink: 0 }}
              disabled={portalBusy}
              onClick={() => void handleManageBilling()}
            >
              <ExternalLink size={14} aria-hidden />
              {portalBusy ? "Opening…" : "Manage billing"}
            </button>
            ) : null
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <p
          className="cp_billing_subtitle"
          role="alert"
          style={{ color: "#b91c1c" }}
        >
          {actionError}
        </p>
      ) : null}

      <div className="cp_billing_filters">
        {wizardMode ? (
          <div className="cp_billing_filter_row">
            <span
              className="cp_billing_filter_heading"
              id="cp-billing-deal-label"
            >
              For this deal
            </span>
            <p className="cp_billing_deal_name" id="cp-billing-deal-name">
              {dealDisplayName || "this deal"}
            </p>
          </div>
        ) : null}

        {wizardMode ? (
          <div className="cp_billing_filter_row">
            <span className="cp_billing_filter_heading">
              Plan selected by offering size
            </span>
            <div className="cp_billing_auto_plan" role="status">
              <Check size={16} strokeWidth={2.25} aria-hidden />
              <span>
                <strong>{billingPlanLabel(appropriatePlanId)}</strong>
                <small>The system selected this tier for the deal.</small>
              </span>
            </div>
          </div>
        ) : null}

        <div className="cp_billing_filter_row">
          <span className="cp_billing_filter_heading" id="cp-billing-cycle-label">
            Billing cycle
          </span>
          <div
            className="cp_billing_cycle"
            role="radiogroup"
            aria-labelledby="cp-billing-cycle-label"
          >
            <label
              className={`cp_billing_cycle_option ${
                (wizardMode ? wizardCycle : billingCycle) === "monthly"
                  ? "cp_billing_cycle_option_active"
                  : ""
              }`}
            >
              <input
                type="radio"
                name="cp_billing_cycle"
                value="monthly"
                checked={
                  wizardMode
                    ? wizardCycle === "monthly"
                    : billingCycle === "monthly"
                }
                onChange={() => {
                  if (wizardMode) setWizardCycle("monthly");
                  onBillingCycleChange("monthly");
                }}
              />
              <span>Monthly</span>
            </label>
            <label
              className={`cp_billing_cycle_option ${
                (wizardMode ? wizardCycle : billingCycle) === "annually"
                  ? "cp_billing_cycle_option_active"
                  : ""
              }`}
            >
              <input
                type="radio"
                name="cp_billing_cycle"
                value="annually"
                checked={
                  wizardMode
                    ? wizardCycle === "annually"
                    : billingCycle === "annually"
                }
                onChange={() => {
                  if (wizardMode) setWizardCycle("annually");
                  onBillingCycleChange("annually");
                }}
              />
              <span>
                Yearly{" "}
                <span className="cp_billing_cycle_save">2 months free</span>
              </span>
            </label>
          </div>
          {wizardMode && !cycleSelected ? (
            <p className="cp_billing_filter_hint" style={{ margin: 0 }}>
              Choose monthly or yearly to continue.
            </p>
          ) : null}
        </div>

        <div
          className={`cp_billing_filter_row${
            membersEnabled ? "" : " cp_billing_filter_row_disabled"
          }`}
        >
          <span className="cp_billing_filter_heading" id="cp-billing-seats-label">
            Co-Sponsors
          </span>
          <div
            className="cp_cosponsor_picker"
            role="radiogroup"
            aria-labelledby="cp-billing-seats-label"
            aria-disabled={!membersEnabled}
          >
            {CO_SPONSOR_OPTIONS.map((option) => {
              const selected = seatBand === option.id
              return (
                <label
                  key={option.id}
                  className={`cp_cosponsor_choice${
                    selected ? " cp_cosponsor_choice_active" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="cp_billing_seats"
                    value={option.id}
                    checked={selected}
                    disabled={!membersEnabled}
                    aria-label={
                      option.id === "10plus"
                        ? "10 or more co-sponsors"
                        : `${option.label} co-sponsors`
                    }
                    onChange={() => setSeatBand(option.id)}
                  />
                  <span className="cp_cosponsor_choice_count">{option.label}</span>
                  <span className="cp_cosponsor_choice_label">Co-sponsors</span>
                </label>
              )
            })}
          </div>
          <p className="cp_billing_filter_hint" style={{ margin: 0 }}>
            {!membersEnabled
              ? "Choose a billing cycle first to pick Co-Sponsors."
              : seatBand == null
                ? "Choose how many Co-Sponsors to include."
                : seatBand === "10plus"
                  ? "More than 10 co-sponsors use the 12 co-sponsor price. Each co-sponsor past 12 is $10."
                  : seatBand === "10"
                    ? "6 to 10 co-sponsors use the 10 co-sponsor price."
                    : "1 to 5 co-sponsors use the 5 co-sponsor price."}
          </p>
        </div>
      </div>

      <div className="cp_billing_plans">
        {DEAL_TIERS.filter(
          (tier) => !wizardMode || tier.id === appropriatePlanId,
        ).map((tier) => {
          const pricedCoGps = includedCoSponsorsForSeat(displaySeat);
          const listPrice = planPrice(tier.id, displayCycle, pricedCoGps);
          const previousPrice = previousPlanPrice(
            tier.id,
            displayCycle,
            pricedCoGps,
          );
          const price = couponPrice(listPrice, appliedCoupon);
          const priceSuffix = displayCycle === "monthly" ? "/mo" : "/yr";
          const id = planKey(tier.id);
          const isAppropriate = appropriatePlanId === tier.id;
          const isCurrent =
            selectedDeal != null &&
            Boolean(selectedDeal.billed) &&
            (selectedDeal?.planId?.trim().toLowerCase() === id ||
              (selectedDeal?.planId ?? "").toLowerCase().startsWith(`${id}_`)) &&
            catalogSeatBand(selectedDeal) === displaySeat;
          const ctaBusy = busyPlanId === id;
          const otherPlanLocked =
            wizardMode && planCardsEnabled && !isAppropriate;
          const cardLocked =
            !tier.enabled ||
            (wizardMode && (!planCardsEnabled || otherPlanLocked));
          const payDisabled =
            !allowPayment || cardLocked || ctaBusy || isCurrent;
          const highlightForDeal =
            wizardMode &&
            isAppropriate &&
            (Boolean(selectedDeal) || Boolean(selectedDealId));
          return (
            <div
              key={tier.id}
              className={`cp_billing_plan_card${
                highlightForDeal || (!wizardMode && tier.featured)
                  ? " cp_billing_plan_card_featured"
                  : ""
              }${cardLocked ? " cp_billing_plan_card_locked" : ""}`}
              aria-disabled={cardLocked || undefined}
            >
              {tier.featured ? (
                <span className="cp_billing_plan_badge">
                  {wizardMode ? "Selected for this deal" : "Most popular"}
                </span>
              ) : (
                <span className="cp_billing_plan_badge">
                  {wizardMode ? "Selected for this deal" : "Available now"}
                </span>
              )}
              <div className="cp_billing_plan_heading">
                <h4 className="cp_billing_plan_name">{tier.name}</h4>
                {(tier.id === "starter" ||
                  (wizardMode &&
                    appropriatePlanId !== "starter" &&
                    tier.id === appropriatePlanId)) &&
                allowPayment &&
                !selectedDeal?.couponRedeemed ? (
                  appliedCoupon ? (
                    <p className="cp_billing_coupon_applied">
                      {appliedCoupon.code} applied
                      <button
                        type="button"
                        className="cp_billing_coupon_remove"
                        aria-label={`Remove ${appliedCoupon.code}`}
                        onClick={() => {
                          const code = appliedCoupon.code;
                          setAppliedCoupon(null);
                          toast.success(
                            "Coupon removed",
                            `${code} is no longer applied.`,
                          );
                        }}
                      >
                        <Trash2 size={15} strokeWidth={2} aria-hidden />
                      </button>
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="cp_billing_coupon_link"
                      onClick={() => setCouponModalOpen(true)}
                    >
                      Have a coupon?
                    </button>
                  )
                ) : null}
              </div>
              <p className="cp_billing_plan_tagline">{tier.dealSize}</p>
              <div className="cp_billing_plan_price">
                <div className="cp_billing_plan_price_main">
                  {previousPrice !== listPrice ? (
                    <span className="cp_billing_plan_price_was">
                      ${formatPlanPrice(previousPrice)}
                    </span>
                  ) : null}
                  {appliedCoupon && price !== listPrice ? (
                    <span className="cp_billing_plan_price_was">
                      ${formatPlanPrice(listPrice)}
                    </span>
                  ) : null}
                  <span className="cp_billing_plan_price_amount">
                    ${formatPlanPrice(price)}
                  </span>
                  <span className="cp_billing_plan_price_suffix">
                    {priceSuffix}
                  </span>
                </div>
                {displayCycle === "annually" && seatsSelected ? (
                  <p className="cp_billing_plan_price_perk">2 months free</p>
                ) : null}
                <p className="cp_billing_plan_price_calc">
                  {seatsSelected
                    ? `${coSponsorRangeLabel(displaySeat)} · ACH or credit card`
                    : "Choose Co-Sponsors to see this price"}
                  {displayCycle === "annually" && seatsSelected
                    ? " · billed yearly"
                    : ""}
                </p>
              </div>
              <div className="cp_billing_plan_body">
                <ul className="cp_billing_plan_features">
                  <li>
                    <Check size={16} aria-hidden="true" />
                    <span>{tier.dealSize}</span>
                  </li>
                  <li>
                    <Check size={16} aria-hidden="true" />
                    <span>
                      {coSponsorPackageCopy(displaySeat)}
                    </span>
                  </li>
                  <li>
                    <Check size={16} aria-hidden="true" />
                    <span>
                      Recurring monthly or annual payments; ACH or credit card
                    </span>
                  </li>
                </ul>
              </div>
              {allowPayment ? (
              <span
                className={
                  payDisabled ? "cp_billing_plan_cta_disabled_wrap" : undefined
                }
              >
                <button
                  type="button"
                  className={`cp_billing_plan_cta ${
                    allowPayment && tier.enabled && !cardLocked
                      ? "cp_billing_plan_cta_pay"
                      : "cp_billing_plan_cta_secondary"
                  }`}
                  disabled={payDisabled}
                  title={
                    !tier.enabled
                      ? `${tier.name} checkout is not available yet`
                      : wizardMode && !planCardsEnabled
                        ? "Choose billing cycle and Co-Sponsors first"
                        : otherPlanLocked
                          ? `${billingPlanLabel(appropriatePlanId)} is the plan for this deal`
                          : undefined
                  }
                  onClick={() => {
                    if (cardLocked) return;
                    if (isCurrent) {
                      onStatusRefresh();
                      return;
                    }
                    void handleChoosePlan(tier.id);
                  }}
                >
                  {!tier.enabled
                    ? "Coming soon"
                    : isCurrent
                      ? "Current plan"
                      : ctaBusy
                        ? "Redirecting…"
                        : wizardMode && !planCardsEnabled
                          ? "Choose cycle and Co-Sponsors first"
                          : wizardMode && selectedDeal?.needsCoGpUpgrade && isAppropriate
                          ? "Upgrade Co-Sponsors"
                          : otherPlanLocked
                            ? "Not for this deal"
                            : "Proceed to pay"}
                </button>
              </span>
              ) : null}
            </div>
          );
        })}

        {!wizardMode ? (
        <div
          className={`cp_billing_plan_card${
            wizardMode && !planCardsEnabled ? " cp_billing_plan_card_locked" : ""
          }`}
        >
          <span className="cp_billing_plan_badge">Available now</span>
          <h4 className="cp_billing_plan_name">Custom</h4>
          <p className="cp_billing_plan_tagline">
            $11M+ deals or 25+ company users
          </p>
          <div className="cp_billing_plan_price">
            <span className="cp_billing_plan_price_custom">Let&apos;s talk</span>
          </div>
          <div className="cp_billing_plan_body">
            <ul className="cp_billing_plan_features">
              <li>
                <Check size={16} aria-hidden="true" />
                <span>Contact for pricing</span>
              </li>
              <li>
                <Check size={16} aria-hidden="true" />
                <span>Recurring monthly or annual payments; ACH or credit card</span>
              </li>
            </ul>
          </div>
          <a
            className="cp_billing_plan_cta um_btn_primary"
            href={contactSalesHref}
            onClick={(event) => {
              event.preventDefault();
              void (async () => {
                const bcc =
                  salesBcc.length > 0 ? salesBcc : await getDefaultBccFromEnv();
                window.location.href = customPlanContactHref(bcc);
              })();
            }}
          >
            Contact sales
          </a>
        </div>
        ) : null}
      </div>

      <BillingCouponModal
        open={couponModalOpen}
        dealId={selectedDealId}
        onClose={() => setCouponModalOpen(false)}
        onApplied={setAppliedCoupon}
      />
      <BillingPayMethodModal
        open={payModalOpen}
        dealName={dealDisplayName}
        methods={payModalMethods}
        loading={payModalLoading}
        busy={payModalBusy}
        error={payModalError}
        onClose={closePayModal}
        onPaySaved={(paymentMethodId) => {
          void handlePayWithSavedMethod(paymentMethodId);
        }}
        onPayStripe={() => {
          void handlePayInStripe();
        }}
      />
      <PlatformComplimentaryNoticeModal
        open={complimentaryNoticeOpen}
        onClose={() => setComplimentaryNoticeOpen(false)}
        untilDisplay={
          selectedDeal
            ? formatSaasBillingStartIsoDisplay(selectedDeal.saasBillingStartsAt)
            : undefined
        }
      />
    </>
  );
}

function BillingPaymentMethodsPanel({
  companyId,
  billingStatus,
  paymentMethods,
  onStatusRefresh,
}: {
  companyId: string;
  billingStatus: CompanyBillingStatus | null;
  paymentMethods: CompanyBillingPaymentMethod[];
  onStatusRefresh: () => void;
}) {
  const [setupBusy, setSetupBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [setupSession, setSetupSession] =
    useState<BillingSetupIntentSession | null>(null);

  const handleAddPaymentMethod = async () => {
    setActionError("");
    if (!companyId) {
      setActionError("No company workspace selected.");
      return;
    }
    setSetupBusy(true);
    const result = await startCompanyBillingSetupIntent(companyId);
    setSetupBusy(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    setSetupSession(result.session);
  };

  return (
    <div className="cp_billing_payment_methods">
      <div className="cp_billing_payment_methods_head">
        <div>
          <h3 className="cp_billing_payment_methods_title">Payment methods</h3>
          <p className="cp_billing_payment_methods_lead">
            Add and manage the cards or US bank accounts used for your
            subscription.
          </p>
        </div>
        <div className="cp_billing_payment_methods_actions">
          {billingStatus?.configured &&
          companyId &&
          paymentMethods.length > 0 ? (
            <button
              type="button"
              className="um_btn_primary"
              disabled={setupBusy}
              onClick={() => void handleAddPaymentMethod()}
            >
              <Plus size={16} aria-hidden />
              {setupBusy ? "Loading…" : "Add payment method"}
            </button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <p className="cp_billing_payment_methods_error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="cp_billing_payment_methods_panel">
        {paymentMethods.length > 0 ? (
          <ul className="cp_billing_payment_methods_list">
            {paymentMethods.map((pm) => (
              <li key={pm.id} className="cp_billing_payment_method_row">
                <span
                  className="cp_billing_payment_method_icon"
                  aria-hidden="true"
                >
                  <CreditCard size={20} />
                </span>
                <span className="cp_billing_payment_method_details">
                  <strong>{formatPaymentMethodLabel(pm)}</strong>
                  <small>Stored securely with Stripe</small>
                </span>
                {pm.isDefault ? (
                  <span className="cp_billing_invoice_status cp_billing_invoice_status--paid">
                    Default
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className="cp_billing_payment_methods_empty">
            <span
              className="cp_billing_payment_methods_empty_icon"
              aria-hidden="true"
            >
              <WalletCards size={26} />
            </span>
            <h4>No payment methods yet</h4>
            <p>Add a card or US bank account for subscription billing.</p>
            {billingStatus?.configured && companyId ? (
              <button
                type="button"
                className="um_btn_primary"
                disabled={setupBusy}
                onClick={() => void handleAddPaymentMethod()}
              >
                <Plus size={16} aria-hidden />
                {setupBusy ? "Loading…" : "Add payment method"}
              </button>
            ) : null}
          </div>
        )}
        <div className="cp_billing_payment_security_note">
          <ShieldCheck size={17} aria-hidden="true" />
          <span>
            Payment details are encrypted and securely processed by Stripe.
          </span>
        </div>
      </div>

      {setupSession ? (
        <BillingPaymentElementModal
          open
          mode="setup"
          companyId={companyId}
          clientSecret={setupSession.clientSecret}
          publishableKeyHint={setupSession.publishableKey}
          title="Add payment method"
          subtitle="Save a card or US bank account for future billing."
          submitLabel="Save payment method"
          onClose={() => setSetupSession(null)}
          onSuccess={() => {
            setSetupSession(null);
            onStatusRefresh();
          }}
        />
      ) : null}
    </div>
  );
}

function DealMrrPaymentHistory({
  deal,
  invoices,
}: {
  deal: CompanyDealBillingRow;
  invoices: CompanyBillingInvoice[];
}) {
  const extra = extraCoGpDetail(deal);
  const mrrInvoices = invoices.filter(
    (inv) => inv.billingScope !== "extra_company_user",
  );
  const extraInvoices = invoices.filter(
    (inv) => inv.billingScope === "extra_company_user",
  );
  const rows = mrrInvoices.map((inv) => ({
    id: inv.id,
    start: inv.periodStart || inv.invoiceDate,
    end: inv.periodEnd || inv.dueDate || inv.invoiceDate,
    plan: billingPlanLabel(inv.planId || dealPlanId(deal)),
    amount: inv.amount,
  }));

  return (
    <div className="cp_billing_deal_mrr_history">
      <p className="cp_billing_deal_mrr_history_title">Previous MRR payments</p>
      {rows.length === 0 ? (
        <p className="cp_billing_deal_mrr_history_empty">
          No previous MRR payments for this deal yet.
        </p>
      ) : (
        <table className="cp_billing_deal_mrr_table">
          <thead>
            <tr>
              <th scope="col">Start date</th>
              <th scope="col">End date</th>
              <th scope="col">Plan</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.start ? formatDealListDateDisplay(row.start) : "—"}
                </td>
                <td>{row.end ? formatDealListDateDisplay(row.end) : "—"}</td>
                <td>{row.plan}</td>
                <td>{row.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="cp_billing_deal_mrr_history_title">Extra Co-Sponsors</p>
      <table className="cp_billing_deal_mrr_table">
        <thead>
          <tr>
            <th scope="col">Co-Sponsors</th>
            <th scope="col">Included</th>
            <th scope="col">Extra</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{formatCount(extra.count)}</td>
            <td>{extra.included == null ? "10+" : extra.included}</td>
            <td>{extra.extra}</td>
            <td className="cp_billing_mrr_amount">
              {extra.extra > 0 && catalogPlanAmountDollars(deal) != null ? (
                <BillingAmountBreakdown
                  total={
                    (catalogPlanAmountDollars(deal) ?? 0) + extra.dueDollars
                  }
                  base={catalogPlanAmountDollars(deal)}
                  extra={extra.dueDollars}
                  period={
                    /annual|year/i.test(String(deal.billingCycle ?? ""))
                      ? "/yr"
                      : "/mo"
                  }
                />
              ) : extra.extra > 0 ? (
                <span className="cp_billing_amount_stack">
                  <span className="cp_billing_amount_total">
                    {formatBillingDollars(extra.dueDollars)}
                    {/annual|year/i.test(String(deal.billingCycle ?? ""))
                      ? "/yr"
                      : "/mo"}
                  </span>
                  <span className="cp_billing_amount_extra">
                    <span>extra users</span>
                  </span>
                </span>
              ) : extra.paid > 0 ? (
                `${formatBillingDollars(extra.paidDollars)} paid`
              ) : (
                "$0"
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {extra.extra === 0 ? (
        <p className="cp_billing_deal_mrr_history_empty">
          {extra.included == null
            ? "10+ co-sponsors are included in this plan. No per-Co-Sponsor add-on."
            : `The ${extra.included} co-sponsors in this plan are included. No extra Co-Sponsor fee.`}
        </p>
      ) : null}
      {extraInvoices.length > 0 ? (
        <table className="cp_billing_deal_mrr_table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {extraInvoices.map((inv) => (
              <tr key={inv.id}>
                <td>
                  {inv.invoiceDate
                    ? formatDealListDateDisplay(inv.invoiceDate)
                    : "—"}
                </td>
                <td>{inv.status}</td>
                <td>{inv.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function BillingDealDetailsPanel({
  companyId,
  viewerScope,
  canPay,
  onPaid,
  onSelectOrganization,
}: {
  companyId: string;
  viewerScope: "all_deals" | "lead_sponsor" | undefined;
  canPay: boolean;
  onPaid?: () => void;
  onSelectOrganization?: (organizationId: string) => void;
}) {
  const navigate = useNavigate();
  const platformAdmin = isPlatformAdmin();
  const [deals, setDeals] = useState<CompanyDealBillingRow[]>([]);
  const [organizations, setOrganizations] = useState<
    BillingOrganizationOption[]
  >([]);
  const [orgPaidTotals, setOrgPaidTotals] = useState<
    Map<string, { cents: number; label: string }>
  >(() => new Map());
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [query, setQuery] = useState("");
  const [resolvedScope, setResolvedScope] = useState<
    "all_deals" | "lead_sponsor" | undefined
  >(viewerScope);
  const [payBusyId, setPayBusyId] = useState<string | null>(null);
  const [payError, setPayError] = useState("");
  const [dealsRefresh, setDealsRefresh] = useState(0);
  const [payChoice, setPayChoice] = useState<{
    row: CompanyDealBillingRow;
    companyId: string;
    planId: string;
    cycle: "monthly" | "annually";
    seatBand: SeatBand;
  } | null>(null);
  const [payChoiceMethods, setPayChoiceMethods] = useState<
    CompanyBillingPaymentMethod[]
  >([]);
  const [payChoiceLoading, setPayChoiceLoading] = useState(false);
  const [payChoiceBusy, setPayChoiceBusy] = useState<"saved" | "stripe" | null>(
    null,
  );
  const [payChoiceError, setPayChoiceError] = useState("");
  const [complimentaryNoticeOpen, setComplimentaryNoticeOpen] = useState(false);
  const [futureBillingSetup, setFutureBillingSetup] = useState<{
    row: CompanyDealBillingRow;
    companyId: string;
    session: BillingSetupIntentSession;
  } | null>(null);
  const [cycleBusyId, setCycleBusyId] = useState<string | null>(null);
  const [cycleConfirm, setCycleConfirm] = useState<{
    row: CompanyDealBillingRow;
    next: "monthly" | "annually";
  } | null>(null);
  const [startDateRow, setStartDateRow] = useState<CompanyDealBillingRow | null>(
    null,
  );
  const [startDateBusy, setStartDateBusy] = useState(false);
  const payOnceRef = useRef(false);
  const [expandedDealId, setExpandedDealId] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<CompanyBillingInvoice[]>([]);

  useEffect(() => {
    if (!platformAdmin && !companyId) {
      setDeals([]);
      setInvoices([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    void (async () => {
      if (platformAdmin) {
        const orgResult = await fetchPlatformOrganizationBilling();
        if (cancelled) return;
        if (!orgResult.ok) {
          setLoading(false);
          setLoadError(orgResult.message);
          setDeals([]);
          setOrganizations([]);
          setOrgPaidTotals(new Map());
          setInvoices([]);
          return;
        }
        setOrganizations(
          orgResult.organizations.map((row) => ({
            id: row.id,
            name: row.name,
          })),
        );
        setOrgPaidTotals(
          new Map(
            orgResult.organizations.map((row) => [
              row.id,
              { cents: row.totalPaidCents, label: row.totalPaid },
            ]),
          ),
        );
        setDeals(orgResult.organizations.flatMap((row) => row.deals));
        setResolvedScope(orgResult.viewerScope);
        setInvoices([]);
        setLoading(false);
        return;
      }

      const dealResult = await fetchCompanyBillingDeals(companyId);
      if (cancelled) return;
      if (!dealResult.ok) {
        setLoading(false);
        setLoadError(dealResult.message);
        setDeals([]);
        setInvoices([]);
        return;
      }
      setDeals(dealResult.deals);
      setResolvedScope(dealResult.viewerScope);

      const invoiceResult = companyId
        ? await fetchCompanyBillingInvoices(companyId)
        : { ok: false as const };
      if (cancelled) return;
      setInvoices(invoiceResult.ok ? invoiceResult.invoices : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, platformAdmin, dealsRefresh]);

  useEffect(() => {
    if (!platformAdmin || !expandedOrgId) return;
    const cid = expandedOrgId.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        cid,
      )
    ) {
      return;
    }
    let cancelled = false;
    void fetchCompanyBillingInvoices(cid).then((result) => {
      if (cancelled || !result.ok) return;
      setInvoices((current) => {
        const seen = new Set(current.map((inv) => inv.id));
        const next = result.invoices.filter((inv) => !seen.has(inv.id));
        return next.length === 0 ? current : [...current, ...next];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [expandedOrgId, platformAdmin]);

  const organizationRows = useMemo((): BillingOrganizationTableRow[] => {
    const dealsByOrg = new Map<string, CompanyDealBillingRow[]>();
    for (const deal of deals) {
      const id = dealBillingCompanyId(deal, "") || "unassigned";
      const list = dealsByOrg.get(id);
      if (list) list.push(deal);
      else dealsByOrg.set(id, [deal]);
    }
    const merged = new Map<string, string>();
    for (const org of organizations) {
      merged.set(org.id, org.name);
    }
    for (const [id, orgDeals] of dealsByOrg) {
      const fromDeal = dealOrganizationLabel(orgDeals[0]);
      if (!merged.has(id) || merged.get(id) === "Untitled organization") {
        merged.set(id, fromDeal === "—" ? "Untitled organization" : fromDeal);
      }
    }
    return [...merged.entries()]
      .map(([id, name]) => {
        const orgDeals = dealsByOrg.get(id) ?? [];
        return {
          id,
          name,
          deals: orgDeals,
          billedCount: orgDeals.filter((row) => row.billed).length,
          totalPaidCents: orgPaidTotals.get(id)?.cents ?? 0,
          totalPaid: orgPaidTotals.get(id)?.label ?? "$0.00",
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
  }, [deals, orgPaidTotals, organizations]);

  const dealMatchesQuery = useCallback(
    (row: CompanyDealBillingRow, q: string) => {
      const name = row.dealName.toLowerCase();
      const org = dealOrganizationLabel(row).toLowerCase();
      const plan = billingPlanLabel(dealPlanId(row)).toLowerCase();
      const amount = dealAmountLabel(row, invoices).toLowerCase();
      const status = dealBillingStatusLabel(row).toLowerCase();
      const stage = (
        row.archived ? "Archived" : dealStageLabel(row.dealStage)
      ).toLowerCase();
      return (
        name.includes(q) ||
        org.includes(q) ||
        plan.includes(q) ||
        amount.includes(q) ||
        status.includes(q) ||
        stage.includes(q)
      );
    },
    [invoices],
  );

  const filteredOrganizationRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return organizationRows;
    return organizationRows
      .map((org) => {
        const nameMatch =
          org.name.toLowerCase().includes(q) ||
          org.totalPaid.toLowerCase().includes(q);
        const matchingDeals = nameMatch
          ? org.deals
          : org.deals.filter((row) => dealMatchesQuery(row, q));
        if (!nameMatch && matchingDeals.length === 0) return null;
        return {
          ...org,
          deals: matchingDeals,
          billedCount: matchingDeals.filter((row) => row.billed).length,
        };
      })
      .filter((row): row is BillingOrganizationTableRow => row != null);
  }, [dealMatchesQuery, organizationRows, query]);

  const filteredDeals = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return deals;
    return deals.filter((row) => dealMatchesQuery(row, q));
  }, [dealMatchesQuery, deals, query]);

  useEffect(() => {
    setPage(1);
  }, [query]);

  const tableRowCount = platformAdmin
    ? filteredOrganizationRows.length
    : filteredDeals.length;

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(tableRowCount / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [tableRowCount, pageSize, page]);

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: tableRowCount,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
      ariaLabel: platformAdmin
        ? "Organization billing table pagination"
        : "Detailed billing table pagination",
    }),
    [page, pageSize, platformAdmin, tableRowCount],
  );

  const billedCount = useMemo(
    () => deals.filter((row) => row.billed).length,
    [deals],
  );

  const platformPaidTotal = useMemo(() => {
    const cents = organizationRows.reduce(
      (sum, org) => sum + org.totalPaidCents,
      0,
    );
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  }, [organizationRows]);

  const sponsorPaidTotal = useMemo(() => {
    let total = 0;
    for (const inv of invoices) {
      if (String(inv.status ?? "").trim().toLowerCase() !== "paid") continue;
      const n = parseMoneyDigits(inv.amount);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  }, [invoices]);

  const billingSummaryAmount = platformAdmin
    ? platformPaidTotal
    : sponsorPaidTotal;

  const handleFutureBillingPaymentMethodSetup = async (
    row: CompanyDealBillingRow,
  ) => {
    const setupCompanyId = dealBillingCompanyId(row, companyId);
    if (!setupCompanyId) {
      setPayError("No company workspace selected.");
      return;
    }
    setPayBusyId(row.id);
    const result = await startCompanyBillingSetupIntent(setupCompanyId);
    setPayBusyId(null);
    if (!result.ok) {
      setPayError(result.message);
      return;
    }
    setFutureBillingSetup({
      row,
      companyId: setupCompanyId,
      session: result.session,
    });
  };

  const openCoGpUpgrade = useCallback((row: CompanyDealBillingRow) => {
    const params = new URLSearchParams({
      billing: "upgrade",
      dealId: row.id,
    });
    const dealName = row.dealName.trim();
    if (dealName) params.set("dealName", dealName);
    navigate(`/settings?${params.toString()}`);
  }, [navigate]);

  const handlePayDeal = async (row: CompanyDealBillingRow) => {
    setPayError("");
    const payCompanyId = dealBillingCompanyId(row, companyId);
    if (!payCompanyId) {
      setPayError("No company workspace selected.");
      return;
    }
    const planId = (
      row.suggestedPlanId ||
      row.planId ||
      "starter"
    )
      .trim()
      .toLowerCase();
    const rowCycle = billingCycleSelectValue(row.billingCycle);
    if (!rowCycle) {
      setPayError("Choose monthly or yearly billing first.");
      return;
    }
    if (!dealRowCheckoutAllowed(row)) {
      if (dealCanSavePaymentMethodForFutureBilling(row)) {
        await handleFutureBillingPaymentMethodSetup(row);
        return;
      }
      setComplimentaryNoticeOpen(true);
      return;
    }
    payOnceRef.current = false;
    setPayChoice({
      row,
      companyId: payCompanyId,
      planId,
      cycle: rowCycle,
      seatBand: catalogSeatBand(row),
    });
    setPayChoiceError("");
    setPayChoiceBusy(null);
    setPayChoiceLoading(true);
    setPayChoiceMethods([]);
    const methodsResult = await fetchCompanyBillingPaymentMethods(payCompanyId);
    setPayChoiceLoading(false);
    if (methodsResult.ok) {
      setPayChoiceMethods(methodsResult.paymentMethods);
    }
  };

  const closePayChoice = () => {
    if (payChoiceBusy) return;
    setPayChoice(null);
    setPayChoiceError("");
    setPayChoiceBusy(null);
  };

  const handlePayDealInStripe = async () => {
    if (!payChoice || payOnceRef.current) return;
    payOnceRef.current = true;
    setPayChoiceError("");
    setPayChoiceBusy("stripe");
    const result = await startCompanyBillingCheckout(
      payChoice.companyId,
      payChoice.planId,
      payChoice.cycle,
      payChoice.seatBand,
      payChoice.row.id,
    );
    if (!result.ok) {
      payOnceRef.current = false;
      setPayChoiceBusy(null);
      setPayChoiceError(result.message);
      return;
    }
    onPaid?.();
    window.location.assign(result.url);
  };

  const handlePayDealWithSavedMethod = async (paymentMethodId: string) => {
    if (!payChoice || payOnceRef.current) return;
    payOnceRef.current = true;
    setPayChoiceError("");
    setPayChoiceBusy("saved");
    const result = await payCompanyBillingWithSavedMethod(
      payChoice.companyId,
      payChoice.planId,
      payChoice.cycle,
      payChoice.seatBand,
      payChoice.row.id,
      paymentMethodId,
    );
    if (!result.ok) {
      payOnceRef.current = false;
      setPayChoiceBusy(null);
      setPayChoiceError(result.message);
      return;
    }
    const dealName = payChoice.row.dealName.trim() || "this deal";
    setPayChoice(null);
    setPayChoiceBusy(null);
    setPayChoiceError("");
    onPaid?.();
    setDealsRefresh((n) => n + 1);
    toast.success("Payment received", `${dealName} was paid with the selected method.`);
  };

  const handleCycleChange = useCallback(
    async (row: CompanyDealBillingRow, next: "monthly" | "annually") => {
      setPayError("");
      if (dealBillingSettingsLocked(row)) {
        setCycleConfirm(null);
        toast.error(
          "Could not update payment cycle",
          dealBillingSettingsLockedTitle(row),
        );
        return;
      }
      const cycleCompanyId = dealBillingCompanyId(row, companyId);
      if (!cycleCompanyId) {
        setPayError("No company workspace selected.");
        toast.error(
          "Could not update payment cycle",
          "No company workspace selected.",
        );
        return;
      }
      if (billingCycleSelectValue(row.billingCycle) === next) {
        setCycleConfirm(null);
        return;
      }
      setCycleBusyId(row.id);
      const result = await updateCompanyDealBillingCycle(
        cycleCompanyId,
        row.id,
        next,
      );
      setCycleBusyId(null);
      if (!result.ok) {
        setPayError(result.message);
        toast.error("Could not update payment cycle", result.message);
        return;
      }
      setCycleConfirm(null);
      setDeals((current) =>
        current.map((deal) =>
          deal.id === row.id ? { ...deal, ...result.deal } : deal,
        ),
      );
      const cycleLabel = next === "annually" ? "yearly" : "monthly";
      const dealName = row.dealName.trim() || "this deal";
      toast.success(
        "Payment cycle updated",
        `${dealName} is now billed ${cycleLabel}.`,
      );
    },
    [companyId],
  );

  const handleBillingStartDateSave = useCallback(
    async (row: CompanyDealBillingRow, ymd: string) => {
      if (dealBillingSettingsLocked(row)) {
        setStartDateRow(null);
        toast.error(
          "Could not update billing start date",
          dealBillingSettingsLockedTitle(row),
        );
        return;
      }
      if (isBillingStartDateInThePast(ymd)) {
        toast.error(
          "Could not update billing start date",
          "Billing start date cannot be in the past.",
        );
        return;
      }
      const orgId = dealBillingCompanyId(row, companyId);
      if (!orgId) {
        toast.error("Could not update billing start date", "No company workspace selected.");
        return;
      }
      setStartDateBusy(true);
      const result = await updateCompanyDealBillingStartDate(orgId, row.id, ymd);
      setStartDateBusy(false);
      if (!result.ok) {
        toast.error("Could not update billing start date", result.message);
        return;
      }
      setStartDateRow(null);
      setDeals((current) =>
        current.map((deal) =>
          deal.id === row.id ? { ...deal, ...result.deal } : deal,
        ),
      );
      const dealName = row.dealName.trim() || "this deal";
      toast.success(
        "Billing start date saved",
        `${dealName} will start billing on ${formatSaasBillingStartIsoDisplay(result.deal.saasBillingStartsAt)}.`,
      );
    },
    [companyId],
  );

  const columns: DataTableColumn<CompanyDealBillingRow>[] = useMemo(
    () => [
      {
        id: "dealName",
        header: "Deal",
        sortValue: (row) => row.dealName.toLowerCase(),
        thClassName: "deals_col_deal_name",
        tdClassName: "um_td_user deals_col_deal_name cp_billing_invoice_number_td",
        cell: (row) => {
          const open = expandedDealId === row.id;
          return (
            <div className="deals_list_name_cell cp_billing_deal_name_cell">
              <DealAvatarIconRing />
              <div className="deals_list_name_text">
                <button
                  type="button"
                  className={`cp_billing_deal_name_toggle${
                    open ? " cp_billing_deal_name_toggle--open" : ""
                  }`}
                  aria-expanded={open}
                  aria-label={
                    open
                      ? `Hide previous MRR payments for ${row.dealName.trim() || "this deal"}`
                      : `Show previous MRR payments for ${row.dealName.trim() || "this deal"}`
                  }
                  onClick={() =>
                    setExpandedDealId((current) =>
                      current === row.id ? null : row.id,
                    )
                  }
                >
                  <span className="cp_billing_invoice_number">
                    {row.dealName.trim() || "Untitled deal"}
                  </span>
                  <ChevronDown size={16} aria-hidden />
                </button>
              </div>
            </div>
          );
        },
      },
      {
        id: "dealStage",
        header: "Stage",
        sortValue: (row) =>
          (row.archived
            ? "Archived"
            : dealStageLabel(row.dealStage)
          ).toLowerCase(),
        cell: (row) => {
          const archived = Boolean(row.archived);
          const label = archived
            ? "Archived"
            : dealStageLabel(row.dealStage).trim() || "—";
          return (
            <span
              className={
                archived
                  ? "deals_stage_chip deals_stage_chip--compact deals_stage_chip--archived"
                  : dealStageChipCompactClassName(row.dealStage)
              }
              title={`Stage: ${label}`}
            >
              <span className="deals_list_stage_badge_icon" aria-hidden>
                <CircleDot size={12} strokeWidth={2} />
              </span>
              <span>{label}</span>
            </span>
          );
        },
      },
      {
        id: "plan",
        header: "Plan",
        align: "center" as const,
        thClassName: "deals_th_align_center",
        tdClassName: "deals_td_align_center",
        sortValue: (row) => billingPlanLabel(dealPlanId(row)).toLowerCase(),
        cell: (row) => billingPlanLabel(dealPlanId(row)),
      },
      {
        id: "amount",
        header: "Amount",
        align: "right" as const,
        thClassName: "deals_th_align_right cp_billing_amount_col",
        tdClassName: "um_td_numeric cp_billing_amount_td cp_billing_amount_col",
        sortValue: (row) => dealAmountLabel(row, invoices).toLowerCase(),
        cell: (row) => <DealAmountCell row={row} invoices={invoices} />,
      },
      {
        id: "cycle",
        header: "Payment cycle",
        align: "center" as const,
        thClassName: "deals_th_align_center",
        tdClassName: "deals_td_align_center",
        sortValue: (row) => billingCycleLabel(row.billingCycle).toLowerCase(),
        cell: (row) => {
          const settingsLocked = dealBillingSettingsLocked(row);
          const canEditCycle = canPay && row.billable === true;
          if (!canEditCycle) {
            return billingCycleLabel(row.billingCycle);
          }
          const value = billingCycleSelectValue(row.billingCycle);
          const busy = cycleBusyId === row.id;
          return (
            <select
              className="cp_billing_filter_input cp_billing_status_select cp_billing_cycle_select"
              value={value}
              disabled={busy || settingsLocked}
              title={
                settingsLocked
                  ? dealBillingSettingsLockedTitle(row)
                  : undefined
              }
              aria-label={`Payment cycle for ${row.dealName.trim() || "this deal"}`}
              onChange={(e) => {
                const next = e.target.value;
                if (next !== "monthly" && next !== "annually") return;
                if (billingCycleSelectValue(row.billingCycle) === next) return;
                setCycleConfirm({ row, next });
              }}
            >
              {value ? null : (
                <option value="" disabled>
                  Choose
                </option>
              )}
              <option value="monthly">Monthly</option>
              <option value="annually">Yearly</option>
            </select>
          );
        },
      },
      {
        id: "status",
        header: "Payment",
        align: "center" as const,
        thClassName: "deals_th_align_center cp_billing_payment_status_col",
        tdClassName: "deals_td_align_center cp_billing_payment_status_col",
        sortValue: (row) => dealBillingStatusLabel(row).toLowerCase(),
        cell: (row) => (
          <span
            className={dealBillingStatusClassName(row)}
            title={dealBillingStatusTitle(row)}
          >
            {dealBillingStatusLabel(row)}
          </span>
        ),
      },
      {
        id: "nextBilling",
        header: "Next billing",
        sortValue: (row) => row.nextBillingDate ?? "",
        cell: (row) =>
          row.nextBillingDate
            ? formatDealListDateDisplay(row.nextBillingDate)
            : "—",
      },
      ...(canPay
        ? ([
            {
              id: "pay",
              header: "Actions",
              align: "center" as const,
              thClassName:
                "deals_th_align_center um_th_actions cp_billing_actions_col",
              tdClassName:
                "um_td_actions cp_billing_actions_col",
              cell: (row: CompanyDealBillingRow) => {
                const canOfferUpgrade =
                  !row.billed || catalogSeatBand(row) !== "10plus";
                const canPayRow =
                  dealRowIsPayable(row) &&
                  (!row.billed || canOfferUpgrade);
                if (!canPayRow) {
                  return <span className="um_status_muted">—</span>;
                }
                const busy = payBusyId === row.id;
                return (
                  <div className="cp_billing_deal_payment_actions">
                    {!row.billed ? (
                      <button
                        type="button"
                        className="um_btn_primary cp_billing_pay_btn"
                        disabled={busy}
                        aria-label={busy ? "Loading payment options" : undefined}
                        onClick={() => void handlePayDeal(row)}
                      >
                        {busy ? (
                          <Loader2
                            size={16}
                            strokeWidth={2}
                            className="deals_create_btn_spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <>
                            <CreditCard size={15} strokeWidth={2} aria-hidden />
                            Pay
                          </>
                        )}
                      </button>
                    ) : null}
                    {canOfferUpgrade ? (
                      <button
                        type="button"
                        className="um_btn_secondary cp_billing_upgrade_btn"
                        disabled={busy}
                        aria-label={`Upgrade Co-Sponsor package for ${row.dealName.trim() || "this deal"}`}
                        onClick={() => openCoGpUpgrade(row)}
                      >
                        <BadgeDollarSign
                          size={15}
                          strokeWidth={2}
                          aria-hidden
                        />
                        Upgrade
                      </button>
                    ) : null}
                  </div>
                );
              },
            },
          ] satisfies DataTableColumn<CompanyDealBillingRow>[])
        : []),
      ...(platformAdmin
        ? ([
            {
              id: "actions",
              header: "Actions",
              align: "center" as const,
              thClassName: "deals_th_align_center um_th_actions",
              tdClassName: "um_td_actions",
              cell: (row: CompanyDealBillingRow) => {
                const settingsLocked = dealBillingSettingsLocked(row);
                return (
                  <button
                    type="button"
                    className="cp_billing_start_date_btn"
                    aria-label={`Set billing start date for ${row.dealName.trim() || "this deal"}`}
                    title={
                      settingsLocked
                        ? dealBillingSettingsLockedTitle(row)
                        : "Set billing start date"
                    }
                    disabled={settingsLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!settingsLocked) setStartDateRow(row);
                    }}
                  >
                    <Calendar size={16} strokeWidth={2} aria-hidden />
                  </button>
                );
              },
            },
          ] satisfies DataTableColumn<CompanyDealBillingRow>[])
        : []),
    ],
    [
      canPay,
      companyId,
      cycleBusyId,
      expandedDealId,
      invoices,
      onPaid,
      openCoGpUpgrade,
      payBusyId,
      platformAdmin,
    ],
  );

  const organizationColumns: DataTableColumn<BillingOrganizationTableRow>[] =
    useMemo(
      () => [
        {
          id: "name",
          header: "Organization",
          sortValue: (row) => row.name.toLowerCase(),
          thClassName: "deals_col_deal_name",
          tdClassName:
            "um_td_user deals_col_deal_name cp_billing_invoice_number_td",
          cell: (row) => {
            const open = expandedOrgId === row.id;
            return (
              <div className="deals_list_name_cell cp_billing_deal_name_cell">
                <div
                  className="um_user_avatar_ring cp_company_avatar"
                  aria-hidden
                >
                  <Building2 size={18} strokeWidth={2} />
                </div>
                <div className="deals_list_name_text">
                  <button
                    type="button"
                    className={`cp_billing_org_name_btn${
                      open ? " cp_billing_org_name_btn--open" : ""
                    }`}
                    aria-expanded={open}
                    onClick={() => {
                      const next = open ? null : row.id;
                      setExpandedOrgId(next);
                      if (next) onSelectOrganization?.(next);
                    }}
                  >
                    <span>{row.name}</span>
                    <ChevronDown size={16} aria-hidden />
                  </button>
                </div>
              </div>
            );
          },
        },
        {
          id: "deals",
          header: "Deals",
          align: "center" as const,
          thClassName: "deals_th_align_center",
          tdClassName: "deals_td_align_center",
          sortValue: (row) => row.deals.length,
          cell: (row) => formatCount(row.deals.length),
        },
        {
          id: "billed",
          header: "Billed",
          align: "center" as const,
          thClassName: "deals_th_align_center",
          tdClassName: "deals_td_align_center",
          sortValue: (row) => row.billedCount,
          cell: (row) => formatCount(row.billedCount),
        },
        {
          id: "totalPaid",
          header: "Total paid",
          align: "right" as const,
          thClassName: "deals_th_align_right",
          tdClassName: "um_td_numeric cp_billing_amount_td",
          sortValue: (row) => row.totalPaidCents,
          cell: (row) => row.totalPaid,
        },
      ],
      [expandedOrgId, onSelectOrganization],
    );

  const isLeadSponsorScope =
    (resolvedScope ?? viewerScope) === "lead_sponsor";

  return (
    <div
      className={`cp_billing_payment_history${
        platformAdmin ? " cp_billing_payment_history--admin" : ""
      }`}
    >
      <header className="cp_billing_payment_history_head">
        <h3 className="cp_billing_payment_history_title">
          {platformAdmin ? "Organizations" : "Detailed billing"}
        </h3>
        <p className="cp_billing_payment_history_lead cp_billing_deal_lead">
          {isLeadSponsorScope
            ? "You pay for deals you lead when they are raising capital or asset managing. Draft and Archived are free."
            : platformAdmin
              ? "Totals across every organization. Expand a row to review that company’s deals."
              : "Lead sponsors pay per deal when they are raising capital or asset managing. Draft and Archived are free."}
        </p>
      </header>

      <section
        className="cp_billing_kpi_metrics"
        aria-label="Billing totals"
        aria-busy={loading}
      >
        {platformAdmin ? (
          <ToolStyleCard
            variant="metric"
            icon={Building2}
            title="Organizations"
            loading={loading}
            description={formatCount(organizationRows.length)}
          />
        ) : null}
        <ToolStyleCard
          variant="metric"
          icon={Briefcase}
          title="Total deals"
          loading={loading}
          description={formatCount(deals.length)}
        />
        <ToolStyleCard
          variant="metric"
          icon={Receipt}
          title="Billed deals"
          loading={loading}
          description={formatCount(billedCount)}
        />
        <ToolStyleCard
          variant="metric"
          icon={DollarSign}
          title="Total amount"
          loading={loading}
          description={cardCompactAmountOrDash(billingSummaryAmount)}
        />
      </section>

      {loadError ? (
        <p role="alert" style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>
          {loadError}
        </p>
      ) : null}
      {payError ? (
        <p role="alert" style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>
          {payError}
        </p>
      ) : null}

      <div
        className="um_toolbar um_toolbar_export_then_search cp_billing_deal_search_toolbar"
        role="search"
        aria-label={platformAdmin ? "Search organizations" : "Search deals"}
      >
        <div className="um_search_wrap">
          <Search className="um_search_icon" size={18} aria-hidden />
          <input
            id="cp-billing-deal-search"
            type="search"
            className="um_search_input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              platformAdmin ? "Search organizations…" : "Search deals…"
            }
            aria-label={
              platformAdmin ? "Search organizations" : "Search deals"
            }
          />
        </div>
      </div>

      <div
        className={`cp_billing_invoices_table_wrap deal_inv_table_panel${
          platformAdmin ? "" : " cp_billing_detail_table_wrap"
        }`}
      >
        {platformAdmin ? (
          <DataTable
            columns={organizationColumns}
            rows={filteredOrganizationRows}
            getRowKey={(row) => row.id}
            emptyLabel={
              loading
                ? "Loading organizations…"
                : "No organizations found."
            }
            isLoading={loading}
            visualVariant="members"
            membersTableClassName="um_table_members deal_inv_table cp_billing_orgs_table"
            membersShell="default"
            initialSort={{ columnId: "name", direction: "asc" }}
            pagination={pagination}
            onBodyRowClick={(row) => {
              const next = expandedOrgId === row.id ? null : row.id;
              setExpandedOrgId(next);
              if (next) onSelectOrganization?.(next);
            }}
            getRowClassName={(row) =>
              expandedOrgId === row.id ? "cp_billing_deal_row_expanded" : ""
            }
            renderExpandedContent={(row) =>
              expandedOrgId === row.id ? (
                <div className="cp_billing_org_deals">
                  {row.deals.length === 0 ? (
                    <p className="cp_billing_org_empty">No deals</p>
                  ) : (
                    <DataTable
                      columns={columns}
                      rows={row.deals}
                      getRowKey={(deal) => deal.id}
                      emptyLabel="No deals"
                      visualVariant="members"
                      membersTableClassName="um_table_members deal_inv_table cp_billing_org_deals_table"
                      membersShell="plain"
                      stickyFirstColumn={false}
                      forceHorizontalScroll={false}
                      floatingHorizontalScroll={false}
                      initialSort={{ columnId: "dealName", direction: "asc" }}
                      getRowClassName={(deal) =>
                        expandedDealId === deal.id
                          ? "cp_billing_deal_row_expanded"
                          : ""
                      }
                      renderExpandedContent={(deal) =>
                        expandedDealId === deal.id ? (
                          <DealMrrPaymentHistory
                            deal={deal}
                            invoices={invoices.filter(
                              (inv) => inv.dealId === deal.id,
                            )}
                          />
                        ) : null
                      }
                    />
                  )}
                </div>
              ) : null
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={filteredDeals}
            getRowKey={(row) => row.id}
            emptyLabel={
              loading ? "Loading deal billing…" : "No deals found for billing."
            }
            isLoading={loading}
            visualVariant="members"
            membersTableClassName="um_table_members deal_inv_table cp_billing_detail_table"
            membersShell="default"
            forceHorizontalScroll={false}
            floatingHorizontalScroll={false}
            initialSort={{ columnId: "dealName", direction: "asc" }}
            pagination={pagination}
            getRowClassName={(row) =>
              expandedDealId === row.id ? "cp_billing_deal_row_expanded" : ""
            }
            renderExpandedContent={(row) =>
              expandedDealId === row.id ? (
                <DealMrrPaymentHistory
                  deal={row}
                  invoices={invoices.filter((inv) => inv.dealId === row.id)}
                />
              ) : null
            }
          />
        )}
      </div>
      {cycleConfirm ? (
        <BillingCycleConfirmModal
          row={cycleConfirm.row}
          nextCycle={cycleConfirm.next}
          confirming={cycleBusyId === cycleConfirm.row.id}
          onConfirm={() =>
            void handleCycleChange(cycleConfirm.row, cycleConfirm.next)
          }
          onCancel={() => {
            if (cycleBusyId) return;
            setCycleConfirm(null);
          }}
        />
      ) : null}
      {startDateRow ? (
        <BillingDealStartDateModal
          key={startDateRow.id}
          row={startDateRow}
          saving={startDateBusy}
          onSave={(ymd) => void handleBillingStartDateSave(startDateRow, ymd)}
          onCancel={() => {
            if (startDateBusy) return;
            setStartDateRow(null);
          }}
        />
      ) : null}
      {futureBillingSetup ? (
        <BillingPaymentElementModal
          open
          mode="setup"
          companyId={futureBillingSetup.companyId}
          clientSecret={futureBillingSetup.session.clientSecret}
          publishableKeyHint={futureBillingSetup.session.publishableKey}
          title="Add payment method for future billing"
          subtitle={`${futureBillingSetup.row.dealName.trim() || "This deal"} is complimentary until ${formatSaasBillingStartIsoDisplay(
            futureBillingSetup.row.saasBillingStartsAt,
          )}.`}
          footerInfo={
            <span className="cp_billing_future_method_note">
              <Info size={15} strokeWidth={2} aria-hidden="true" />
              <span>
                You will not be charged today. This payment method will be
                added now, and the SaaS amount will be deducted from the SaaS
                billing date. Payments stop only when the deal is archived or
                liquidated.
              </span>
            </span>
          }
          submitLabel="Save and proceed"
          onClose={() => setFutureBillingSetup(null)}
          onSuccess={() => {
            const row = futureBillingSetup.row;
            setFutureBillingSetup(null);
            onPaid?.();
            toast.success(
              "Payment method saved",
              `Payment for ${row.dealName.trim() || "this deal"} will start with this method on the SaaS billing date, ${formatSaasBillingStartIsoDisplay(
                row.saasBillingStartsAt,
              )}.`,
            );
          }}
        />
      ) : null}
      <BillingPayMethodModal
        open={payChoice != null}
        dealName={payChoice?.row.dealName ?? ""}
        methods={payChoiceMethods}
        loading={payChoiceLoading}
        busy={payChoiceBusy}
        error={payChoiceError}
        title={
          payChoice?.row.billed &&
          (payChoice.row.needsPlanUpgrade || payChoice.row.needsCoGpUpgrade)
            ? "Choose how to upgrade"
            : "Choose how to pay"
        }
        onClose={closePayChoice}
        onPaySaved={(paymentMethodId) => {
          void handlePayDealWithSavedMethod(paymentMethodId);
        }}
        onPayStripe={() => {
          void handlePayDealInStripe();
        }}
      />
      <PlatformComplimentaryNoticeModal
        open={complimentaryNoticeOpen}
        onClose={() => setComplimentaryNoticeOpen(false)}
      />
    </div>
  );
}

export function BillingPaymentHistoryPanel({ companyId }: { companyId: string }) {
  const [dateFrom, setDateFrom] = useState(DEFAULT_DATE_FROM);
  const [dateTo, setDateTo] = useState(DEFAULT_DATE_TO);
  const [statusFilter, setStatusFilter] = useState("");
  const [appliedFrom, setAppliedFrom] = useState(DEFAULT_DATE_FROM);
  const [appliedTo, setAppliedTo] = useState(DEFAULT_DATE_TO);
  const [appliedStatus, setAppliedStatus] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!companyId) {
      setInvoices([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    void fetchCompanyBillingInvoices(companyId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.message);
        setInvoices([]);
        return;
      }
      setInvoices(result.invoices);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const filteredInvoices = useMemo(
    () =>
      invoices.filter((row) =>
        invoiceMatchesFilters(row, appliedStatus, appliedFrom, appliedTo),
      ),
    [invoices, appliedFrom, appliedTo, appliedStatus],
  );

  useEffect(() => {
    setPage(1);
  }, [appliedFrom, appliedTo, appliedStatus]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / pageSize));
    if (page > totalPages) setPage(totalPages);
  }, [filteredInvoices.length, pageSize, page]);

  const invoicePagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: filteredInvoices.length,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
      ariaLabel: "Payment history table pagination",
    }),
    [page, pageSize, filteredInvoices.length],
  );

  const allSelected =
    filteredInvoices.length > 0 &&
    filteredInvoices.every((row) => selectedIds.has(row.id));

  const outstandingCount = useMemo(
    () =>
      invoices.filter((row) => {
        const s = row.status.toLowerCase();
        return (
          s === "open" ||
          s === "uncollectible" ||
          Boolean(row.paymentFailureMessage)
        );
      }).length,
    [invoices],
  );

  const columns: DataTableColumn<InvoiceRow>[] = useMemo(
    () => [
      {
        id: "select",
        header: (
          <input
            type="checkbox"
            className="um_table_header_select_cb"
            checked={allSelected}
            disabled={filteredInvoices.length === 0}
            onChange={() => {
              if (allSelected) {
                setSelectedIds(new Set());
                return;
              }
              setSelectedIds(new Set(filteredInvoices.map((r) => r.id)));
            }}
            aria-label="Select all invoices"
          />
        ),
        align: "center",
        thClassName: "um_th_checkbox",
        tdClassName: "um_td_checkbox",
        cell: (row) => (
          <input
            type="checkbox"
            className="um_table_row_select_cb"
            checked={selectedIds.has(row.id)}
            onChange={() => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(row.id)) next.delete(row.id);
                else next.add(row.id);
                return next;
              });
            }}
            aria-label={`Select invoice ${row.invoiceNumber}`}
          />
        ),
      },
      {
        id: "invoiceNumber",
        header: "Invoice number",
        sortValue: (row) => row.invoiceNumber.toLowerCase(),
        tdClassName: "cp_billing_invoice_number_td",
        cell: (row) => (
          <span className="cp_billing_invoice_number">{row.invoiceNumber}</span>
        ),
      },
      {
        id: "dealName",
        header: "Deal",
        sortValue: (row) => (row.dealName ?? "").toLowerCase(),
        cell: (row) =>
          row.dealName?.trim() ? (
            <span className="cp_billing_invoice_number">{row.dealName}</span>
          ) : (
            <span className="um_status_muted">—</span>
          ),
      },
      {
        id: "invoiceDate",
        header: "Invoice Date",
        sortValue: (row) => row.invoiceDate,
        cell: (row) => formatPaymentHistoryDate(row.invoiceDate),
      },
      {
        id: "dueDate",
        header: "Due Date",
        sortValue: (row) => row.dueDate,
        cell: (row) => formatPaymentHistoryDate(row.dueDate),
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status.toLowerCase(),
        cell: (row) => (
          <span className={invoiceStatusClassName(row.status)}>
            {row.status}
            {row.paymentFailureMessage ? (
              <span
                title={row.paymentFailureMessage}
                style={{ display: "block", fontSize: 12, color: "#b91c1c" }}
              >
                Payment failed
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: "amount",
        header: "Amount",
        align: "right",
        thClassName: "deals_th_align_right",
        tdClassName: "um_td_numeric cp_billing_amount_td",
        sortValue: (row) => row.amount,
        cell: (row) => row.amount,
      },
      {
        id: "receipt",
        header: "Receipt",
        align: "center",
        thClassName: "deals_th_align_center um_th_actions",
        tdClassName: "um_td_actions cp_billing_receipt_td",
        cell: (row) => {
          const href = row.invoicePdf || row.hostedInvoiceUrl;
          if (!href) {
            return (
              <button
                type="button"
                className="cp_billing_receipt_btn"
                disabled
                aria-label="Download receipt (unavailable)"
                title="Receipt unavailable"
              >
                <Receipt size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            );
          }
          return (
            <a
              className="cp_billing_receipt_btn"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open receipt for ${row.invoiceNumber}`}
              title="Open receipt"
            >
              <Receipt size={16} strokeWidth={2} aria-hidden="true" />
            </a>
          );
        },
      },
    ],
    [allSelected, filteredInvoices, selectedIds],
  );

  const handleSearch = () => {
    setAppliedFrom(dateFrom);
    setAppliedTo(dateTo);
    setAppliedStatus(statusFilter);
    setSelectedIds(new Set());
    setPage(1);
  };

  const handleReset = () => {
    setDateFrom(DEFAULT_DATE_FROM);
    setDateTo(DEFAULT_DATE_TO);
    setStatusFilter("");
    setAppliedFrom(DEFAULT_DATE_FROM);
    setAppliedTo(DEFAULT_DATE_TO);
    setAppliedStatus("");
    setSelectedIds(new Set());
    setPage(1);
  };

  return (
    <div className="cp_billing_payment_history">
      <header className="cp_billing_payment_history_head">
        <h3 className="cp_billing_payment_history_title">Payment history</h3>
        <p className="cp_billing_payment_history_lead">
          Filter invoices by date, status, and deal. Download receipts when
          available.
        </p>
      </header>

      {loadError ? (
        <p role="alert" style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>
          {loadError}
        </p>
      ) : null}

      <section
        className="cp_billing_payment_filters_panel"
        role="search"
        aria-label="Invoice filters"
      >
        <div className="cp_billing_payment_filters_grid">
          <div className="cp_billing_filter_field cp_billing_filter_field--date">
            <label className="cp_billing_filter_label" htmlFor="cp-billing-date-from">
              <Calendar size={14} strokeWidth={2} aria-hidden />
              Invoice date
            </label>
            <div className="cp_billing_date_range">
              <input
                id="cp-billing-date-from"
                type="date"
                className="cp_billing_filter_input cp_billing_date_input"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                aria-label="Invoice date from"
              />
              <span className="cp_billing_date_range_sep">to</span>
              <input
                type="date"
                className="cp_billing_filter_input cp_billing_date_input"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                aria-label="Invoice date to"
              />
            </div>
          </div>

          <div className="cp_billing_filter_field">
            <label className="cp_billing_filter_label" htmlFor="cp-billing-status">
              Status
            </label>
            <select
              id="cp-billing-status"
              className="cp_billing_filter_input cp_billing_status_select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Invoice status"
            >
              <option value="">All statuses</option>
              <option value="paid">Paid</option>
              <option value="open">Open</option>
              <option value="overdue">Overdue</option>
              <option value="void">Void</option>
            </select>
          </div>
        </div>

        <div className="cp_billing_payment_filters_actions">
          <button
            type="button"
            className="um_btn_secondary cp_billing_reset_btn"
            onClick={handleReset}
          >
            <RotateCcw size={16} strokeWidth={2} aria-hidden />
            Reset filters
          </button>
          <button
            type="button"
            className="um_btn_primary cp_billing_search_btn"
            onClick={handleSearch}
          >
            <Search size={16} strokeWidth={2} aria-hidden />
            Search
          </button>
        </div>
      </section>

      <div
        className="cp_billing_outstanding_banner"
        role="status"
        aria-live="polite"
      >
        <span className="cp_billing_outstanding_icon" aria-hidden="true">
          <Check size={14} strokeWidth={2.5} />
        </span>
        <p>
          {loading
            ? "Loading invoices…"
            : outstandingCount === 0
              ? "Your account has no outstanding invoices at this time."
              : `You have ${outstandingCount} outstanding invoice${outstandingCount === 1 ? "" : "s"}.`}
        </p>
      </div>

      <div className="cp_billing_invoices_table_wrap deal_inv_table_panel">
        <DataTable
          columns={columns}
          rows={filteredInvoices}
          getRowKey={(row) => row.id}
          emptyLabel="No invoices found for the selected filters."
          visualVariant="members"
          membersTableClassName="um_table_members deal_inv_table"
          membersShell="default"
          initialSort={{ columnId: "invoiceDate", direction: "desc" }}
          pagination={invoicePagination}
        />
      </div>
    </div>
  );
}

export function CompanyBillingTab({
  workspaceCompanyId,
  focusDealId,
  focusDealName,
}: {
  workspaceCompanyId?: string;
  focusDealId?: string;
  focusDealName?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const platformAdmin = isPlatformAdmin();
  const likelyManager = isCompanyAdmin() || platformAdmin;
  const billingQuery = new URLSearchParams(location.search).get("billing");
  const fromDealPayFlow =
    (billingQuery === "pay" || billingQuery === "upgrade") &&
    Boolean((focusDealId ?? "").trim());
  const canCheckout = fromDealPayFlow;
  const [billingSubTab, setBillingSubTab] = useState<BillingSubTab>(() => {
    if (typeof window !== "undefined") {
      const billing = new URLSearchParams(window.location.search).get(
        "billing",
      );
      if (billing === "pay" || billing === "upgrade") return "pricing";
    }
    return "deals";
  });
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annually">(
    "monthly",
  );
  const [billingStatus, setBillingStatus] =
    useState<CompanyBillingStatus | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<
    CompanyBillingPaymentMethod[]
  >([]);
  const [statusError, setStatusError] = useState("");
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const workspaceId = (workspaceCompanyId ?? "").trim();
  const companyId = (
    platformAdmin && selectedOrgId.trim() ? selectedOrgId : workspaceId
  ).trim();

  useEffect(() => {
    if (!platformAdmin || selectedOrgId.trim() || !focusDealId?.trim()) return;
    const dealKey = focusDealId.trim().toLowerCase();
    let cancelled = false;
    void fetchPlatformBillingDeals().then((result) => {
      if (cancelled || !result.ok) return;
      const row = result.deals.find(
        (deal) => deal.id.trim().toLowerCase() === dealKey,
      );
      const orgId = String(row?.companyId ?? "").trim();
      if (orgId) setSelectedOrgId(orgId);
    });
    return () => {
      cancelled = true;
    };
  }, [platformAdmin, selectedOrgId, focusDealId]);

  const canManageBilling = billingStatus?.canManage ?? likelyManager;
  const canPayBilling = Boolean(
    billingStatus?.canPay ?? (!platformAdmin && canManageBilling),
  );
  const showPricingTab = platformAdmin || canPayBilling;

  const refreshPaymentMethods = useCallback(() => {
    if (!companyId) {
      setPaymentMethods([]);
      return;
    }
    void fetchCompanyBillingPaymentMethods(companyId).then((result) => {
      if (result.ok) setPaymentMethods(result.paymentMethods);
    });
  }, [companyId]);

  const refreshStatus = useCallback(() => {
    if (!companyId) {
      setBillingStatus(null);
      setPaymentMethods([]);
      return;
    }
    void fetchCompanyBillingStatus(companyId).then((result) => {
      if (!result.ok) {
        setStatusError(result.message);
        setBillingStatus(null);
        return;
      }
      setStatusError("");
      setBillingStatus(result.status);
      if (result.status.canManage === false) {
        setBillingSubTab((current) =>
          current === "payment-methods" ? "deals" : current,
        );
        setPaymentMethods([]);
      } else {
        refreshPaymentMethods();
      }
      if (
        result.status.billingCycle === "annual" ||
        result.status.billingCycle === "annually"
      ) {
        setBillingCycle("annually");
      } else if (result.status.billingCycle === "monthly") {
        setBillingCycle("monthly");
      }
    });
  }, [companyId, refreshPaymentMethods]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!fromDealPayFlow || !companyId || !focusDealId?.trim()) return;
    void releaseCompanyBillingPayment(companyId, focusDealId.trim());
  }, [fromDealPayFlow, companyId, focusDealId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const billing = params.get("billing");
    if (billing !== "pay" && billing !== "upgrade") return;
    if (canPayBilling) {
      setBillingSubTab("pricing");
      return;
    }
    if (billingStatus && !canPayBilling) {
      setBillingSubTab("deals");
    }
  }, [billingStatus, canPayBilling, location.search]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get("billing");
    if (
      billing === "success" ||
      billing === "portal_return" ||
      billing === "payment_return" ||
      billing === "setup_return"
    ) {
      const sessionId = (params.get("session_id") ?? "").trim();
      const subscriptionId = (params.get("subscription_id") ?? "").trim();
      const paymentIntentId = (
        params.get("payment_intent") ??
        params.get("payment_intent_id") ??
        ""
      ).trim();
      setBillingSubTab(
        billing === "setup_return"
          ? "payment-methods"
          : billing === "success" ||
              billing === "portal_return" ||
              billing === "payment_return"
            ? canCheckout
              ? "pricing"
              : "deals"
            : "deals",
      );

      const finish = () => {
        params.delete("billing");
        params.delete("session_id");
        params.delete("subscription_id");
        params.delete("payment_intent");
        params.delete("payment_intent_client_secret");
        params.delete("setup_intent");
        params.delete("setup_intent_client_secret");
        params.delete("redirect_status");
        const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", next);
      };

      if (billing === "success" && companyId && sessionId.startsWith("cs_")) {
        const dealIdFromUrl = normalizeBillingDealId(params.get("dealId"));
        if (dealIdFromUrl) {
          void releaseCompanyBillingPayment(companyId, dealIdFromUrl);
        }
        void syncCompanyBillingCheckout(companyId, sessionId, dealIdFromUrl).then((result) => {
          if (result.ok) {
            setStatusError("");
            setBillingStatus(result.status);
          } else {
            setStatusError(result.message);
            refreshStatus();
          }
          if (result.ok ? result.status.canManage !== false : likelyManager) {
            refreshPaymentMethods();
          }
          const paidDealId =
            (result.ok ? result.paidDealId : null) || dealIdFromUrl;
          if (result.ok && paidDealId) {
            navigate(`/deals/${encodeURIComponent(paidDealId)}`, {
              replace: true,
            });
            return;
          }
          finish();
        });
        return;
      }

      if (billing === "payment_return" && companyId) {
        const dealIdFromUrl = normalizeBillingDealId(params.get("dealId"));
        void syncCompanyBillingPayment(companyId, {
          subscriptionId: subscriptionId || undefined,
          paymentIntentId: paymentIntentId || undefined,
        }).then((result) => {
          if (result.ok) {
            setStatusError("");
            setBillingStatus(result.status);
          } else {
            setStatusError(result.message);
            refreshStatus();
          }
          if (result.ok ? result.status.canManage !== false : likelyManager) {
            refreshPaymentMethods();
          }
          if (result.ok && dealIdFromUrl) {
            navigate(`/deals/${encodeURIComponent(dealIdFromUrl)}`, {
              replace: true,
            });
            return;
          }
          finish();
        });
        return;
      }

      if (
        (billing === "portal_return" || billing === "setup_return") &&
        companyId
      ) {
        void syncCompanyBillingPaymentMethods(companyId).then((result) => {
          if (result.ok) {
            setPaymentMethods(result.paymentMethods);
          } else {
            refreshPaymentMethods();
          }
          refreshStatus();
          finish();
        });
        return;
      }

      refreshStatus();
      finish();
    } else if (billing === "cancel") {
      const dealIdFromUrl = normalizeBillingDealId(params.get("dealId"));
      if (companyId && dealIdFromUrl) {
        void releaseCompanyBillingPayment(companyId, dealIdFromUrl);
      }
      params.set("billing", "pay");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      navigate(next, { replace: true });
    }
  }, [companyId, likelyManager, navigate, refreshPaymentMethods, refreshStatus]);

  return (
    <div className="cp_settings_billing_tab">
      {!companyId && !platformAdmin ? (
        <p className="cp_billing_subtitle" role="status">
          Select a company workspace to manage billing.
        </p>
      ) : null}
      {statusError ? (
        <p
          className="cp_billing_subtitle"
          role="alert"
          style={{ color: "#b91c1c" }}
        >
          {statusError}
        </p>
      ) : null}

      <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer cp_billing_subtabs_outer">
        <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
          <div
            className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
            role="tablist"
            aria-label="Billing sections"
          >
            {showPricingTab ? (
              <button
                type="button"
                id="cp-billing-subtab-pricing"
                role="tab"
                aria-selected={billingSubTab === "pricing"}
                aria-controls="cp-billing-panel-pricing"
                className={`um_members_tab deals_tabs_tab um_segmented_tab${
                  billingSubTab === "pricing" ? " um_members_tab_active" : ""
                }`}
                onClick={() => {
                  if (billingSubTab !== "pricing") {
                    const params = new URLSearchParams(location.search);
                    if (
                      params.get("billing") === "pay" ||
                      params.get("dealId") ||
                      params.get("dealName")
                    ) {
                      params.delete("billing");
                      params.delete("dealId");
                      params.delete("dealName");
                      const search = params.toString();
                      navigate(
                        `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
                        { replace: true },
                      );
                    }
                  }
                  setBillingSubTab("pricing");
                }}
              >
                <BadgeDollarSign
                  className="deals_tabs_icon um_segmented_tab_icon"
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="deals_tabs_label um_segmented_tab_label">
                  Pricing
                </span>
              </button>
            ) : null}
            <button
              type="button"
              id="cp-billing-subtab-deals"
              role="tab"
              aria-selected={billingSubTab === "deals"}
              aria-controls="cp-billing-panel-deals"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                billingSubTab === "deals" ? " um_members_tab_active" : ""
              }`}
              onClick={() => setBillingSubTab("deals")}
            >
              <Briefcase
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Detailed billing
              </span>
            </button>
            {canManageBilling ? (
              <button
                type="button"
                id="cp-billing-subtab-payment-methods"
                role="tab"
                aria-selected={billingSubTab === "payment-methods"}
                aria-controls="cp-billing-panel-payment-methods"
                className={`um_members_tab deals_tabs_tab um_segmented_tab${
                  billingSubTab === "payment-methods"
                    ? " um_members_tab_active"
                    : ""
                }`}
                onClick={() => setBillingSubTab("payment-methods")}
              >
                <WalletCards
                  className="deals_tabs_icon um_segmented_tab_icon"
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="deals_tabs_label um_segmented_tab_label">
                  Payment Methods
                </span>
              </button>
            ) : null}
            {/*
            <button
              type="button"
              id="cp-billing-subtab-payment-history"
              role="tab"
              aria-selected={billingSubTab === "payment-history"}
              aria-controls="cp-billing-panel-payment-history"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                billingSubTab === "payment-history"
                  ? " um_members_tab_active"
                  : ""
              }`}
              onClick={() => setBillingSubTab("payment-history")}
            >
              <Receipt
                className="deals_tabs_icon um_segmented_tab_icon"
                size={16}
                strokeWidth={2}
                aria-hidden
              />
              <span className="deals_tabs_label um_segmented_tab_label">
                Payment History
              </span>
            </button>
            */}
          </div>
        </TabsScrollStrip>
      </div>

      {showPricingTab ? (
        <div
          id="cp-billing-panel-pricing"
          role="tabpanel"
          aria-labelledby="cp-billing-subtab-pricing"
          hidden={billingSubTab !== "pricing"}
          className="cp_billing_subtab_panel cp_billing_subtab_panel_pricing"
        >
          {billingSubTab === "pricing" ? (
            <BillingPricingPanel
              key={fromDealPayFlow ? `deal-${focusDealId}` : "browse"}
              billingCycle={billingCycle}
              onBillingCycleChange={setBillingCycle}
              companyId={companyId}
              billingStatus={billingStatus}
              onStatusRefresh={refreshStatus}
              initialDealId={fromDealPayFlow ? focusDealId : undefined}
              initialDealName={fromDealPayFlow ? focusDealName : undefined}
              allowPayment={canCheckout && !platformAdmin}
            />
          ) : null}
        </div>
      ) : null}

      <div
        id="cp-billing-panel-deals"
        role="tabpanel"
        aria-labelledby="cp-billing-subtab-deals"
        hidden={billingSubTab !== "deals"}
        className="cp_billing_subtab_panel"
      >
        {billingSubTab === "deals" ? (
          <BillingDealDetailsPanel
            key={isPlatformAdmin() ? "all-organizations" : companyId}
            companyId={companyId}
            viewerScope={billingStatus?.viewerScope}
            canPay={canPayBilling}
            onPaid={refreshStatus}
            onSelectOrganization={setSelectedOrgId}
          />
        ) : null}
      </div>

      {canManageBilling ? (
        <div
          id="cp-billing-panel-payment-methods"
          role="tabpanel"
          aria-labelledby="cp-billing-subtab-payment-methods"
          hidden={billingSubTab !== "payment-methods"}
          className="cp_billing_subtab_panel cp_billing_subtab_panel_payment_methods"
        >
          {billingSubTab === "payment-methods" ? (
            <BillingPaymentMethodsPanel
              companyId={companyId}
              billingStatus={billingStatus}
              paymentMethods={paymentMethods}
              onStatusRefresh={refreshStatus}
            />
          ) : null}
        </div>
      ) : null}

      {/*
      <div
        id="cp-billing-panel-payment-history"
        role="tabpanel"
        aria-labelledby="cp-billing-subtab-payment-history"
        hidden={billingSubTab !== "payment-history"}
        className="cp_billing_subtab_panel"
      >
        {billingSubTab === "payment-history" ? (
          <BillingPaymentHistoryPanel companyId={companyId} />
        ) : null}
      </div>
      */}
    </div>
  );
}
