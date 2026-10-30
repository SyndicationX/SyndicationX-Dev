import Stripe from "stripe";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, pool } from "../../database/db.js";
import {
  addDealForm,
  companies,
  companyBillingInvoices,
  dealInvestorClass,
  type AddDealFormRow,
} from "../../schema/schema.js";
import {
  isPortalUserLeadSponsorOnDeal,
  listDealIdsWhereViewerIsLeadSponsor,
} from "../deal/dealMemberScope.service.js";
import { normalizeDealStageCanonical } from "../../constants/deal-lifecycle/deal-stage.js";
import { resolveOfferingStatusForStageChange } from "../../constants/deal-lifecycle/deal-status-rules.js";
import {
  dealSaasPaymentIsComplete,
  isSaasBillableDealStage,
} from "./dealStageSaasPaymentHold.js";
import {
  getStripeConfig,
  normalizeBillingPlanId,
  normalizeBillingSeatBand,
  planAndCycleFromPriceId,
  requireStripeConfig,
  resolveStripePriceId,
  type StripeBillingCycle,
  type StripeBillingPlanId,
  type StripeBillingSeatBand,
} from "../../config/stripe.config.js";
import {
  coGpSeatBandIsUpgrade,
  coGpSeatBandNeedsUpgrade,
  creditExtraCompanyUsersPaid,
  descriptionForExtraCompanyUserCharge,
  extraCoGpSubscriptionItem,
  extraCompanyUserChargeDescription,
  extraCompanyUsersToCharge,
  catalogPackagePriceCents,
  couponCheckoutLineCents,
  couponDurationAppliesToOneTime,
  differenceRepeatPriceCents,
  getDealCompanyUserSnapshot,
  priceGapCents,
  stripePriceIdForPlatformAmount,
  parseExtraCompanyUsersQuantity,
  suggestedSeatBandForDeal,
  countDealCoGps,
  economicPlanIdForDeal,
} from "./dealExtraCompanyUser.service.js";
import {
  notifyLeadSponsorsOfDealBillingStartDate,
  notifyLeadSponsorsOfDealPlanUpgrade,
} from "./dealPlanUpgradeAlert.service.js";
import {
  HARDCODED_SAAS_BILLING_STARTS_AT,
  dealSaasBillingHasStarted,
  dealSaasBillingNotYetDueMessage,
  dealSaasBillingStartsAt,
  utcMidnightFromYmdString,
  utcMidnightToday,
} from "./saasBillingStartDate.js";

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
  const cfg = requireStripeConfig();
  if (!stripeClient) {
    stripeClient = new Stripe(cfg.secretKey, {
      apiVersion: "2026-06-24.dahlia",
    });
  }
  return stripeClient;
}

const DEAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STARTER_MAX_CENTS = 3_000_000;
const RUNNING_MAX_CENTS = 5_000_000;

const BILLING_PLAN_RANK: Record<StripeBillingPlanId, number> = {
  starter: 1,
  running: 2,
  growth: 3,
};

const ACTIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
/** Workspace view/edit requires a current paid period — failed renewals lock the deal. */
const PAID_ACCESS_STATUSES = new Set(["active", "trialing"]);
export const DEAL_SAAS_PAYMENT_REQUIRED = "DEAL_SAAS_PAYMENT_REQUIRED";

export type DealSaasLockReason = "unpaid" | "expired" | "past_due";

export type DealSaasAccessEvaluation = {
  locked: boolean;
  reason: DealSaasLockReason | null;
};

export type DealSaasPaymentRequiredPayload = {
  code: typeof DEAL_SAAS_PAYMENT_REQUIRED;
  message: string;
  reason: DealSaasLockReason;
  dealId: string;
  dealName: string;
  organizationId: string | null;
  nextBillingDate: string | null;
  billingSubscriptionStatus: string;
  billingPlanId: string | null;
  viewerIsLeadSponsor?: boolean;
  needsPlanUpgrade?: boolean;
  suggestedPlanId?: string | null;
};

export type DealSaasBillingListFields = {
  viewerIsLeadSponsor: true;
  nextBillingDate: string | null;
  saasBillingStartsAt: string | null;
  billingSubscriptionStatus: string;
  billingPlanId: string | null;
  suggestedPlanId: string | null;
  needsPlanUpgrade: boolean;
  billingAccessLocked: boolean;
  billingLockReason: DealSaasLockReason | null;
};

export function normalizeDealId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return DEAL_UUID_RE.test(s) ? s : null;
}

export function isDealSaasBillable(
  row: Pick<AddDealFormRow, "archived" | "dealStage">,
): boolean {
  if (row.archived) return false;
  const stage = normalizeDealStageCanonical(row.dealStage);
  return stage === "capital_raising" || stage === "asset_managing";
}

/**
 * After the SaaS start date, unpaid CR/AM deals stay Draft with
 * `pending_deal_stage` until Checkout succeeds. Those rows must keep the
 * Stripe subscription so payment can promote the stage.
 */
function dealShouldKeepStripeSaasSubscription(
  row: Pick<AddDealFormRow, "archived" | "dealStage" | "pendingDealStage">,
): boolean {
  if (row.archived) return false;
  return (
    isDealSaasBillable(row) || isSaasBillableDealStage(row.pendingDealStage)
  );
}

function parseMoneyAmount(raw: string | null | undefined): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Starter ≤ $3M, Running ≤ $5M, Growth ≤ $10M — custom above $11M. */
export function planIdForDealRaiseAmount(
  raiseAmount: number,
): StripeBillingPlanId {
  if (raiseAmount > RUNNING_MAX_CENTS) return "growth";
  if (raiseAmount > STARTER_MAX_CENTS) return "running";
  return "starter";
}

export function billingPlanRank(
  planId: string | null | undefined,
): number {
  const id = normalizeBillingPlanId(planId);
  return id ? BILLING_PLAN_RANK[id] : 0;
}

/**
 * Billing table plan. Offering size wins when it is below the plan stored
 * on the subscription. A higher size plan stays on the paid id so the
 * upgrade difference is still the new price minus what was paid.
 */
function displayPlanIdForBilledDeal(
  paidPlanId: string | null | undefined,
  suggestedPlanId: string | null | undefined,
): string | null {
  const paid = normalizeBillingPlanId(paidPlanId);
  const suggested = normalizeBillingPlanId(suggestedPlanId);
  if (suggested && billingPlanRank(suggested) < billingPlanRank(paid)) {
    return suggested;
  }
  return paid ?? suggested ?? null;
}

function dealShouldAlertPlanUpgrade(
  row: Pick<
    AddDealFormRow,
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "stripeSubscriptionStatus"
    | "stripePlanId"
    | "saasBillingStartsAt"
  >,
  suggestedPlanId: string | null | undefined,
): boolean {
  if (!saasBillingHasStarted(row)) return false;
  if (!dealIsActivelyBilled(row)) return false;
  return dealPaidPlanNeedsUpgrade(row.stripePlanId, suggestedPlanId);
}

/** True when the paid plan is below the plan required by current deal size. */
export function dealPaidPlanNeedsUpgrade(
  currentPlanId: string | null | undefined,
  suggestedPlanId: string | null | undefined,
): boolean {
  const current = normalizeBillingPlanId(currentPlanId);
  const suggested = normalizeBillingPlanId(suggestedPlanId);
  if (!current || !suggested) return false;
  return BILLING_PLAN_RANK[suggested] > BILLING_PLAN_RANK[current];
}

/** Sum of paid invoices for a deal subscription. Used when the Stripe Price cannot be read. */
async function collectedInvoiceCentsBySubscription(
  subscriptionIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  const ids = [
    ...new Set(
      subscriptionIds.map((id) => String(id ?? "").trim()).filter(Boolean),
    ),
  ];
  if (ids.length === 0) return amounts;
  const rows = await db
    .select({
      stripeSubscriptionId: companyBillingInvoices.stripeSubscriptionId,
      totalPaidCents: sql<number>`coalesce(sum(${companyBillingInvoices.amountPaidCents}), 0)::int`,
    })
    .from(companyBillingInvoices)
    .where(
      and(
        inArray(companyBillingInvoices.stripeSubscriptionId, ids),
        eq(companyBillingInvoices.status, "paid"),
      ),
    )
    .groupBy(companyBillingInvoices.stripeSubscriptionId);
  for (const row of rows) {
    const id = String(row.stripeSubscriptionId ?? "").trim();
    const total = Number(row.totalPaidCents) || 0;
    if (id && total > 0) amounts.set(id, total);
  }
  return amounts;
}

/** New package price minus the amount already on the Stripe subscription. */
export async function dealSubscriptionPriceGapCents(params: {
  stripePriceId: string | null | undefined;
  stripePlanId: string | null | undefined;
  stripeBillingCycle: string | null | undefined;
  stripeSeatBand: string | null | undefined;
  stripeSubscriptionId?: string | null | undefined;
  /** A redeemed coupon lowered the charge. It is not an unpaid package gap. */
  couponRedeemed?: boolean;
  nextPlanId: string | null | undefined;
  nextSeatBand: string | null | undefined;
}): Promise<number> {
  const mapped = planAndCycleFromPriceId(params.stripePriceId);
  const cycle =
    normalizeDealBillingCycle(params.stripeBillingCycle) ?? mapped.cycle;
  const currentSeat =
    normalizeBillingSeatBand(params.stripeSeatBand) ?? mapped.seatBand ?? "5";
  const nextSeat =
    normalizeBillingSeatBand(params.nextSeatBand) ?? currentSeat;
  const currentPlan = params.stripePlanId ?? mapped.planId;
  const nextPlan = params.nextPlanId ?? currentPlan;
  if (
    params.couponRedeemed &&
    currentPlan &&
    nextPlan &&
    currentPlan === nextPlan &&
    currentSeat === nextSeat
  ) {
    return 0;
  }
  let paidCents = catalogPackagePriceCents(currentPlan, cycle, currentSeat);
  const priceId = String(params.stripePriceId ?? "").trim();
  let readStripePrice = false;
  if (priceId) {
    try {
      const price = await getStripeClient().prices.retrieve(priceId);
      if (typeof price.unit_amount === "number" && price.unit_amount > 0) {
        paidCents = price.unit_amount;
        readStripePrice = true;
      }
    } catch (err) {
      console.warn("dealSubscriptionPriceGapCents:", err);
    }
  }
  if (!readStripePrice && !params.couponRedeemed) {
    const collected = await collectedInvoiceCentsBySubscription([
      params.stripeSubscriptionId,
    ]);
    const invoicePaid = collected.get(
      String(params.stripeSubscriptionId ?? "").trim(),
    );
    if (invoicePaid != null) paidCents = invoicePaid;
  }
  return priceGapCents(
    paidCents,
    catalogPackagePriceCents(nextPlan, cycle, nextSeat),
  );
}

export async function suggestedPlanIdForDeal(
  dealId: string,
  /** Precomputed raise (see `mapDealRaiseAmountByDealIds`) to skip the per-deal query. */
  raiseAmount?: number,
  /** Precomputed co-sponsor count to skip the roster query. */
  coGpCount?: number,
): Promise<StripeBillingPlanId> {
  const raise = raiseAmount ?? (await raiseAmountForDeal(dealId));
  const coGps = coGpCount ?? (await countDealCoGps(dealId));
  return economicPlanIdForDeal(raise, coGps);
}

export async function assertCheckoutPlanMatchesDeal(params: {
  dealId: string;
  planId: StripeBillingPlanId;
}): Promise<
  | { ok: true; suggestedPlanId: StripeBillingPlanId }
  | { ok: false; status: number; message: string }
> {
  const suggestedPlanId = await suggestedPlanIdForDeal(params.dealId);
  if (params.planId !== suggestedPlanId) {
    const label =
      suggestedPlanId.charAt(0).toUpperCase() + suggestedPlanId.slice(1);
    return {
      ok: false,
      status: 400,
      message: `${label} is the plan for this deal.`,
    };
  }
  return { ok: true, suggestedPlanId };
}

async function raiseAmountForDeal(dealId: string): Promise<number> {
  const classes = await db
    .select({
      offeringSize: dealInvestorClass.offeringSize,
      billingRaiseQuota: dealInvestorClass.billingRaiseQuota,
    })
    .from(dealInvestorClass)
    .where(eq(dealInvestorClass.dealId, dealId));
  let offering = 0;
  let quota = 0;
  for (const c of classes) {
    offering += parseMoneyAmount(c.offeringSize);
    quota += parseMoneyAmount(c.billingRaiseQuota);
  }
  return offering > 0 ? offering : quota;
}

/** `raiseAmountForDeal` for many deals in one query (deals list billing columns). */
export async function mapDealRaiseAmountByDealIds(
  dealIds: readonly string[],
): Promise<Map<string, number>> {
  const raiseByDealId = new Map<string, number>();
  const ids = [
    ...new Set(dealIds.map((d) => String(d ?? "").trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return raiseByDealId;

  const classes = await db
    .select({
      dealId: dealInvestorClass.dealId,
      offeringSize: dealInvestorClass.offeringSize,
      billingRaiseQuota: dealInvestorClass.billingRaiseQuota,
    })
    .from(dealInvestorClass)
    .where(inArray(dealInvestorClass.dealId, ids));

  const offeringByDealId = new Map<string, number>();
  const quotaByDealId = new Map<string, number>();
  for (const c of classes) {
    const key = String(c.dealId);
    offeringByDealId.set(
      key,
      (offeringByDealId.get(key) ?? 0) + parseMoneyAmount(c.offeringSize),
    );
    quotaByDealId.set(
      key,
      (quotaByDealId.get(key) ?? 0) + parseMoneyAmount(c.billingRaiseQuota),
    );
  }

  for (const id of ids) {
    const offering = offeringByDealId.get(id) ?? 0;
    const quota = quotaByDealId.get(id) ?? 0;
    raiseByDealId.set(id, offering > 0 ? offering : quota);
  }
  return raiseByDealId;
}

function unixSecondsToDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (value && typeof value === "object" && "end" in value) {
    return unixSecondsToDate((value as { end?: unknown }).end);
  }
  return null;
}

/** Stripe Basil+: period end lives on subscription items (and nested current_period). */
export function periodEndFromSubscription(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as
    | {
        current_period_end?: number;
        current_period?: { end?: number } | number;
      }
    | undefined;
  const legacy = (sub as { current_period_end?: number }).current_period_end;
  return (
    unixSecondsToDate(item?.current_period_end) ??
    unixSecondsToDate(item?.current_period) ??
    unixSecondsToDate(legacy)
  );
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

function planCycleSeatFromSubscription(sub: Stripe.Subscription): {
  planId: StripeBillingPlanId | null;
  cycle: StripeBillingCycle | null;
  seatBand: StripeBillingSeatBand | null;
} {
  const priceId = priceIdFromSubscription(sub);
  const mapped = planAndCycleFromPriceId(priceId);
  const metaPlan = normalizeBillingPlanId(sub.metadata?.planId);
  const metaCycleRaw = String(sub.metadata?.billingCycle ?? "").trim();
  const metaCycle: StripeBillingCycle | null =
    metaCycleRaw === "monthly"
      ? "monthly"
      : metaCycleRaw === "annual" ||
          metaCycleRaw === "annually" ||
          metaCycleRaw === "yearly"
        ? "annual"
        : null;
  const metaSeat = normalizeBillingSeatBand(sub.metadata?.seatBand);
  return {
    planId: mapped.planId ?? metaPlan,
    cycle: mapped.cycle ?? metaCycle,
    seatBand: mapped.seatBand ?? metaSeat,
  };
}

function periodEndIso(
  row: Pick<AddDealFormRow, "stripeCurrentPeriodEnd">,
): string | null {
  return row.stripeCurrentPeriodEnd
    ? row.stripeCurrentPeriodEnd.toISOString()
    : null;
}

function periodEndHasPassed(
  row: Pick<AddDealFormRow, "stripeCurrentPeriodEnd">,
  nowMs = Date.now(),
): boolean {
  const end = row.stripeCurrentPeriodEnd;
  if (!end) return false;
  const t = end instanceof Date ? end.getTime() : Date.parse(String(end));
  return Number.isFinite(t) && t < nowMs;
}

function paidBillingPeriodIsLocked(
  row: Pick<
    AddDealFormRow,
    "stripeSubscriptionStatus" | "stripeCurrentPeriodEnd"
  >,
  nowMs = Date.now(),
): boolean {
  const status = String(row.stripeSubscriptionStatus ?? "").trim().toLowerCase();
  if (!PAID_ACCESS_STATUSES.has(status)) return false;
  if (!row.stripeCurrentPeriodEnd) return true;
  const end =
    row.stripeCurrentPeriodEnd instanceof Date
      ? row.stripeCurrentPeriodEnd.getTime()
      : Date.parse(String(row.stripeCurrentPeriodEnd));
  return !Number.isFinite(end) || end > nowMs;
}

function paidBillingPeriodLockedMessage(
  row: Pick<AddDealFormRow, "stripeCurrentPeriodEnd">,
): string {
  const end = row.stripeCurrentPeriodEnd;
  if (!end) {
    return "Billing settings are locked while this deal is in its current paid billing period.";
  }
  return `Billing settings are locked until the next billing date, ${end.toISOString()}.`;
}

function billingStartsAtDate(
  row?: Pick<AddDealFormRow, "saasBillingStartsAt">,
): Date {
  return dealSaasBillingStartsAt(row);
}

function saasBillingHasStarted(
  row?: Pick<AddDealFormRow, "saasBillingStartsAt">,
  nowMs = Date.now(),
): boolean {
  return dealSaasBillingHasStarted(row, nowMs);
}

export async function ensureDealSaasComplimentaryPeriod(
  deal: Pick<
    AddDealFormRow,
    | "id"
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "saasBillingStartsAt"
    | "organizationId"
  >,
): Promise<Date | null> {
  if (deal.saasBillingStartsAt) return deal.saasBillingStartsAt;
  if (!isDealSaasBillable(deal)) return null;
  const startsAt = HARDCODED_SAAS_BILLING_STARTS_AT;
  const id = normalizeDealId(String(deal.id));
  if (!id) return startsAt;
  await db
    .update(addDealForm)
    .set({ saasBillingStartsAt: startsAt })
    .where(eq(addDealForm.id, id));
  return startsAt;
}

export async function getPlatformSaasBillingStartsAt(): Promise<Date | null> {
  const alert = await getPlatformSaasBillingStartAlert();
  return alert.startsAt;
}

export async function getPlatformSaasBillingStartAlert(): Promise<{
  startsAt: Date | null;
  updatedAt: Date | null;
}> {
  return {
    startsAt: HARDCODED_SAAS_BILLING_STARTS_AT,
    updatedAt: HARDCODED_SAAS_BILLING_STARTS_AT,
  };
}

export async function getPlatformSaasBillingStartsAtIso(): Promise<
  string | null
> {
  const startsAt = await getPlatformSaasBillingStartsAt();
  return startsAt ? startsAt.toISOString() : null;
}

/**
 * Until the deal SaaS billing start date the workspace stays open.
 * After that date, unpaid / past-due / expired MRR locks view and edit.
 * Draft, archived, and liquidated are free. Stripe unset → no gate.
 */
export async function evaluateDealSaasWorkspaceAccessRefreshing(
  row: AddDealFormRow,
): Promise<{ row: AddDealFormRow; access: DealSaasAccessEvaluation }> {
  if (!row.saasBillingStartsAt) {
    void ensureDealSaasComplimentaryPeriod(row).catch((err) => {
      console.warn("ensureDealSaasComplimentaryPeriod:", row.id, err);
    });
  }
  let access = evaluateDealSaasWorkspaceAccess(row);
  if (access.locked && row.stripeSubscriptionId?.trim()) {
    try {
      const fresh = await refreshDealSaasSubscriptionFromStripe(row);
      if (fresh) {
        row = fresh;
        access = evaluateDealSaasWorkspaceAccess(fresh);
      }
    } catch (err) {
      console.warn("evaluateDealSaasWorkspaceAccessRefreshing:", row.id, err);
    }
  }
  return { row, access };
}

export function evaluateDealSaasWorkspaceAccess(
  row: Pick<
    AddDealFormRow,
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "stripeSubscriptionStatus"
    | "stripeCurrentPeriodEnd"
    | "saasBillingStartsAt"
  >,
): DealSaasAccessEvaluation {
  if (!getStripeConfig()) return { locked: false, reason: null };
  if (!isDealSaasBillable(row)) return { locked: false, reason: null };
  if (!saasBillingHasStarted(row)) return { locked: false, reason: null };

  const status = String(row.stripeSubscriptionStatus ?? "none").toLowerCase();
  const expired = periodEndHasPassed(row);
  const hasSub = Boolean(row.stripeSubscriptionId?.trim());
  const paidStatus = PAID_ACCESS_STATUSES.has(status);

  // Stripe status is the source of truth. A missing/stale period-end timestamp
  // must not keep the deal locked after the lead sponsor has paid.
  if (hasSub && paidStatus) {
    return { locked: false, reason: null };
  }
  if (hasSub && (status === "past_due" || status === "unpaid")) {
    return { locked: true, reason: "past_due" };
  }
  if (hasSub && expired) return { locked: true, reason: "expired" };
  return { locked: true, reason: "unpaid" };
}

export function dealSaasPaymentRequiredMessage(
  reason: DealSaasLockReason,
  dealName?: string | null,
): string {
  const label = String(dealName ?? "").trim()
    ? `“${String(dealName).trim()}”`
    : "this deal";
  if (reason === "expired") {
    return `The billing period for ${label} has ended. Pay monthly SaaS (MRR) to continue.`;
  }
  if (reason === "past_due") {
    return `Monthly SaaS (MRR) for ${label} is past due. Pay now to continue.`;
  }
  return `Pay monthly SaaS (MRR) for ${label} to continue.`;
}

/** Paid deal whose offering or co-sponsors now require a higher package. */
export async function dealPackageUpgradeDue(row: AddDealFormRow): Promise<{
  due: boolean;
  suggestedPlanId: StripeBillingPlanId | null;
  needsPlanUpgrade: boolean;
  needsCoGpUpgrade: boolean;
}> {
  if (!dealIsActivelyBilled(row) || !saasBillingHasStarted(row)) {
    return {
      due: false,
      suggestedPlanId: null,
      needsPlanUpgrade: false,
      needsCoGpUpgrade: false,
    };
  }
  const suggestedPlanId = await suggestedPlanIdForDeal(String(row.id));
  const needsPlanUpgrade = dealPaidPlanNeedsUpgrade(
    row.stripePlanId,
    suggestedPlanId,
  );
  const snapshot = await getDealCompanyUserSnapshot(String(row.id));
  const needsCoGpUpgrade = coGpSeatBandNeedsUpgrade(
    snapshot?.seatBand,
    snapshot?.coGpCount ?? 0,
    suggestedPlanId,
  );
  const owesPriceGap = await unpaidPackagePriceGap({
    row,
    suggestedPlanId,
    seatBand: snapshot?.seatBand,
    coGpCount: snapshot?.coGpCount ?? 0,
  });
  return {
    due: needsPlanUpgrade || needsCoGpUpgrade || owesPriceGap,
    suggestedPlanId,
    needsPlanUpgrade: needsPlanUpgrade || owesPriceGap,
    needsCoGpUpgrade,
  };
}

async function unpaidPackagePriceGap(params: {
  row: Pick<
    AddDealFormRow,
    | "stripePriceId"
    | "stripePlanId"
    | "stripeBillingCycle"
    | "stripeSeatBand"
    | "stripeSubscriptionId"
    | "saasCouponCode"
  >;
  suggestedPlanId: string | null;
  seatBand: string | null | undefined;
  coGpCount: number;
}): Promise<boolean> {
  if (!params.suggestedPlanId) return false;
  const gap = await dealSubscriptionPriceGapCents({
    stripePriceId: params.row.stripePriceId,
    stripePlanId: params.row.stripePlanId,
    stripeBillingCycle: params.row.stripeBillingCycle,
    stripeSeatBand: params.row.stripeSeatBand ?? params.seatBand,
    stripeSubscriptionId: params.row.stripeSubscriptionId,
    couponRedeemed: Boolean(String(params.row.saasCouponCode ?? "").trim()),
    nextPlanId: params.suggestedPlanId,
    nextSeatBand: suggestedSeatBandForDeal(
      params.suggestedPlanId,
      params.coGpCount,
    ),
  });
  return gap > 0;
}

function upgradeDifferenceLockMessage(dealName: string | null | undefined): string {
  const label = String(dealName ?? "").trim()
    ? `“${String(dealName).trim()}”`
    : "this deal";
  return `Pay the upgrade difference for ${label} before this deal can be opened.`;
}

export async function dealSaasLockHttpPayload(
  row: AddDealFormRow,
  extras?: { viewerIsLeadSponsor?: boolean },
): Promise<DealSaasPaymentRequiredPayload | null> {
  const evaluated = await evaluateDealSaasWorkspaceAccessRefreshing(row);
  if (evaluated.access.locked) {
    return dealSaasPaymentRequiredPayload(
      evaluated.row,
      evaluated.access,
      extras,
    );
  }
  const upgrade = await dealPackageUpgradeDue(evaluated.row);
  if (!upgrade.due) return null;
  return {
    ...dealSaasPaymentRequiredPayload(
      evaluated.row,
      { locked: true, reason: "unpaid" },
      extras,
    ),
    needsPlanUpgrade: true,
    suggestedPlanId: upgrade.suggestedPlanId,
    message: upgradeDifferenceLockMessage(evaluated.row.dealName),
  };
}

export function dealSaasPaymentRequiredPayload(
  row: AddDealFormRow,
  access?: DealSaasAccessEvaluation,
  extras?: { viewerIsLeadSponsor?: boolean },
): DealSaasPaymentRequiredPayload {
  const evaluated = access ?? evaluateDealSaasWorkspaceAccess(row);
  const reason: DealSaasLockReason = evaluated.reason ?? "unpaid";
  return {
    code: DEAL_SAAS_PAYMENT_REQUIRED,
    message: dealSaasPaymentRequiredMessage(reason, row.dealName),
    reason,
    dealId: String(row.id),
    dealName: row.dealName ?? "",
    organizationId: row.organizationId ? String(row.organizationId) : null,
    nextBillingDate: nextBillingDateForList(row),
    billingSubscriptionStatus: row.stripeSubscriptionStatus || "none",
    billingPlanId: row.stripePlanId ?? null,
    viewerIsLeadSponsor: extras?.viewerIsLeadSponsor === true,
  };
}

function nextBillingDateForList(
  row: Pick<
    AddDealFormRow,
    | "archived"
    | "dealStage"
    | "pendingDealStage"
    | "stripeSubscriptionId"
    | "stripeSubscriptionStatus"
    | "stripeCurrentPeriodEnd"
    | "saasBillingStartsAt"
  >,
): string | null {
  if (!dealShouldKeepStripeSaasSubscription(row)) return null;
  const status = String(row.stripeSubscriptionStatus ?? "none").toLowerCase();
  const activelyBilled =
    dealIsActivelyBilled(row) ||
    PAID_ACCESS_STATUSES.has(status) ||
    ACTIVE_SUB_STATUSES.has(status);
  // Hardcoded platform date is only the first due date. After the lead
  // sponsor is on a Stripe subscription, show the real current-period end.
  if (activelyBilled) {
    return periodEndIso(row);
  }
  if (!saasBillingHasStarted(row)) {
    return billingStartsAtDate(row).toISOString();
  }
  // Unpaid after the SaaS start date: due now. Do not surface a leftover
  // Stripe current_period_end as if payment is still in the complimentary window.
  return billingStartsAtDate(row).toISOString();
}

export async function dealSaasBillingListFields(
  row: AddDealFormRow,
  options?: { raiseAmount?: number },
): Promise<DealSaasBillingListFields> {
  const access = evaluateDealSaasWorkspaceAccess(row);
  if (
    isDealSaasBillable(row) &&
    !row.saasBillingStartsAt
  ) {
    void ensureDealSaasComplimentaryPeriod(row).catch((err) => {
      console.warn("ensureDealSaasComplimentaryPeriod:", row.id, err);
    });
  }
  const billable = isDealSaasBillable(row);
  const suggestedPlanId = billable
    ? await suggestedPlanIdForDeal(String(row.id), options?.raiseAmount)
    : null;
  const billed = dealIsActivelyBilled(row);
  const needsPlanUpgrade = dealShouldAlertPlanUpgrade(row, suggestedPlanId);
  let needsCoGpUpgrade = false;
  let owesPriceGap = false;
  if (billed && saasBillingHasStarted(row) && suggestedPlanId) {
    const snapshot = await getDealCompanyUserSnapshot(String(row.id));
    needsCoGpUpgrade = coGpSeatBandNeedsUpgrade(
      snapshot?.seatBand,
      snapshot?.coGpCount ?? 0,
      suggestedPlanId,
    );
    owesPriceGap = await unpaidPackagePriceGap({
      row,
      suggestedPlanId,
      seatBand: snapshot?.seatBand,
      coGpCount: snapshot?.coGpCount ?? 0,
    });
  }
  const upgradeDue = needsPlanUpgrade || needsCoGpUpgrade || owesPriceGap;
  return {
    viewerIsLeadSponsor: true,
    nextBillingDate: nextBillingDateForList(row),
    saasBillingStartsAt: billingStartsAtDate(row).toISOString(),
    billingSubscriptionStatus: row.stripeSubscriptionStatus || "none",
    billingPlanId: row.stripePlanId ?? null,
    suggestedPlanId,
    needsPlanUpgrade: upgradeDue,
    billingAccessLocked: access.locked || upgradeDue,
    billingLockReason: access.reason,
  };
}

async function subscriptionWithPeriodFields(
  sub: Stripe.Subscription,
): Promise<Stripe.Subscription> {
  if (periodEndFromSubscription(sub) && sub.items?.data?.[0]) return sub;
  if (!getStripeConfig()) return sub;
  try {
    return await getStripeClient().subscriptions.retrieve(sub.id, {
      expand: ["items.data.price"],
    });
  } catch (err) {
    console.warn("subscriptionWithPeriodFields:", sub.id, err);
    return sub;
  }
}

/**
 * After Stripe SaaS payment succeeds, move Draft → pending Capital Raising
 * (or Asset Managing) and clear `pending_deal_stage`.
 */
export async function promotePendingDealStageAfterSaasPayment(
  dealId: string,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const [deal] = await db
    .select({
      dealStage: addDealForm.dealStage,
      pendingDealStage: addDealForm.pendingDealStage,
      offeringStatus: addDealForm.offeringStatus,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!deal || !dealSaasPaymentIsComplete(deal)) return;
  const pending = normalizeDealStageCanonical(deal.pendingDealStage);
  if (!isSaasBillableDealStage(pending) || !pending) return;
  if (normalizeDealStageCanonical(deal.dealStage) === pending) {
    await db
      .update(addDealForm)
      .set({ pendingDealStage: null })
      .where(eq(addDealForm.id, id));
    return;
  }
  const offeringStatus = resolveOfferingStatusForStageChange({
    nextStage: pending,
    currentStatus: deal.offeringStatus,
  });
  const candidates =
    pending === "capital_raising"
      ? ["raising_capital", "capital_raising"]
      : ["asset_managing", "managing_asset"];
  let lastErr: unknown = null;
  for (const stage of candidates) {
    try {
      await db
        .update(addDealForm)
        .set({
          dealStage: stage,
          pendingDealStage: null,
          offeringStatus,
        })
        .where(eq(addDealForm.id, id));
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("check") || stage === candidates[candidates.length - 1]) {
        throw err;
      }
    }
  }
  if (lastErr) throw lastErr;
}

export async function dealHasRedeemedSaasCoupon(dealId: string): Promise<boolean> {
  const id = normalizeDealId(dealId);
  if (!id) return false;
  const [row] = await db
    .select({
      saasCouponCode: addDealForm.saasCouponCode,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!row) return false;
  if (String(row.saasCouponCode ?? "").trim()) return true;
  const subId = String(row.stripeSubscriptionId ?? "").trim();
  if (!subId || !getStripeConfig()) return false;
  try {
    const sub = await getStripeClient().subscriptions.retrieve(subId);
    const code = String(sub.metadata?.couponCode ?? "").trim();
    const discounted = (sub.discounts?.length ?? 0) > 0 || Boolean(code);
    if (!discounted) return false;
    await db
      .update(addDealForm)
      .set({ saasCouponCode: code || "redeemed" })
      .where(and(eq(addDealForm.id, id), isNull(addDealForm.saasCouponCode)));
    return true;
  } catch (err) {
    console.warn("dealHasRedeemedSaasCoupon:", err);
    return false;
  }
}

export async function applyStripeSubscriptionToDeal(
  dealId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const [deal] = await db
    .select({
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
      pendingDealStage: addDealForm.pendingDealStage,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (deal && !dealShouldKeepStripeSaasSubscription(deal)) {
    const status = String(sub.status ?? "").toLowerCase();
    if (status !== "canceled" && status !== "incomplete_expired") {
      await cancelStripeSubscriptionQuietly(sub.id);
    }
    await clearDealSaasSubscription(id);
    return;
  }
  const fresh = await subscriptionWithPeriodFields(sub);
  const mapped = planCycleSeatFromSubscription(fresh);
  const status = String(fresh.status ?? "none");
  const redeemedCoupon =
    String(fresh.metadata?.couponCode ?? sub.metadata?.couponCode ?? "").trim() ||
    ((fresh.discounts?.length ?? 0) > 0 ? "redeemed" : "");
  await db
    .update(addDealForm)
    .set({
      stripeSubscriptionId: fresh.id,
      stripePlanId: mapped.planId,
      stripeBillingCycle: mapped.cycle,
      stripeSubscriptionStatus: status || "none",
      stripePriceId: priceIdFromSubscription(fresh),
      stripeSeatBand: mapped.seatBand,
      stripeCurrentPeriodEnd: periodEndFromSubscription(fresh),
    })
    .where(eq(addDealForm.id, id));
  if (redeemedCoupon) {
    await db
      .update(addDealForm)
      .set({ saasCouponCode: redeemedCoupon })
      .where(and(eq(addDealForm.id, id), isNull(addDealForm.saasCouponCode)));
  }
  const extraUsers = parseExtraCompanyUsersQuantity(
    fresh.metadata?.extraCompanyUsers ?? sub.metadata?.extraCompanyUsers,
  );
  if (extraUsers > 0 && (status === "active" || status === "trialing")) {
    await creditExtraCompanyUsersPaid({
      dealId: id,
      quantity: extraUsers,
      paymentRef: fresh.id,
    });
  }
  if (PAID_ACCESS_STATUSES.has(status.toLowerCase())) {
    await promotePendingDealStageAfterSaasPayment(id);
  }
}

export async function clearDealSaasSubscription(dealId: string): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const [deal] = await db
    .select({
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
      stripeCurrentPeriodEnd: addDealForm.stripeCurrentPeriodEnd,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  const stillBillable = deal ? isDealSaasBillable(deal) : false;
  await db
    .update(addDealForm)
    .set({
      stripeSubscriptionId: null,
      stripePlanId: null,
      stripeBillingCycle: null,
      stripeSubscriptionStatus: stillBillable ? "none" : "canceled",
      stripePriceId: null,
      stripeSeatBand: null,
      stripeCurrentPeriodEnd: stillBillable
        ? (deal?.stripeCurrentPeriodEnd ?? null)
        : null,
    })
    .where(eq(addDealForm.id, id));
}

/**
 * Re-read this deal's Stripe subscription so a just-completed payment unlocks
 * the workspace even if the webhook is a few seconds behind.
 */
export async function refreshDealSaasSubscriptionFromStripe(
  deal: Pick<AddDealFormRow, "id" | "stripeSubscriptionId">,
): Promise<AddDealFormRow | null> {
  const id = normalizeDealId(String(deal.id));
  const subId = deal.stripeSubscriptionId?.trim() ?? "";
  if (!id) return null;
  const [current] = await db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!current) return null;
  if (!dealShouldKeepStripeSaasSubscription(current)) {
    if (subId) {
      await cancelStripeSubscriptionQuietly(subId);
      await clearDealSaasSubscription(id);
    }
    const [cleared] = await db
      .select()
      .from(addDealForm)
      .where(eq(addDealForm.id, id))
      .limit(1);
    return cleared ?? current;
  }
  if (!subId || !getStripeConfig()) {
    return current;
  }
  try {
    const sub = await getStripeClient().subscriptions.retrieve(subId, {
      expand: ["items.data.price"],
    });
    const status = String(sub.status ?? "").toLowerCase();
    if (status === "canceled" || status === "incomplete_expired") {
      await clearDealSaasSubscription(id);
    } else {
      await applyStripeSubscriptionToDeal(id, sub);
    }
  } catch (err) {
    console.warn("refreshDealSaasSubscriptionFromStripe:", id, subId, err);
  }
  const [row] = await db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  return row ?? null;
}

export async function refreshDealSaasSubscriptionsFromStripe(
  companyId: string,
): Promise<void> {
  const cid = normalizeDealId(companyId);
  if (!cid || !getStripeConfig()) return;
  const stripe = getStripeClient();
  const deals = await db
    .select({
      id: addDealForm.id,
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
      pendingDealStage: addDealForm.pendingDealStage,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
    })
    .from(addDealForm)
    .where(eq(addDealForm.organizationId, cid));
  for (const deal of deals) {
    const subId = deal.stripeSubscriptionId?.trim() ?? "";
    if (!dealShouldKeepStripeSaasSubscription(deal)) {
      if (subId) {
        await cancelStripeSubscriptionQuietly(subId);
        await clearDealSaasSubscription(String(deal.id));
      }
      continue;
    }
    if (!subId) continue;
    try {
      const sub = await stripe.subscriptions.retrieve(subId, {
        expand: ["items.data.price"],
      });
      const status = String(sub.status ?? "").toLowerCase();
      if (status === "canceled" || status === "incomplete_expired") {
        await clearDealSaasSubscription(String(deal.id));
      } else {
        await applyStripeSubscriptionToDeal(String(deal.id), sub);
      }
    } catch (err) {
      console.warn(
        "refreshDealSaasSubscriptionsFromStripe:",
        deal.id,
        subId,
        err,
      );
    }
  }
  await refreshCompanyBillingFromDeals(cid);
}

export async function findDealIdForStripeSubscription(
  subscriptionId: string,
): Promise<string | null> {
  const id = String(subscriptionId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: addDealForm.id, organizationId: addDealForm.organizationId })
    .from(addDealForm)
    .where(eq(addDealForm.stripeSubscriptionId, id))
    .limit(1);
  return row?.id ?? null;
}

export async function findCompanyIdForDealSubscription(
  subscriptionId: string,
): Promise<string | null> {
  const id = String(subscriptionId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ organizationId: addDealForm.organizationId })
    .from(addDealForm)
    .where(eq(addDealForm.stripeSubscriptionId, id))
    .limit(1);
  return row?.organizationId ?? null;
}

async function cancelStripeSubscriptionQuietly(
  subscriptionId: string | null | undefined,
): Promise<void> {
  const id = String(subscriptionId ?? "").trim();
  if (!id || !getStripeConfig()) return;
  try {
    const stripe = getStripeClient();
    await stripe.subscriptions.cancel(id);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code ?? "")
        : "";
    if (code !== "resource_missing") {
      console.warn("cancelStripeSubscriptionQuietly:", id, err);
    }
  }
}

async function defaultPaymentMethodId(
  stripe: Stripe,
  customerId: string,
): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) return null;
    const def = customer.invoice_settings?.default_payment_method;
    const fromInvoice =
      typeof def === "string" ? def : def && typeof def === "object" ? def.id : null;
    if (fromInvoice?.trim()) return fromInvoice.trim();
    const fromCustomer =
      typeof customer.default_source === "string"
        ? customer.default_source
        : null;
    if (fromCustomer?.startsWith("pm_")) return fromCustomer;
  } catch (err) {
    console.warn("defaultPaymentMethodId retrieve customer:", err);
  }
  try {
    const listed = await stripe.paymentMethods.list({
      customer: customerId,
      limit: 5,
    });
    const first = listed.data.find((pm) => pm.id?.startsWith("pm_"));
    return first?.id ?? null;
  } catch (err) {
    console.warn("defaultPaymentMethodId list:", err);
    return null;
  }
}

type CompanyBillingDefaults = {
  customerId: string;
  cycle: StripeBillingCycle;
  seatBand: StripeBillingSeatBand;
};

async function companyBillingDefaults(
  companyId: string,
): Promise<CompanyBillingDefaults | null> {
  const [company] = await db
    .select({
      stripeCustomerId: companies.stripeCustomerId,
      stripeBillingCycle: companies.stripeBillingCycle,
      stripePriceId: companies.stripePriceId,
      stripeSubscriptionStatus: companies.stripeSubscriptionStatus,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const customerId = company?.stripeCustomerId?.trim() ?? "";
  if (!customerId) return null;
  const status = String(company?.stripeSubscriptionStatus ?? "none").toLowerCase();
  if (status === "none" && !company?.stripePriceId) {
    // Customer may exist from a SetupIntent with no paid plan yet.
  }
  const fromPrice = planAndCycleFromPriceId(company?.stripePriceId);
  const cycle: StripeBillingCycle =
    company?.stripeBillingCycle === "annual" ||
    company?.stripeBillingCycle === "annually" ||
    company?.stripeBillingCycle === "yearly"
      ? "annual"
      : fromPrice.cycle === "annual"
        ? "annual"
        : "monthly";
  const seatBand: StripeBillingSeatBand = fromPrice.seatBand ?? "5";
  return { customerId, cycle, seatBand };
}

async function listCompanyDeals(companyId: string): Promise<AddDealFormRow[]> {
  return db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.organizationId, companyId));
}

async function attachSubscriptionMetadataToDeal(
  sub: Stripe.Subscription,
  deal: AddDealFormRow,
  extras: {
    planId: StripeBillingPlanId;
    cycle: StripeBillingCycle;
    seatBand: StripeBillingSeatBand;
  },
): Promise<Stripe.Subscription> {
  const stripe = getStripeClient();
  return stripe.subscriptions.update(sub.id, {
    metadata: {
      ...sub.metadata,
      companyId: String(deal.organizationId ?? ""),
      dealId: String(deal.id),
      dealName: deal.dealName ?? "",
      planId: extras.planId,
      billingCycle: extras.cycle,
      seatBand: extras.seatBand,
      billingScope: "deal",
    },
  });
}

export async function createDealStripeSubscription(params: {
  deal: AddDealFormRow;
  customerId: string;
  paymentMethodId: string;
  planId: StripeBillingPlanId;
  cycle: StripeBillingCycle;
  seatBand: StripeBillingSeatBand;
  payerUserId?: string;
  paymentBehavior?: Stripe.SubscriptionCreateParams.PaymentBehavior;
  extraCompanyUsers?: number;
  promotionCodeId?: string;
  couponCode?: string;
}): Promise<Stripe.Subscription | null> {
  const stripe = getStripeClient();
  const priceId = await stripePriceIdForPlatformAmount({
    stripe,
    planId: params.planId,
    cycle: params.cycle,
    seatBand: params.seatBand,
  });
  if (!priceId) {
    console.warn(
      "createDealStripeSubscription: missing price",
      params.planId,
      params.cycle,
      params.seatBand,
    );
    return null;
  }
  const snapshot = await getDealCompanyUserSnapshot(String(params.deal.id), {
    seatBand: params.seatBand,
  });
  const extraUsers = snapshot ? extraCompanyUsersToCharge(snapshot) : 0;
  const extraUserComment = snapshot
    ? descriptionForExtraCompanyUserCharge(snapshot, extraUsers)
    : extraCompanyUserChargeDescription({ quantity: extraUsers });
  const extraItem = await extraCoGpSubscriptionItem(
    stripe,
    extraUsers,
    params.cycle,
    extraUserComment,
  );
  const sub = await stripe.subscriptions.create({
      customer: params.customerId,
      items: [
        { price: priceId, quantity: 1 },
        ...(extraItem ? [extraItem] : []),
      ],
      default_payment_method: params.paymentMethodId,
      ...(params.paymentBehavior
        ? { payment_behavior: params.paymentBehavior }
        : {}),
      ...(params.promotionCodeId
        ? { discounts: [{ promotion_code: params.promotionCodeId }] }
        : {}),
      metadata: {
        companyId: String(params.deal.organizationId ?? ""),
        dealId: String(params.deal.id),
        dealName: params.deal.dealName ?? "",
        planId: params.planId,
        billingCycle: params.cycle,
        seatBand: params.seatBand,
        billingScope: "deal",
        extraCompanyUsers: String(extraUsers),
        extraUserComment: extraUserComment.slice(0, 500),
        ...(params.payerUserId ? { payerUserId: params.payerUserId } : {}),
        ...(params.couponCode ? { couponCode: params.couponCode } : {}),
      },
    });
  const subStatus = String(sub.status ?? "").toLowerCase();
  if (
    extraUsers > 0 &&
    (subStatus === "active" || subStatus === "trialing")
  ) {
    await creditExtraCompanyUsersPaid({
      dealId: String(params.deal.id),
      quantity: extraUsers,
      paymentRef: sub.id,
    });
  }
  return sub;
}

export type UpgradeDealSubscriptionResult =
  | {
      ok: true;
      subscription: Stripe.Subscription;
      hostedInvoiceUrl: string | null;
      paid: boolean;
    }
  | { ok: false; status: number; message: string };

function priceUnitAmountCents(
  price: Stripe.Price | string | null | undefined,
): number | null {
  if (!price || typeof price === "string" || typeof price.unit_amount !== "number") {
    return null;
  }
  return price.unit_amount;
}

/**
 * Charge only the catalog gap between the paid package and the new one.
 * A $1,490 Starter payment upgraded to a $1,690 package bills $200, not the full new price.
 */
async function chargePaidPlanDifference(params: {
  stripe: Stripe;
  customerId: string;
  paymentMethodId: string | null;
  amountCents: number;
  dealId: string;
  dealName: string;
  description: string;
  planId?: string;
  cycle?: string;
  seatBand?: string;
  companyId?: string;
  promotionCodeId?: string;
  extraMetadata?: Record<string, string>;
}): Promise<
  | { ok: true }
  | { ok: false; message: string; hostedInvoiceUrl?: string }
> {
  if (params.amountCents <= 0) return { ok: true };
  let oneTimePromotionCodeId = params.promotionCodeId;
  if (oneTimePromotionCodeId) {
    const promo = await params.stripe.promotionCodes.retrieve(
      oneTimePromotionCodeId,
      { expand: ["promotion.coupon"] },
    );
    const coupon = promo.promotion?.coupon;
    const duration =
      coupon && typeof coupon !== "string" ? coupon.duration : "";
    if (!couponDurationAppliesToOneTime(duration)) oneTimePromotionCodeId = undefined;
  }
  const item = await params.stripe.invoiceItems.create({
    customer: params.customerId,
    amount: params.amountCents,
    currency: "usd",
    description: params.description,
    metadata: {
      dealId: params.dealId,
      billingScope: "deal",
    },
  });
  let invoice = await params.stripe.invoices.create({
    customer: params.customerId,
    collection_method: "charge_automatically",
    auto_advance: false,
    pending_invoice_items_behavior: "include",
    ...(params.paymentMethodId
      ? { default_payment_method: params.paymentMethodId }
      : {}),
    ...(oneTimePromotionCodeId
      ? { discounts: [{ promotion_code: oneTimePromotionCodeId }] }
      : {}),
    metadata: {
      dealId: params.dealId,
      dealName: params.dealName,
      billingScope: "deal_upgrade",
      ...(params.companyId ? { companyId: params.companyId } : {}),
      ...(params.planId ? { planId: params.planId } : {}),
      ...(params.cycle ? { billingCycle: params.cycle } : {}),
      ...(params.seatBand ? { seatBand: params.seatBand } : {}),
      ...(params.extraMetadata ?? {}),
    },
  });
  invoice = await params.stripe.invoices.finalizeInvoice(invoice.id);
  if ((invoice.amount_due ?? 0) <= 0) return { ok: true };
  const hostedInvoiceUrl = () => invoice.hosted_invoice_url?.trim() || null;
  if (!params.paymentMethodId) {
    const hosted = hostedInvoiceUrl();
    if (hosted) return { ok: false, message: "", hostedInvoiceUrl: hosted };
  }
  try {
    invoice = await params.stripe.invoices.pay(invoice.id, {
      ...(params.paymentMethodId
        ? { payment_method: params.paymentMethodId }
        : {}),
    });
  } catch (err) {
    const hosted = hostedInvoiceUrl();
    if (hosted) return { ok: false, message: "", hostedInvoiceUrl: hosted };
    try {
      await params.stripe.invoiceItems.del(item.id);
    } catch (deleteErr) {
      console.warn("chargePaidPlanDifference cleanup:", deleteErr);
    }
    const message =
      err instanceof Error
        ? err.message
        : "Could not collect the upgrade difference.";
    return { ok: false, message };
  }
  if (invoice.status !== "paid" && (invoice.amount_remaining ?? 0) > 0) {
    if (!invoice.hosted_invoice_url) {
      invoice = await params.stripe.invoices.retrieve(invoice.id);
    }
    const hosted = hostedInvoiceUrl();
    if (hosted) return { ok: false, message: "", hostedInvoiceUrl: hosted };
    return {
      ok: false,
      message: "Stripe could not charge this card. Use Pay to open Stripe checkout.",
    };
  }
  return { ok: true };
}

function addUtcMonths(unixSeconds: number, months: number): number {
  const date = new Date(unixSeconds * 1000);
  const day = date.getUTCDate();
  date.setUTCMonth(date.getUTCMonth() + months);
  if (date.getUTCDate() < day) date.setUTCDate(0);
  return Math.floor(date.getTime() / 1000);
}

function scheduleIdFromSubscription(sub: Stripe.Subscription): string {
  const schedule = sub.schedule;
  if (!schedule) return "";
  return typeof schedule === "string" ? schedule : schedule.id;
}

async function recurringPriceForAmount(params: {
  stripe: Stripe;
  productId: string;
  currency: string;
  amountCents: number;
  cycle: StripeBillingCycle;
  planId: string;
  seatBand: string;
}): Promise<string> {
  const lookupKey = `sx_hold_${params.planId}_${params.seatBand}_${params.cycle}_${params.amountCents}`;
  const listed = await params.stripe.prices.list({
    lookup_keys: [lookupKey],
    limit: 1,
  });
  const existingId = listed.data[0]?.id;
  if (existingId) return existingId;
  const created = await params.stripe.prices.create({
    product: params.productId,
    currency: params.currency || "usd",
    unit_amount: params.amountCents,
    recurring: { interval: params.cycle === "annual" ? "year" : "month" },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    nickname: `${params.planId} ${params.seatBand} coupon hold`,
    metadata: {
      planId: params.planId,
      seatBand: params.seatBand,
      billingCycle: params.cycle,
      billingScope: "coupon_hold",
      platformAmountCents: String(params.amountCents),
    },
  });
  return created.id;
}

async function releaseSubscriptionSchedule(
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<void> {
  const scheduleId = scheduleIdFromSubscription(sub);
  if (!scheduleId) return;
  try {
    await stripe.subscriptionSchedules.release(scheduleId);
  } catch (err) {
    console.warn("release coupon schedule:", err);
  }
}

/** Put the subscription back if the coupon charge fails after the price schedule was created. */
export async function restoreSubscriptionToSnapshot(
  snapshot: Stripe.Subscription,
): Promise<void> {
  const stripe = getStripeClient();
  const fresh = await stripe.subscriptions.retrieve(snapshot.id);
  if (scheduleIdFromSubscription(fresh)) {
    await releaseSubscriptionSchedule(stripe, fresh);
  }
  const current = await stripe.subscriptions.retrieve(snapshot.id);
  const additions = snapshot.items.data.flatMap((item) => {
    const price = typeof item.price === "string" ? item.price : item.price?.id;
    if (!price) return [];
    return [{ price, quantity: item.quantity ?? 1 }];
  });
  if (additions.length === 0) return;
  await stripe.subscriptions.update(snapshot.id, {
    items: [
      ...current.items.data.map((item) => ({ id: item.id, deleted: true as const })),
      ...additions,
    ],
    proration_behavior: "none",
    metadata: snapshot.metadata,
  });
}

/**
 * Bill `holdPriceId` until `untilUnix`, then the catalog price.
 * The coupon already reduced the one-time difference, so this does not discount again.
 */
async function scheduleCouponHoldPrice(params: {
  stripe: Stripe;
  subscription: Stripe.Subscription;
  holdPriceId: string;
  fullPriceId: string;
  extraItems: Array<{ price: string; quantity: number }>;
  untilUnix: number;
  metadata: Stripe.MetadataParam;
}): Promise<void> {
  let scheduleId = scheduleIdFromSubscription(params.subscription);
  if (!scheduleId) {
    try {
      const created = await params.stripe.subscriptionSchedules.create({
        from_subscription: params.subscription.id,
      });
      scheduleId = created.id;
    } catch (err) {
      const fresh = await params.stripe.subscriptions.retrieve(
        params.subscription.id,
      );
      scheduleId = scheduleIdFromSubscription(fresh);
      if (!scheduleId) throw err;
    }
  }
  const schedule = await params.stripe.subscriptionSchedules.retrieve(scheduleId);
  const start =
    schedule.current_phase?.start_date ?? schedule.phases[0]?.start_date;
  if (!start) {
    throw new Error("Could not read the current subscription period.");
  }
  const end = Math.max(params.untilUnix, start + 60);
  const holdItems = [
    { price: params.holdPriceId, quantity: 1 },
    ...params.extraItems,
  ];
  const fullItems = [
    { price: params.fullPriceId, quantity: 1 },
    ...params.extraItems,
  ];
  await params.stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      {
        items: holdItems,
        start_date: start,
        end_date: end,
        proration_behavior: "none",
        discounts: "",
        metadata: params.metadata,
      },
      {
        items: fullItems,
        proration_behavior: "none",
        discounts: "",
        metadata: {
          ...params.metadata,
          couponRepeatPriceCents: "",
          couponRepeatUntil: "",
        },
      },
    ],
  });
}

/**
 * Move an existing deal subscription to the plan required by the offering and co-sponsors.
 * The lead pays the difference from the amount already paid, then the subscription renews at the new price.
 * A repeating coupon keeps the deal at the price already paid, plus any gap the coupon did not cover, for that coupon's months.
 */
export async function upgradeDealStripeSubscription(params: {
  deal: AddDealFormRow;
  planId: StripeBillingPlanId;
  cycle: StripeBillingCycle;
  seatBand: StripeBillingSeatBand;
  paymentMethodId?: string;
  promotionCodeId?: string;
  couponCode?: string;
  couponDuration?: string;
  couponDurationMonths?: number | null;
  /** Price to bill while a repeating or forever coupon is active. */
  repeatPriceCents?: number;
  percentOff?: number | null;
  amountOffCents?: number | null;
  /** False when Stripe Checkout already collected the difference. */
  collectDifference?: boolean;
}): Promise<UpgradeDealSubscriptionResult> {
  const existingId = params.deal.stripeSubscriptionId?.trim() ?? "";
  if (!existingId) {
    return {
      ok: false,
      status: 400,
      message: "This deal does not have an active subscription to upgrade.",
    };
  }

  const suggestedPlanId = await suggestedPlanIdForDeal(String(params.deal.id));
  if (billingPlanRank(params.planId) < billingPlanRank(suggestedPlanId)) {
    const label =
      suggestedPlanId.charAt(0).toUpperCase() + suggestedPlanId.slice(1);
    return {
      ok: false,
      status: 400,
      message: `${label} is the plan for this deal.`,
    };
  }
  const currentCompanyUsers = await getDealCompanyUserSnapshot(
    String(params.deal.id),
  );
  const seatUpgrade =
    coGpSeatBandNeedsUpgrade(
      currentCompanyUsers?.seatBand,
      currentCompanyUsers?.coGpCount ?? 0,
      suggestedPlanId,
    ) ||
    coGpSeatBandIsUpgrade(
      currentCompanyUsers?.seatBand ?? params.deal.stripeSeatBand,
      params.seatBand,
    );
  const samePackage =
    !dealPaidPlanNeedsUpgrade(params.deal.stripePlanId, params.planId) &&
    !seatUpgrade;

  const stripe = getStripeClient();
  const priceId = await stripePriceIdForPlatformAmount({
    stripe,
    planId: params.planId,
    cycle: params.cycle,
    seatBand: params.seatBand,
  });
  if (!priceId) {
    return {
      ok: false,
      status: 503,
      message: `Stripe Price is not configured for ${params.planId} / ${params.seatBand} seats (${params.cycle}).`,
    };
  }
  try {
    const sub = await stripe.subscriptions.retrieve(existingId, {
      expand: ["items.data.price"],
    });
    const itemId = sub.items.data[0]?.id;
    if (!itemId) {
      return {
        ok: false,
        status: 502,
        message: "Could not find the current subscription price to upgrade.",
      };
    }

    if (params.paymentMethodId?.trim()) {
      await stripe.subscriptions.update(sub.id, {
        default_payment_method: params.paymentMethodId.trim(),
      });
    }

    const companyUsers = await getDealCompanyUserSnapshot(
      String(params.deal.id),
      { seatBand: params.seatBand },
    );
    const extraUsers = companyUsers
      ? extraCompanyUsersToCharge(companyUsers)
      : 0;
    const extraUserComment = companyUsers
      ? descriptionForExtraCompanyUserCharge(companyUsers, extraUsers)
      : extraCompanyUserChargeDescription({ quantity: extraUsers });
    const replacementExtraItem = await extraCoGpSubscriptionItem(
      stripe,
      extraUsers,
      params.cycle,
      extraUserComment,
    );
    const subscriptionItems: Stripe.SubscriptionUpdateParams.Item[] = [
      { id: itemId, price: priceId },
      ...sub.items.data
        .slice(1)
        .map((item) => ({ id: item.id, deleted: true }) as const),
      ...(replacementExtraItem ? [replacementExtraItem] : []),
    ];

    const currentPrice = sub.items.data[0]?.price;
    const currentPriceId =
      typeof currentPrice === "string" ? currentPrice : currentPrice?.id;
    const paidPackage = planAndCycleFromPriceId(currentPriceId);
    const paidCatalog = catalogPackagePriceCents(
      paidPackage.planId ?? params.deal.stripePlanId,
      paidPackage.cycle ?? params.cycle,
      paidPackage.seatBand ?? "5",
    );
    const nextCatalog = catalogPackagePriceCents(
      params.planId,
      params.cycle,
      params.seatBand,
    );
    const sameCycle =
      !paidPackage.cycle || paidPackage.cycle === params.cycle;
    const currentCents = priceUnitAmountCents(currentPrice);
    const nextPrice = await stripe.prices.retrieve(priceId);
    const nextCents = priceUnitAmountCents(nextPrice);
    const paidCents =
      currentCents != null && currentCents > 0 ? currentCents : paidCatalog;
    const nextAmount = nextCatalog ?? nextCents;
    const differenceCents = sameCycle
      ? priceGapCents(paidCents, nextAmount)
      : currentCents == null || nextCents == null
        ? null
        : Math.max(0, nextCents - currentCents);
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
    const paymentMethodId =
      params.paymentMethodId?.trim() ||
      (typeof sub.default_payment_method === "string"
        ? sub.default_payment_method
        : sub.default_payment_method?.id) ||
      null;
    const couponDuration = String(params.couponDuration ?? "").trim();
    const repeatingCoupon =
      couponDuration === "repeating" || couponDuration === "forever";
    const pricedGap =
      repeatingCoupon && differenceCents != null && paidCents != null
        ? differenceRepeatPriceCents({
            paidCents,
            differenceCents,
            percentOff: params.percentOff,
            amountOffCents: params.amountOffCents,
          })
        : null;
    const requestedHold =
      params.repeatPriceCents != null && Number.isFinite(params.repeatPriceCents)
        ? Math.max(0, Math.round(params.repeatPriceCents))
        : pricedGap?.repeatPriceCents;
    const holdCents =
      repeatingCoupon && requestedHold != null ? requestedHold : null;
    const holdMonths =
      couponDuration === "repeating" &&
      params.couponDurationMonths != null &&
      params.couponDurationMonths > 0
        ? Math.round(params.couponDurationMonths)
        : null;
    const useHold =
      holdCents != null &&
      nextAmount != null &&
      holdCents !== nextAmount &&
      (couponDuration === "forever" || holdMonths != null);
    if (
      samePackage &&
      !(differenceCents != null && differenceCents > 0) &&
      !useHold
    ) {
      return {
        ok: false,
        status: 409,
        message:
          "This deal is already on the offering and Co-Sponsor package selected.",
      };
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const storedUntil = Number(sub.metadata?.couponRepeatUntil ?? "");
    const sameWindow =
      useHold &&
      String(sub.metadata?.couponCode ?? "") === String(params.couponCode ?? "") &&
      Number(sub.metadata?.couponRepeatPriceCents ?? "") === holdCents &&
      Number.isFinite(storedUntil) &&
      storedUntil > nowUnix;
    const holdUntil =
      useHold && couponDuration === "repeating" && holdMonths
        ? sameWindow
          ? storedUntil
          : addUtcMonths(nowUnix, holdMonths)
        : null;
    const couponMetadata: Stripe.MetadataParam = {
      couponRepeatPriceCents:
        useHold && holdCents != null ? String(holdCents) : "",
      couponRepeatUntil:
        couponDuration === "forever" && useHold
          ? "forever"
          : holdUntil
            ? String(holdUntil)
            : "",
    };
    const chargeDifference =
      params.collectDifference !== false &&
      differenceCents != null &&
      differenceCents > 0 &&
      Boolean(customerId);
    const couponOnOneTimeInvoice =
      Boolean(params.promotionCodeId) && couponDuration === "once";
    const discountedDue =
      differenceCents == null
        ? null
        : differenceRepeatPriceCents({
            paidCents: paidCents ?? 0,
            differenceCents,
            percentOff: params.percentOff,
            amountOffCents: params.amountOffCents,
          }).discountedDifferenceCents;
    const couponChargeCents =
      !params.promotionCodeId || differenceCents == null
        ? differenceCents
        : !couponOnOneTimeInvoice
          ? discountedDue
          : params.percentOff === 100
            ? differenceCents
            : couponCheckoutLineCents({
                dueCents: discountedDue ?? 0,
                percentOff: params.percentOff,
                amountOffCents: params.amountOffCents,
              });
    if (chargeDifference && !useHold && couponChargeCents != null) {
      const charged = await chargePaidPlanDifference({
        stripe,
        customerId,
        paymentMethodId,
        amountCents: couponChargeCents,
        dealId: String(params.deal.id),
        dealName: params.deal.dealName ?? "",
        description: `Upgrade difference for ${params.deal.dealName ?? "this deal"}`,
        planId: params.planId,
        cycle: params.cycle,
        seatBand: params.seatBand,
        companyId: String(params.deal.organizationId ?? ""),
        ...(couponOnOneTimeInvoice && params.promotionCodeId
          ? { promotionCodeId: params.promotionCodeId }
          : {}),
        extraMetadata: {
          ...(couponDuration ? { couponDuration } : {}),
          ...(holdMonths ? { couponDurationMonths: String(holdMonths) } : {}),
          ...(useHold && holdCents != null
            ? { repeatPriceCents: String(holdCents) }
            : {}),
          ...(params.couponCode ? { couponCode: params.couponCode } : {}),
        },
      });
      if (!charged.ok) {
        if (charged.hostedInvoiceUrl) {
          return {
            ok: true,
            subscription: sub,
            hostedInvoiceUrl: charged.hostedInvoiceUrl,
            paid: false,
          };
        }
        return { ok: false, status: 402, message: charged.message };
      }
    }

    let billedPriceId = priceId;
    if (useHold && holdCents != null) {
      const productRef = nextPrice.product;
      const productId =
        typeof productRef === "string"
          ? productRef
          : productRef && "id" in productRef
            ? productRef.id
            : "";
      if (productId) {
        billedPriceId = await recurringPriceForAmount({
          stripe,
          productId,
          currency: nextPrice.currency || "usd",
          amountCents: holdCents,
          cycle: params.cycle,
          planId: params.planId,
          seatBand: params.seatBand,
        });
        subscriptionItems[0] = { id: itemId, price: billedPriceId };
      }
    }
    const couponAppliesToDifference = Boolean(
      params.promotionCodeId || params.couponCode || params.couponDuration,
    );
    const keepCouponOffSubscription =
      useHold ||
      (couponAppliesToDifference &&
        differenceCents != null &&
        differenceCents > 0);
    const subscriptionMetadata: Stripe.MetadataParam = {
      ...sub.metadata,
      dealId: String(params.deal.id),
      dealName: params.deal.dealName ?? "",
      planId: params.planId,
      billingCycle: params.cycle,
      seatBand: params.seatBand,
      billingScope: "deal",
      extraCompanyUsers: String(extraUsers),
      extraUserComment: extraUserComment.slice(0, 500),
      ...(params.couponCode ? { couponCode: params.couponCode } : {}),
      ...couponMetadata,
    };
    const extraPhaseItems = subscriptionItems.flatMap((item) => {
      if (!("price" in item) || !item.price || item.price === billedPriceId) {
        return [];
      }
      const quantity = "quantity" in item && item.quantity ? item.quantity : 1;
      return [{ price: item.price, quantity }];
    });
    let updated: Stripe.Subscription;
    if (useHold && holdUntil && billedPriceId !== priceId) {
      await scheduleCouponHoldPrice({
        stripe,
        subscription: sub,
        holdPriceId: billedPriceId,
        fullPriceId: priceId,
        extraItems: extraPhaseItems,
        untilUnix: holdUntil,
        metadata: subscriptionMetadata,
      });
      updated = await stripe.subscriptions.update(sub.id, {
        metadata: subscriptionMetadata,
        expand: ["latest_invoice"],
      });
    } else {
      if (scheduleIdFromSubscription(sub)) {
        await releaseSubscriptionSchedule(stripe, sub);
      }
      updated = await stripe.subscriptions.update(sub.id, {
        items: subscriptionItems,
        proration_behavior: differenceCents == null ? "always_invoice" : "none",
        payment_behavior: "pending_if_incomplete",
        ...(keepCouponOffSubscription || !couponOnOneTimeInvoice
          ? { discounts: "" }
          : params.promotionCodeId
            ? { discounts: [{ promotion_code: params.promotionCodeId }] }
            : {}),
        metadata: subscriptionMetadata,
        expand: ["latest_invoice"],
      });
    }

  if (chargeDifference && useHold && differenceCents != null && customerId && couponChargeCents != null) {
      const charged = await chargePaidPlanDifference({
        stripe,
        customerId,
        paymentMethodId,
        amountCents: couponChargeCents,
        dealId: String(params.deal.id),
        dealName: params.deal.dealName ?? "",
        description: `Upgrade difference for ${params.deal.dealName ?? "this deal"}`,
        planId: params.planId,
        cycle: params.cycle,
        seatBand: params.seatBand,
        companyId: String(params.deal.organizationId ?? ""),
        ...(couponOnOneTimeInvoice && params.promotionCodeId
          ? { promotionCodeId: params.promotionCodeId }
          : {}),
        extraMetadata: {
          ...(couponDuration ? { couponDuration } : {}),
          ...(holdMonths ? { couponDurationMonths: String(holdMonths) } : {}),
          ...(holdCents != null ? { repeatPriceCents: String(holdCents) } : {}),
          ...(params.couponCode ? { couponCode: params.couponCode } : {}),
        },
      });
      if (!charged.ok) {
        try {
          await restoreSubscriptionToSnapshot(sub);
        } catch (restoreErr) {
          console.warn("restore subscription after coupon charge:", restoreErr);
        }
        if (charged.hostedInvoiceUrl) {
          return {
            ok: true,
            subscription: sub,
            hostedInvoiceUrl: charged.hostedInvoiceUrl,
            paid: false,
          };
        }
        return { ok: false, status: 402, message: charged.message };
      }
    }

    let invoice: Stripe.Invoice | null =
      updated.latest_invoice && typeof updated.latest_invoice === "object"
        ? updated.latest_invoice
        : null;
    if (!invoice && typeof updated.latest_invoice === "string") {
      invoice = await stripe.invoices.retrieve(updated.latest_invoice);
    }

    let hostedInvoiceUrl: string | null =
      invoice?.hosted_invoice_url?.trim() || null;
    let paid = String(updated.status ?? "").toLowerCase() === "active" ||
      String(updated.status ?? "").toLowerCase() === "trialing";

    if (invoice && (invoice.status === "draft" || invoice.status === "open")) {
      if (invoice.status === "draft") {
        invoice = await stripe.invoices.finalizeInvoice(invoice.id);
        hostedInvoiceUrl = invoice.hosted_invoice_url?.trim() || hostedInvoiceUrl;
      }
      if (invoice.status === "open" && (invoice.amount_due ?? 0) > 0) {
        try {
          invoice = await stripe.invoices.pay(invoice.id);
          paid =
            invoice.status === "paid" ||
            invoice.amount_remaining === 0;
          hostedInvoiceUrl =
            invoice.hosted_invoice_url?.trim() || hostedInvoiceUrl;
        } catch (payErr) {
          console.warn("upgradeDealStripeSubscription invoice pay:", payErr);
          paid = false;
          hostedInvoiceUrl =
            invoice.hosted_invoice_url?.trim() || hostedInvoiceUrl;
        }
      } else if ((invoice.amount_due ?? 0) <= 0) {
        paid = true;
      }
    }

    const fresh = await stripe.subscriptions.retrieve(updated.id);
    await applyStripeSubscriptionToDeal(String(params.deal.id), fresh);
    return {
      ok: true,
      subscription: fresh,
      hostedInvoiceUrl: paid ? null : hostedInvoiceUrl,
      paid,
    };
  } catch (err) {
    console.error("upgradeDealStripeSubscription:", err);
    const raw =
      err instanceof Error ? err.message : "Could not upgrade this deal’s plan.";
    const text = raw.toLowerCase();
    const msg = text.includes("cannot be applied to one-time")
      ? "A repeating coupon applies to the subscription. The difference due is already reduced."
      : raw;
    return { ok: false, status: 502, message: msg };
  }
}

/**
 * Keep the current paid period unchanged while selecting the offering-size
 * tier that Stripe will charge at the next renewal.
 */
export async function alignDealPlanForNextRenewal(
  deal: AddDealFormRow,
  planId: StripeBillingPlanId,
  seatBand?: StripeBillingSeatBand,
): Promise<void> {
  const subscriptionId = deal.stripeSubscriptionId?.trim() ?? "";
  if (!subscriptionId || !getStripeConfig()) return;

  const stripe = getStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });
  const mapped = planCycleSeatFromSubscription(sub);
  const cycle =
    mapped.cycle ??
    normalizeDealBillingCycle(deal.stripeBillingCycle) ??
    "monthly";
  const resolvedSeat = seatBand ?? mapped.seatBand ?? "5";
  const nextPriceId = resolveStripePriceId(planId, cycle, resolvedSeat);
  const mainItem = sub.items.data[0];
  if (!nextPriceId || !mainItem) {
    throw new Error(
      `Stripe Price is not configured for ${planId} / ${resolvedSeat} seats (${cycle}).`,
    );
  }

  if (priceIdFromSubscription(sub) === nextPriceId) {
    if (normalizeBillingPlanId(deal.stripePlanId) !== planId) {
      await applyStripeSubscriptionToDeal(String(deal.id), sub);
    }
    return;
  }

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: mainItem.id, price: nextPriceId }],
    proration_behavior: "none",
    metadata: {
      ...sub.metadata,
      planId,
      billingCycle: cycle,
      seatBand: resolvedSeat,
    },
  });
  await applyStripeSubscriptionToDeal(String(deal.id), updated);
}

const PACKAGE_SEAT_RANK: Record<StripeBillingSeatBand, number> = {
  "5": 1,
  "10": 2,
  "10plus": 3,
};

/**
 * A paid cycle keeps its current price. A smaller plan or Co-Sponsor package
 * starts on the invoice after this period ends.
 */
async function schedulePackageChangeAtPeriodEnd(
  deal: AddDealFormRow,
  planId: StripeBillingPlanId,
  seatBand: StripeBillingSeatBand,
): Promise<void> {
  const subscriptionId = deal.stripeSubscriptionId?.trim() ?? "";
  if (!subscriptionId || !getStripeConfig()) return;
  const stripe = getStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });
  const periodEnd = periodEndFromSubscription(sub);
  const periodEndUnix = periodEnd ? Math.floor(periodEnd.getTime() / 1000) : 0;
  const nowUnix = Math.floor(Date.now() / 1000);
  if (!periodEndUnix || periodEndUnix <= nowUnix + 30) {
    await alignDealPlanForNextRenewal(deal, planId, seatBand);
    return;
  }
  if (String(sub.metadata?.couponRepeatUntil ?? "").trim()) return;

  const mapped = planCycleSeatFromSubscription(sub);
  const cycle =
    mapped.cycle ??
    normalizeDealBillingCycle(deal.stripeBillingCycle) ??
    "monthly";
  const nextPriceId =
    (await stripePriceIdForPlatformAmount({
      stripe,
      planId,
      cycle,
      seatBand,
    })) ?? resolveStripePriceId(planId, cycle, seatBand);
  const currentPriceId = priceIdFromSubscription(sub);
  if (!nextPriceId || !currentPriceId || nextPriceId === currentPriceId) return;

  const currentItems = sub.items.data.flatMap((item) => {
    const price = typeof item.price === "string" ? item.price : item.price?.id;
    if (!price) return [];
    return [{ price, quantity: item.quantity ?? 1 }];
  });
  if (currentItems.length === 0) return;
  const nextItems = currentItems.map((item, index) =>
    index === 0 ? { price: nextPriceId, quantity: item.quantity } : item,
  );

  let scheduleId = scheduleIdFromSubscription(sub);
  if (!scheduleId) {
    try {
      const created = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
      });
      scheduleId = created.id;
    } catch (err) {
      const fresh = await stripe.subscriptions.retrieve(sub.id);
      scheduleId = scheduleIdFromSubscription(fresh);
      if (!scheduleId) throw err;
    }
  }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const start =
    schedule.current_phase?.start_date ?? schedule.phases[0]?.start_date;
  if (!start) return;
  const end = Math.max(periodEndUnix, start + 60);
  const upcoming = schedule.phases[1]?.items?.[0]?.price;
  const upcomingId = typeof upcoming === "string" ? upcoming : upcoming?.id;
  if (upcomingId === nextPriceId && schedule.phases[0]?.end_date === end) return;

  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      {
        items: currentItems,
        start_date: start,
        end_date: end,
        proration_behavior: "none",
      },
      {
        items: nextItems,
        proration_behavior: "none",
        metadata: {
          ...sub.metadata,
          planId,
          billingCycle: cycle,
          seatBand,
        },
      },
    ],
  });
}

/**
 * Start, stop, or realign this deal's SaaS subscription.
 * Archived / draft / liquidated deals drop MRR even when Stripe is unset.
 */
export async function syncDealSaasBillingForDeal(
  dealId: string,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const [deal] = await db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!deal) return;

  if (!dealShouldKeepStripeSaasSubscription(deal)) {
    if (deal.stripeSubscriptionId?.trim()) {
      await cancelStripeSubscriptionQuietly(deal.stripeSubscriptionId);
      await clearDealSaasSubscription(id);
    } else if (
      deal.stripeCurrentPeriodEnd ||
      (deal.stripeSubscriptionStatus &&
        deal.stripeSubscriptionStatus !== "canceled" &&
        deal.stripeSubscriptionStatus !== "none")
    ) {
      await clearDealSaasSubscription(id);
    }
    const orgId = String(deal.organizationId ?? "").trim();
    if (orgId) await refreshCompanyBillingFromDeals(orgId);
    return;
  }

  const suggested = await suggestedPlanIdForDeal(id);
  if (dealIsActivelyBilled(deal)) {
    const paidPlan = normalizeBillingPlanId(deal.stripePlanId);
    const paidSeat = normalizeBillingSeatBand(deal.stripeSeatBand) ?? "5";
    const nextSeat = suggestedSeatBandForDeal(
      suggested,
      await countDealCoGps(id),
    );
    const planLower = billingPlanRank(suggested) < billingPlanRank(paidPlan);
    const seatLower = PACKAGE_SEAT_RANK[nextSeat] < PACKAGE_SEAT_RANK[paidSeat];
    const planHigher = billingPlanRank(suggested) > billingPlanRank(paidPlan);
    const seatHigher = PACKAGE_SEAT_RANK[nextSeat] > PACKAGE_SEAT_RANK[paidSeat];
    if ((planLower || seatLower) && !planHigher && !seatHigher) {
      await schedulePackageChangeAtPeriodEnd(deal, suggested, nextSeat);
    } else if (paidPlan !== suggested) {
      await alignDealPlanForNextRenewal(deal, suggested);
    }
  } else {
    if (normalizeBillingPlanId(deal.stripePlanId) !== suggested) {
      await db
        .update(addDealForm)
        .set({ stripePlanId: suggested })
        .where(eq(addDealForm.id, id));
    }
  }

  if (!getStripeConfig()) return;

  await ensureDealSaasComplimentaryPeriod(deal);

  const orgId = String(deal.organizationId ?? "").trim();
  if (!orgId) return;
  await syncCompanyDealSaasSubscriptions(orgId);
}

export function scheduleDealSaasBillingSync(dealId: string): void {
  const id = String(dealId ?? "").trim();
  if (!id) return;
  void syncDealSaasBillingForDeal(id)
    .then(() => notifyLeadSponsorsIfPaidPlanTooSmall(id))
    .catch((err) => {
      console.warn("scheduleDealSaasBillingSync:", id, err);
    });
}

async function notifyLeadSponsorsIfPaidPlanTooSmall(
  dealId: string,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const [deal] = await db
    .select({
      id: addDealForm.id,
      dealName: addDealForm.dealName,
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
      stripePlanId: addDealForm.stripePlanId,
      saasBillingStartsAt: addDealForm.saasBillingStartsAt,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!deal) return;
  const suggested = await suggestedPlanIdForDeal(id);
  if (!dealShouldAlertPlanUpgrade(deal, suggested)) return;
  await notifyLeadSponsorsOfDealPlanUpgrade({
    dealId: id,
    dealName: deal.dealName ?? "",
    currentPlanId: String(deal.stripePlanId ?? ""),
    suggestedPlanId: suggested,
  });
}

export async function cancelDealSaasBillingBeforeDelete(
  dealId: string,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id || !getStripeConfig()) return;
  const [deal] = await db
    .select({
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (deal?.stripeSubscriptionId?.trim()) {
    await cancelStripeSubscriptionQuietly(deal.stripeSubscriptionId);
  }
}

/**
 * Align Stripe subscriptions with the company's currently billable deals.
 * Reuses an unassigned company-level subscription for the first billable deal.
 */
export async function syncCompanyDealSaasSubscriptions(
  companyId: string,
): Promise<void> {
  const cid = normalizeDealId(companyId);
  if (!cid || !getStripeConfig()) return;

  const defaults = await companyBillingDefaults(cid);
  if (!defaults) return;

  const stripe = getStripeClient();
  const deals = await listCompanyDeals(cid);
  const billable = deals.filter((d) => isDealSaasBillable(d));
  const notBillable = deals.filter(
    (d) => !dealShouldKeepStripeSaasSubscription(d),
  );

  for (const deal of notBillable) {
    if (!deal.stripeSubscriptionId?.trim()) continue;
    await cancelStripeSubscriptionQuietly(deal.stripeSubscriptionId);
    await clearDealSaasSubscription(String(deal.id));
  }

  const [company] = await db
    .select({
      stripeSubscriptionId: companies.stripeSubscriptionId,
      stripeSubscriptionStatus: companies.stripeSubscriptionStatus,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);

  let unassignedSub: Stripe.Subscription | null = null;
  const companySubId = company?.stripeSubscriptionId?.trim() ?? "";
  if (companySubId) {
    const claimed = billable.some(
      (d) => d.stripeSubscriptionId?.trim() === companySubId,
    );
    if (!claimed) {
      try {
        const sub = await stripe.subscriptions.retrieve(companySubId);
        const metaDeal = normalizeDealId(sub.metadata?.dealId);
        const alreadyOnADeal = billable.some(
          (d) => String(d.id) === (metaDeal ?? ""),
        );
        if (
          !sub.status ||
          ["canceled", "incomplete_expired", "unpaid"].includes(sub.status)
        ) {
          unassignedSub = null;
        } else if (!metaDeal || !alreadyOnADeal) {
          unassignedSub = sub;
        }
      } catch (err) {
        console.warn("syncCompanyDealSaasSubscriptions retrieve company sub:", err);
      }
    }
  }

  for (const deal of billable) {
    const raise = await raiseAmountForDeal(String(deal.id));
    const planId = await suggestedPlanIdForDeal(String(deal.id), raise);
    const existingId = deal.stripeSubscriptionId?.trim() ?? "";

    if (existingId) {
      try {
        const sub = await stripe.subscriptions.retrieve(existingId);
        if (sub.status === "canceled" || sub.status === "incomplete_expired") {
          await clearDealSaasSubscription(String(deal.id));
        } else {
          const mapped = planCycleSeatFromSubscription(sub);
          if (!normalizeDealId(sub.metadata?.dealId)) {
            await attachSubscriptionMetadataToDeal(sub, deal, {
              planId: mapped.planId ?? planId,
              cycle: mapped.cycle ?? defaults.cycle,
              seatBand: mapped.seatBand ?? defaults.seatBand,
            });
          }
          const fresh = await stripe.subscriptions.retrieve(existingId);
          await applyStripeSubscriptionToDeal(String(deal.id), fresh);
          continue;
        }
      } catch (err) {
        console.warn("syncCompanyDealSaasSubscriptions existing sub:", err);
        await clearDealSaasSubscription(String(deal.id));
      }
    }

    if (unassignedSub) {
      const metaDealId = normalizeDealId(unassignedSub.metadata?.dealId);
      if (metaDealId && metaDealId !== String(deal.id)) {
        continue;
      }
      if (!metaDealId) {
        // Legacy company-level checkout: attach once, then stop. Additional
        // deals are paid by their lead sponsor via Checkout.
        continue;
      }
      const mapped = planCycleSeatFromSubscription(unassignedSub);
      const updated = await attachSubscriptionMetadataToDeal(
        unassignedSub,
        deal,
        {
          planId,
          cycle: mapped.cycle ?? defaults.cycle,
          seatBand: mapped.seatBand ?? defaults.seatBand,
        },
      );
      const priceId = await stripePriceIdForPlatformAmount({
        stripe,
        planId,
        cycle: mapped.cycle ?? defaults.cycle,
        seatBand: mapped.seatBand ?? defaults.seatBand,
      });
      const currentPrice = priceIdFromSubscription(updated);
      if (priceId && currentPrice && priceId !== currentPrice) {
        const itemId = updated.items.data[0]?.id;
        if (itemId) {
          await stripe.subscriptions.update(updated.id, {
            items: [{ id: itemId, price: priceId }],
            proration_behavior: "none",
          });
        }
      }
      const fresh = await stripe.subscriptions.retrieve(updated.id);
      await applyStripeSubscriptionToDeal(String(deal.id), fresh);
      unassignedSub = null;
      continue;
    }

    // Lead sponsors pay MRR per deal via Checkout — do not auto-charge the
    // company default payment method for new billable deals.
    await ensureDealSaasComplimentaryPeriod(deal);
  }

  await refreshCompanyBillingFromDeals(cid);
}

export async function refreshCompanyBillingFromDeals(
  companyId: string,
): Promise<void> {
  const cid = normalizeDealId(companyId);
  if (!cid) return;
  const deals = await db
    .select({
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
      stripeCurrentPeriodEnd: addDealForm.stripeCurrentPeriodEnd,
      stripePlanId: addDealForm.stripePlanId,
      stripeBillingCycle: addDealForm.stripeBillingCycle,
      stripePriceId: addDealForm.stripePriceId,
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
    })
    .from(addDealForm)
    .where(
      and(
        eq(addDealForm.organizationId, cid),
        isNotNull(addDealForm.stripeSubscriptionId),
        ne(addDealForm.stripeSubscriptionId, ""),
      ),
    );

  const billed = deals.filter((d) => isDealSaasBillable(d));
  const rank = (status: string): number => {
    switch (String(status ?? "").toLowerCase()) {
      case "unpaid":
        return 80;
      case "past_due":
        return 70;
      case "incomplete":
        return 60;
      case "paused":
        return 50;
      case "trialing":
        return 40;
      case "active":
        return 30;
      case "canceled":
        return 10;
      default:
        return 0;
    }
  };
  let worstStatus = "none";
  let worstRank = -1;
  let earliestEnd: Date | null = null;
  let firstSubId: string | null = null;
  for (const d of billed) {
    const st = String(d.stripeSubscriptionStatus ?? "none");
    const r = rank(st);
    if (r > worstRank) {
      worstRank = r;
      worstStatus = st;
    }
    if (d.stripeCurrentPeriodEnd) {
      if (!earliestEnd || d.stripeCurrentPeriodEnd < earliestEnd) {
        earliestEnd = d.stripeCurrentPeriodEnd;
      }
    }
    if (!firstSubId && d.stripeSubscriptionId?.trim()) {
      firstSubId = d.stripeSubscriptionId.trim();
    }
  }

  const [company] = await db
    .select({
      stripeSubscriptionId: companies.stripeSubscriptionId,
      stripeSubscriptionStatus: companies.stripeSubscriptionStatus,
      stripeCurrentPeriodEnd: companies.stripeCurrentPeriodEnd,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!company) return;

  const companySubStillOnADeal = billed.some(
    (d) => d.stripeSubscriptionId?.trim() === company.stripeSubscriptionId?.trim(),
  );

  await db
    .update(companies)
    .set({
      ...(firstSubId &&
      (!company.stripeSubscriptionId?.trim() || !companySubStillOnADeal)
        ? { stripeSubscriptionId: firstSubId }
        : {}),
      ...(worstRank >= 0
        ? { stripeSubscriptionStatus: worstStatus || "none" }
        : {}),
      ...(earliestEnd ? { stripeCurrentPeriodEnd: earliestEnd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, cid));
}

export type DealBillingListRow = {
  id: string;
  companyId: string;
  companyName: string;
  dealName: string;
  dealStage: string;
  archived: boolean;
  planId: string | null;
  suggestedPlanId: string | null;
  needsPlanUpgrade: boolean;
  suggestedSeatBand: StripeBillingSeatBand;
  needsCoGpUpgrade: boolean;
  billingCycle: string | null;
  subscriptionStatus: string;
  nextBillingDate: string | null;
  saasBillingStartsAt: string | null;
  billed: boolean;
  billable: boolean;
  /** Draft with a pending CR/AM stage can still be paid on Pricing. */
  payable: boolean;
  includedCompanyUsers: number;
  currentCompanyUsers: number;
  extraCompanyUsersPaid: number;
  extraCompanyUsersDue: number;
  coGpCount: number;
  seatBand: string | null;
  includedCoGps: number | null;
  extraUserFeeCents: number;
  extraUserComment: string;
  couponRedeemed: boolean;
  /** Cents already charged on the current subscription price. */
  amountPaidCents: number | null;
};

type DealBillingQueryRow = Pick<
  AddDealFormRow,
  | "id"
  | "dealName"
  | "dealStage"
  | "archived"
  | "stripeSubscriptionId"
  | "stripePriceId"
  | "stripePlanId"
  | "stripeBillingCycle"
  | "stripeSubscriptionStatus"
  | "stripeCurrentPeriodEnd"
    | "saasBillingStartsAt"
    | "organizationId"
    | "pendingDealStage"
    | "saasCouponCode"
  > & { companyName: string | null };

const dealBillingSelect = {
  id: addDealForm.id,
  dealName: addDealForm.dealName,
  dealStage: addDealForm.dealStage,
  archived: addDealForm.archived,
  stripeSubscriptionId: addDealForm.stripeSubscriptionId,
  stripePriceId: addDealForm.stripePriceId,
  stripePlanId: addDealForm.stripePlanId,
  stripeBillingCycle: addDealForm.stripeBillingCycle,
  stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
  stripeCurrentPeriodEnd: addDealForm.stripeCurrentPeriodEnd,
  saasBillingStartsAt: addDealForm.saasBillingStartsAt,
  pendingDealStage: addDealForm.pendingDealStage,
  saasCouponCode: addDealForm.saasCouponCode,
  organizationId: addDealForm.organizationId,
  companyName: companies.name,
};

function dealIsActivelyBilled(
  row: Pick<
    AddDealFormRow,
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "stripeSubscriptionStatus"
  >,
): boolean {
  return (
    isDealSaasBillable(row) &&
    Boolean(row.stripeSubscriptionId?.trim()) &&
    ACTIVE_SUB_STATUSES.has(
      String(row.stripeSubscriptionStatus ?? "none").toLowerCase(),
    )
  );
}

/**
 * Deal ids in this company where the viewer is Lead Sponsor.
 */
export async function listLeadSponsorDealIdsInCompany(
  userId: string,
  companyId: string,
): Promise<string[]> {
  const cid = normalizeDealId(companyId);
  if (!cid) return [];
  const leadIds = await listDealIdsWhereViewerIsLeadSponsor(userId);
  if (leadIds.length === 0) return [];
  const rows = await db
    .select({ id: addDealForm.id })
    .from(addDealForm)
    .where(
      and(eq(addDealForm.organizationId, cid), inArray(addDealForm.id, leadIds)),
    );
  return rows.map((r) => String(r.id));
}

export async function mapStripeSubscriptionsToDeals(
  companyId: string,
  dealIdFilter?: string[] | null,
): Promise<Map<string, { dealId: string; dealName: string }>> {
  const cid = normalizeDealId(companyId);
  const map = new Map<string, { dealId: string; dealName: string }>();
  if (!cid) return map;
  if (dealIdFilter && dealIdFilter.length === 0) return map;

  const conditions = [
    eq(addDealForm.organizationId, cid),
    isNotNull(addDealForm.stripeSubscriptionId),
  ];
  if (dealIdFilter && dealIdFilter.length > 0) {
    conditions.push(inArray(addDealForm.id, dealIdFilter));
  }

  const rows = await db
    .select({
      id: addDealForm.id,
      dealName: addDealForm.dealName,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
    })
    .from(addDealForm)
    .where(and(...conditions));

  for (const row of rows) {
    const sub = row.stripeSubscriptionId?.trim();
    if (!sub) continue;
    map.set(sub, { dealId: String(row.id), dealName: row.dealName ?? "" });
  }
  return map;
}

async function subscribedUnitAmounts(
  priceIds: Array<string | null | undefined>,
): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  if (!getStripeConfig()) return amounts;
  const ids = [
    ...new Set(
      priceIds.map((id) => String(id ?? "").trim()).filter((id) => id.startsWith("price_")),
    ),
  ];
  if (ids.length === 0) return amounts;
  const stripe = getStripeClient();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const price = await stripe.prices.retrieve(id);
        if (typeof price.unit_amount === "number" && price.unit_amount > 0) {
          amounts.set(id, price.unit_amount);
        }
      } catch (err) {
        console.warn("subscribedUnitAmounts:", err);
      }
    }),
  );
  return amounts;
}

async function mapDealBillingQueryRows(
  rows: DealBillingQueryRow[],
): Promise<DealBillingListRow[]> {
  const paidByPriceId = await subscribedUnitAmounts(
    rows.map((row) => row.stripePriceId),
  );
  const paidBySubscription = await collectedInvoiceCentsBySubscription(
    rows.map((row) => row.stripeSubscriptionId),
  );
  const list: DealBillingListRow[] = [];
  for (const row of rows) {
    const saasBillingStartsAt =
      (await ensureDealSaasComplimentaryPeriod(row)) ?? row.saasBillingStartsAt;
    const dated = { ...row, saasBillingStartsAt };
    const billed = dealIsActivelyBilled(dated);
    const billable = isDealSaasBillable(dated);
    const payable =
      billable ||
      (!dated.archived && isSaasBillableDealStage(row.pendingDealStage));
    const raise = payable ? await raiseAmountForDeal(String(row.id)) : 0;
    const companyUsers = payable
      ? await getDealCompanyUserSnapshot(String(row.id))
      : null;
    const suggestedPlanId = payable
      ? economicPlanIdForDeal(raise, companyUsers?.coGpCount ?? 0)
      : null;
    if (
      !billed &&
      suggestedPlanId &&
      normalizeBillingPlanId(row.stripePlanId) !== suggestedPlanId
    ) {
      await db
        .update(addDealForm)
        .set({ stripePlanId: suggestedPlanId })
        .where(eq(addDealForm.id, row.id));
    }
    const currentSeatBand =
      normalizeBillingSeatBand(companyUsers?.seatBand) ?? "5";
    const suggestedSeatBand = suggestedSeatBandForDeal(
      suggestedPlanId,
      companyUsers?.coGpCount ?? 0,
    );
    const priceId = String(row.stripePriceId ?? "").trim();
    const subscriptionId = String(row.stripeSubscriptionId ?? "").trim();
    const couponRedeemed = Boolean(String(row.saasCouponCode ?? "").trim());
    const subscribedCatalog = catalogPackagePriceCents(
      row.stripePlanId,
      normalizeDealBillingCycle(row.stripeBillingCycle),
      currentSeatBand,
    );
    const nextPackageCents = catalogPackagePriceCents(
      suggestedPlanId ?? row.stripePlanId,
      normalizeDealBillingCycle(row.stripeBillingCycle),
      suggestedSeatBand,
    );
    const onTargetPackage =
      normalizeBillingPlanId(row.stripePlanId) === suggestedPlanId &&
      currentSeatBand === suggestedSeatBand;
    const amountPaidCents =
      couponRedeemed && onTargetPackage
        ? subscribedCatalog ?? nextPackageCents
        : paidByPriceId.get(priceId) ??
          paidBySubscription.get(subscriptionId) ??
          null;
    const owesPriceGap = priceGapCents(amountPaidCents, nextPackageCents) > 0;
    list.push({
      id: String(row.id),
      companyId: String(row.organizationId ?? "").trim().toLowerCase(),
      companyName: String(row.companyName ?? "").trim() || "—",
      dealName: row.dealName ?? "",
      dealStage: row.dealStage ?? "",
      archived: Boolean(row.archived),
      planId: billed
        ? displayPlanIdForBilledDeal(row.stripePlanId, suggestedPlanId)
        : payable
          ? suggestedPlanId
          : null,
      suggestedPlanId,
      needsPlanUpgrade:
        dealShouldAlertPlanUpgrade(dated, suggestedPlanId) || owesPriceGap,
      suggestedSeatBand,
      needsCoGpUpgrade: coGpSeatBandNeedsUpgrade(
        currentSeatBand,
        companyUsers?.coGpCount ?? 0,
        suggestedPlanId,
      ),
      billingCycle: payable ? row.stripeBillingCycle ?? null : null,
      subscriptionStatus: payable
        ? row.stripeSubscriptionStatus || "none"
        : "canceled",
      nextBillingDate: nextBillingDateForList(dated),
      saasBillingStartsAt: saasBillingStartsAt
        ? saasBillingStartsAt.toISOString()
        : null,
      billed,
      billable,
      payable,
      includedCompanyUsers: companyUsers?.includedCompanyUsers ?? 1,
      currentCompanyUsers: companyUsers?.currentCompanyUsers ?? 0,
      extraCompanyUsersPaid: payable
        ? companyUsers?.extraCompanyUsersPaid ?? 0
        : 0,
      extraCompanyUsersDue: companyUsers?.extraCompanyUsersDue ?? 0,
      coGpCount: companyUsers?.coGpCount ?? 0,
      seatBand: companyUsers?.seatBand ?? null,
      includedCoGps: companyUsers?.includedCoGps ?? null,
      extraUserFeeCents: companyUsers?.extraUserFeeCents ?? 1000,
      extraUserComment: companyUsers?.extraUserComment ?? "",
      couponRedeemed: Boolean(String(row.saasCouponCode ?? "").trim()),
      amountPaidCents,
    });
  }

  list.sort((a, b) => {
    const org = a.companyName.localeCompare(b.companyName, undefined, {
      sensitivity: "base",
    });
    if (org !== 0) return org;
    return a.dealName.localeCompare(b.dealName, undefined, {
      sensitivity: "base",
    });
  });
  return list;
}

export async function listDealBillingForCompany(
  companyId: string,
  dealIdFilter?: string[] | null,
): Promise<DealBillingListRow[]> {
  const cid = normalizeDealId(companyId);
  if (!cid) return [];
  if (dealIdFilter && dealIdFilter.length === 0) return [];

  const conditions = [eq(addDealForm.organizationId, cid)];
  if (dealIdFilter && dealIdFilter.length > 0) {
    conditions.push(inArray(addDealForm.id, dealIdFilter));
  }

  const rows = await db
    .select(dealBillingSelect)
    .from(addDealForm)
    .leftJoin(companies, eq(addDealForm.organizationId, companies.id))
    .where(and(...conditions));

  return mapDealBillingQueryRows(rows as DealBillingQueryRow[]);
}

/** Platform admin: every deal across every organization. */
export async function listDealBillingForAllOrganizations(): Promise<
  DealBillingListRow[]
> {
  const rows = await db
    .select(dealBillingSelect)
    .from(addDealForm)
    .leftJoin(companies, eq(addDealForm.organizationId, companies.id));

  return mapDealBillingQueryRows(rows as DealBillingQueryRow[]);
}

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format((Number.isFinite(cents) ? cents : 0) / 100);
}

export type PlatformOrganizationBillingRow = {
  id: string;
  name: string;
  dealCount: number;
  billedCount: number;
  totalPaidCents: number;
  totalPaid: string;
  deals: DealBillingListRow[];
};

/** Lead sponsor label for deals that are not on a company. */
async function leadSponsorLabelsForDeals(
  dealIds: string[],
): Promise<Map<string, { personId: string; name: string }>> {
  const labels = new Map<string, { personId: string; name: string }>();
  const ids = [
    ...new Set(
      dealIds
        .map((id) => String(id ?? "").trim().toLowerCase())
        .filter((id) => DEAL_UUID_RE.test(id)),
    ),
  ];
  if (ids.length === 0) return labels;
  const res = await pool.query<{
    deal_id: string;
    user_id: string | null;
    matched_user_id: string | null;
    contact_id: string | null;
    user_name: string | null;
    user_email: string | null;
    matched_name: string | null;
    matched_email: string | null;
    contact_name: string | null;
    contact_email: string | null;
  }>(
    `SELECT DISTINCT ON (dm.deal_id)
       dm.deal_id::text AS deal_id,
       u.id::text AS user_id,
       u2.id::text AS matched_user_id,
       c.id::text AS contact_id,
       trim(concat_ws(' ', nullif(trim(u.first_name), ''), nullif(trim(u.last_name), ''))) AS user_name,
       u.email AS user_email,
       trim(concat_ws(' ', nullif(trim(u2.first_name), ''), nullif(trim(u2.last_name), ''))) AS matched_name,
       u2.email AS matched_email,
       nullif(trim(c.full_name), '') AS contact_name,
       c.email AS contact_email
     FROM deal_member dm
     LEFT JOIN users u ON u.id::text = trim(dm.contact_member_id)
     LEFT JOIN contact c ON c.id::text = trim(both from dm.contact_member_id)
     LEFT JOIN users u2 ON lower(trim(u2.email)) = lower(trim(c.email))
     WHERE dm.deal_id = ANY($1::uuid[])
       AND dm.is_draft = false
       AND (
         lower(trim(dm.deal_member_role)) IN ('lead sponsor', 'lead_sponsor')
         OR (
           position('lead' in lower(trim(dm.deal_member_role))) > 0
           AND position('sponsor' in lower(trim(dm.deal_member_role))) > 0
           AND position('admin' in lower(trim(dm.deal_member_role))) = 0
         )
       )
     ORDER BY dm.deal_id, dm.created_at`,
    [ids],
  );
  for (const row of res.rows) {
    const dealId = String(row.deal_id ?? "").trim().toLowerCase();
    if (!dealId) continue;
    const personId =
      String(row.user_id ?? row.matched_user_id ?? row.contact_id ?? "")
        .trim()
        .toLowerCase() || dealId;
    const name =
      String(row.user_name ?? "").trim() ||
      String(row.user_email ?? "").trim() ||
      String(row.matched_name ?? "").trim() ||
      String(row.matched_email ?? "").trim() ||
      String(row.contact_name ?? "").trim() ||
      String(row.contact_email ?? "").trim() ||
      "Lead sponsor";
    labels.set(dealId, { personId, name });
  }
  return labels;
}

/** Platform admin: every organization with deals and total paid. */
export async function listPlatformOrganizationBilling(): Promise<
  PlatformOrganizationBillingRow[]
> {
  const [orgs, deals, paidRows] = await Promise.all([
    db.select({ id: companies.id, name: companies.name }).from(companies),
    listDealBillingForAllOrganizations(),
    db
      .select({
        companyId: companyBillingInvoices.companyId,
        totalPaidCents: sql<number>`coalesce(sum(${companyBillingInvoices.amountPaidCents}), 0)::int`,
      })
      .from(companyBillingInvoices)
      .where(sql`lower(${companyBillingInvoices.status}) = 'paid'`)
      .groupBy(companyBillingInvoices.companyId),
  ]);

  const dealsByOrg = new Map<string, DealBillingListRow[]>();
  for (const deal of deals) {
    const id = String(deal.companyId ?? "").trim().toLowerCase();
    if (!id) continue;
    const list = dealsByOrg.get(id);
    if (list) list.push(deal);
    else dealsByOrg.set(id, [deal]);
  }

  const unassigned = deals.filter(
    (deal) => !String(deal.companyId ?? "").trim(),
  );
  if (unassigned.length > 0) {
    const sponsors = await leadSponsorLabelsForDeals(
      unassigned.map((deal) => deal.id),
    );
    const grouped = new Map<string, DealBillingListRow[]>();
    for (const deal of unassigned) {
      const sponsor = sponsors.get(deal.id.trim().toLowerCase());
      const groupId = sponsor
        ? `lead:${sponsor.personId}`
        : "lead:unassigned";
      const label = sponsor?.name || "No lead sponsor";
      deal.companyName = label;
      const list = grouped.get(groupId);
      if (list) list.push(deal);
      else grouped.set(groupId, [deal]);
    }
    for (const [groupId, groupDeals] of grouped) {
      dealsByOrg.set(groupId, groupDeals);
    }
  }

  const paidByOrg = new Map<string, number>();
  for (const row of paidRows) {
    const id = String(row.companyId ?? "").trim().toLowerCase();
    if (!id) continue;
    paidByOrg.set(id, Number(row.totalPaidCents) || 0);
  }

  const names = new Map<string, string>();
  for (const org of orgs) {
    names.set(
      String(org.id).trim().toLowerCase(),
      String(org.name ?? "").trim(),
    );
  }
  for (const [id, orgDeals] of dealsByOrg) {
    if (!names.has(id)) {
      names.set(
        id,
        orgDeals[0]?.companyName?.trim() || "Untitled organization",
      );
    }
  }

  const list: PlatformOrganizationBillingRow[] = [...names.entries()].map(
    ([id, name]) => {
      const orgDeals = dealsByOrg.get(id) ?? [];
      const totalPaidCents = paidByOrg.get(id) ?? 0;
      return {
        id,
        name: name || "Untitled organization",
        dealCount: orgDeals.length,
        billedCount: orgDeals.filter((d) => d.billed).length,
        totalPaidCents,
        totalPaid: formatUsdCents(totalPaidCents),
        deals: orgDeals,
      };
    },
  );

  list.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return list;
}

function normalizeDealBillingCycle(
  raw: string | null | undefined,
): StripeBillingCycle | null {
  const c = String(raw ?? "").trim().toLowerCase();
  if (c === "annual" || c === "annually" || c === "yearly") return "annual";
  if (c === "monthly") return "monthly";
  return null;
}

/**
 * Set monthly vs yearly for a deal. During the complimentary month this is
 * stored on the deal and used at checkout. If a Stripe subscription already
 * exists, its price is switched to the matching cycle (no proration).
 */
export async function updateDealBillingCycle(params: {
  companyId: string;
  dealId: string;
  billingCycle: string;
  allowedDealIds?: string[] | null;
}): Promise<
  | { ok: true; deal: DealBillingListRow }
  | { ok: false; status: number; message: string }
> {
  const cycle = normalizeDealBillingCycle(params.billingCycle);
  if (!cycle) {
    return {
      ok: false,
      status: 400,
      message: "Choose monthly or yearly billing.",
    };
  }

  const cid = normalizeDealId(params.companyId);
  const dealId = normalizeDealId(params.dealId);
  if (!cid || !dealId) {
    return { ok: false, status: 400, message: "Select a deal first." };
  }
  if (params.allowedDealIds) {
    const allow = new Set(
      params.allowedDealIds.map((id) => String(id).trim().toLowerCase()),
    );
    if (!allow.has(dealId)) {
      return {
        ok: false,
        status: 403,
        message: "You can only change billing for deals you lead.",
      };
    }
  }

  const [deal] = await db
    .select()
    .from(addDealForm)
    .where(and(eq(addDealForm.id, dealId), eq(addDealForm.organizationId, cid)))
    .limit(1);
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  if (!dealShouldKeepStripeSaasSubscription(deal)) {
    return {
      ok: false,
      status: 400,
      message:
        "Billing cycle applies when the deal is raising capital or asset managing.",
    };
  }
  if (paidBillingPeriodIsLocked(deal)) {
    return {
      ok: false,
      status: 409,
      message: paidBillingPeriodLockedMessage(deal),
    };
  }

  const raise = await raiseAmountForDeal(dealId);
  const suggestedPlan = await suggestedPlanIdForDeal(dealId, raise);
  const planId = dealIsActivelyBilled(deal)
    ? normalizeBillingPlanId(deal.stripePlanId) ?? suggestedPlan
    : suggestedPlan;

  const existingSub = deal.stripeSubscriptionId?.trim() ?? "";
  if (existingSub && getStripeConfig()) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(existingSub, {
        expand: ["items.data.price"],
      });
      const mapped = planCycleSeatFromSubscription(sub);
      const seatBand = mapped.seatBand ?? "5";
      const resolvedPlan = mapped.planId ?? planId;
      const priceId = await stripePriceIdForPlatformAmount({
        stripe,
        planId: resolvedPlan,
        cycle,
        seatBand,
      });
      if (!priceId) {
        return {
          ok: false,
          status: 503,
          message: `Stripe Price is not configured for ${resolvedPlan} / ${seatBand} seats (${cycle}).`,
        };
      }
      const itemId = sub.items?.data?.[0]?.id;
      if (!itemId) {
        return {
          ok: false,
          status: 502,
          message: "This subscription has no price to update.",
        };
      }
      const updated = await stripe.subscriptions.update(existingSub, {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: "none",
        metadata: {
          ...sub.metadata,
          planId: resolvedPlan,
          billingCycle: cycle,
          seatBand,
        },
      });
      await applyStripeSubscriptionToDeal(dealId, updated);
    } catch (err) {
      console.error("updateDealBillingCycle stripe:", err);
      const msg =
        err instanceof Error ? err.message : "Could not update billing cycle.";
      return { ok: false, status: 502, message: msg };
    }
  } else {
    await db
      .update(addDealForm)
      .set({
        stripeBillingCycle: cycle,
        stripePlanId: planId,
      })
      .where(eq(addDealForm.id, dealId));
  }

  const [row] = await listDealBillingForCompany(params.companyId, [dealId]);
  if (!row) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  return { ok: true, deal: row };
}

export async function updateDealSaasBillingStartsAt(params: {
  companyId: string;
  dealId: string;
  saasBillingStartsAt: string;
}): Promise<
  | { ok: true; deal: DealBillingListRow }
  | { ok: false; status: number; message: string }
> {
  const startsAt = utcMidnightFromYmdString(params.saasBillingStartsAt);
  if (!startsAt) {
    return {
      ok: false,
      status: 400,
      message: "Choose a valid billing start date.",
    };
  }
  if (startsAt.getTime() < utcMidnightToday().getTime()) {
    return {
      ok: false,
      status: 400,
      message: "Billing start date cannot be in the past.",
    };
  }

  const dealId = normalizeDealId(params.dealId);
  if (!dealId) {
    return { ok: false, status: 400, message: "Select a deal first." };
  }

  const [deal] = await db
    .select({
      id: addDealForm.id,
      organizationId: addDealForm.organizationId,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }

  await db
    .update(addDealForm)
    .set({ saasBillingStartsAt: startsAt })
    .where(eq(addDealForm.id, dealId));

  const orgId =
    normalizeDealId(String(deal.organizationId ?? "")) ||
    normalizeDealId(params.companyId);
  let row: DealBillingListRow | undefined;
  try {
    if (orgId) {
      const [listed] = await listDealBillingForCompany(orgId, [dealId]);
      row = listed;
    }
    if (!row) {
      const all = await listDealBillingForAllOrganizations();
      row = all.find((item) => item.id.trim().toLowerCase() === dealId);
    }
  } catch (err) {
    console.error("updateDealSaasBillingStartsAt reload:", err);
  }
  if (!row) {
    return {
      ok: false,
      status: 500,
      message: "The billing date was saved, but the deal list could not be refreshed. Reload the page.",
    };
  }

  void notifyLeadSponsorsOfDealBillingStartDate({
    dealId,
    dealName: row.dealName,
    saasBillingStartsAt: startsAt,
  }).catch((err) => {
    console.warn("notifyLeadSponsorsOfDealBillingStartDate:", dealId, err);
  });

  return { ok: true, deal: row };
}

export async function loadPayableDeal(params: {
  companyId: string;
  dealId: string;
  allowedDealIds: string[] | null;
  /** Signed-in user. A lead sponsor may pay their deal even when the company allow-list missed it. */
  actorUserId?: string | null;
  requestedSeatBand?: string | null;
}): Promise<
  | { ok: true; deal: AddDealFormRow }
  | { ok: false; status: number; message: string }
> {
  const cid = normalizeDealId(params.companyId);
  const dealId = normalizeDealId(params.dealId);
  if (!cid || !dealId) {
    return { ok: false, status: 400, message: "Select a deal to pay MRR for." };
  }
  const actorId = String(params.actorUserId ?? "").trim();
  const leadsThisDeal = actorId
    ? await isPortalUserLeadSponsorOnDeal(dealId, actorId)
    : false;
  if (params.allowedDealIds && !leadsThisDeal) {
    const allow = new Set(
      params.allowedDealIds.map((id) => String(id).trim().toLowerCase()),
    );
    if (!allow.has(dealId)) {
      return {
        ok: false,
        status: 403,
        message: "You can only pay SaaS billing for deals you lead.",
      };
    }
  }
  const [inCompany] = await db
    .select()
    .from(addDealForm)
    .where(and(eq(addDealForm.id, dealId), eq(addDealForm.organizationId, cid)))
    .limit(1);
  let deal = inCompany;
  if (!deal && leadsThisDeal) {
    const [led] = await db
      .select()
      .from(addDealForm)
      .where(eq(addDealForm.id, dealId))
      .limit(1);
    deal = led;
  }
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  if (!dealSaasBillingHasStarted(deal)) {
    return {
      ok: false,
      status: 400,
      message: dealSaasBillingNotYetDueMessage(deal),
    };
  }
  if (deal.archived) {
    return {
      ok: false,
      status: 400,
      message:
        "Billing starts when the deal is raising capital or asset managing. Draft, archived, and liquidated deals are not billed.",
    };
  }
  if (
    !isDealSaasBillable(deal) &&
    !isSaasBillableDealStage(deal.pendingDealStage)
  ) {
    return {
      ok: false,
      status: 400,
      message:
        "Billing starts when the deal is raising capital or asset managing. Draft, archived, and liquidated deals are not billed.",
    };
  }
  return { ok: true, deal };
}

export async function countBilledDealsForCompany(
  companyId: string,
  dealIdFilter?: string[] | null,
): Promise<{ billedDealCount: number; nextDealBillingDate: string | null }> {
  const cid = normalizeDealId(companyId);
  if (!cid) return { billedDealCount: 0, nextDealBillingDate: null };
  if (dealIdFilter && dealIdFilter.length === 0) {
    return { billedDealCount: 0, nextDealBillingDate: null };
  }
  const conditions = [eq(addDealForm.organizationId, cid)];
  if (dealIdFilter && dealIdFilter.length > 0) {
    conditions.push(inArray(addDealForm.id, dealIdFilter));
  }
  const deals = await db
    .select({
      archived: addDealForm.archived,
      dealStage: addDealForm.dealStage,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
      stripeCurrentPeriodEnd: addDealForm.stripeCurrentPeriodEnd,
    })
    .from(addDealForm)
    .where(and(...conditions));
  let billedDealCount = 0;
  let earliest: Date | null = null;
  for (const d of deals) {
    if (!isDealSaasBillable(d) || !d.stripeSubscriptionId?.trim()) continue;
    if (
      !ACTIVE_SUB_STATUSES.has(
        String(d.stripeSubscriptionStatus ?? "none").toLowerCase(),
      )
    ) {
      continue;
    }
    billedDealCount += 1;
    if (d.stripeCurrentPeriodEnd) {
      if (!earliest || d.stripeCurrentPeriodEnd < earliest) {
        earliest = d.stripeCurrentPeriodEnd;
      }
    }
  }
  return {
    billedDealCount,
    nextDealBillingDate: earliest ? earliest.toISOString() : null,
  };
}
