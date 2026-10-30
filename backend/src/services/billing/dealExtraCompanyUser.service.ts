import { and, desc, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../database/db.js";
import { addDealForm, companyBillingInvoices, contact, dealInvestorClass, dealInvestment, dealLpInvestor, dealMember, users } from "../../schema/schema.js";
import {
  EXTRA_COMPANY_USER_FEE_CENTS,
  EXTRA_COMPANY_USER_PAYMENT_REQUIRED,
  includedCompanyUsersForPlan,
  MAX_SELF_SERVE_COMPANY_USERS,
  normalizeBillingPlanId,
  normalizeBillingSeatBand,
  planAndCycleFromPriceId,
  resolveStripePriceId,
  type StripeBillingCycle,
  type StripeBillingPlanId,
  type StripeBillingSeatBand,
} from "../../config/stripe.config.js";
import {
  DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER,
  isDealCompanyUserStoredRole,
  isLpInvestorRole,
} from "../deal/dealInvestment.service.js";
const STARTER_MAX_CENTS = 3_000_000;
const RUNNING_MAX_CENTS = 5_000_000;
const DEAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeDealId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return DEAL_UUID_RE.test(s) ? s : null;
}

function parseMoneyAmount(raw: string | null | undefined): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function planIdForDealRaiseAmount(raiseAmount: number): StripeBillingPlanId {
  if (raiseAmount > RUNNING_MAX_CENTS) return "growth";
  if (raiseAmount > STARTER_MAX_CENTS) return "running";
  return "starter";
}

/** Catalog dollars for the 5 / 10 / 10+ package. Index matches the billing screen. */
const CATALOG_MONTHLY: Record<StripeBillingPlanId, readonly number[]> = {
  starter: [149, 149, 149, 149, 149, 159, 169, 169, 169, 169, 179, 189],
  running: [199, 199, 199, 199, 199, 209, 219, 229, 229, 229, 239, 249],
  growth: [249, 249, 249, 249, 249, 259, 269, 269, 269, 269, 279, 289],
};
const CATALOG_ANNUAL: Record<StripeBillingPlanId, readonly number[]> = {
  starter: [1490, 1490, 1490, 1490, 1490, 1590, 1690, 1690, 1690, 1690, 1790, 1890],
  running: [1990, 1990, 1990, 1990, 1990, 2090, 2190, 2190, 2190, 2190, 2390, 2490],
  growth: [2490, 2490, 2490, 2490, 2490, 2590, 2690, 2690, 2690, 2690, 2790, 2890],
};

/** 10+ package prices in cents. A payment of one of these includes every co-sponsor. */
const TEN_PLUS_PACKAGE_CENTS = new Set(
  [CATALOG_MONTHLY, CATALOG_ANNUAL].flatMap((table) =>
    (["starter", "running", "growth"] as const).map((plan) => table[plan][11] * 100),
  ),
);

export function paidAmountIncludesAllCoSponsors(
  paidCents: number | null | undefined,
): boolean {
  const amount = Math.round(Number(paidCents) || 0);
  return amount > 0 && TEN_PLUS_PACKAGE_CENTS.has(amount);
}

/** Price of the package already paid or the package being purchased. */
export function catalogPackagePriceCents(
  planId: string | null | undefined,
  cycle: "monthly" | "annual" | "annually" | null | undefined,
  seatBand: string | null | undefined,
): number | null {
  const plan = normalizeBillingPlanId(planId);
  const seat = normalizeBillingSeatBand(seatBand);
  if (!plan || !seat) return null;
  const annual =
    cycle === "annual" || cycle === "annually";
  const table = annual ? CATALOG_ANNUAL : CATALOG_MONTHLY;
  const index = seat === "10plus" ? 11 : seat === "10" ? 9 : 4;
  return table[plan][index] * 100;
}

/** New package price minus the amount already paid. $149 after a $49 payment is $100. */
export function priceGapCents(
  paidCents: number | null | undefined,
  nextCents: number | null | undefined,
): number {
  if (paidCents == null || nextCents == null) return 0;
  if (!Number.isFinite(paidCents) || !Number.isFinite(nextCents)) return 0;
  return Math.max(0, Math.round(nextCents) - Math.round(paidCents));
}

/** Difference after a percent or amount coupon. The coupon applies only to the gap. */
export function discountedDifferenceCents(
  differenceCents: number,
  percentOff: number | null | undefined,
  amountOffCents: number | null | undefined,
): number {
  const amount = Math.max(0, Math.round(differenceCents));
  if (percentOff != null && Number.isFinite(percentOff)) {
    const percent = Math.min(100, Math.max(0, percentOff));
    return Math.max(0, Math.round((amount * (100 - percent)) / 100));
  }
  if (
    amountOffCents != null &&
    Number.isFinite(amountOffCents) &&
    amountOffCents > 0
  ) {
    return Math.max(0, amount - Math.round(amountOffCents));
  }
  return amount;
}

/**
 * Coupon on a difference payment.
 * The discount is taken from the full package price. The amount due now is
 * that discounted price minus what was already paid.
 * $49 paid toward a $149 package with 50% off is $25.50 due now, and the
 * deal bills $74.50 while the coupon repeats.
 */
export function differenceRepeatPriceCents(params: {
  paidCents: number;
  differenceCents: number;
  percentOff?: number | null;
  amountOffCents?: number | null;
}): { discountedDifferenceCents: number; repeatPriceCents: number } {
  const paid = Math.max(0, Math.round(params.paidCents));
  const full = paid + Math.max(0, Math.round(params.differenceCents));
  const discountedFull = discountedDifferenceCents(
    full,
    params.percentOff,
    params.amountOffCents,
  );
  return {
    discountedDifferenceCents: Math.max(0, discountedFull - paid),
    repeatPriceCents: discountedFull,
  };
}

/**
 * Checkout line before Stripe applies the same coupon, so the customer pays
 * the difference due after the coupon on the full package price.
 */
/** Repeating and forever coupons can only be attached to a subscription. */
export function couponDurationAppliesToOneTime(duration: string | null | undefined): boolean {
  const value = String(duration ?? "").trim();
  return value !== "repeating" && value !== "forever";
}

export function couponCheckoutLineCents(params: {
  dueCents: number;
  percentOff?: number | null;
  amountOffCents?: number | null;
}): number {
  const due = Math.max(0, Math.round(params.dueCents));
  const percent = params.percentOff;
  if (percent != null && Number.isFinite(percent) && percent > 0 && percent < 100) {
    const estimate = Math.round(due / (1 - percent / 100));
    for (let line = Math.max(due, estimate - 5); line <= estimate + 5; line += 1) {
      const discount = Math.round((line * percent) / 100);
      if (line - discount === due) return line;
    }
    return estimate;
  }
  if (
    params.amountOffCents != null &&
    Number.isFinite(params.amountOffCents) &&
    params.amountOffCents > 0
  ) {
    return due + Math.round(params.amountOffCents);
  }
  return due;
}

const platformPriceIds = new Map<string, string>();

/**
 * Stripe Price whose unit amount is the platform package price.
 * Renewals and the first charge both use that amount.
 */
export async function stripePriceIdForPlatformAmount(params: {
  stripe: Stripe;
  planId: StripeBillingPlanId;
  cycle: StripeBillingCycle;
  seatBand: StripeBillingSeatBand;
}): Promise<string | null> {
  const configuredId = resolveStripePriceId(
    params.planId,
    params.cycle,
    params.seatBand,
  );
  const amount = catalogPackagePriceCents(
    params.planId,
    params.cycle,
    params.seatBand,
  );
  if (!configuredId || amount == null) return configuredId;
  const cacheKey = `${params.planId}:${params.seatBand}:${params.cycle}:${amount}`;
  const cached = platformPriceIds.get(cacheKey);
  if (cached) return cached;

  const configured = await params.stripe.prices.retrieve(configuredId);
  if (configured.unit_amount === amount) {
    platformPriceIds.set(cacheKey, configuredId);
    return configuredId;
  }
  const productId =
    typeof configured.product === "string"
      ? configured.product
      : configured.product && "id" in configured.product
        ? configured.product.id
        : null;
  if (!productId) return configuredId;

  const lookupKey = `sx_${params.planId}_${params.seatBand}_${params.cycle}_${amount}`;
  const listed = await params.stripe.prices.list({
    lookup_keys: [lookupKey],
    limit: 1,
  });
  const existingId = listed.data[0]?.id;
  if (existingId) {
    platformPriceIds.set(cacheKey, existingId);
    return existingId;
  }

  const created = await params.stripe.prices.create({
    product: productId,
    currency: configured.currency || "usd",
    unit_amount: amount,
    recurring: { interval: params.cycle === "annual" ? "year" : "month" },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    nickname: `${params.planId} ${params.seatBand} ${params.cycle} platform`,
    metadata: {
      planId: params.planId,
      seatBand: params.seatBand,
      billingCycle: params.cycle,
      platformAmountCents: String(amount),
      billingScope: "deal",
    },
  });
  platformPriceIds.set(cacheKey, created.id);
  return created.id;
}

/**
 * Plan tier follows the offering size. Co-sponsor count chooses the
 * 5 / 10 / 10+ price inside that plan and does not change the tier.
 */
export function economicPlanIdForDeal(
  raiseAmount: number,
  _coGpCount?: number,
): StripeBillingPlanId {
  return planIdForDealRaiseAmount(raiseAmount);
}

const BILLING_COMMENT_MAX = 450;

/** Co-sponsors and general partners fill the 5 / 10 Co-GP plan count. */
export function isCoSponsorStoredRole(raw: string | null | undefined): boolean {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, " ");
  return (
    s.includes("co-sponsor") ||
    s.includes("co sponsor") ||
    s.includes("cosponsor") ||
    s === "co gp" ||
    s === "co-gp"
  );
}

/** Extra Co-GP billing counts co-sponsors only, not other roster roles. */
export function isCoGpStoredRole(raw: string | null | undefined): boolean {
  return isCoSponsorStoredRole(raw);
}

/** Months billed on the annual plan (2 months free). Extra Co-GPs use the same rule. */
export const EXTRA_CO_GP_ANNUAL_MONTHS = 10;

export function extraCoGpUnitAmountCents(
  cycle: "monthly" | "annual",
): number {
  return cycle === "annual"
    ? EXTRA_COMPANY_USER_FEE_CENTS * EXTRA_CO_GP_ANNUAL_MONTHS
    : EXTRA_COMPANY_USER_FEE_CENTS;
}

/**
 * 5 and 10 packages include that many co-sponsors.
 * 10+ is one flat price, so nobody on that package is an extra.
 */
export function includedCoGpsForSeatBand(
  seatBand: string | null | undefined,
): number | null {
  const band = normalizeBillingSeatBand(seatBand);
  if (band === "5") return 5;
  if (band === "10") return 10;
  if (band === "10plus") return null;
  return null;
}

/** Smallest Co-GP package that contains the deal's current Co-GP roster. */
export function suggestedSeatBandForCoGpCount(
  coGpCount: number,
): StripeBillingSeatBand {
  const count = Math.max(0, Math.floor(Number(coGpCount) || 0));
  if (count > 10) return "10plus";
  if (count > 5) return "10";
  return "5";
}

/** 1–5 co-sponsors use 5, 6–10 use 10, and more than 10 use 10+. */
export function suggestedSeatBandForDeal(
  _planId: string | null | undefined,
  coGpCount: number,
): StripeBillingSeatBand {
  return suggestedSeatBandForCoGpCount(coGpCount);
}

export function coGpSeatBandNeedsUpgrade(
  currentSeatBand: string | null | undefined,
  coGpCount: number,
  planId?: string | null,
): boolean {
  const current = normalizeBillingSeatBand(currentSeatBand) ?? "5";
  const suggested = suggestedSeatBandForDeal(planId, coGpCount);
  const rank: Record<StripeBillingSeatBand, number> = {
    "5": 1,
    "10": 2,
    "10plus": 3,
  };
  return rank[suggested] > rank[current];
}

export function coGpSeatBandIsUpgrade(
  currentSeatBand: string | null | undefined,
  requestedSeatBand: string | null | undefined,
): boolean {
  const current = normalizeBillingSeatBand(currentSeatBand) ?? "5";
  const requested = normalizeBillingSeatBand(requestedSeatBand) ?? "5";
  const rank: Record<StripeBillingSeatBand, number> = {
    "5": 1,
    "10": 2,
    "10plus": 3,
  };
  return rank[requested] > rank[current];
}

export type DealBillingRosterMember = {
  contactId: string;
  name: string;
  isCoGp: boolean;
  createdAtMs: number;
};

export function buildExtraUserBilling(params: {
  members: DealBillingRosterMember[];
  includedCoGps: number | null;
  paid: number;
}): {
  currentCompanyUsers: number;
  coGpCount: number;
  coGpsToCharge: DealBillingRosterMember[];
  comment: string;
} {
  const members = [...params.members].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
    return a.name.localeCompare(b.name);
  });
  const coGps = members.filter((member) => member.isCoGp);
  const coGpsToCharge =
    params.includedCoGps == null ? [] : coGps.slice(params.includedCoGps);
  return {
    currentCompanyUsers: members.length,
    coGpCount: coGps.length,
    coGpsToCharge,
    comment: formatExtraUserBillingComment(params.includedCoGps, coGpsToCharge),
  };
}

function formatExtraUserBillingComment(
  includedCoGps: number | null,
  coGpsToCharge: DealBillingRosterMember[],
): string {
  if (coGpsToCharge.length === 0 || includedCoGps == null) return "";
  const names = coGpsToCharge.map((member) => member.name).join(", ");
  const dollarsPerMonth =
    coGpsToCharge.length * (EXTRA_COMPANY_USER_FEE_CENTS / 100);
  const dollarsPerYear = dollarsPerMonth * EXTRA_CO_GP_ANNUAL_MONTHS;
  const text = `${coGpsToCharge.length} extra Co-GP${
    coGpsToCharge.length === 1 ? "" : "s"
  } beyond ${includedCoGps} co-sponsors: ${names}. $${dollarsPerMonth}/mo ($${dollarsPerYear}/yr).`;
  return text.length > BILLING_COMMENT_MAX
    ? `${text.slice(0, BILLING_COMMENT_MAX - 1)}…`
    : text;
}

export function extraCompanyUserChargeDescription(params: {
  quantity: number;
  comment?: string | null;
  namedCoGps?: number;
}): string {
  const qty = Math.max(0, Math.floor(params.quantity));
  const comment = String(params.comment ?? "").trim();
  const named = Math.max(0, Math.floor(params.namedCoGps ?? 0));
  const more = qty > named ? qty - named : 0;
  const extra =
    more > 0
      ? ` Plus ${more} additional Co-GP${more === 1 ? "" : "s"} at $10 each.`
      : "";
  if (comment) {
    const text = `${comment}${extra}`.trim();
    return text.length > 500 ? `${text.slice(0, 499)}…` : text;
  }
  if (qty <= 0) return "";
  return `${qty} Co-GP${qty === 1 ? "" : "s"} at $10 each`;
}

function extraUserProductData(
  description: string,
): Stripe.Checkout.SessionCreateParams.LineItem.PriceData.ProductData {
  return {
    name: "Extra Co-GPs",
    description:
      description ||
      "$10 per extra Co-GP beyond the company users included in the deal plan",
  };
}

export function extraCompanyUserCheckoutLineItems(
  quantity: number,
  description?: string | null,
  cycle: "monthly" | "annual" = "monthly",
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const qty = Math.max(0, Math.floor(quantity));
  if (qty <= 0) return [];
  const comment =
    String(description ?? "").trim() ||
    extraCompanyUserChargeDescription({ quantity: qty });
  return [
    {
      price_data: {
        currency: "usd",
        unit_amount: extraCoGpUnitAmountCents(cycle),
        recurring: { interval: cycle === "annual" ? "year" : "month" },
        product_data: extraUserProductData(comment),
      },
      quantity: qty,
    },
  ];
}

export async function extraCoGpSubscriptionItem(
  stripe: Stripe,
  quantity: number,
  cycle: "monthly" | "annual",
  description?: string | null,
): Promise<Stripe.SubscriptionCreateParams.Item | null> {
  const qty = Math.max(0, Math.floor(quantity));
  if (qty <= 0) return null;
  const comment =
    String(description ?? "").trim() ||
    extraCompanyUserChargeDescription({ quantity: qty });
  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: extraCoGpUnitAmountCents(cycle),
    recurring: { interval: cycle === "annual" ? "year" : "month" },
    product_data: {
      name: "Extra Co-GPs",
    },
    metadata: { extraUserComment: comment.slice(0, 500) },
  });
  return { price: price.id, quantity: qty };
}

export async function attachExtraCompanyUserInvoiceItems(params: {
  stripe: Stripe;
  customerId: string;
  quantity: number;
  dealId: string;
  description?: string | null;
}): Promise<void> {
  const qty = Math.max(0, Math.floor(params.quantity));
  if (qty <= 0) return;
  const description =
    String(params.description ?? "").trim() ||
    extraCompanyUserChargeDescription({ quantity: qty });
  await params.stripe.invoiceItems.create({
    customer: params.customerId,
    amount: qty * EXTRA_COMPANY_USER_FEE_CENTS,
    currency: "usd",
    description,
    metadata: {
      dealId: params.dealId,
      billingScope: "extra_company_user",
      extraCompanyUsers: String(qty),
      extraUserComment: description.slice(0, 500),
    },
  });
}

export type DealCompanyUserSnapshot = {
  dealId: string;
  dealName: string;
  organizationId: string | null;
  planId: StripeBillingPlanId;
  includedCompanyUsers: number;
  currentCompanyUsers: number;
  coGpCount: number;
  seatBand: StripeBillingSeatBand | null;
  /** 5 or 10 co-sponsors included in the plan. Null means 10+ or no band yet. */
  includedCoGps: number | null;
  extraCompanyUsersPaid: number;
  extraCompanyUsersDue: number;
  extraUserFeeCents: number;
  extraUserComment: string;
  saasBillingStartsAt: Date | null;
};

export type ExtraCompanyUserPaymentRequiredPayload = {
  code: typeof EXTRA_COMPANY_USER_PAYMENT_REQUIRED;
  message: string;
  dealId: string;
  dealName: string;
  planId: StripeBillingPlanId;
  includedCompanyUsers: number;
  currentCompanyUsers: number;
  extraUsersToPay: number;
  extraUserFeeCents: number;
  amountDueCents: number;
  comment?: string;
};

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

function rosterDisplayName(parts: {
  dealMemberName: string | null;
  contactName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  isCoGp: boolean;
}): string {
  const stored = String(parts.dealMemberName ?? "").trim();
  if (stored) return stored;
  const contactName = String(parts.contactName ?? "").trim();
  if (contactName) return contactName;
  const person = [parts.firstName, parts.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (person) return person;
  const email = String(parts.email ?? "").trim();
  if (email) return email;
  return parts.isCoGp ? "Co-GP" : "Company user";
}

export async function listDealBillingRoster(
  dealId: string,
): Promise<DealBillingRosterMember[]> {
  const did = normalizeDealId(dealId);
  if (!did) return [];
  const rows = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
      dealMemberName: dealMember.dealMemberName,
      createdAt: dealMember.createdAt,
      contactName: contact.fullName,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(dealMember)
    .leftJoin(
      contact,
      sql`lower(${contact.id}::text) = lower(trim(${dealMember.contactMemberId}))`,
    )
    .leftJoin(
      users,
      sql`lower(${users.id}::text) = lower(trim(${dealMember.contactMemberId}))`,
    )
    .where(and(eq(dealMember.dealId, did), eq(dealMember.isDraft, false)));

  const byContact = new Map<string, DealBillingRosterMember>();
  for (const row of rows) {
    const contactId = String(row.contactMemberId ?? "").trim();
    if (!contactId || contactId === DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER) {
      continue;
    }
    if (!isDealCompanyUserStoredRole(row.dealMemberRole)) continue;
    const key = contactId.toLowerCase();
    const isCoGp = isCoGpStoredRole(row.dealMemberRole);
    const createdAtMs = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    const name = rosterDisplayName({
      dealMemberName: row.dealMemberName,
      contactName: row.contactName,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      isCoGp,
    });
    const existing = byContact.get(key);
    if (!existing || createdAtMs < existing.createdAtMs) {
      byContact.set(key, { contactId: key, name, isCoGp, createdAtMs });
    } else if (isCoGp && !existing.isCoGp) {
      existing.isCoGp = true;
    }
  }

  const rememberCoGp = (
    contactId: string,
    name: string,
    createdAt: Date | null,
  ) => {
    const key = contactId.trim().toLowerCase();
    if (!key || key === DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER) return;
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : 0;
    const existing = byContact.get(key);
    if (!existing) {
      byContact.set(key, {
        contactId: key,
        name: name.trim() || "Co-sponsor",
        isCoGp: true,
        createdAtMs,
      });
      return;
    }
    existing.isCoGp = true;
    if (!existing.name || existing.name === "Company user") {
      const next = name.trim();
      if (next) existing.name = next;
    }
  };

  const investments = await db
    .select({
      contactId: dealInvestment.contactId,
      role: dealInvestment.investor_role,
      name: dealInvestment.contactDisplayName,
      createdAt: dealInvestment.createdAt,
    })
    .from(dealInvestment)
    .where(
      and(eq(dealInvestment.dealId, did), eq(dealInvestment.isDraft, false)),
    );
  for (const row of investments) {
    if (!isCoSponsorStoredRole(row.role)) continue;
    rememberCoGp(row.contactId, row.name, row.createdAt);
  }

  const lpRoster = await db
    .select({
      contactId: dealLpInvestor.contactMemberId,
      role: dealLpInvestor.role,
      name: dealLpInvestor.investorName,
      createdAt: dealLpInvestor.createdAt,
    })
    .from(dealLpInvestor)
    .where(
      and(eq(dealLpInvestor.dealId, did), eq(dealLpInvestor.isDraft, false)),
    );
  for (const row of lpRoster) {
    if (!isCoSponsorStoredRole(row.role)) continue;
    rememberCoGp(row.contactId, row.name, row.createdAt);
  }

  return [...byContact.values()];
}

export async function countDealCompanyUsers(dealId: string): Promise<number> {
  const roster = await listDealBillingRoster(dealId);
  return roster.length;
}

export async function countDealCoGps(dealId: string): Promise<number> {
  const roster = await listDealBillingRoster(dealId);
  return roster.reduce((count, member) => count + (member.isCoGp ? 1 : 0), 0);
}

export async function contactIsDealCompanyUser(
  dealId: string,
  contactId: string,
): Promise<boolean> {
  const did = normalizeDealId(dealId);
  const cid = String(contactId ?? "").trim();
  if (!did || !cid || cid === DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER) {
    return false;
  }
  const rows = await db
    .select({
      contactMemberId: dealMember.contactMemberId,
      dealMemberRole: dealMember.dealMemberRole,
    })
    .from(dealMember)
    .where(
      and(
        eq(dealMember.dealId, did),
        eq(dealMember.isDraft, false),
        sql`lower(trim(${dealMember.contactMemberId})) = ${cid.toLowerCase()}`,
      ),
    );
  return rows.some((row) => isDealCompanyUserStoredRole(row.dealMemberRole));
}

async function latestPaidInvoiceCents(
  subscriptionId: string | null | undefined,
): Promise<number | null> {
  const id = String(subscriptionId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ amountPaidCents: companyBillingInvoices.amountPaidCents })
    .from(companyBillingInvoices)
    .where(
      and(
        eq(companyBillingInvoices.stripeSubscriptionId, id),
        eq(companyBillingInvoices.status, "paid"),
      ),
    )
    .orderBy(desc(companyBillingInvoices.paidAt))
    .limit(1);
  const amount = Number(row?.amountPaidCents ?? 0);
  return amount > 0 ? amount : null;
}

async function resolveDealPlanId(
  dealId: string,
  stripePlanId: string | null | undefined,
  coGpCount: number,
): Promise<StripeBillingPlanId> {
  const fromSub = normalizeBillingPlanId(stripePlanId);
  if (fromSub) return fromSub;
  const raise = await raiseAmountForDeal(dealId);
  return economicPlanIdForDeal(raise, coGpCount);
}

export async function getDealCompanyUserSnapshot(
  dealId: string,
  options?: { seatBand?: string | null },
): Promise<DealCompanyUserSnapshot | null> {
  const did = normalizeDealId(dealId);
  if (!did) return null;
  const [deal] = await db
    .select({
      id: addDealForm.id,
      dealName: addDealForm.dealName,
      organizationId: addDealForm.organizationId,
      stripePlanId: addDealForm.stripePlanId,
      stripeSubscriptionId: addDealForm.stripeSubscriptionId,
      stripeSubscriptionStatus: addDealForm.stripeSubscriptionStatus,
      stripePriceId: addDealForm.stripePriceId,
      stripeSeatBand: addDealForm.stripeSeatBand,
      extraCompanyUsersPaid: addDealForm.extraCompanyUsersPaid,
      saasBillingStartsAt: addDealForm.saasBillingStartsAt,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, did))
    .limit(1);
  if (!deal) return null;
  const subscriptionStatus = String(deal.stripeSubscriptionStatus ?? "none")
    .trim()
    .toLowerCase();
  const paidPlanStillApplies =
    Boolean(deal.stripeSubscriptionId?.trim()) &&
    (subscriptionStatus === "active" ||
      subscriptionStatus === "trialing" ||
      subscriptionStatus === "past_due" ||
      subscriptionStatus === "unpaid");
  const roster = await listDealBillingRoster(did);
  const coGpCount = roster.reduce(
    (count, member) => count + (member.isCoGp ? 1 : 0),
    0,
  );
  const planId = paidPlanStillApplies
    ? await resolveDealPlanId(did, deal.stripePlanId, coGpCount)
    : economicPlanIdForDeal(await raiseAmountForDeal(did), coGpCount);
  const included = includedCompanyUsersForPlan(planId);
  const paid = Math.max(0, Number(deal.extraCompanyUsersPaid ?? 0) || 0);
  const rosterSeat = suggestedSeatBandForCoGpCount(coGpCount);
  const subscribedSeat =
    normalizeBillingSeatBand(deal.stripeSeatBand) ??
    planAndCycleFromPriceId(deal.stripePriceId).seatBand;
  const paidPackageCents = await latestPaidInvoiceCents(
    deal.stripeSubscriptionId,
  );
  const paidCoversAllCoSponsors = paidAmountIncludesAllCoSponsors(paidPackageCents);
  const requestedSeat = normalizeBillingSeatBand(options?.seatBand);
  const seatRank: Record<StripeBillingSeatBand, number> = {
    "5": 1,
    "10": 2,
    "10plus": 3,
  };
  const coverageSeat = paidCoversAllCoSponsors
    ? "10plus"
    : requestedSeat ??
      (subscribedSeat && seatRank[subscribedSeat] > seatRank[rosterSeat]
        ? subscribedSeat
        : rosterSeat);
  const includedCoGps = includedCoGpsForSeatBand(coverageSeat);
  const billing = buildExtraUserBilling({
    members: roster,
    includedCoGps,
    paid,
  });
  return {
    dealId: did,
    dealName: deal.dealName ?? "",
    organizationId: deal.organizationId ? String(deal.organizationId) : null,
    planId,
    includedCompanyUsers: included,
    currentCompanyUsers: billing.currentCompanyUsers,
    coGpCount: billing.coGpCount,
    seatBand: paidCoversAllCoSponsors ? "10plus" : subscribedSeat,
    includedCoGps,
    extraCompanyUsersPaid: paid,
    extraCompanyUsersDue: billing.coGpsToCharge.length,
    extraUserFeeCents: EXTRA_COMPANY_USER_FEE_CENTS,
    extraUserComment: billing.comment,
    saasBillingStartsAt: deal.saasBillingStartsAt ?? null,
  };
}

export function descriptionForExtraCompanyUserCharge(
  snapshot: Pick<
    DealCompanyUserSnapshot,
    "extraUserComment" | "extraCompanyUsersDue"
  >,
  quantity: number,
): string {
  return extraCompanyUserChargeDescription({
    quantity,
    comment: snapshot.extraUserComment,
    namedCoGps: snapshot.extraCompanyUsersDue,
  });
}

export function extraCompanyUsersToCharge(
  snapshot: DealCompanyUserSnapshot,
): number {
  return Math.max(0, Math.floor(snapshot.extraCompanyUsersDue));
}

export async function assertExtraCompanyUserAllowedForAdd(params: {
  dealId: string;
  contactId: string;
  investorRole: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: number; payload: ExtraCompanyUserPaymentRequiredPayload }
> {
  if (isLpInvestorRole(params.investorRole)) {
    return { ok: true };
  }
  if (!isDealCompanyUserStoredRole(params.investorRole)) {
    return { ok: true };
  }
  const contactId = String(params.contactId ?? "").trim();
  if (!contactId || contactId === DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER) {
    return { ok: true };
  }
  if (await contactIsDealCompanyUser(params.dealId, contactId)) {
    return { ok: true };
  }
  const snapshot = await getDealCompanyUserSnapshot(params.dealId);
  if (!snapshot) return { ok: true };

  const nextCount = snapshot.currentCompanyUsers + 1;
  if (nextCount > MAX_SELF_SERVE_COMPANY_USERS) {
    return {
      ok: false,
      status: 400,
      payload: {
        code: EXTRA_COMPANY_USER_PAYMENT_REQUIRED,
        message:
          "This deal would have 25 or more company users. Contact sales for custom pricing.",
        dealId: snapshot.dealId,
        dealName: snapshot.dealName,
        planId: snapshot.planId,
        includedCompanyUsers: snapshot.includedCompanyUsers,
        currentCompanyUsers: snapshot.currentCompanyUsers,
        extraUsersToPay: 0,
        extraUserFeeCents: EXTRA_COMPANY_USER_FEE_CENTS,
        amountDueCents: 0,
      },
    };
  }

  if (!isCoGpStoredRole(params.investorRole)) return { ok: true };
  // 6th co-sponsor uses the 10 package. 11th uses 10+. No $10 add-on.
  return { ok: true };
}

export async function creditExtraCompanyUsersPaid(params: {
  dealId: string;
  quantity: number;
  paymentRef: string;
}): Promise<void> {
  const did = normalizeDealId(params.dealId);
  const qty = Math.max(0, Math.floor(params.quantity));
  const paymentRef = String(params.paymentRef ?? "").trim();
  if (!did || qty <= 0 || !paymentRef) return;

  await db
    .update(addDealForm)
    .set({
      extraCompanyUsersPaid: sql`${addDealForm.extraCompanyUsersPaid} + ${qty}`,
      extraCompanyUsersLastPaymentRef: paymentRef,
    })
    .where(
      and(
        eq(addDealForm.id, did),
        sql`coalesce(${addDealForm.extraCompanyUsersLastPaymentRef}, '') <> ${paymentRef}`,
      ),
    );
}

export function parseExtraCompanyUsersQuantity(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  return 0;
}
