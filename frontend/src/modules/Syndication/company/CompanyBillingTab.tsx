import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Calendar,
  Check,
  CreditCard,
  ExternalLink,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import {
  DataTable,
  type DataTableColumn,
} from "../../../common/components/data-table/DataTable";
import { TabsScrollStrip } from "../../../common/components/tabs-scroll-strip/TabsScrollStrip";
import {
  fetchCompanyBillingInvoices,
  fetchCompanyBillingPaymentMethods,
  fetchCompanyBillingStatus,
  openCompanyBillingPortal,
  startCompanyBillingCheckout,
  startCompanyBillingSetupIntent,
  syncCompanyBillingCheckout,
  syncCompanyBillingPayment,
  syncCompanyBillingPaymentMethods,
  type BillingSetupIntentSession,
  type CompanyBillingInvoice,
  type CompanyBillingPaymentMethod,
  type CompanyBillingStatus,
} from "./companyBillingApi";
import { BillingPaymentElementModal } from "./BillingPaymentElementModal";

type BillingSubTab = "pricing" | "payment-methods" | "payment-history";
type InvoiceRow = CompanyBillingInvoice;
type SeatBand = "5" | "10" | "10plus";

type DealTier = {
  id: "starter" | "running" | "growth";
  name: string;
  dealSize: string;
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

const CUSTOM_PLAN_CONTACT_HREF =
  "mailto:support@syndicationx.com?subject=Custom%20plan%20inquiry%20%E2%80%93%20SyndicationX";

const DEAL_TIERS: DealTier[] = [
  {
    id: "starter",
    name: "Starter",
    dealSize: "Up to $5M Deal",
    featured: true,
    enabled: true,
    prices: {
      "5": { monthly: 49, annual: 490 },
      "10": { monthly: 69, annual: 690 },
      "10plus": { monthly: 89, annual: 890 },
    },
  },
  {
    id: "running",
    name: "Running",
    dealSize: "Up to $15M Deal",
    featured: false,
    enabled: true,
    prices: {
      "5": { monthly: 99, annual: 990 },
      "10": { monthly: 129, annual: 1290 },
      "10plus": { monthly: 149, annual: 1490 },
    },
  },
  {
    id: "growth",
    name: "Growth",
    dealSize: "$15M+ Deal",
    featured: false,
    enabled: true,
    prices: {
      "5": { monthly: 149, annual: 1490 },
      "10": { monthly: 169, annual: 1690 },
      "10plus": { monthly: 189, annual: 1890 },
    },
  },
];

const SEAT_OPTIONS: { id: SeatBand; label: string }[] = [
  { id: "5", label: "5 users" },
  { id: "10", label: "10 users" },
  { id: "10plus", label: "10+ users" },
];

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
  return `${titled} ${last4}${exp}`;
}

function BillingPricingPanel({
  billingCycle,
  onBillingCycleChange,
  companyId,
  billingStatus,
  onStatusRefresh,
}: {
  billingCycle: "monthly" | "annually";
  onBillingCycleChange: (cycle: "monthly" | "annually") => void;
  companyId: string;
  billingStatus: CompanyBillingStatus | null;
  onStatusRefresh: () => void;
}) {
  const [seatBand, setSeatBand] = useState<SeatBand>("5");
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [actionError, setActionError] = useState("");

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
    const seatRow = row.seats?.find((s) => s.seatBand === seatBand);
    if (seatRow) {
      return billingCycle === "monthly"
        ? seatRow.monthlyReady
        : seatRow.annualReady;
    }
    return billingCycle === "monthly" ? row.monthlyReady : row.annualReady;
  };

  const handleChoosePlan = async (tierId: DealTier["id"]) => {
    setActionError("");
    if (!companyId) {
      setActionError("No company workspace selected.");
      return;
    }
    if (!billingStatus?.configured) {
      setActionError(
        "Stripe is not configured. Set STRIPE_SECRET_KEY in backend/.env.local.",
      );
      return;
    }
    const id = planKey(tierId);
    if (!planReady(tierId)) {
      const envHint =
        billingCycle === "monthly"
          ? PRICE_ENV_HINT[tierId][seatBand].monthly
          : PRICE_ENV_HINT[tierId][seatBand].annual;
      const tierName =
        DEAL_TIERS.find((t) => t.id === tierId)?.name ?? tierId;
      setActionError(
        `Stripe Price for ${tierName} / ${seatBand} seats (${billingCycle}) is not set. Check ${envHint} in backend/.env.local.`,
      );
      return;
    }
    setBusyPlanId(id);
    const result = await startCompanyBillingCheckout(
      companyId,
      id,
      billingCycle,
      seatBand,
    );
    setBusyPlanId(null);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    window.location.assign(result.url);
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
          Pricing by deal size and company users. No charge for draft or
          archived deals — billing starts when you begin raising capital /
          asset managing. Pay with card or ACH (US bank account) via Stripe Checkout.
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
                billingCycle === "monthly" ? "cp_billing_cycle_option_active" : ""
              }`}
            >
              <input
                type="radio"
                name="cp_billing_cycle"
                value="monthly"
                checked={billingCycle === "monthly"}
                onChange={() => onBillingCycleChange("monthly")}
              />
              <span>Monthly</span>
            </label>
            <label
              className={`cp_billing_cycle_option ${
                billingCycle === "annually"
                  ? "cp_billing_cycle_option_active"
                  : ""
              }`}
            >
              <input
                type="radio"
                name="cp_billing_cycle"
                value="annually"
                checked={billingCycle === "annually"}
                onChange={() => onBillingCycleChange("annually")}
              />
              <span>
                Yearly{" "}
                <span className="cp_billing_cycle_save">2 months free</span>
              </span>
            </label>
          </div>
        </div>

        <div className="cp_billing_filter_row">
          <span className="cp_billing_filter_heading" id="cp-billing-seats-label">
            Company users{" "}
            <span className="cp_billing_filter_hint">
              (doesn&apos;t include co-sponsors)
            </span>
          </span>
          <div
            className="cp_billing_cycle"
            role="radiogroup"
            aria-labelledby="cp-billing-seats-label"
          >
            {SEAT_OPTIONS.map((opt) => (
              <label
                key={opt.id}
                className={`cp_billing_cycle_option ${
                  seatBand === opt.id ? "cp_billing_cycle_option_active" : ""
                }`}
              >
                <input
                  type="radio"
                  name="cp_billing_seats"
                  value={opt.id}
                  checked={seatBand === opt.id}
                  onChange={() => setSeatBand(opt.id)}
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="cp_billing_plans">
        {DEAL_TIERS.map((tier) => {
          const priceRow = tier.prices[seatBand];
          const price =
            billingCycle === "monthly" ? priceRow.monthly : priceRow.annual;
          const priceSuffix = billingCycle === "monthly" ? "/mo" : "/yr";
          const id = planKey(tier.id);
          const isCurrent =
            isPaid &&
            (activePlanId === id || activePlanId.startsWith(`${id}_`));
          const ctaBusy = busyPlanId === id;
          const disabledCard = !tier.enabled;
          return (
            <div
              key={tier.id}
              className={`cp_billing_plan_card ${
                tier.featured ? "cp_billing_plan_card_featured" : ""
              }`}
              style={
                disabledCard
                  ? { opacity: 0.55, pointerEvents: "none" }
                  : undefined
              }
              aria-disabled={disabledCard || undefined}
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
                  <span className="cp_billing_plan_price_amount">${price}</span>
                  <span className="cp_billing_plan_price_suffix">
                    {priceSuffix}
                  </span>
                </div>
                {billingCycle === "annually" ? (
                  <p className="cp_billing_plan_price_perk">2 months free</p>
                ) : null}
                <p className="cp_billing_plan_price_calc">
                  {SEAT_OPTIONS.find((s) => s.id === seatBand)?.label} · card /
                  ACH
                  {billingCycle === "annually" ? " · billed yearly" : ""}
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
                      Company users:{" "}
                      {SEAT_OPTIONS.find((s) => s.id === seatBand)?.label}{" "}
                      (doesn’t include co-sponsors)
                    </span>
                  </li>
                  <li>
                    <Check size={16} aria-hidden="true" />
                    <span>
                      {billingCycle === "annually"
                        ? "Yearly billing — 2 months free"
                        : "Recurring monthly or annual billing"}
                    </span>
                  </li>
                </ul>
              </div>
              <button
                type="button"
                className={`cp_billing_plan_cta ${
                  tier.enabled
                    ? "cp_billing_plan_cta_primary"
                    : "cp_billing_plan_cta_secondary"
                }`}
                disabled={disabledCard || ctaBusy || isCurrent}
                title={
                  disabledCard
                    ? `${tier.name} checkout is not available yet`
                    : undefined
                }
                onClick={() => {
                  if (disabledCard) return;
                  if (isCurrent) {
                    onStatusRefresh();
                    return;
                  }
                  void handleChoosePlan(tier.id);
                }}
              >
                {disabledCard
                  ? "Coming soon"
                  : isCurrent
                    ? "Current plan"
                    : ctaBusy
                      ? "Redirecting…"
                      : `Choose ${tier.name}`}
              </button>
            </div>
          );
        })}

        <div className="cp_billing_plan_card">
          <span className="cp_billing_plan_badge">Available now</span>
          <h4 className="cp_billing_plan_name">Custom</h4>
          <p className="cp_billing_plan_tagline">
            $50M+ deals or 25+ company users
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
            </ul>
          </div>
          <a
            className="cp_billing_plan_cta cp_billing_plan_cta_primary"
            href={CUSTOM_PLAN_CONTACT_HREF}
          >
            Contact sales
          </a>
        </div>
      </div>

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
  const [portalBusy, setPortalBusy] = useState(false);
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
          {billingStatus?.hasCustomer ? (
            <button
              type="button"
              className="um_btn_secondary"
              disabled={portalBusy}
              onClick={() => void handleManageBilling()}
            >
              <ExternalLink size={15} aria-hidden />
              {portalBusy ? "Opening…" : "Manage in Stripe"}
            </button>
          ) : null}
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

function BillingPaymentHistoryPanel({ companyId }: { companyId: string }) {
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
          Filter invoices by date and status. Download receipts when available.
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
}: {
  workspaceCompanyId?: string;
} = {}) {
  const [billingSubTab, setBillingSubTab] =
    useState<BillingSubTab>("pricing");
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annually">(
    "monthly",
  );
  const [billingStatus, setBillingStatus] =
    useState<CompanyBillingStatus | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<
    CompanyBillingPaymentMethod[]
  >([]);
  const [statusError, setStatusError] = useState("");
  const companyId = (workspaceCompanyId ?? "").trim();

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
      if (
        result.status.billingCycle === "annual" ||
        result.status.billingCycle === "annually"
      ) {
        setBillingCycle("annually");
      } else if (result.status.billingCycle === "monthly") {
        setBillingCycle("monthly");
      }
    });
    refreshPaymentMethods();
  }, [companyId, refreshPaymentMethods]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

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
        billing === "setup_return" ? "payment-methods" : "pricing",
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
        void syncCompanyBillingCheckout(companyId, sessionId).then((result) => {
          if (result.ok) {
            setStatusError("");
            setBillingStatus(result.status);
          } else {
            setStatusError(result.message);
            refreshStatus();
          }
          refreshPaymentMethods();
          finish();
        });
        return;
      }

      if (billing === "payment_return" && companyId) {
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
          refreshPaymentMethods();
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
      params.delete("billing");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", next);
    }
  }, [companyId, refreshPaymentMethods, refreshStatus]);

  return (
    <div className="cp_settings_billing_tab">
      {!companyId ? (
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
            <button
              type="button"
              id="cp-billing-subtab-pricing"
              role="tab"
              aria-selected={billingSubTab === "pricing"}
              aria-controls="cp-billing-panel-pricing"
              className={`um_members_tab deals_tabs_tab um_segmented_tab${
                billingSubTab === "pricing" ? " um_members_tab_active" : ""
              }`}
              onClick={() => setBillingSubTab("pricing")}
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
          </div>
        </TabsScrollStrip>
      </div>

      <div
        id="cp-billing-panel-pricing"
        role="tabpanel"
        aria-labelledby="cp-billing-subtab-pricing"
        hidden={billingSubTab !== "pricing"}
        className="cp_billing_subtab_panel cp_billing_subtab_panel_pricing"
      >
        {billingSubTab === "pricing" ? (
          <BillingPricingPanel
            billingCycle={billingCycle}
            onBillingCycleChange={setBillingCycle}
            companyId={companyId}
            billingStatus={billingStatus}
            onStatusRefresh={refreshStatus}
          />
        ) : null}
      </div>

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
    </div>
  );
}
