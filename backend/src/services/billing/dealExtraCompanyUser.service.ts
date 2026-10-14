import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "../../database/db.js";
import { addDealForm, contact, dealInvestorClass, dealInvestment, dealLpInvestor, dealMember, users } from "../../schema/schema.js";
import {
  EXTRA_COMPANY_USER_FEE_CENTS,
  EXTRA_COMPANY_USER_PAYMENT_REQUIRED,
  includedCompanyUsersForPlan,
  MAX_SELF_SERVE_COMPANY_USERS,
  normalizeBillingPlanId,
  normalizeBillingSeatBand,
  planAndCycleFromPriceId,
  type StripeBillingPlanId,
  type StripeBillingSeatBand,
} from "../../config/stripe.config.js";
import {
  DEAL_INVESTMENT_AUTOSAVE_CONTACT_PLACEHOLDER,
  isDealCompanyUserStoredRole,
  isLpInvestorRole,
} from "../deal/dealInvestment.service.js";
import { dealSaasBillingHasStarted } from "./saasBillingStartDate.js";

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

/** 5 and 10 co-sponsors are included in those packages. 10+ includes 12; each Co-GP past 12 is $10. */
export function includedCoGpsForSeatBand(
  seatBand: string | null | undefined,
): number | null {
  const band = normalizeBillingSeatBand(seatBand);
  if (band === "5") return 5;
  if (band === "10") return 10;
  if (band === "10plus") return 12;
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

export function coGpSeatBandNeedsUpgrade(
  currentSeatBand: string | null | undefined,
  coGpCount: number,
): boolean {
  const current = normalizeBillingSeatBand(currentSeatBand) ?? "5";
  const suggested = suggestedSeatBandForCoGpCount(coGpCount);
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

async function resolveDealPlanId(
  dealId: string,
  stripePlanId: string | null | undefined,
): Promise<StripeBillingPlanId> {
  const fromSub = normalizeBillingPlanId(stripePlanId);
  if (fromSub) return fromSub;
  const raise = await raiseAmountForDeal(dealId);
  return planIdForDealRaiseAmount(raise);
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
  const planId = paidPlanStillApplies
    ? await resolveDealPlanId(did, deal.stripePlanId)
    : planIdForDealRaiseAmount(await raiseAmountForDeal(did));
  const included = includedCompanyUsersForPlan(planId);
  const roster = await listDealBillingRoster(did);
  const paid = Math.max(0, Number(deal.extraCompanyUsersPaid ?? 0) || 0);
  const seatBand =
    normalizeBillingSeatBand(options?.seatBand) ??
    planAndCycleFromPriceId(deal.stripePriceId).seatBand;
  const includedCoGps = includedCoGpsForSeatBand(seatBand) ?? 5;
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
    seatBand,
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
  if (snapshot.includedCoGps == null) return { ok: true };

  const roster = await listDealBillingRoster(params.dealId);
  const billing = buildExtraUserBilling({
    members: [
      ...roster,
      {
        contactId: contactId.toLowerCase(),
        name: "this GP",
        isCoGp: true,
        createdAtMs: Date.now(),
      },
    ],
    includedCoGps: snapshot.includedCoGps,
    paid: snapshot.extraCompanyUsersPaid,
  });
  if (billing.coGpsToCharge.length === 0) return { ok: true };
  if (!dealSaasBillingHasStarted(snapshot)) return { ok: true };

  const extraUsersToPay = billing.coGpsToCharge.length;
  const amountDueCents = extraUsersToPay * EXTRA_COMPANY_USER_FEE_CENTS;
  return {
    ok: false,
    status: 402,
    payload: {
      code: EXTRA_COMPANY_USER_PAYMENT_REQUIRED,
      message: `This deal includes ${snapshot.includedCoGps} co-sponsors. ${billing.comment || `Pay $${(amountDueCents / 100).toFixed(0)} ($10 each) for ${extraUsersToPay} GP${extraUsersToPay === 1 ? "" : "s"} beyond that count.`}`,
      dealId: snapshot.dealId,
      dealName: snapshot.dealName,
      planId: snapshot.planId,
      includedCompanyUsers: snapshot.includedCompanyUsers,
      currentCompanyUsers: snapshot.currentCompanyUsers,
      extraUsersToPay,
      extraUserFeeCents: EXTRA_COMPANY_USER_FEE_CENTS,
      amountDueCents,
      comment: billing.comment,
    },
  };
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
