import Stripe from "stripe";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  addDealForm,
  companies,
  dealInvestorClass,
  type AddDealFormRow,
} from "../../schema/schema.js";
import { listDealIdsWhereViewerIsLeadSponsor } from "../deal/dealMemberScope.service.js";
import { normalizeDealStageCanonical } from "../../constants/deal-lifecycle/deal-stage.js";
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

const STARTER_MAX_CENTS = 5_000_000;
const RUNNING_MAX_CENTS = 15_000_000;

const ACTIVE_SUB_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
/** Workspace view/edit requires a current paid period — failed renewals lock the deal. */
const PAID_ACCESS_STATUSES = new Set(["active", "trialing"]);
/** Stripe Checkout `trial_end` must be at least 48 hours in the future. */
const STRIPE_MIN_TRIAL_MS = 48 * 60 * 60 * 1000;

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
};

export type DealSaasBillingListFields = {
  viewerIsLeadSponsor: true;
  nextBillingDate: string | null;
  billingSubscriptionStatus: string;
  billingPlanId: string | null;
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

function parseMoneyAmount(raw: string | null | undefined): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Starter ≤ $5M, Running ≤ $15M, Growth above that — matches billing plan cards. */
export function planIdForDealRaiseAmount(
  raiseAmount: number,
): StripeBillingPlanId {
  if (raiseAmount > RUNNING_MAX_CENTS) return "growth";
  if (raiseAmount > STARTER_MAX_CENTS) return "running";
  return "starter";
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
  return quota > 0 ? quota : offering;
}

function periodEndFromSubscription(sub: Stripe.Subscription): Date | null {
  const end = sub.items?.data?.[0]?.current_period_end ?? null;
  if (end == null || !Number.isFinite(end)) return null;
  return new Date(end * 1000);
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

/** First instant of next calendar month (UTC) — billing and paywall start here. */
export function startOfNextCalendarMonth(from = new Date()): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
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

function billingStartsAtDate(
  row: Pick<AddDealFormRow, "saasBillingStartsAt">,
): Date {
  return row.saasBillingStartsAt ?? startOfNextCalendarMonth();
}

function saasBillingHasStarted(
  row: Pick<AddDealFormRow, "saasBillingStartsAt">,
  nowMs = Date.now(),
): boolean {
  return periodEndHasPassed(
    { stripeCurrentPeriodEnd: billingStartsAtDate(row) },
    nowMs,
  );
}

/**
 * Unix `trial_end` so Checkout does not charge until billing starts next month.
 * Undefined when Stripe would reject the timestamp (< 48h) or billing is already due.
 */
export function dealSaasStripeTrialEndUnix(
  row: Pick<AddDealFormRow, "saasBillingStartsAt">,
  nowMs = Date.now(),
): number | undefined {
  const until = billingStartsAtDate(row).getTime();
  if (!Number.isFinite(until) || until < nowMs + STRIPE_MIN_TRIAL_MS) {
    return undefined;
  }
  return Math.floor(until / 1000);
}

export async function ensureDealSaasComplimentaryPeriod(
  deal: Pick<
    AddDealFormRow,
    | "id"
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "saasBillingStartsAt"
  >,
): Promise<void> {
  if (!isDealSaasBillable(deal)) return;
  if (deal.saasBillingStartsAt) return;
  const id = normalizeDealId(String(deal.id));
  if (!id) return;
  await db
    .update(addDealForm)
    .set({ saasBillingStartsAt: startOfNextCalendarMonth() })
    .where(eq(addDealForm.id, id));
}

/**
 * This calendar month is fully accessible. Billing and the upgrade paywall
 * start on the 1st of next month (persisted once as saasBillingStartsAt).
 * After that date, unpaid / past-due / expired MRR locks view and edit.
 * Draft, archived, and liquidated are free. Stripe unset → no gate.
 */
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

  if (hasSub && paidStatus && !expired) {
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

export function dealSaasPaymentRequiredPayload(
  row: AddDealFormRow,
  access?: DealSaasAccessEvaluation,
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
  };
}

function nextBillingDateForList(
  row: Pick<
    AddDealFormRow,
    | "archived"
    | "dealStage"
    | "stripeSubscriptionId"
    | "stripeCurrentPeriodEnd"
    | "saasBillingStartsAt"
  >,
): string | null {
  if (!isDealSaasBillable(row)) return periodEndIso(row);
  if (!saasBillingHasStarted(row)) {
    return billingStartsAtDate(row).toISOString();
  }
  return periodEndIso(row) ?? billingStartsAtDate(row).toISOString();
}

export function dealSaasBillingListFields(
  row: AddDealFormRow,
): DealSaasBillingListFields {
  const access = evaluateDealSaasWorkspaceAccess(row);
  if (
    isDealSaasBillable(row) &&
    !row.saasBillingStartsAt
  ) {
    void ensureDealSaasComplimentaryPeriod(row).catch((err) => {
      console.warn("ensureDealSaasComplimentaryPeriod:", row.id, err);
    });
  }
  return {
    viewerIsLeadSponsor: true,
    nextBillingDate: nextBillingDateForList(row),
    billingSubscriptionStatus: row.stripeSubscriptionStatus || "none",
    billingPlanId: row.stripePlanId ?? null,
    billingAccessLocked: access.locked,
    billingLockReason: access.reason,
  };
}

export async function applyStripeSubscriptionToDeal(
  dealId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id) return;
  const mapped = planCycleSeatFromSubscription(sub);
  const status = String(sub.status ?? "none");
  await db
    .update(addDealForm)
    .set({
      stripeSubscriptionId: sub.id,
      stripePlanId: mapped.planId,
      stripeBillingCycle: mapped.cycle,
      stripeSubscriptionStatus: status || "none",
      stripePriceId: priceIdFromSubscription(sub),
      stripeCurrentPeriodEnd: periodEndFromSubscription(sub),
    })
    .where(eq(addDealForm.id, id));
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
      stripeCurrentPeriodEnd: stillBillable
        ? (deal?.stripeCurrentPeriodEnd ?? null)
        : null,
    })
    .where(eq(addDealForm.id, id));
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

async function createDealStripeSubscription(params: {
  deal: AddDealFormRow;
  customerId: string;
  paymentMethodId: string;
  planId: StripeBillingPlanId;
  cycle: StripeBillingCycle;
  seatBand: StripeBillingSeatBand;
}): Promise<Stripe.Subscription | null> {
  const priceId = resolveStripePriceId(
    params.planId,
    params.cycle,
    params.seatBand,
  );
  if (!priceId) {
    console.warn(
      "createDealStripeSubscription: missing price",
      params.planId,
      params.cycle,
      params.seatBand,
    );
    return null;
  }
  const stripe = getStripeClient();
  const trialEnd = dealSaasStripeTrialEndUnix(params.deal);
  const sub = await stripe.subscriptions.create({
      customer: params.customerId,
      items: [{ price: priceId, quantity: 1 }],
      default_payment_method: params.paymentMethodId,
      ...(trialEnd ? { trial_end: trialEnd } : {}),
      metadata: {
        companyId: String(params.deal.organizationId ?? ""),
        dealId: String(params.deal.id),
        dealName: params.deal.dealName ?? "",
        planId: params.planId,
        billingCycle: params.cycle,
        seatBand: params.seatBand,
        billingScope: "deal",
      },
    });
  return sub;
}

/**
 * Start, stop, or realign this deal's SaaS subscription.
 * No-ops when Stripe is unset or the company has no customer / payment method.
 */
export async function syncDealSaasBillingForDeal(
  dealId: string,
): Promise<void> {
  const id = normalizeDealId(dealId);
  if (!id || !getStripeConfig()) return;
  const [deal] = await db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  if (!deal) return;

  if (!isDealSaasBillable(deal)) {
    if (deal.stripeSubscriptionId?.trim()) {
      await cancelStripeSubscriptionQuietly(deal.stripeSubscriptionId);
      await clearDealSaasSubscription(id);
    } else if (deal.stripeCurrentPeriodEnd) {
      await db
        .update(addDealForm)
        .set({ stripeCurrentPeriodEnd: null })
        .where(eq(addDealForm.id, id));
    }
    return;
  }

  await ensureDealSaasComplimentaryPeriod(deal);

  const orgId = String(deal.organizationId ?? "").trim();
  if (!orgId) return;
  await syncCompanyDealSaasSubscriptions(orgId);
}

export function scheduleDealSaasBillingSync(dealId: string): void {
  const id = String(dealId ?? "").trim();
  if (!id) return;
  void syncDealSaasBillingForDeal(id).catch((err) => {
    console.warn("scheduleDealSaasBillingSync:", id, err);
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
  const notBillable = deals.filter((d) => !isDealSaasBillable(d));

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
    const planId = planIdForDealRaiseAmount(raise);
    const existingId = deal.stripeSubscriptionId?.trim() ?? "";

    if (existingId) {
      try {
        const sub = await stripe.subscriptions.retrieve(existingId);
        if (sub.status === "canceled" || sub.status === "incomplete_expired") {
          await clearDealSaasSubscription(String(deal.id));
        } else {
          const mapped = planCycleSeatFromSubscription(sub);
          const priceId = resolveStripePriceId(
            planId,
            mapped.cycle ?? defaults.cycle,
            mapped.seatBand ?? defaults.seatBand,
          );
          const currentPrice = priceIdFromSubscription(sub);
          if (priceId && currentPrice && priceId !== currentPrice) {
            const itemId = sub.items.data[0]?.id;
            if (itemId) {
              await stripe.subscriptions.update(sub.id, {
                items: [{ id: itemId, price: priceId }],
                metadata: {
                  ...sub.metadata,
                  dealId: String(deal.id),
                  planId,
                  billingScope: "deal",
                },
                proration_behavior: "create_prorations",
              });
            }
          } else if (!normalizeDealId(sub.metadata?.dealId)) {
            await attachSubscriptionMetadataToDeal(sub, deal, {
              planId,
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
      const priceId = resolveStripePriceId(
        planId,
        mapped.cycle ?? defaults.cycle,
        mapped.seatBand ?? defaults.seatBand,
      );
      const currentPrice = priceIdFromSubscription(updated);
      if (priceId && currentPrice && priceId !== currentPrice) {
        const itemId = updated.items.data[0]?.id;
        if (itemId) {
          await stripe.subscriptions.update(updated.id, {
            items: [{ id: itemId, price: priceId }],
            proration_behavior: "create_prorations",
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
  dealName: string;
  dealStage: string;
  archived: boolean;
  planId: string | null;
  suggestedPlanId: string | null;
  billingCycle: string | null;
  subscriptionStatus: string;
  nextBillingDate: string | null;
  billed: boolean;
  billable: boolean;
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
    .select({
      id: addDealForm.id,
      dealName: addDealForm.dealName,
      dealStage: addDealForm.dealStage,
      archived: addDealForm.archived,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripePlanId: addDealForm.stripePlanId,
      stripeBillingCycle: addDealForm.stripeBillingCycle,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
      stripeCurrentPeriodEnd: addDealForm.stripeCurrentPeriodEnd,
      saasBillingStartsAt: addDealForm.saasBillingStartsAt,
    })
    .from(addDealForm)
    .where(and(...conditions));

  const list: DealBillingListRow[] = [];
  for (const row of rows) {
    await ensureDealSaasComplimentaryPeriod(row);
    const billed = dealIsActivelyBilled(row);
    const billable = isDealSaasBillable(row);
    const raise = billable ? await raiseAmountForDeal(String(row.id)) : 0;
    list.push({
      id: String(row.id),
      dealName: row.dealName ?? "",
      dealStage: row.dealStage ?? "",
      archived: Boolean(row.archived),
      planId: row.stripePlanId ?? null,
      suggestedPlanId: billable ? planIdForDealRaiseAmount(raise) : null,
      billingCycle: row.stripeBillingCycle ?? null,
      subscriptionStatus: row.stripeSubscriptionStatus || "none",
      nextBillingDate: nextBillingDateForList(row),
      billed,
      billable,
    });
  }

  list.sort((a, b) =>
    a.dealName.localeCompare(b.dealName, undefined, { sensitivity: "base" }),
  );
  return list;
}

export async function loadPayableDeal(params: {
  companyId: string;
  dealId: string;
  allowedDealIds: string[] | null;
}): Promise<
  | { ok: true; deal: AddDealFormRow }
  | { ok: false; status: number; message: string }
> {
  const cid = normalizeDealId(params.companyId);
  const dealId = normalizeDealId(params.dealId);
  if (!cid || !dealId) {
    return { ok: false, status: 400, message: "Select a deal to pay MRR for." };
  }
  if (params.allowedDealIds) {
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
  const [deal] = await db
    .select()
    .from(addDealForm)
    .where(and(eq(addDealForm.id, dealId), eq(addDealForm.organizationId, cid)))
    .limit(1);
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  if (!isDealSaasBillable(deal)) {
    return {
      ok: false,
      status: 400,
      message:
        "Billing starts when the deal is raising capital or asset managing. Draft, archived, and liquidated deals are not billed.",
    };
  }
  if (
    deal.stripeSubscriptionId?.trim() &&
    ACTIVE_SUB_STATUSES.has(
      String(deal.stripeSubscriptionStatus ?? "none").toLowerCase(),
    )
  ) {
    return {
      ok: false,
      status: 409,
      message:
        "This deal already has an active SaaS subscription. Use Manage billing to update the payment method.",
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
