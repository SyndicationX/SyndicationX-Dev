import Stripe from "stripe";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, pool } from "../../database/db.js";
import {
  addDealForm,
  companies,
  companyBillingEvents,
  companyBillingInvoices,
  companyBillingPaymentMethods,
  users,
} from "../../schema/schema.js";
import {
  getStripeConfig,
  normalizeBillingPlanId,
  normalizeBillingSeatBand,
  planAndCycleFromPriceId,
  priceEnvNameFor,
  requireStripeConfig,
  resolveFrontendOrigin,
  resolveStripePriceId,
  STRIPE_BILLING_PLAN_IDS,
  STRIPE_BILLING_SEAT_BANDS,
  type StripeBillingCycle,
  type StripeBillingPlanId,
  type StripeBillingSeatBand,
} from "../../config/stripe.config.js";
import {
  isCompanyAdminRole,
  isPlatformAdminRole,
} from "../../constants/roles.js";
import { userHasAccessToOrganization } from "../org/orgResolution.service.js";
import { releaseBillingPaymentHold } from "../../middleware/billingPaymentLock.js";
import {
  createDealStripeSubscription,
  periodEndFromSubscription,
  billingPlanRank,
  suggestedPlanIdForDeal,
  upgradeDealStripeSubscription,
  restoreSubscriptionToSnapshot,
} from "./dealBilling.service.js";
import {
  catalogPackagePriceCents,
  countDealCoGps,
  couponCheckoutLineCents,
  couponDurationAppliesToOneTime,
  differenceRepeatPriceCents,
  priceGapCents,
  stripePriceIdForPlatformAmount,
  suggestedSeatBandForDeal,
} from "./dealExtraCompanyUser.service.js";
import {
  dealSaasBillingHasStarted,
  dealSaasBillingNotYetDueMessage,
} from "./saasBillingStartDate.js";

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  const cfg = requireStripeConfig();
  if (!stripeClient) {
    stripeClient = new Stripe(cfg.secretKey, {
      apiVersion: "2026-06-24.dahlia",
    });
  }
  return stripeClient;
}

const COMPANY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCompanyId(raw: string): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  return COMPANY_UUID_RE.test(s) ? s : null;
}

export async function userCanManageCompanyBilling(
  userId: string,
  userRole: string | undefined,
  companyId: string,
): Promise<boolean> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return false;
  const [co] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!co) return false;
  if (isPlatformAdminRole(userRole)) return true;
  if (!isCompanyAdminRole(userRole)) return false;
  return userHasAccessToOrganization(userId, cid);
}

export type CompanyBillingViewerScope = "all_deals" | "lead_sponsor";

export type CompanyBillingAccess = {
  canView: boolean;
  canManage: boolean;
  canPay: boolean;
  viewerScope: CompanyBillingViewerScope;
  /** `null` = every deal in the company; otherwise only these deal ids. */
  dealIds: string[] | null;
};

const DENIED_BILLING_ACCESS: CompanyBillingAccess = {
  canView: false,
  canManage: false,
  canPay: false,
  viewerScope: "lead_sponsor",
  dealIds: [],
};

/**
 * Org / platform admins manage billing and see every deal.
 * Lead sponsors may view billing only for deals they lead.
 */
export async function resolveCompanyBillingAccess(
  userId: string,
  userRole: string | undefined,
  companyId: string,
): Promise<CompanyBillingAccess> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return DENIED_BILLING_ACCESS;

  const { listLeadSponsorDealIdsInCompany } = await import(
    "./dealBilling.service.js"
  );
  const leadDealIds = await listLeadSponsorDealIdsInCompany(userId, cid);
  const canManage = await userCanManageCompanyBilling(userId, userRole, cid);
  if (canManage) {
    const platformAdmin = isPlatformAdminRole(userRole);
    if (platformAdmin && leadDealIds.length > 0) {
      return {
        canView: true,
        canManage: true,
        canPay: true,
        viewerScope: "lead_sponsor",
        dealIds: leadDealIds,
      };
    }
    return {
      canView: true,
      canManage: true,
      // Platform admins may view other customers’ records, but only pay when
      // they are the lead sponsor on the deal.
      canPay: !platformAdmin,
      viewerScope: "all_deals",
      dealIds: null,
    };
  }

  const dealIds = leadDealIds;
  if (dealIds.length === 0) return DENIED_BILLING_ACCESS;
  return {
    canView: true,
    canManage: false,
    canPay: true,
    viewerScope: "lead_sponsor",
    dealIds,
  };
}

export type CompanyBillingStatus = {
  configured: boolean;
  testMode: boolean;
  webhookConfigured: boolean;
  companyId: string;
  planId: string | null;
  billingCycle: string | null;
  subscriptionStatus: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  hasCustomer: boolean;
  hasSubscription: boolean;
  lastPaymentError: string | null;
  lastPaymentFailedAt: string | null;
  paymentHealthy: boolean;
  /** Active per-deal SaaS subscriptions (capital raising / asset managing). */
  billedDealCount: number;
  canManage: boolean;
  canPay: boolean;
  viewerScope: CompanyBillingViewerScope;
  saasBillingStartsAt: string | null;
  plansConfigured: Array<{
    id: StripeBillingPlanId;
    monthlyReady: boolean;
    annualReady: boolean;
    monthlyEnv: string;
    annualEnv: string;
    seats: Array<{
      seatBand: StripeBillingSeatBand;
      monthlyReady: boolean;
      annualReady: boolean;
      monthlyEnv: string;
      annualEnv: string;
    }>;
  }>;
};

export async function getCompanyBillingStatus(
  companyId: string,
  options?: {
    dealIds?: string[] | null;
    canManage?: boolean;
    canPay?: boolean;
    viewerScope?: CompanyBillingViewerScope;
  },
): Promise<CompanyBillingStatus | null> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return null;
  const [row] = await db
    .select({
      id: companies.id,
      stripeCustomerId: companies.stripeCustomerId,
      stripeSubscriptionId: companies.stripeSubscriptionId,
      stripePlanId: companies.stripePlanId,
      stripeBillingCycle: companies.stripeBillingCycle,
      stripeSubscriptionStatus: companies.stripeSubscriptionStatus,
      stripePriceId: companies.stripePriceId,
      stripeCurrentPeriodEnd: companies.stripeCurrentPeriodEnd,
      stripeLastPaymentError: companies.stripeLastPaymentError,
      stripeLastPaymentFailedAt: companies.stripeLastPaymentFailedAt,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!row) return null;

  const cfg = getStripeConfig();
  const publicPlans = cfg
    ? STRIPE_BILLING_PLAN_IDS.map((id) => {
        const seats = STRIPE_BILLING_SEAT_BANDS.map((seatBand) => ({
          seatBand,
          monthlyReady: Boolean(cfg.prices[id][seatBand].monthly),
          annualReady: Boolean(cfg.prices[id][seatBand].annual),
          monthlyEnv: priceEnvNameFor(id, "monthly", seatBand),
          annualEnv: priceEnvNameFor(id, "annual", seatBand),
        }));
        return {
          id,
          monthlyReady: seats.some((s) => s.monthlyReady),
          annualReady: seats.some((s) => s.annualReady),
          monthlyEnv: priceEnvNameFor(id, "monthly", "5"),
          annualEnv: priceEnvNameFor(id, "annual", "5"),
          seats,
        };
      })
    : [];

  const subscriptionStatus = row.stripeSubscriptionStatus || "none";
  const paymentHealthy =
    !row.stripeLastPaymentError &&
    subscriptionStatus !== "past_due" &&
    subscriptionStatus !== "unpaid" &&
    subscriptionStatus !== "incomplete";

  const status: CompanyBillingStatus = {
    configured: Boolean(cfg),
    testMode: cfg?.testMode ?? false,
    webhookConfigured: Boolean(cfg?.webhookSecret),
    companyId: row.id,
    planId: row.stripePlanId,
    billingCycle: row.stripeBillingCycle,
    subscriptionStatus,
    priceId: row.stripePriceId,
    currentPeriodEnd: row.stripeCurrentPeriodEnd
      ? row.stripeCurrentPeriodEnd.toISOString()
      : null,
    hasCustomer: Boolean(row.stripeCustomerId),
    hasSubscription: Boolean(row.stripeSubscriptionId),
    lastPaymentError: row.stripeLastPaymentError,
    lastPaymentFailedAt: row.stripeLastPaymentFailedAt
      ? row.stripeLastPaymentFailedAt.toISOString()
      : null,
    paymentHealthy,
    billedDealCount: 0,
    canManage: options?.canManage ?? true,
    canPay: options?.canPay ?? options?.canManage ?? true,
    viewerScope: options?.viewerScope ?? "all_deals",
    saasBillingStartsAt: null,
    plansConfigured: publicPlans,
  };

  try {
    const {
      countBilledDealsForCompany,
      getPlatformSaasBillingStartsAtIso,
    } = await import("./dealBilling.service.js");
    const platformStart = await getPlatformSaasBillingStartsAtIso();
    if (platformStart) status.saasBillingStartsAt = platformStart;
    const scopedDealIds = options?.dealIds;
    const dealBilling = await countBilledDealsForCompany(
      row.id,
      scopedDealIds,
    );
    status.billedDealCount = dealBilling.billedDealCount;
    if (Array.isArray(scopedDealIds)) {
      status.currentPeriodEnd = dealBilling.nextDealBillingDate;
      status.hasSubscription = dealBilling.billedDealCount > 0;
    } else {
      if (dealBilling.nextDealBillingDate) {
        status.currentPeriodEnd = dealBilling.nextDealBillingDate;
      }
      if (dealBilling.billedDealCount > 0) {
        status.hasSubscription = true;
      }
    }
  } catch (err) {
    console.warn("getCompanyBillingStatus deal billing:", err);
  }

  return status;
}

async function ensureStripeCustomer(params: {
  companyId: string;
  actorUserId: string;
}): Promise<string> {
  const cid = normalizeCompanyId(params.companyId);
  if (!cid) throw new Error("Invalid company id");

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!company) throw new Error("Company not found");

  let replacedCustomerId = "";
  if (company.stripeCustomerId?.trim()) {
    const existingId = company.stripeCustomerId.trim();
    const stripe = getStripeClient();
    try {
      const existing = await stripe.customers.retrieve(existingId);
      if (!existing.deleted) return existingId;
    } catch (err) {
      const missing =
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing";
      if (!missing) throw err;
    }
    replacedCustomerId = existingId;
    await db
      .update(companies)
      .set({ stripeCustomerId: null, updatedAt: new Date() })
      .where(
        and(eq(companies.id, cid), eq(companies.stripeCustomerId, existingId)),
      );
  }

  const [actor] = await db
    .select({ email: users.email, name: users.username })
    .from(users)
    .where(eq(users.id, params.actorUserId))
    .limit(1);

  const stripe = getStripeClient();
  const customer = await stripe.customers.create(
    {
      name: company.name,
      email: actor?.email?.trim() || undefined,
      metadata: {
        companyId: cid,
        companyName: company.name,
      },
    },
    {
      idempotencyKey: replacedCustomerId
        ? `company_customer_${cid}_replaces_${replacedCustomerId}`
        : `company_customer_${cid}`,
    },
  );

  // Race-safe: only write if still empty; another request may have won.
  await db
    .update(companies)
    .set({
      stripeCustomerId: customer.id,
      updatedAt: new Date(),
    })
    .where(and(eq(companies.id, cid), isNull(companies.stripeCustomerId)));

  const [after] = await db
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  return after?.stripeCustomerId?.trim() || customer.id;
}

/**
 * Stripe customer for one user's saved cards. Company and deal customers are
 * not used here, so a card saved by one person is not an organization record.
 */
async function ensureUserCardStripeCustomer(params: {
  companyId: string;
  actorUserId: string;
}): Promise<string> {
  const userId = normalizeCompanyId(params.actorUserId);
  const cid = normalizeCompanyId(params.companyId);
  if (!userId || !cid) throw new Error("Invalid user id");

  const [actor] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      firstName: users.firstName,
      lastName: users.lastName,
      stripeCustomerId: users.stripeCustomerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!actor) throw new Error("User not found");

  const stripe = getStripeClient();
  const storedId = actor.stripeCustomerId?.trim() ?? "";
  if (storedId) {
    try {
      const existing = await stripe.customers.retrieve(storedId);
      if (!("deleted" in existing && existing.deleted)) return storedId;
    } catch (err) {
      const missing =
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing";
      if (!missing) throw err;
    }
    await db
      .update(users)
      .set({ stripeCustomerId: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.stripeCustomerId, storedId)));
  }

  const name =
    [actor.firstName, actor.lastName].filter((part) => part?.trim()).join(" ").trim() ||
    actor.username;
  const customer = await stripe.customers.create(
    {
      name: name || undefined,
      email: actor.email?.trim() || undefined,
      metadata: {
        payerUserId: userId,
        companyId: cid,
        billingScope: "user_payment_method",
      },
    },
    {
      idempotencyKey: storedId
        ? `user_card_customer_${userId}_replaces_${storedId}`
        : `user_card_customer_${userId}`,
    },
  );

  await db
    .update(users)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.stripeCustomerId)));

  const [after] = await db
    .select({ stripeCustomerId: users.stripeCustomerId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return after?.stripeCustomerId?.trim() || customer.id;
}

async function userIdForStripeCustomer(
  customerId: string | null | undefined,
): Promise<string | null> {
  const id = String(customerId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, id))
    .limit(1);
  return row?.id ?? null;
}

const SQL_ROLE_IS_LEAD = `(
  lower(trim(%COL%)) IN ('lead sponsor', 'lead_sponsor')
  OR (
    position('lead' in lower(trim(%COL%))) > 0
    AND position('sponsor' in lower(trim(%COL%))) > 0
    AND position('admin' in lower(trim(%COL%))) = 0
  )
)`;

function sqlRoleIsLead(columnSql: string): string {
  return SQL_ROLE_IS_LEAD.replaceAll("%COL%", columnSql);
}

/** Stripe Customer.phone must be E.164. Blank or unusable values are omitted. */
function stripeE164Phone(raw: string | null | undefined): string | undefined {
  const text = String(raw ?? "").trim();
  if (!text) return undefined;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return undefined;
  if (text.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

type DealPayerContact = {
  email: string;
  phone?: string;
  name: string;
};

/**
 * Lead sponsor for this deal. The paying user's own row wins when they are
 * the lead sponsor; otherwise the roster lead sponsor is used.
 */
async function resolveDealPayerContact(params: {
  dealId: string;
  actorUserId: string;
}): Promise<DealPayerContact | null> {
  const dealId = normalizeCompanyId(params.dealId);
  if (!dealId) return null;
  const actorId = normalizeCompanyId(params.actorUserId);
  const leadMember = sqlRoleIsLead("dm.deal_member_role");
  const leadInvestment = sqlRoleIsLead("di.investor_role");
  const res = await pool.query<{
    email: string;
    phone: string | null;
    display_name: string | null;
  }>(
    `SELECT email, phone, display_name FROM (
       SELECT lower(trim(u.email)) AS email,
              trim(u.phone) AS phone,
              trim(concat_ws(' ', nullif(trim(u.first_name), ''), nullif(trim(u.last_name), ''))) AS display_name,
              CASE WHEN $2::uuid IS NOT NULL AND u.id = $2::uuid THEN 0 ELSE 1 END AS priority
       FROM deal_member dm
       INNER JOIN users u ON u.id::text = trim(dm.contact_member_id)
       WHERE dm.deal_id = $1::uuid
         AND dm.is_draft = false
         AND ${leadMember}
         AND u.email IS NOT NULL AND trim(u.email) <> ''
       UNION ALL
       SELECT lower(trim(c.email)) AS email,
              COALESCE(NULLIF(trim(u.phone), ''), NULLIF(trim(c.phone), ''), '') AS phone,
              COALESCE(
                NULLIF(trim(c.full_name), ''),
                trim(concat_ws(' ', nullif(trim(c.first_name), ''), nullif(trim(c.last_name), '')))
              ) AS display_name,
              CASE WHEN $2::uuid IS NOT NULL AND u.id = $2::uuid THEN 0 ELSE 2 END AS priority
       FROM deal_member dm
       INNER JOIN contact c ON c.id::text = trim(dm.contact_member_id)
       LEFT JOIN users u ON lower(trim(u.email)) = lower(trim(c.email))
       WHERE dm.deal_id = $1::uuid
         AND dm.is_draft = false
         AND ${leadMember}
         AND c.email IS NOT NULL AND trim(c.email) <> ''
       UNION ALL
       SELECT lower(trim(u.email)) AS email,
              trim(u.phone) AS phone,
              trim(concat_ws(' ', nullif(trim(u.first_name), ''), nullif(trim(u.last_name), ''))) AS display_name,
              CASE WHEN $2::uuid IS NOT NULL AND u.id = $2::uuid THEN 0 ELSE 1 END AS priority
       FROM deal_investment di
       INNER JOIN users u ON u.id::text = trim(di.contact_id)
       WHERE di.deal_id = $1::uuid
         AND di.is_draft = false
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND ${leadInvestment}
         AND u.email IS NOT NULL AND trim(u.email) <> ''
       UNION ALL
       SELECT lower(trim(c.email)) AS email,
              COALESCE(NULLIF(trim(u.phone), ''), NULLIF(trim(c.phone), ''), '') AS phone,
              COALESCE(
                NULLIF(trim(c.full_name), ''),
                trim(concat_ws(' ', nullif(trim(c.first_name), ''), nullif(trim(c.last_name), '')))
              ) AS display_name,
              CASE WHEN $2::uuid IS NOT NULL AND u.id = $2::uuid THEN 0 ELSE 2 END AS priority
       FROM deal_investment di
       INNER JOIN contact c ON c.id::text = trim(di.contact_id)
       LEFT JOIN users u ON lower(trim(u.email)) = lower(trim(c.email))
       WHERE di.deal_id = $1::uuid
         AND di.is_draft = false
         AND trim(di.contact_id) <> '__portal_investment_autosave__'
         AND ${leadInvestment}
         AND c.email IS NOT NULL AND trim(c.email) <> ''
     ) payers
     WHERE position('@' in email) > 1
     ORDER BY priority
     LIMIT 1`,
    [dealId, actorId],
  );
  const row = res.rows[0];
  if (!row?.email?.includes("@")) return null;
  const email = row.email.trim().toLowerCase();
  const name = String(row.display_name ?? "").trim() || email;
  return {
    email,
    phone: stripeE164Phone(row.phone),
    name,
  };
}

async function fallbackActorPayer(
  actorUserId: string,
): Promise<DealPayerContact | null> {
  const actorId = normalizeCompanyId(actorUserId);
  if (!actorId) return null;
  const [actor] = await db
    .select({
      email: users.email,
      phone: users.phone,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  const email = actor?.email?.trim().toLowerCase() ?? "";
  if (!email.includes("@")) return null;
  const name =
    [actor?.firstName, actor?.lastName]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ") || email;
  return { email, phone: stripeE164Phone(actor?.phone), name };
}

/**
 * Stripe Customer for this deal's lead sponsor. Email and phone are refreshed
 * on every payment so Link and the contact field follow the current sponsor.
 */
async function ensureDealPayerStripeCustomer(params: {
  companyId: string;
  dealId: string;
  actorUserId: string;
}): Promise<string> {
  const cid = normalizeCompanyId(params.companyId);
  const dealId = normalizeCompanyId(params.dealId);
  if (!cid || !dealId) throw new Error("Invalid company or deal id");

  const payer =
    (await resolveDealPayerContact({
      dealId,
      actorUserId: params.actorUserId,
    })) ?? (await fallbackActorPayer(params.actorUserId));
  if (!payer) {
    throw new Error(
      "This deal has no lead sponsor email, so Stripe cannot open checkout.",
    );
  }

  const [deal] = await db
    .select({
      stripePayerCustomerId: addDealForm.stripePayerCustomerId,
      dealName: addDealForm.dealName,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  if (!deal) throw new Error("Deal not found");

  const [company] = await db
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  const companyCustomerId = company?.stripeCustomerId?.trim() ?? "";

  const stripe = getStripeClient();
  const profile = {
    email: payer.email,
    name: payer.name,
    ...(payer.phone ? { phone: payer.phone } : {}),
    metadata: {
      companyId: cid,
      dealId,
      dealName: deal.dealName ?? "",
      payerRole: "lead_sponsor",
    },
  };

  // The company customer is shared and keeps whoever first opened billing.
  // A deal payment must not reuse or rewrite that customer.
  const storedPayerId = deal.stripePayerCustomerId?.trim() ?? "";
  const storedId =
    storedPayerId && storedPayerId !== companyCustomerId ? storedPayerId : "";
  if (storedId) {
    try {
      const existing = await stripe.customers.retrieve(storedId);
      if (!existing.deleted) {
        const phoneChanged = payer.phone
          ? existing.phone !== payer.phone
          : false;
        if (
          existing.email?.trim().toLowerCase() !== payer.email ||
          existing.name !== payer.name ||
          phoneChanged
        ) {
          await stripe.customers.update(storedId, profile);
        }
        return storedId;
      }
    } catch (err) {
      const missing =
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === "resource_missing";
      if (!missing) throw err;
    }
  }

  const customer = await stripe.customers.create(profile, {
    idempotencyKey: storedId
      ? `deal_payer_${dealId}_replaces_${storedId}`
      : `deal_payer_${dealId}`,
  });

  await db
    .update(addDealForm)
    .set({ stripePayerCustomerId: customer.id })
    .where(eq(addDealForm.id, dealId));
  return customer.id;
}

export function stripeCustomerIdOf(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string {
  if (!customer) return "";
  return typeof customer === "string" ? customer : customer.id ?? "";
}

export const SAVED_CARD_USE_NEW_METHOD_MESSAGE =
  "This saved card can't be used for this deal. Select Pay with new method. You can enter the same card there.";

export type SavedDealPaymentDecision =
  | { action: "charge"; customerId: string; paymentMethodId: string }
  | { action: "attach"; customerId: string; paymentMethodId: string }
  | { action: "reject"; message: string };

/**
 * One saved-card attempt charges the Stripe customer that already holds that
 * card. The paying user's customer and this deal's payer customer are valid.
 * The organization customer is not.
 */
export function decideSavedDealPayment(params: {
  payerCustomerId: string;
  attachedCustomerId: string;
  paymentMethodId: string;
  /** Company customer and every deal payer customer for this company. */
  ownedCustomerIds?: string[];
}): SavedDealPaymentDecision {
  const payerCustomerId = params.payerCustomerId.trim();
  const attachedCustomerId = params.attachedCustomerId.trim();
  const owned = new Set(
    (params.ownedCustomerIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (payerCustomerId) owned.add(payerCustomerId);

  if (attachedCustomerId) {
    if (owned.size > 0 && !owned.has(attachedCustomerId)) {
      return { action: "reject", message: SAVED_CARD_USE_NEW_METHOD_MESSAGE };
    }
    return {
      action: "charge",
      customerId: attachedCustomerId,
      paymentMethodId: params.paymentMethodId,
    };
  }
  return {
    action: "attach",
    customerId: payerCustomerId,
    paymentMethodId: params.paymentMethodId,
  };
}

/** Deal payer customers for this company. The organization customer is excluded. */
async function dealPayerStripeCustomerIds(companyId: string): Promise<string[]> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return [];
  const payerRows = await db
    .select({ stripePayerCustomerId: addDealForm.stripePayerCustomerId })
    .from(addDealForm)
    .where(
      and(
        eq(addDealForm.organizationId, cid),
        isNotNull(addDealForm.stripePayerCustomerId),
      ),
    );
  return [
    ...new Set(
      payerRows
        .map((row) => String(row.stripePayerCustomerId ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

async function organizationStripeCustomerId(companyId: string): Promise<string> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return "";
  const [company] = await db
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  return company?.stripeCustomerId?.trim() ?? "";
}

/**
 * Charge a saved card on the customer that already holds it. A card that
 * belongs to another company's Stripe customer is not moved or charged.
 */
async function customerForSavedDealPayment(params: {
  companyId: string;
  dealId: string;
  actorUserId: string;
  paymentMethodId: string;
}): Promise<{ customerId: string; paymentMethodId: string }> {
  const payerCustomerId = await ensureDealPayerStripeCustomer(params);
  const stripe = getStripeClient();
  const pm = await stripe.paymentMethods.retrieve(params.paymentMethodId);
  const attachedCustomerId = stripeCustomerIdOf(pm.customer);
  const organizationCustomerId = await organizationStripeCustomerId(
    params.companyId,
  );
  if (
    organizationCustomerId &&
    attachedCustomerId === organizationCustomerId
  ) {
    throw new Error(
      "Organization cards are not used to pay a deal. Use your own card.",
    );
  }
  const actorId = normalizeCompanyId(params.actorUserId);
  let actorCustomerId = "";
  if (actorId) {
    const [actor] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    actorCustomerId = actor?.stripeCustomerId?.trim() ?? "";
  }
  const decision = decideSavedDealPayment({
    payerCustomerId,
    attachedCustomerId,
    paymentMethodId: params.paymentMethodId,
    ownedCustomerIds: [
      ...(await dealPayerStripeCustomerIds(params.companyId)),
      actorCustomerId,
    ],
  });
  if (decision.action === "reject") {
    throw new Error(decision.message);
  }
  if (decision.action === "attach") {
    await stripe.paymentMethods.attach(decision.paymentMethodId, {
      customer: decision.customerId,
    });
  }
  return {
    customerId: decision.customerId,
    paymentMethodId: decision.paymentMethodId,
  };
}

/**
 * An existing subscription can only be charged with a card on that same
 * Stripe customer. A card saved on another company customer stays in place.
 */
export async function paymentMethodForExistingSubscription(params: {
  stripe: Stripe;
  subscriptionId: string;
  paymentMethodId: string;
  paymentMethodCustomerId: string;
}): Promise<string | undefined> {
  try {
    const sub = await params.stripe.subscriptions.retrieve(params.subscriptionId);
    const subCustomer = stripeCustomerIdOf(sub.customer);
    if (!subCustomer || subCustomer === params.paymentMethodCustomerId) {
      return params.paymentMethodId;
    }
  } catch (err) {
    console.warn("paymentMethodForExistingSubscription:", err);
    return params.paymentMethodId;
  }
  return undefined;
}

/**
 * After a lead-sponsor change, point this deal's Stripe customer at the new
 * sponsor. The shared company customer is left unchanged.
 */
export async function syncDealPayerProfileToCurrentLead(
  dealId: string,
): Promise<void> {
  const id = normalizeCompanyId(dealId);
  if (!id || !getStripeConfig()) return;
  const [deal] = await db
    .select({
      organizationId: addDealForm.organizationId,
      stripePayerCustomerId: addDealForm.stripePayerCustomerId,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, id))
    .limit(1);
  const payerId = deal?.stripePayerCustomerId?.trim() ?? "";
  const companyId = deal?.organizationId ? String(deal.organizationId) : "";
  if (!payerId || !companyId) return;
  await ensureDealPayerStripeCustomer({
    companyId,
    dealId: id,
    actorUserId: "",
  });
}

export type CheckoutResult =
  | { ok: true; url: string; upgraded?: boolean }
  | { ok: false; status: number; message: string };

/** Show the customer's saved card and bank account on the Stripe Checkout page. */
const CHECKOUT_SAVED_PAYMENT_METHODS: Pick<
  Stripe.Checkout.SessionCreateParams,
  "saved_payment_method_options"
> = {
  saved_payment_method_options: {
    payment_method_save: "enabled",
    allow_redisplay_filters: ["always"],
  },
};

/**
 * Checkout may show only this user's saved cards. Other people's methods on
 * the same Stripe customer stay hidden.
 */
async function scopeCheckoutCardsToUser(
  stripe: Stripe,
  customerId: string,
  companyId: string,
  actorUserId: string,
): Promise<void> {
  const id = customerId.trim();
  const cid = normalizeCompanyId(companyId);
  const userId = normalizeCompanyId(actorUserId);
  if (!id || !cid || !userId) return;

  const owned = await db
    .select({
      stripePaymentMethodId: companyBillingPaymentMethods.stripePaymentMethodId,
    })
    .from(companyBillingPaymentMethods)
    .where(
      and(
        eq(companyBillingPaymentMethods.companyId, cid),
        eq(companyBillingPaymentMethods.addedByUserId, userId),
        isNull(companyBillingPaymentMethods.detachedAt),
      ),
    );
  const ownedIds = new Set(owned.map((row) => row.stripePaymentMethodId));
  const methods = await stripe.paymentMethods.list({ customer: id, limit: 100 });
  for (const method of methods.data) {
    const metaOwner = normalizeCompanyId(
      String(method.metadata?.payerUserId ?? ""),
    );
    const mine = ownedIds.has(method.id) || metaOwner === userId;
    const target = mine ? "always" : "limited";
    if (method.allow_redisplay === target) continue;
    try {
      await stripe.paymentMethods.update(method.id, {
        allow_redisplay: target,
      });
    } catch (err) {
      console.warn("scopeCheckoutCardsToUser:", err);
    }
  }
}

/**
 * Checkout uses this user's Stripe customer when they already saved a card,
 * so another person's cards on the company customer are not offered.
 */
async function customerIdShowingSavedCards(
  stripe: Stripe,
  preferredCustomerId: string,
  companyId: string,
  actorUserId: string,
): Promise<string> {
  const preferred = preferredCustomerId.trim();
  const userId = normalizeCompanyId(actorUserId);
  const cid = normalizeCompanyId(companyId);
  let customerId = preferred;
  if (userId && cid) {
    const [owned] = await db
      .select({
        stripeCustomerId: companyBillingPaymentMethods.stripeCustomerId,
      })
      .from(companyBillingPaymentMethods)
      .where(
        and(
          eq(companyBillingPaymentMethods.companyId, cid),
          eq(companyBillingPaymentMethods.addedByUserId, userId),
          isNull(companyBillingPaymentMethods.detachedAt),
          isNotNull(companyBillingPaymentMethods.stripeCustomerId),
        ),
      )
      .orderBy(desc(companyBillingPaymentMethods.createdAt))
      .limit(1);
    const ownedCustomer = owned?.stripeCustomerId?.trim() ?? "";
    if (ownedCustomer) customerId = ownedCustomer;
    else {
      const [userRow] = await db
        .select({ stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const userCustomer = userRow?.stripeCustomerId?.trim() ?? "";
      if (userCustomer) customerId = userCustomer;
    }
  }
  if (customerId) {
    await scopeCheckoutCardsToUser(stripe, customerId, companyId, actorUserId);
  }
  return customerId || preferred;
}

async function promotionCodeIdFromInput(
  raw: string | undefined,
): Promise<
  | {
      ok: true;
      id?: string;
      code?: string;
      preview?: {
        percentOff: number | null;
        amountOffCents: number | null;
        duration: string;
        durationInMonths: number | null;
      };
    }
  | { ok: false; status: number; message: string }
> {
  const code = String(raw ?? "").trim();
  if (!code) return { ok: true };
  const { lookupActivePromotionCode } = await import("./platformCoupon.service.js");
  const looked = await lookupActivePromotionCode(code);
  if (!looked.ok) return { ok: false, status: 400, message: looked.message };
  return {
    ok: true,
    id: looked.preview.promotionCodeId,
    code: looked.preview.code,
    preview: {
      percentOff: looked.preview.percentOff,
      amountOffCents: looked.preview.amountOffCents,
      duration: looked.preview.duration,
      durationInMonths: looked.preview.durationInMonths,
    },
  };
}

async function redeemCoveredDifferenceCoupon(params: {
  stripe: Stripe;
  customerId: string;
  amountCents: number;
  promotionCodeId: string;
  description: string;
  metadata: Record<string, string>;
  /** Subtracted after the coupon, so a covered package invoices at $0. */
  creditCents?: number;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const item = await params.stripe.invoiceItems.create({
    customer: params.customerId,
    amount: params.amountCents,
    currency: "usd",
    description: params.description,
    metadata: params.metadata,
    discounts: [{ promotion_code: params.promotionCodeId }],
  });
  let creditId = "";
  if (params.creditCents != null && params.creditCents > 0) {
    const credit = await params.stripe.invoiceItems.create({
      customer: params.customerId,
      amount: -Math.round(params.creditCents),
      currency: "usd",
      description: "Amount already covered",
      metadata: params.metadata,
    });
    creditId = credit.id;
  }
  try {
    let invoice = await params.stripe.invoices.create({
      customer: params.customerId,
      collection_method: "charge_automatically",
      auto_advance: false,
      pending_invoice_items_behavior: "include",
      metadata: params.metadata,
    });
    invoice = await params.stripe.invoices.finalizeInvoice(invoice.id);
    if ((invoice.amount_due ?? 0) > 0) {
      if (invoice.status === "open") {
        await params.stripe.invoices.voidInvoice(invoice.id);
      }
      return { ok: false, message: "Coupon did not cover the difference." };
    }
    return { ok: true };
  } catch (err) {
    try {
      await params.stripe.invoiceItems.del(item.id);
      if (creditId) await params.stripe.invoiceItems.del(creditId);
    } catch (deleteErr) {
      console.warn("redeemCoveredDifferenceCoupon cleanup:", deleteErr);
    }
    const message =
      err instanceof Error ? err.message : "Could not apply that coupon.";
    return { ok: false, message: couponFailureMessage(message) };
  }
}

function couponHoldFromMetadata(
  meta: Stripe.Metadata | null | undefined,
): {
  couponCode?: string;
  couponDuration?: string;
  couponDurationMonths?: number;
  repeatPriceCents?: number;
} {
  const couponCode = String(meta?.couponCode ?? "").trim();
  const couponDuration = String(meta?.couponDuration ?? "").trim();
  const months = Number(meta?.couponDurationMonths ?? "");
  const repeat = Number(meta?.repeatPriceCents ?? "");
  return {
    ...(couponCode ? { couponCode } : {}),
    ...(couponDuration ? { couponDuration } : {}),
    ...(Number.isFinite(months) && months > 0
      ? { couponDurationMonths: months }
      : {}),
    ...(meta?.repeatPriceCents != null &&
    String(meta.repeatPriceCents).trim() !== "" &&
    Number.isFinite(repeat)
      ? { repeatPriceCents: repeat }
      : {}),
  };
}

function couponFailureMessage(message: string): string {
  const text = message.toLowerCase();
  if (text.includes("cannot be applied to one-time")) {
    return "A repeating coupon applies to the subscription. The difference due is already reduced.";
  }
  if (text.includes("already used a coupon")) return "Coupon redeemed";
  if (text.includes("expired")) return "Expired";
  if (
    text.includes("redeemed") ||
    text.includes("redemption limit") ||
    text.includes("maximum number of times")
  ) {
    return "Coupon redeemed";
  }
  return message;
}

export async function createCompanyCheckoutSession(params: {
  companyId: string;
  actorUserId: string;
  /** starter | running | growth (seat suffixes like starter_5 are normalized) */
  planId: string;
  seatBand?: string;
  billingCycle: string;
  /** Required: each billable deal has its own SaaS subscription paid by the lead sponsor. */
  dealId?: string;
  extraCompanyUsers?: number;
  promotionCode?: string;
  /**
   * `difference` charges only the catalog gap, then the subscription renews at the new package.
   * `plan` charges that same gap and moves the deal onto the package it needs now.
   */
  upgradeMode?: "difference" | "plan";
  /** `null` = org admin (all deals); otherwise only these deal ids. */
  allowedDealIds?: string[] | null;
}): Promise<CheckoutResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cycle: StripeBillingCycle =
    params.billingCycle === "annually" ||
    params.billingCycle === "annual" ||
    params.billingCycle === "yearly"
      ? "annual"
      : params.billingCycle === "monthly"
        ? "monthly"
        : ("" as StripeBillingCycle);

  if (cycle !== "monthly" && cycle !== "annual") {
    return {
      ok: false,
      status: 400,
      message: "billingCycle must be monthly or annual.",
    };
  }

  const rawPlan = String(params.planId ?? "").trim().toLowerCase();
  if (rawPlan === "custom") {
    return {
      ok: false,
      status: 400,
      message:
        "For deals over $11M or more than 25 company users, contact sales for pricing.",
    };
  }

  const resolvedPlan = normalizeBillingPlanId(rawPlan);
  if (!resolvedPlan) {
    return {
      ok: false,
      status: 400,
      message: 'planId must be "starter", "running", or "growth".',
    };
  }

  const resolvedSeat =
    normalizeBillingSeatBand(params.seatBand) ??
    normalizeBillingSeatBand(rawPlan.includes("_") ? rawPlan.split("_")[1] : "") ??
    "5";

  const priceId = resolveStripePriceId(resolvedPlan, cycle, resolvedSeat);
  if (!priceId) {
    const envName = priceEnvNameFor(resolvedPlan, cycle, resolvedSeat);
    return {
      ok: false,
      status: 503,
      message: `Stripe Price is not configured for ${resolvedPlan} / ${resolvedSeat} seats (${cycle}). Set ${envName}=price_... in backend/.env.local.`,
    };
  }

  let cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const frontend = resolveFrontendOrigin();
  if (!frontend) {
    return {
      ok: false,
      status: 503,
      message:
        "BASE_URL must be set so Stripe can redirect after checkout.",
    };
  }

  try {
    const [company] = await db
      .select({
        stripeSubscriptionId: companies.stripeSubscriptionId,
        stripeSubscriptionStatus: companies.stripeSubscriptionStatus,
      })
      .from(companies)
      .where(eq(companies.id, cid))
      .limit(1);
    if (!company) {
      return { ok: false, status: 404, message: "Company not found" };
    }

    const dealId = String(params.dealId ?? "").trim();
    if (!dealId) {
      return {
        ok: false,
        status: 400,
        message: "Select a deal to pay monthly SaaS billing for.",
      };
    }
    const { loadPayableDeal } = await import("./dealBilling.service.js");
    const payable = await loadPayableDeal({
      companyId: cid,
      dealId,
      allowedDealIds: params.allowedDealIds ?? null,
      actorUserId: params.actorUserId,
      requestedSeatBand: resolvedSeat,
    });
    if (!payable.ok) {
      return {
        ok: false,
        status: payable.status,
        message: payable.message,
      };
    }
    const deal = payable.deal;
    const dealCompanyId = normalizeCompanyId(String(deal.organizationId ?? ""));
    if (dealCompanyId) cid = dealCompanyId;
    const {
      assertCheckoutPlanMatchesDeal,
      clearDealSaasSubscription,
    } = await import("./dealBilling.service.js");
    if (params.upgradeMode === "plan") {
      const minimumPlan = await suggestedPlanIdForDeal(String(deal.id));
      if (billingPlanRank(resolvedPlan) < billingPlanRank(minimumPlan)) {
        const label =
          minimumPlan.charAt(0).toUpperCase() + minimumPlan.slice(1);
        return {
          ok: false,
          status: 400,
          message: `${label} is the plan for this deal.`,
        };
      }
    } else {
      const planMatch = await assertCheckoutPlanMatchesDeal({
        dealId: String(deal.id),
        planId: resolvedPlan,
      });
      if (!planMatch.ok) {
        return {
          ok: false,
          status: planMatch.status,
          message: planMatch.message,
        };
      }
    }
    const customerId = await ensureDealPayerStripeCustomer({
      companyId: cid,
      dealId: String(deal.id),
      actorUserId: params.actorUserId,
    });
    const stripe = getStripeClient();
    const promotion = await promotionCodeIdFromInput(params.promotionCode);
    if (!promotion.ok) return promotion;
    const promotionCodeId = promotion.id;
    const couponCode = promotion.code;

    const existingDealSub = deal.stripeSubscriptionId?.trim() ?? "";
    const dealSubStatus = String(deal.stripeSubscriptionStatus ?? "none");
    if (existingDealSub && dealSubStatus === "incomplete") {
      try {
        await stripe.subscriptions.cancel(existingDealSub);
      } catch (cancelErr) {
        console.warn(
          "createCompanyCheckoutSession: cancel incomplete deal sub:",
          cancelErr,
        );
      }
      await clearDealSaasSubscription(String(deal.id));
    } else if (
      existingDealSub &&
      ["active", "trialing", "past_due", "unpaid"].includes(
        dealSubStatus.toLowerCase(),
      )
    ) {
      const sub = await stripe.subscriptions.retrieve(existingDealSub, {
        expand: ["items.data.price"],
      });
      const currentPrice = sub.items.data[0]?.price;
      const currentPriceId =
        typeof currentPrice === "string" ? currentPrice : currentPrice?.id;
      const paidPackage = planAndCycleFromPriceId(currentPriceId);
      const paidSeat =
        normalizeBillingSeatBand(deal.stripeSeatBand) ??
        paidPackage.seatBand ??
        "5";
      const suggestedPlan = await suggestedPlanIdForDeal(String(deal.id));
      const suggestedSeat = suggestedSeatBandForDeal(
        suggestedPlan,
        await countDealCoGps(String(deal.id)),
      );
      const upgradePlan =
        params.upgradeMode === "plan" ? resolvedPlan : suggestedPlan;
      const upgradeSeat =
        params.upgradeMode === "plan" ? resolvedSeat : suggestedSeat;
      // The cycle chosen for this payment, not the cycle already on Stripe.
      const upgradeCycle = cycle;
      const sameCycle = !paidPackage.cycle || paidPackage.cycle === upgradeCycle;
      const paidCatalog = catalogPackagePriceCents(
        paidPackage.planId ?? deal.stripePlanId,
        upgradeCycle,
        paidSeat,
      );
      const nextCatalog = catalogPackagePriceCents(
        upgradePlan,
        upgradeCycle,
        upgradeSeat,
      );
      const paidOnStripe =
        currentPrice && typeof currentPrice !== "string"
          ? currentPrice.unit_amount
          : null;
      const paidCents =
        sameCycle && typeof paidOnStripe === "number" && paidOnStripe > 0
          ? paidOnStripe
          : paidCatalog;
      const differenceCents = priceGapCents(paidCents, nextCatalog);
      if (params.upgradeMode === "plan" && differenceCents <= 0) {
        const { upgradeDealStripeSubscription } = await import(
          "./dealBilling.service.js"
        );
        const upgraded = await upgradeDealStripeSubscription({
          deal,
          planId: upgradePlan,
          cycle: upgradeCycle,
          seatBand: upgradeSeat,
          collectDifference: false,
          ...(promotionCodeId ? { promotionCodeId } : {}),
          ...(couponCode ? { couponCode } : {}),
        });
        if (!upgraded.ok) {
          return {
            ok: false,
            status: upgraded.status,
            message: upgraded.message,
          };
        }
        if (upgraded.hostedInvoiceUrl && !upgraded.paid) {
          return { ok: true, url: upgraded.hostedInvoiceUrl };
        }
        await applySubscriptionToCompany(cid, upgraded.subscription, {
          dealId: String(deal.id),
        });
        return { ok: true, url: "", upgraded: true };
      }
      if (differenceCents <= 0) {
        return {
          ok: false,
          status: 409,
          message: "This deal is already on the package selected.",
        };
      }
      const couponDuration = promotion.preview?.duration ?? "";
      const couponMonths = promotion.preview?.durationInMonths ?? null;
      const repeats =
        couponDuration === "repeating" || couponDuration === "forever";
      const priced = promotion.preview
        ? differenceRepeatPriceCents({
            paidCents: paidCents ?? 0,
            differenceCents,
            percentOff: promotion.preview.percentOff,
            amountOffCents: promotion.preview.amountOffCents,
          })
        : null;
      const upgradeMetadata: Record<string, string> = {
        companyId: cid,
        dealId: String(deal.id),
        dealName: deal.dealName ?? "",
        planId: upgradePlan,
        billingCycle: upgradeCycle,
        seatBand: upgradeSeat,
        billingScope: "deal_upgrade",
        payerUserId: params.actorUserId,
        ...(couponCode ? { couponCode } : {}),
        ...(couponDuration ? { couponDuration } : {}),
        ...(repeats && couponMonths
          ? { couponDurationMonths: String(couponMonths) }
          : {}),
        ...(repeats && priced
          ? { repeatPriceCents: String(priced.repeatPriceCents) }
          : {}),
      };
      const holdDescription =
        repeats && priced
          ? couponDuration === "forever"
            ? `Pays the difference from the amount already paid. This deal then bills $${(priced.repeatPriceCents / 100).toFixed(2)}.`
            : `Pays the difference from the amount already paid. This deal then bills $${(priced.repeatPriceCents / 100).toFixed(2)} for ${couponMonths ?? 0} months, then the new package price.`
          : "Pays the difference from the amount already paid. The subscription then renews at the new package price.";
      const subCustomerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? "";
      const checkoutCustomerId = await customerIdShowingSavedCards(
        stripe,
        subCustomerId || customerId,
        cid,
        params.actorUserId,
      );
      if (
        promotionCodeId &&
        priced &&
        priced.discountedDifferenceCents === 0
      ) {
        const beforeUpgrade = existingDealSub
          ? await stripe.subscriptions.retrieve(existingDealSub, {
              expand: ["items.data.price"],
            })
          : null;
        const upgraded = await upgradeDealStripeSubscription({
          deal,
          planId: upgradePlan,
          cycle: upgradeCycle,
          seatBand: upgradeSeat,
          collectDifference: false,
          ...(couponCode ? { couponCode } : {}),
          ...(couponDuration ? { couponDuration } : {}),
          ...(couponMonths ? { couponDurationMonths: couponMonths } : {}),
          ...(repeats ? { repeatPriceCents: priced.repeatPriceCents } : {}),
        });
        if (!upgraded.ok && upgraded.status !== 409) {
          return {
            ok: false,
            status: upgraded.status,
            message: upgraded.message,
          };
        }
        if (couponDurationAppliesToOneTime(couponDuration)) {
          const redeemed = await redeemCoveredDifferenceCoupon({
            stripe,
            customerId: checkoutCustomerId,
            amountCents: (paidCents ?? 0) + differenceCents,
            creditCents: priced.repeatPriceCents,
            promotionCodeId,
            description: `Upgrade difference for ${deal.dealName?.trim() || "this deal"}`,
            metadata: upgradeMetadata,
          });
          if (!redeemed.ok) {
            if (beforeUpgrade && upgraded.ok) {
              try {
                await restoreSubscriptionToSnapshot(beforeUpgrade);
              } catch (restoreErr) {
                console.warn("restore subscription after coupon redeem:", restoreErr);
              }
            }
            return { ok: false, status: 400, message: redeemed.message };
          }
        }
        if (upgraded.ok) {
          await applySubscriptionToCompany(cid, upgraded.subscription, {
            dealId: String(deal.id),
          });
        }
        return { ok: true, url: "", upgraded: true };
      }
      const netDue = priced?.discountedDifferenceCents ?? differenceCents;
      const oneTimeCoupon = Boolean(promotionCodeId) && couponDuration === "once";
      const lineAmount =
        oneTimeCoupon && promotion.preview
          ? couponCheckoutLineCents({
              dueCents: netDue,
              percentOff: promotion.preview.percentOff,
              amountOffCents: promotion.preview.amountOffCents,
            })
          : netDue;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: checkoutCustomerId,
        payment_method_types: ["card", "us_bank_account"],
        ...CHECKOUT_SAVED_PAYMENT_METHODS,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: lineAmount,
              product_data: {
                name: `Upgrade difference for ${deal.dealName?.trim() || "this deal"}`,
                description: holdDescription,
              },
            },
          },
        ],
        success_url: `${frontend}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}&dealId=${encodeURIComponent(String(deal.id))}`,
        cancel_url: `${frontend}/settings?billing=cancel&dealId=${encodeURIComponent(String(deal.id))}`,
        client_reference_id: cid,
        metadata: upgradeMetadata,
        payment_intent_data: {
          description: `Upgrade difference for ${deal.dealName?.trim() || "this deal"}`,
          metadata: upgradeMetadata,
        },
        ...(oneTimeCoupon && promotionCodeId
          ? { discounts: [{ promotion_code: promotionCodeId }] }
          : {}),
      });
      if (!session.url) {
        return {
          ok: false,
          status: 502,
          message: "Stripe did not return a checkout URL.",
        };
      }
      return { ok: true, url: session.url };
    }

    const {
      descriptionForExtraCompanyUserCharge,
      extraCompanyUserChargeDescription,
      extraCompanyUserCheckoutLineItems,
      extraCompanyUsersToCharge,
      getDealCompanyUserSnapshot,
    } = await import("./dealExtraCompanyUser.service.js");
    const snapshot = await getDealCompanyUserSnapshot(String(deal.id), {
      seatBand: resolvedSeat,
    });
    const extraUsers = snapshot ? extraCompanyUsersToCharge(snapshot) : 0;
    const extraUserComment = snapshot
      ? descriptionForExtraCompanyUserCharge(snapshot, extraUsers)
      : extraCompanyUserChargeDescription({ quantity: extraUsers });
    const extraLineItems = extraCompanyUserCheckoutLineItems(
      extraUsers,
      extraUserComment,
      cycle,
    );
    const platformPriceId =
      (await stripePriceIdForPlatformAmount({
        stripe,
        planId: resolvedPlan,
        cycle,
        seatBand: resolvedSeat,
      })) ?? priceId;
    const checkoutCustomerId = await customerIdShowingSavedCards(
      stripe,
      customerId,
      cid,
      params.actorUserId,
    );
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: checkoutCustomerId,
      // Card + ACH (US bank account). Wallet methods follow Dashboard settings.
      payment_method_types: ["card", "us_bank_account"],
      ...CHECKOUT_SAVED_PAYMENT_METHODS,
      line_items: [
        { price: platformPriceId, quantity: 1 },
        ...extraLineItems,
      ],
      success_url: `${frontend}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}&dealId=${encodeURIComponent(String(deal.id))}`,
      cancel_url: `${frontend}/settings?billing=cancel&dealId=${encodeURIComponent(String(deal.id))}`,
      client_reference_id: cid,
      metadata: {
        companyId: cid,
        dealId: String(deal.id),
        dealName: deal.dealName ?? "",
        planId: resolvedPlan,
        billingCycle: cycle,
        seatBand: resolvedSeat,
        billingScope: "deal",
        extraCompanyUsers: String(extraUsers),
        extraUserComment: extraUserComment.slice(0, 500),
        payerUserId: params.actorUserId,
        ...(couponCode ? { couponCode } : {}),
      },
      subscription_data: {
        metadata: {
          companyId: cid,
          dealId: String(deal.id),
          dealName: deal.dealName ?? "",
          planId: resolvedPlan,
          billingCycle: cycle,
          seatBand: resolvedSeat,
          billingScope: "deal",
          extraCompanyUsers: String(extraUsers),
          extraUserComment: extraUserComment.slice(0, 500),
          payerUserId: params.actorUserId,
          ...(couponCode ? { couponCode } : {}),
        },
      },
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ["payment_method"],
          },
        },
      },
      ...(promotionCodeId
        ? { discounts: [{ promotion_code: promotionCodeId }] }
        : { allow_promotion_codes: true }),
    });

    if (!session.url) {
      return {
        ok: false,
        status: 502,
        message: "Stripe did not return a checkout URL.",
      };
    }
    return { ok: true, url: session.url };
  } catch (err) {
    console.error("createCompanyCheckoutSession:", err);
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      const missingPrice =
        err.code === "resource_missing" &&
        String(err.param ?? "").includes("price");
      return {
        ok: false,
        status: missingPrice ? 400 : 502,
        message: missingPrice
          ? `Stripe does not recognize this Price ID in the account for STRIPE_SECRET_KEY (${err.message}). Create the product/price in that same Stripe account (Dashboard → Products) and update backend/.env.local.`
          : couponFailureMessage(err.message || "Stripe rejected the checkout request."),
      };
    }
    const msg =
      err instanceof Error ? err.message : "Could not create checkout session";
    return { ok: false, status: 502, message: msg };
  }
}

/** Shared plan/seat/cycle validation used by Checkout + Payment Element flows. */
function resolveBillingSelection(params: {
  planId: string;
  seatBand?: string;
  billingCycle: string;
}):
  | {
      ok: true;
      planId: StripeBillingPlanId;
      seatBand: StripeBillingSeatBand;
      cycle: StripeBillingCycle;
      priceId: string;
    }
  | { ok: false; status: number; message: string } {
  const cycle: StripeBillingCycle =
    params.billingCycle === "annually" ||
    params.billingCycle === "annual" ||
    params.billingCycle === "yearly"
      ? "annual"
      : params.billingCycle === "monthly"
        ? "monthly"
        : ("" as StripeBillingCycle);

  if (cycle !== "monthly" && cycle !== "annual") {
    return {
      ok: false,
      status: 400,
      message: "billingCycle must be monthly or annual.",
    };
  }

  const rawPlan = String(params.planId ?? "").trim().toLowerCase();
  if (rawPlan === "custom") {
    return {
      ok: false,
      status: 400,
      message:
        "For deals over $11M or more than 25 company users, contact sales for pricing.",
    };
  }

  const resolvedPlan = normalizeBillingPlanId(rawPlan);
  if (!resolvedPlan) {
    return {
      ok: false,
      status: 400,
      message: 'planId must be "starter", "running", or "growth".',
    };
  }

  const resolvedSeat =
    normalizeBillingSeatBand(params.seatBand) ??
    normalizeBillingSeatBand(rawPlan.includes("_") ? rawPlan.split("_")[1] : "") ??
    "5";

  const priceId = resolveStripePriceId(resolvedPlan, cycle, resolvedSeat);
  if (!priceId) {
    const envName = priceEnvNameFor(resolvedPlan, cycle, resolvedSeat);
    return {
      ok: false,
      status: 503,
      message: `Stripe Price is not configured for ${resolvedPlan} / ${resolvedSeat} seats (${cycle}). Set ${envName}=price_... in backend/.env.local.`,
    };
  }

  return {
    ok: true,
    planId: resolvedPlan,
    seatBand: resolvedSeat,
    cycle,
    priceId,
  };
}

export type PaySavedMethodResult =
  | {
      ok: true;
      paidDealId: string;
      status: Awaited<ReturnType<typeof getCompanyBillingStatus>>;
      checkoutUrl?: string;
    }
  | { ok: false; status: number; message: string };

/**
 * Charge (or start complimentary trial) for a deal using a saved card / bank account.
 * Callers who need a new method should use Stripe Checkout instead.
 */
export async function payCompanyDealWithSavedMethod(params: {
  companyId: string;
  actorUserId: string;
  planId: string;
  seatBand?: string;
  billingCycle: string;
  dealId?: string;
  extraCompanyUsers?: number;
  paymentMethodId: string;
  promotionCode?: string;
  allowedDealIds?: string[] | null;
}): Promise<PaySavedMethodResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const selection = resolveBillingSelection(params);
  if (!selection.ok) return selection;

  let cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const dealId = String(params.dealId ?? "").trim();
  if (!dealId) {
    return {
      ok: false,
      status: 400,
      message: "Select a deal to pay monthly SaaS billing for.",
    };
  }

  const rawPm = String(params.paymentMethodId ?? "").trim();
  if (!rawPm) {
    return {
      ok: false,
      status: 400,
      message: "Select a saved payment method, or pay in Stripe.",
    };
  }

  try {
    const { loadPayableDeal, clearDealSaasSubscription, createDealStripeSubscription, assertCheckoutPlanMatchesDeal, upgradeDealStripeSubscription } =
      await import("./dealBilling.service.js");
    const payable = await loadPayableDeal({
      companyId: cid,
      dealId,
      allowedDealIds: params.allowedDealIds ?? null,
      actorUserId: params.actorUserId,
      requestedSeatBand: selection.seatBand,
    });
    if (!payable.ok) {
      return {
        ok: false,
        status: payable.status,
        message: payable.message,
      };
    }
    const deal = payable.deal;
    const dealCompanyId = normalizeCompanyId(String(deal.organizationId ?? ""));
    if (dealCompanyId) cid = dealCompanyId;
    const planMatch = await assertCheckoutPlanMatchesDeal({
      dealId: String(deal.id),
      planId: selection.planId,
    });
    if (!planMatch.ok) {
      return {
        ok: false,
        status: planMatch.status,
        message: planMatch.message,
      };
    }
    const methods = await listCompanyPaymentMethods(cid, {
      userId: params.actorUserId,
    });
    const found = methods.find(
      (m) => m.stripePaymentMethodId === rawPm || m.id === rawPm,
    );
    if (!found?.stripePaymentMethodId) {
      return {
        ok: false,
        status: 400,
        message:
          "That payment method is not available. Choose another, or pay in Stripe.",
      };
    }
    const paymentMethodId = found.stripePaymentMethodId;

    const stripe = getStripeClient();
    const existingDealSub = deal.stripeSubscriptionId?.trim() ?? "";
    if (
      existingDealSub &&
      String(deal.stripeSubscriptionStatus ?? "none") === "incomplete"
    ) {
      try {
        await stripe.subscriptions.cancel(existingDealSub);
      } catch (cancelErr) {
        console.warn(
          "payCompanyDealWithSavedMethod: cancel incomplete deal sub:",
          cancelErr,
        );
      }
      await clearDealSaasSubscription(String(deal.id));
    }

    const payerPayment = await customerForSavedDealPayment({
      companyId: cid,
      dealId: String(deal.id),
      actorUserId: params.actorUserId,
      paymentMethodId,
    });
    const customerId = payerPayment.customerId;
    const payerPaymentMethodId = payerPayment.paymentMethodId;

    const promotion = await promotionCodeIdFromInput(params.promotionCode);
    if (!promotion.ok) return promotion;
    const promotionCodeId = promotion.id;
    const couponCode = promotion.code;

    const existingActive =
      (deal.stripeSubscriptionId?.trim() ?? "") &&
      ["active", "trialing", "past_due", "unpaid"].includes(
        String(deal.stripeSubscriptionStatus ?? "none").toLowerCase(),
      );
    if (existingActive) {
      const upgradePaymentMethodId = await paymentMethodForExistingSubscription({
        stripe,
        subscriptionId: existingDealSub,
        paymentMethodId: payerPaymentMethodId,
        paymentMethodCustomerId: customerId,
      });
      const upgraded = await upgradeDealStripeSubscription({
        deal,
        planId: selection.planId,
        cycle: selection.cycle,
        seatBand: selection.seatBand,
        ...(upgradePaymentMethodId
          ? { paymentMethodId: upgradePaymentMethodId }
          : {}),
        ...(promotionCodeId ? { promotionCodeId } : {}),
        ...(couponCode ? { couponCode } : {}),
        ...(promotion.preview
          ? {
              couponDuration: promotion.preview.duration,
              percentOff: promotion.preview.percentOff,
              amountOffCents: promotion.preview.amountOffCents,
              ...(promotion.preview.durationInMonths
                ? { couponDurationMonths: promotion.preview.durationInMonths }
                : {}),
            }
          : {}),
      });
      if (!upgraded.ok) {
        return {
          ok: false,
          status: upgraded.status,
          message: upgraded.message,
        };
      }
      if (!upgraded.paid) {
        if (upgraded.hostedInvoiceUrl) {
          return {
            ok: true,
            paidDealId: String(deal.id),
            status: await getCompanyBillingStatus(cid, {
              dealIds: params.allowedDealIds,
            }),
            checkoutUrl: upgraded.hostedInvoiceUrl,
          };
        }
        return {
          ok: false,
          status: 402,
          message:
            "This payment method needs extra verification or was declined. Pay in Stripe instead.",
        };
      }
      await applySubscriptionToCompany(cid, upgraded.subscription);
      try {
        await syncCompanyPaymentMethodsFromStripe(cid);
      } catch (pmErr) {
        console.warn("payCompanyDealWithSavedMethod sync methods:", pmErr);
      }
      const status = await getCompanyBillingStatus(cid, {
        dealIds: params.allowedDealIds,
      });
      return {
        ok: true,
        paidDealId: String(deal.id),
        status,
      };
    }

    const sub = await createDealStripeSubscription({
      deal,
      customerId,
      paymentMethodId: payerPaymentMethodId,
      planId: selection.planId,
      cycle: selection.cycle,
      seatBand: selection.seatBand,
      payerUserId: params.actorUserId,
      paymentBehavior: "error_if_incomplete",
      extraCompanyUsers: params.extraCompanyUsers,
      ...(promotionCodeId ? { promotionCodeId } : {}),
      ...(couponCode ? { couponCode } : {}),
    });
    if (!sub) {
      return {
        ok: false,
        status: 503,
        message: `Stripe Price is not configured for ${selection.planId} / ${selection.seatBand} seats (${selection.cycle}).`,
      };
    }

    const subStatus = String(sub.status ?? "").toLowerCase();
    if (subStatus !== "active" && subStatus !== "trialing") {
      try {
        await stripe.subscriptions.cancel(sub.id);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status: 402,
        message:
          "This payment method needs extra verification or was declined. Pay in Stripe instead.",
      };
    }

    await applySubscriptionToCompany(cid, sub);

    try {
      await syncCompanyPaymentMethodsFromStripe(cid);
    } catch (pmErr) {
      console.warn("payCompanyDealWithSavedMethod sync methods:", pmErr);
    }

    const status = await getCompanyBillingStatus(cid, {
      dealIds: params.allowedDealIds,
    });
    return {
      ok: true,
      paidDealId: String(deal.id),
      status,
    };
  } catch (err) {
    console.error("payCompanyDealWithSavedMethod:", err);
    if (err instanceof Stripe.errors.StripeCardError) {
      return {
        ok: false,
        status: 402,
        message: couponFailureMessage(
          err.message || "The card was declined. Pay in Stripe or try another method.",
        ),
      };
    }
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return {
        ok: false,
        status: 502,
        message: couponFailureMessage(err.message || "Stripe rejected the payment."),
      };
    }
    const msg =
      err instanceof Error ? err.message : "Could not pay with this method";
    return { ok: false, status: 502, message: msg };
  }
}

export async function processDueDealSaasBillingFromSavedMethods(
  _options: { limit?: number } = {},
): Promise<{
  checked: number;
  started: number;
  skipped: number;
  failed: number;
}> {
  // A deal is paid by the person who checks out with their own card.
  // Organization cards are not charged when a complimentary period ends.
  return { checked: 0, started: 0, skipped: 0, failed: 0 };
}

type InvoiceWithSecrets = Stripe.Invoice & {
  confirmation_secret?: { client_secret?: string | null } | null;
  payment_intent?: string | Stripe.PaymentIntent | null;
};

/**
 * Resolve Payment Element client_secret from an incomplete subscription invoice.
 * Supports modern confirmation_secret and legacy payment_intent expansion.
 */
async function clientSecretFromSubscriptionInvoice(
  stripe: Stripe,
  subscription: Stripe.Subscription,
): Promise<{
  clientSecret: string;
  paymentIntentId: string | null;
  invoiceId: string | null;
} | null> {
  let invoiceRef = subscription.latest_invoice;
  let invoice: InvoiceWithSecrets | null = null;

  if (typeof invoiceRef === "string" && invoiceRef.trim()) {
    invoice = (await stripe.invoices.retrieve(invoiceRef.trim(), {
      expand: ["confirmation_secret", "payment_intent"],
    })) as InvoiceWithSecrets;
  } else if (invoiceRef && typeof invoiceRef === "object") {
    invoice = invoiceRef as InvoiceWithSecrets;
    // Re-fetch if secrets were not expanded on create.
    if (
      !invoice.confirmation_secret?.client_secret &&
      (typeof invoice.payment_intent === "string" || !invoice.payment_intent)
    ) {
      invoice = (await stripe.invoices.retrieve(invoice.id, {
        expand: ["confirmation_secret", "payment_intent"],
      })) as InvoiceWithSecrets;
    }
  }

  if (!invoice) return null;

  const fromConfirmation = invoice.confirmation_secret?.client_secret?.trim();
  if (fromConfirmation) {
    const piRef = invoice.payment_intent;
    const paymentIntentId =
      typeof piRef === "string"
        ? piRef
        : piRef && typeof piRef === "object"
          ? piRef.id
          : null;
    return {
      clientSecret: fromConfirmation,
      paymentIntentId,
      invoiceId: invoice.id,
    };
  }

  const piRef = invoice.payment_intent;
  if (piRef && typeof piRef === "object" && piRef.client_secret) {
    return {
      clientSecret: piRef.client_secret,
      paymentIntentId: piRef.id,
      invoiceId: invoice.id,
    };
  }
  if (typeof piRef === "string" && piRef.trim()) {
    const pi = await stripe.paymentIntents.retrieve(piRef.trim());
    if (pi.client_secret) {
      return {
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        invoiceId: invoice.id,
      };
    }
  }

  return null;
}

export type PaymentElementSubscriptionResult =
  | {
      ok: true;
      clientSecret: string;
      subscriptionId: string;
      customerId: string;
      publishableKey: string | null;
      paymentIntentId: string | null;
      invoiceId: string | null;
      planId: StripeBillingPlanId;
      seatBand: StripeBillingSeatBand;
      billingCycle: StripeBillingCycle;
      priceId: string;
    }
  | { ok: false; status: number; message: string };

/**
 * Option 2 — Custom Payment Element (card + ACH).
 * Creates an incomplete subscription and returns the invoice PaymentIntent client_secret.
 */
export async function createCompanySubscriptionPaymentElement(params: {
  companyId: string;
  actorUserId: string;
  planId: string;
  seatBand?: string;
  billingCycle: string;
  dealId?: string;
  extraCompanyUsers?: number;
  allowedDealIds?: string[] | null;
}): Promise<PaymentElementSubscriptionResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const selection = resolveBillingSelection(params);
  if (!selection.ok) return selection;

  let cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  try {
    const [company] = await db
      .select({
        id: companies.id,
      })
      .from(companies)
      .where(eq(companies.id, cid))
      .limit(1);
    if (!company) {
      return { ok: false, status: 404, message: "Company not found" };
    }

    const dealId = String(params.dealId ?? "").trim();
    if (!dealId) {
      return {
        ok: false,
        status: 400,
        message: "Select a deal to pay monthly SaaS billing for.",
      };
    }
    const { loadPayableDeal, clearDealSaasSubscription, assertCheckoutPlanMatchesDeal } = await import(
      "./dealBilling.service.js"
    );
    const payable = await loadPayableDeal({
      companyId: cid,
      dealId,
      allowedDealIds: params.allowedDealIds ?? null,
      actorUserId: params.actorUserId,
      requestedSeatBand: selection.seatBand,
    });
    if (!payable.ok) {
      return {
        ok: false,
        status: payable.status,
        message: payable.message,
      };
    }
    const deal = payable.deal;
    const dealCompanyId = normalizeCompanyId(String(deal.organizationId ?? ""));
    if (dealCompanyId) cid = dealCompanyId;
    const planMatch = await assertCheckoutPlanMatchesDeal({
      dealId: String(deal.id),
      planId: selection.planId,
    });
    if (!planMatch.ok) {
      return {
        ok: false,
        status: planMatch.status,
        message: planMatch.message,
      };
    }
    const stripe = getStripeClient();

    const existingDealSub = deal.stripeSubscriptionId?.trim() ?? "";
    if (
      existingDealSub &&
      String(deal.stripeSubscriptionStatus ?? "none") === "incomplete"
    ) {
      try {
        await stripe.subscriptions.cancel(existingDealSub);
      } catch (cancelErr) {
        console.warn(
          "createCompanySubscriptionPaymentElement: cancel incomplete deal sub:",
          cancelErr,
        );
      }
      await clearDealSaasSubscription(String(deal.id));
    } else if (
      existingDealSub &&
      ["active", "trialing", "past_due", "unpaid"].includes(
        String(deal.stripeSubscriptionStatus ?? "none").toLowerCase(),
      )
    ) {
      return {
        ok: false,
        status: 409,
        message:
          "This deal already has a subscription. Use Pay in Stripe or a saved card to upgrade the plan.",
      };
    }

    const customerId = await ensureDealPayerStripeCustomer({
      companyId: cid,
      dealId: String(deal.id),
      actorUserId: params.actorUserId,
    });

    const {
      descriptionForExtraCompanyUserCharge,
      extraCoGpSubscriptionItem,
      extraCompanyUserChargeDescription,
      extraCompanyUsersToCharge,
      getDealCompanyUserSnapshot,
    } = await import("./dealExtraCompanyUser.service.js");
    const snapshot = await getDealCompanyUserSnapshot(String(deal.id), {
      seatBand: selection.seatBand,
    });
    const extraUsers = snapshot ? extraCompanyUsersToCharge(snapshot) : 0;
    const extraUserComment = snapshot
      ? descriptionForExtraCompanyUserCharge(snapshot, extraUsers)
      : extraCompanyUserChargeDescription({ quantity: extraUsers });
    const extraItem = await extraCoGpSubscriptionItem(
      stripe,
      extraUsers,
      selection.cycle,
      extraUserComment,
    );

    const platformPriceId =
      (await stripePriceIdForPlatformAmount({
        stripe,
        planId: selection.planId,
        cycle: selection.cycle,
        seatBand: selection.seatBand,
      })) ?? selection.priceId;
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        { price: platformPriceId, quantity: 1 },
        ...(extraItem ? [extraItem] : []),
      ],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        payment_method_types: ["card", "us_bank_account"],
      },
      expand: [
        "latest_invoice.confirmation_secret",
        "latest_invoice.payment_intent",
      ],
      metadata: {
        companyId: cid,
        dealId: String(deal.id),
        dealName: deal.dealName ?? "",
        planId: selection.planId,
        billingCycle: selection.cycle,
        seatBand: selection.seatBand,
        checkoutMode: "payment_element",
        billingScope: "deal",
        extraCompanyUsers: String(extraUsers),
        extraUserComment: extraUserComment.slice(0, 500),
        payerUserId: params.actorUserId,
      },
    });

    const secrets = await clientSecretFromSubscriptionInvoice(
      stripe,
      subscription,
    );
    if (!secrets?.clientSecret) {
      try {
        await stripe.subscriptions.cancel(subscription.id);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        status: 502,
        message:
          "Stripe did not return a Payment Element client secret for this subscription invoice.",
      };
    }

    await applySubscriptionToCompany(cid, subscription);

    return {
      ok: true,
      clientSecret: secrets.clientSecret,
      subscriptionId: subscription.id,
      customerId,
      publishableKey: cfg.publishableKey,
      paymentIntentId: secrets.paymentIntentId,
      invoiceId: secrets.invoiceId,
      planId: selection.planId,
      seatBand: selection.seatBand,
      billingCycle: selection.cycle,
      priceId: selection.priceId,
    };
  } catch (err) {
    console.error("createCompanySubscriptionPaymentElement:", err);
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
      return {
        ok: false,
        status: 502,
        message: err.message || "Stripe rejected the subscription request.",
      };
    }
    const msg =
      err instanceof Error
        ? err.message
        : "Could not create Payment Element subscription";
    return { ok: false, status: 502, message: msg };
  }
}

export type SetupIntentResult =
  | {
      ok: true;
      clientSecret: string;
      setupIntentId: string;
      customerId: string;
      publishableKey: string | null;
    }
  | { ok: false; status: number; message: string };

/**
 * Save card / ACH for future off-session charges (Manage billing → Add method).
 */
export async function createCompanySetupIntent(params: {
  companyId: string;
  actorUserId: string;
}): Promise<SetupIntentResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  try {
    const customerId = await ensureUserCardStripeCustomer({
      companyId: cid,
      actorUserId: params.actorUserId,
    });
    const stripe = getStripeClient();
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card", "us_bank_account"],
      usage: "off_session",
      payment_method_options: {
        us_bank_account: {
          financial_connections: {
            permissions: ["payment_method"],
          },
        },
      },
      metadata: {
        companyId: cid,
        payerUserId: params.actorUserId,
      },
    });

    if (!setupIntent.client_secret) {
      return {
        ok: false,
        status: 502,
        message: "Stripe did not return a SetupIntent client secret.",
      };
    }

    return {
      ok: true,
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId,
      publishableKey: cfg.publishableKey,
    };
  } catch (err) {
    console.error("createCompanySetupIntent:", err);
    const msg =
      err instanceof Error ? err.message : "Could not create SetupIntent";
    return { ok: false, status: 502, message: msg };
  }
}

export type SyncSubscriptionPaymentResult =
  | { ok: true; status: CompanyBillingStatus }
  | { ok: false; status: number; message: string };

/**
 * Post-confirm sync after Payment Element (return_url or same-page success).
 * Body may include subscriptionId and/or paymentIntentId.
 */
export async function syncCompanySubscriptionPayment(params: {
  companyId: string;
  subscriptionId?: string;
  paymentIntentId?: string;
  actorUserId?: string;
}): Promise<SyncSubscriptionPaymentResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const stripe = getStripeClient();
  let subscriptionId = String(params.subscriptionId ?? "").trim();
  const paymentIntentId = String(params.paymentIntentId ?? "").trim();

  try {
    if (!subscriptionId && paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      const invoiceId = stripeIdRef(
        (pi as Stripe.PaymentIntent & { invoice?: string | { id?: string } | null })
          .invoice,
      );
      if (invoiceId) {
        const inv = await stripe.invoices.retrieve(invoiceId);
        subscriptionId = subscriptionIdFromInvoice(inv) ?? "";
      }
    }

    if (!subscriptionId) {
      const [row] = await db
        .select({ stripeSubscriptionId: companies.stripeSubscriptionId })
        .from(companies)
        .where(eq(companies.id, cid))
        .limit(1);
      subscriptionId = row?.stripeSubscriptionId?.trim() ?? "";
    }

    if (!subscriptionId) {
      return {
        ok: false,
        status: 400,
        message: "subscriptionId or paymentIntentId is required.",
      };
    }

    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price", "latest_invoice"],
    });
    const metaCompany = normalizeCompanyId(sub.metadata?.companyId ?? null);
    if (metaCompany && metaCompany !== cid) {
      return {
        ok: false,
        status: 403,
        message: "Subscription does not belong to this company.",
      };
    }

    let paidSub = sub;
    if (String(sub.status ?? "").toLowerCase() === "incomplete") {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        paidSub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        const st = String(paidSub.status ?? "").toLowerCase();
        if (st === "active" || st === "trialing" || st !== "incomplete") break;
      }
    }

    await applySubscriptionToCompany(cid, paidSub);
    await syncDealSubscriptionsAfterCompanyPayment(cid);
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
    try {
      await persistInvoicesForSubscription({
        companyId: cid,
        subscriptionId: sub.id,
        customerId,
      });
    } catch (invErr) {
      console.warn("syncCompanySubscriptionPayment invoices:", invErr);
    }
    if (customerId) {
      try {
        await syncCompanyPaymentMethodsFromStripe(cid, {
          actorUserId: params.actorUserId,
        });
      } catch (pmErr) {
        console.warn("syncCompanySubscriptionPayment payment methods:", pmErr);
      }
    }
    const payerUserId = normalizeCompanyId(params.actorUserId ?? "");
    if (payerUserId && paymentIntentId) {
      try {
        const paidIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        const paidMethodId = stripeIdRef(paidIntent.payment_method);
        if (paidMethodId) {
          await assignPaymentMethodOwner({
            companyId: cid,
            stripePaymentMethodId: paidMethodId,
            userId: payerUserId,
          });
        }
      } catch (ownerErr) {
        console.warn("syncCompanySubscriptionPayment card owner:", ownerErr);
      }
    }

    const status = await getCompanyBillingStatus(cid);
    if (!status) {
      return { ok: false, status: 404, message: "Company not found" };
    }
    return { ok: true, status };
  } catch (err) {
    console.error("syncCompanySubscriptionPayment:", err);
    const msg =
      err instanceof Error
        ? err.message
        : "Could not sync subscription payment";
    return { ok: false, status: 502, message: msg };
  }
}

export type PortalResult =
  | { ok: true; url: string }
  | { ok: false; status: number; message: string };

export async function createCompanyBillingPortalSession(params: {
  companyId: string;
  actorUserId: string;
}): Promise<PortalResult> {
  if (!getStripeConfig()) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const frontend = resolveFrontendOrigin();
  if (!frontend) {
    return {
      ok: false,
      status: 503,
      message:
        "BASE_URL must be set so Stripe can redirect after the portal.",
    };
  }

  try {
    const customerId = await ensureUserCardStripeCustomer({
      companyId: cid,
      actorUserId: params.actorUserId,
    });
    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontend}/settings?billing=portal_return`,
    });
    return { ok: true, url: session.url };
  } catch (err) {
    console.error("createCompanyBillingPortalSession:", err);
    const msg =
      err instanceof Error ? err.message : "Could not open billing portal";
    return { ok: false, status: 502, message: msg };
  }
}

export type BillingInvoiceRow = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  planId: string | null;
  status: string;
  amount: string;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  paymentFailureMessage: string | null;
  paymentFailedAt: string | null;
  dealId: string | null;
  dealName: string | null;
  billingScope?: "deal" | "extra_company_user" | null;
  comment?: string | null;
  /** Portal user who started the deal payment, when Stripe metadata has one. */
  paidByName?: string | null;
};

function payerUserIdFromStripeInvoice(inv: Stripe.Invoice): string | null {
  const fromInvoice = normalizeCompanyId(String(inv.metadata?.payerUserId ?? ""));
  if (fromInvoice) return fromInvoice;
  const parentMeta = inv.parent?.subscription_details?.metadata;
  return normalizeCompanyId(String(parentMeta?.payerUserId ?? ""));
}

async function billingUserDisplayNames(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      userIds
        .map((id) => normalizeCompanyId(String(id ?? "")))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) {
    const full = [row.firstName, row.lastName]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" ");
    const label =
      full ||
      String(row.username ?? "").trim() ||
      String(row.email ?? "").trim();
    if (label) names.set(String(row.id).toLowerCase(), label);
  }
  return names;
}

function extrasFromStripeInvoice(inv: Stripe.Invoice): {
  periodStart: string;
  periodEnd: string;
  planId: string | null;
  dealId: string | null;
} {
  const line = inv.lines?.data?.[0];
  const period =
    line && typeof line === "object" && "period" in line
      ? (line as { period?: { start?: number | null; end?: number | null } })
          .period
      : undefined;
  const legacy = inv as { period_start?: number; period_end?: number };
  const startUnix = period?.start ?? legacy.period_start;
  const endUnix = period?.end ?? legacy.period_end;
  const periodStart =
    startUnix != null && Number.isFinite(startUnix)
      ? isoDateOnly(new Date(startUnix * 1000))
      : "";
  const periodEnd =
    endUnix != null && Number.isFinite(endUnix)
      ? isoDateOnly(new Date(endUnix * 1000))
      : "";

  let priceId: string | null = null;
  if (line && typeof line === "object") {
    const row = line as {
      pricing?: { price_details?: { price?: string | null } | null } | null;
      price?: string | { id?: string } | null;
    };
    const fromPricing = row.pricing?.price_details?.price?.trim();
    if (fromPricing) priceId = fromPricing;
    else if (typeof row.price === "string") priceId = row.price.trim();
    else if (row.price && typeof row.price === "object") {
      priceId = String(row.price.id ?? "").trim() || null;
    }
  }
  const mapped = planAndCycleFromPriceId(priceId);
  const metaDealId = String(inv.metadata?.dealId ?? "").trim().toLowerCase();
  const lineMeta =
    line && typeof line === "object"
      ? String(
          (line as { metadata?: { dealId?: string } }).metadata?.dealId ?? "",
        )
          .trim()
          .toLowerCase()
      : "";
  return {
    periodStart,
    periodEnd,
    planId: mapped.planId,
    dealId: metaDealId || lineMeta || null,
  };
}

function formatMoneyCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((cents || 0) / 100);
}

function isoDateOnly(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

async function mapCompanyDealNames(
  companyId: string,
  dealIdFilter?: string[] | null,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const conditions = [eq(addDealForm.organizationId, companyId)];
  if (dealIdFilter && dealIdFilter.length > 0) {
    conditions.push(inArray(addDealForm.id, dealIdFilter));
  }
  const rows = await db
    .select({ id: addDealForm.id, dealName: addDealForm.dealName })
    .from(addDealForm)
    .where(and(...conditions));
  for (const row of rows) {
    names.set(String(row.id).toLowerCase(), String(row.dealName ?? "").trim());
  }
  return names;
}

function extraCompanyUserInvoiceRow(params: {
  id: string;
  createdUnix: number;
  amountCents: number;
  currency: string;
  status: string;
  dealId: string | null;
  dealName: string | null;
  hostedInvoiceUrl?: string | null;
  comment?: string | null;
}): BillingInvoiceRow {
  const date = isoDateOnly(new Date(params.createdUnix * 1000));
  return {
    id: params.id,
    invoiceNumber: "Extra company user",
    invoiceDate: date,
    dueDate: date,
    periodStart: date,
    periodEnd: date,
    planId: null,
    status: params.status,
    amount: formatMoneyCents(params.amountCents, params.currency),
    hostedInvoiceUrl: params.hostedInvoiceUrl ?? null,
    invoicePdf: null,
    paymentFailureMessage: null,
    paymentFailedAt: null,
    dealId: params.dealId,
    dealName: params.dealName,
    billingScope: "extra_company_user",
    comment: params.comment?.trim() || null,
  };
}

async function listExtraCompanyUserInvoiceRows(params: {
  stripe: Stripe;
  customerId: string;
  dealNames: Map<string, string>;
  allowedDealIds?: string[] | null;
}): Promise<BillingInvoiceRow[]> {
  const allowed = Array.isArray(params.allowedDealIds)
    ? new Set(params.allowedDealIds.map((id) => id.toLowerCase()))
    : null;
  const rows: BillingInvoiceRow[] = [];
  const seen = new Set<string>();

  const resolveDeal = (rawId: string, rawName: string) => {
    const dealId = rawId.trim().toLowerCase();
    if (!dealId) {
      return { dealId: null as string | null, dealName: null as string | null };
    }
    if (allowed && !allowed.has(dealId)) return null;
    const dealName = rawName.trim() || params.dealNames.get(dealId) || null;
    return { dealId, dealName };
  };

  try {
    const sessions = await params.stripe.checkout.sessions.list({
      customer: params.customerId,
      limit: 50,
    });
    for (const session of sessions.data) {
      if (String(session.metadata?.billingScope ?? "") !== "extra_company_user") {
        continue;
      }
      const deal = resolveDeal(
        String(session.metadata?.dealId ?? ""),
        String(session.metadata?.dealName ?? ""),
      );
      if (!deal) continue;
      const paid = String(session.payment_status ?? "").toLowerCase() === "paid";
      const pi =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id ?? "";
      if (pi) seen.add(pi);
      seen.add(session.id);
      rows.push(
        extraCompanyUserInvoiceRow({
          id: session.id,
          createdUnix: session.created,
          amountCents: session.amount_total ?? 0,
          currency: session.currency ?? "usd",
          status: paid ? "paid" : String(session.payment_status ?? "open"),
          dealId: deal.dealId,
          dealName: deal.dealName,
          hostedInvoiceUrl: session.url,
          comment: String(session.metadata?.extraUserComment ?? ""),
        }),
      );
    }
  } catch (err) {
    console.warn("listExtraCompanyUserInvoiceRows checkout sessions:", err);
  }

  try {
    const intents = await params.stripe.paymentIntents.list({
      customer: params.customerId,
      limit: 50,
    });
    for (const pi of intents.data) {
      if (String(pi.metadata?.billingScope ?? "") !== "extra_company_user") {
        continue;
      }
      if (seen.has(pi.id)) continue;
      const deal = resolveDeal(
        String(pi.metadata?.dealId ?? ""),
        String(pi.metadata?.dealName ?? ""),
      );
      if (!deal) continue;
      const succeeded = String(pi.status ?? "").toLowerCase() === "succeeded";
      rows.push(
        extraCompanyUserInvoiceRow({
          id: pi.id,
          createdUnix: pi.created,
          amountCents: pi.amount_received || pi.amount || 0,
          currency: pi.currency ?? "usd",
          status: succeeded ? "paid" : String(pi.status ?? "open"),
          dealId: deal.dealId,
          dealName: deal.dealName,
          comment: String(
            pi.metadata?.extraUserComment ?? pi.description ?? "",
          ),
        }),
      );
    }
  } catch (err) {
    console.warn("listExtraCompanyUserInvoiceRows payment intents:", err);
  }

  return rows;
}

async function recordBillingEvent(params: {
  companyId: string | null;
  stripeEventId?: string | null;
  eventType: string;
  stripeInvoiceId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeCustomerId?: string | null;
  message?: string | null;
  payload?: unknown;
}): Promise<{ inserted: boolean }> {
  const eventId = params.stripeEventId?.trim() || null;
  try {
    if (eventId) {
      const inserted = await db
        .insert(companyBillingEvents)
        .values({
          companyId: params.companyId,
          stripeEventId: eventId,
          eventType: params.eventType,
          stripeInvoiceId: params.stripeInvoiceId?.trim() || null,
          stripeSubscriptionId: params.stripeSubscriptionId?.trim() || null,
          stripeCustomerId: params.stripeCustomerId?.trim() || null,
          message: params.message?.trim() || null,
          payload: params.payload ?? null,
        })
        .onConflictDoNothing({
          target: companyBillingEvents.stripeEventId,
        })
        .returning({ id: companyBillingEvents.id });
      return { inserted: inserted.length > 0 };
    }

    await db.insert(companyBillingEvents).values({
      companyId: params.companyId,
      stripeEventId: null,
      eventType: params.eventType,
      stripeInvoiceId: params.stripeInvoiceId?.trim() || null,
      stripeSubscriptionId: params.stripeSubscriptionId?.trim() || null,
      stripeCustomerId: params.stripeCustomerId?.trim() || null,
      message: params.message?.trim() || null,
      payload: params.payload ?? null,
    });
    return { inserted: true };
  } catch (err) {
    console.warn("recordBillingEvent:", err);
    return { inserted: false };
  }
}

/** Returns true if this Stripe event id was newly claimed (not a retry). */
async function claimStripeEvent(params: {
  eventId: string;
  eventType: string;
  companyId?: string | null;
  message?: string | null;
  payload?: unknown;
}): Promise<boolean> {
  const { inserted } = await recordBillingEvent({
    companyId: params.companyId ?? null,
    stripeEventId: params.eventId,
    eventType: params.eventType,
    message: params.message ?? "claimed",
    payload: params.payload,
  });
  return inserted;
}

export async function upsertBillingInvoiceFromStripe(params: {
  companyId: string;
  invoice: Stripe.Invoice;
  paymentFailureMessage?: string | null;
  markFailed?: boolean;
  markPaid?: boolean;
}): Promise<void> {
  const cid = normalizeCompanyId(params.companyId);
  if (!cid) return;
  const inv = params.invoice;
  const invoiceId = String(inv.id ?? "").trim();
  if (!invoiceId) return;

  const customerId =
    typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  const subscriptionId = subscriptionIdFromInvoice(inv);

  const invoiceDate = inv.created
    ? new Date(inv.created * 1000)
    : null;
  const dueDate = inv.due_date ? new Date(inv.due_date * 1000) : invoiceDate;
  const paidAt =
    params.markPaid || inv.status === "paid"
      ? inv.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000)
        : new Date()
      : null;
  const failureMessage =
    params.paymentFailureMessage?.trim() ||
    (params.markFailed ? "Payment failed" : null);
  const paymentFailedAt = params.markFailed
    ? new Date()
    : failureMessage
      ? new Date()
      : null;

  const preserveFailures = !params.markPaid && !params.markFailed;
  const values = {
    companyId: cid,
    stripeInvoiceId: invoiceId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    invoiceNumber: inv.number || invoiceId,
    status: String(inv.status ?? "open"),
    currency: String(inv.currency ?? "usd"),
    amountDueCents: inv.amount_due ?? inv.total ?? 0,
    amountPaidCents: inv.amount_paid ?? 0,
    amountRemainingCents: inv.amount_remaining ?? 0,
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    paymentFailureMessage: params.markPaid
      ? null
      : params.markFailed
        ? failureMessage
        : null,
    paymentFailedAt: params.markPaid
      ? null
      : params.markFailed
        ? paymentFailedAt
        : null,
    paidAt,
    invoiceDate,
    dueDate,
    updatedAt: new Date(),
  };

  await db
    .insert(companyBillingInvoices)
    .values(values)
    .onConflictDoUpdate({
      target: companyBillingInvoices.stripeInvoiceId,
      set: {
        stripeCustomerId: values.stripeCustomerId,
        stripeSubscriptionId: values.stripeSubscriptionId,
        invoiceNumber: values.invoiceNumber,
        status: values.status,
        currency: values.currency,
        amountDueCents: values.amountDueCents,
        amountPaidCents: values.amountPaidCents,
        amountRemainingCents: values.amountRemainingCents,
        hostedInvoiceUrl: values.hostedInvoiceUrl,
        invoicePdf: values.invoicePdf,
        // Refreshing from Stripe list must not wipe webhook failure details.
        ...(preserveFailures
          ? {}
          : {
              paymentFailureMessage: values.paymentFailureMessage,
              paymentFailedAt: values.paymentFailedAt,
            }),
        ...(params.markPaid || paidAt ? { paidAt: values.paidAt } : {}),
        invoiceDate: values.invoiceDate,
        dueDate: values.dueDate,
        updatedAt: values.updatedAt,
      },
    });
}

export async function listCompanyStripeInvoices(
  companyId: string,
  options?: { dealIds?: string[] | null },
): Promise<
  | { ok: true; invoices: BillingInvoiceRow[] }
  | { ok: false; status: number; message: string }
> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const [company] = await db
    .select({
      id: companies.id,
      stripeCustomerId: companies.stripeCustomerId,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!company) {
    return { ok: false, status: 404, message: "Company not found" };
  }

  const extrasByInvoice = new Map<
    string,
    ReturnType<typeof extrasFromStripeInvoice>
  >();
  const payerByInvoiceId = new Map<string, string>();
  const payerBySubscriptionId = new Map<string, string>();

  // Prefer refreshing from Stripe when configured, then serve from DB.
  if (getStripeConfig() && company.stripeCustomerId?.trim()) {
    const customerId = company.stripeCustomerId.trim();
    try {
      const stripe = getStripeClient();
      const list = await stripe.invoices.list({
        customer: customerId,
        limit: 50,
        expand: ["data.lines"],
      });
      for (const inv of list.data) {
        await upsertBillingInvoiceFromStripe({
          companyId: cid,
          invoice: inv,
          markPaid: inv.status === "paid",
        });
        extrasByInvoice.set(inv.id, extrasFromStripeInvoice(inv));
        const payerUserId = payerUserIdFromStripeInvoice(inv);
        if (payerUserId) {
          payerByInvoiceId.set(inv.id, payerUserId);
          const subscriptionId = subscriptionIdFromInvoice(inv);
          if (subscriptionId) {
            payerBySubscriptionId.set(subscriptionId, payerUserId);
          }
        }
      }
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 100,
      });
      for (const sub of subscriptions.data) {
        const payerUserId = normalizeCompanyId(
          String(sub.metadata?.payerUserId ?? ""),
        );
        if (payerUserId) payerBySubscriptionId.set(sub.id, payerUserId);
      }
    } catch (err) {
      console.warn("listCompanyStripeInvoices Stripe refresh:", err);
    }
  }

  const rows = await db
    .select()
    .from(companyBillingInvoices)
    .where(eq(companyBillingInvoices.companyId, cid))
    .orderBy(desc(companyBillingInvoices.invoiceDate))
    .limit(50);

  if (getStripeConfig()) {
    const missingSubscriptionIds = [
      ...new Set(
        rows
          .map((row) => row.stripeSubscriptionId?.trim() ?? "")
          .filter((id) => id && !payerBySubscriptionId.has(id)),
      ),
    ];
    if (missingSubscriptionIds.length > 0) {
      try {
        const { mapWithConcurrency } = await import(
          "../../common/mapWithConcurrency.js"
        );
        const stripe = getStripeClient();
        await mapWithConcurrency(missingSubscriptionIds, 4, async (subscriptionId) => {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            const payerUserId = normalizeCompanyId(
              String(sub.metadata?.payerUserId ?? ""),
            );
            if (payerUserId) payerBySubscriptionId.set(subscriptionId, payerUserId);
          } catch (err) {
            console.warn(
              "listCompanyStripeInvoices payer lookup:",
              subscriptionId,
              err,
            );
          }
        });
      } catch (err) {
        console.warn("listCompanyStripeInvoices payer lookup:", err);
      }
    }
  }

  const { mapStripeSubscriptionsToDeals } = await import(
    "./dealBilling.service.js"
  );
  const dealBySub = await mapStripeSubscriptionsToDeals(
    cid,
    options?.dealIds ?? null,
  );
  const dealNames = await mapCompanyDealNames(cid, options?.dealIds ?? null);
  const scoped = Array.isArray(options?.dealIds);
  if (scoped && (options?.dealIds?.length ?? 0) === 0) {
    return { ok: true, invoices: [] };
  }
  const allowedDealIds = scoped
    ? new Set((options?.dealIds ?? []).map((id) => id.toLowerCase()))
    : null;

  const invoices: BillingInvoiceRow[] = [];
  const payerUserIdByInvoiceId = new Map<string, string>();
  for (const row of rows) {
    const sub = row.stripeSubscriptionId?.trim() ?? "";
    const deal = sub ? dealBySub.get(sub) : undefined;
    const extras = extrasByInvoice.get(row.stripeInvoiceId);
    const metaDealId = extras?.dealId ?? null;
    const dealId = deal?.dealId ?? metaDealId;
    if (scoped && (!dealId || (allowedDealIds && !allowedDealIds.has(dealId)))) {
      continue;
    }
    const invoiceDate = isoDateOnly(row.invoiceDate);
    const dueDate = isoDateOnly(row.dueDate) || invoiceDate;
    const dealName =
      (deal?.dealName?.trim() ? deal.dealName : null) ||
      (dealId ? dealNames.get(dealId) || null : null);
    const payerUserId =
      payerByInvoiceId.get(row.stripeInvoiceId) ||
      (sub ? payerBySubscriptionId.get(sub) : undefined) ||
      null;
    if (payerUserId) payerUserIdByInvoiceId.set(row.stripeInvoiceId, payerUserId);
    invoices.push({
      id: row.stripeInvoiceId,
      invoiceNumber: row.invoiceNumber || row.stripeInvoiceId,
      invoiceDate,
      dueDate,
      periodStart: extras?.periodStart || invoiceDate,
      periodEnd: extras?.periodEnd || dueDate,
      planId: extras?.planId ?? null,
      status: row.status,
      amount: formatMoneyCents(
        row.status === "paid"
          ? row.amountPaidCents || row.amountDueCents
          : row.amountDueCents,
        row.currency,
      ),
      hostedInvoiceUrl: row.hostedInvoiceUrl,
      invoicePdf: row.invoicePdf,
      paymentFailureMessage: row.paymentFailureMessage,
      paymentFailedAt: row.paymentFailedAt
        ? row.paymentFailedAt.toISOString()
        : null,
      dealId,
      dealName,
      billingScope: "deal",
    });
  }

  const paidByNames = await billingUserDisplayNames([
    ...payerUserIdByInvoiceId.values(),
  ]);
  for (const invoice of invoices) {
    const payerUserId = payerUserIdByInvoiceId.get(invoice.id);
    invoice.paidByName = payerUserId
      ? paidByNames.get(payerUserId) ?? null
      : null;
  }

  const customerId = company.stripeCustomerId?.trim();
  if (getStripeConfig() && customerId) {
    const extraRows = await listExtraCompanyUserInvoiceRows({
      stripe: getStripeClient(),
      customerId,
      dealNames,
      allowedDealIds: options?.dealIds ?? null,
    });
    invoices.push(...extraRows);
    invoices.sort((a, b) => String(b.invoiceDate).localeCompare(String(a.invoiceDate)));
  }

  return { ok: true, invoices };
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === "string" ? price : price.id;
}

function subscriptionIdFromInvoice(inv: Stripe.Invoice): string | null {
  const nested = inv.parent?.subscription_details?.subscription;
  if (nested) {
    return typeof nested === "string" ? nested : nested.id ?? null;
  }
  // Legacy fallback for older API payloads / expansions.
  const legacy = (inv as { subscription?: string | { id?: string } | null })
    .subscription;
  if (!legacy) return null;
  return typeof legacy === "string" ? legacy : legacy.id ?? null;
}

async function syncDealSubscriptionsAfterCompanyPayment(
  companyId: string,
): Promise<void> {
  try {
    const { syncCompanyDealSaasSubscriptions } = await import(
      "./dealBilling.service.js"
    );
    await syncCompanyDealSaasSubscriptions(companyId);
  } catch (err) {
    console.warn("syncDealSubscriptionsAfterCompanyPayment:", err);
  }
}

export async function applySubscriptionToCompany(
  companyId: string,
  sub: Stripe.Subscription,
  extras?: { dealId?: string | null },
): Promise<void> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return;

  const priceId = priceIdFromSubscription(sub);
  const mapped = planAndCycleFromPriceId(priceId);
  const metaPlan = String(sub.metadata?.planId ?? "").trim();
  const metaCycle = String(sub.metadata?.billingCycle ?? "").trim();
  const planId =
    mapped.planId ?? normalizeBillingPlanId(metaPlan);
  const cycle =
    mapped.cycle ??
    (metaCycle === "monthly" || metaCycle === "annual" || metaCycle === "yearly"
      ? metaCycle === "yearly"
        ? "annual"
        : (metaCycle as "monthly" | "annual")
      : null);

  const status = String(sub.status ?? "none");
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;

  const clearFailure =
    status === "active" || status === "trialing" || status === "canceled";

  const dealIdRaw = String(
    sub.metadata?.dealId ?? extras?.dealId ?? "",
  ).trim();
  const isDealScoped = Boolean(dealIdRaw);

  const [existing] = await db
    .select({
      stripeSubscriptionId: companies.stripeSubscriptionId,
      stripeCustomerId: companies.stripeCustomerId,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  const existingSub = existing?.stripeSubscriptionId?.trim() ?? "";
  const writeCompanySub =
    !existingSub || existingSub === sub.id || !isDealScoped;
  // Deal payments use the lead sponsor's customer. Do not replace the
  // company customer, or the next deal would inherit that sponsor's email.
  const existingCustomer = existing?.stripeCustomerId?.trim() ?? "";
  const writeCompanyCustomer = !existingCustomer && Boolean(customerId);

  await db
    .update(companies)
    .set({
      ...(writeCompanyCustomer ? { stripeCustomerId: customerId } : {}),
      ...(writeCompanySub
        ? {
            stripeSubscriptionId: sub.id,
            stripePlanId: planId,
            stripeBillingCycle: cycle,
            stripeSubscriptionStatus: status || "none",
            stripePriceId: priceId,
            stripeCurrentPeriodEnd: periodEndFromSubscription(sub),
          }
        : {}),
      ...(clearFailure
        ? {
            stripeLastPaymentError: null,
            stripeLastPaymentFailedAt: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, cid));

  try {
    const dealBilling = await import("./dealBilling.service.js");
    if (dealIdRaw) {
      await dealBilling.applyStripeSubscriptionToDeal(dealIdRaw, sub);
    }
    await dealBilling.refreshCompanyBillingFromDeals(cid);
  } catch (err) {
    console.warn("applySubscriptionToCompany deal billing:", err);
  }

  if (dealIdRaw && (status === "active" || status === "trialing")) {
    releaseBillingPaymentHold(cid, dealIdRaw);
  }
}

export async function clearCompanySubscription(
  companyId: string,
  opts?: { keepCustomer?: boolean },
): Promise<void> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return;
  await db
    .update(companies)
    .set({
      stripeSubscriptionId: null,
      stripePlanId: null,
      stripeBillingCycle: null,
      stripeSubscriptionStatus: "canceled",
      stripePriceId: null,
      stripeCurrentPeriodEnd: null,
      ...(opts?.keepCustomer ? {} : {}),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, cid));
}

async function persistInvoicesForSubscription(params: {
  companyId: string;
  subscriptionId: string;
  customerId?: string | null;
}): Promise<void> {
  const cid = normalizeCompanyId(params.companyId);
  if (!cid) return;
  const stripe = getStripeClient();

  const sub = await stripe.subscriptions.retrieve(params.subscriptionId, {
    expand: ["latest_invoice"],
  });

  const latest = sub.latest_invoice;
  if (latest && typeof latest !== "string") {
    await upsertBillingInvoiceFromStripe({
      companyId: cid,
      invoice: latest,
      markPaid: latest.status === "paid",
      markFailed: latest.status === "open" && (latest.attempt_count ?? 0) > 0,
    });
  } else if (typeof latest === "string" && latest.trim()) {
    const inv = await stripe.invoices.retrieve(latest.trim());
    await upsertBillingInvoiceFromStripe({
      companyId: cid,
      invoice: inv,
      markPaid: inv.status === "paid",
    });
  }

  const customerId =
    params.customerId?.trim() ||
    (typeof sub.customer === "string" ? sub.customer : sub.customer?.id) ||
    "";
  if (customerId) {
    const list = await stripe.invoices.list({
      customer: customerId,
      subscription: params.subscriptionId,
      limit: 10,
    });
    for (const inv of list.data) {
      await upsertBillingInvoiceFromStripe({
        companyId: cid,
        invoice: inv,
        markPaid: inv.status === "paid",
        markFailed: inv.status === "open" && (inv.attempt_count ?? 0) > 0,
      });
    }
  }
}

/**
 * Sync company billing from a Checkout Session id (success redirect).
 * Works locally and in production even if the webhook is delayed/missing briefly.
 */
async function syncDealUpgradeCheckoutSession(params: {
  companyId: string;
  session: Stripe.Checkout.Session;
}): Promise<
  | { ok: true; status: CompanyBillingStatus; paidDealId: string | null }
  | { ok: false; status: number; message: string }
> {
  const cid = params.companyId;
  const session = params.session;
  const metaCompany = normalizeCompanyId(
    String(session.metadata?.companyId ?? session.client_reference_id ?? ""),
  );
  if (!metaCompany || metaCompany !== cid) {
    return {
      ok: false,
      status: 403,
      message: "Checkout session does not belong to this company.",
    };
  }
  if (session.payment_status !== "paid") {
    return {
      ok: false,
      status: 409,
      message: "Checkout payment is not complete yet.",
    };
  }
  const dealId = normalizeCompanyId(String(session.metadata?.dealId ?? ""));
  const planId = normalizeBillingPlanId(session.metadata?.planId);
  const seatBand = normalizeBillingSeatBand(session.metadata?.seatBand);
  const cycleRaw = String(session.metadata?.billingCycle ?? "").trim();
  const cycle: StripeBillingCycle | null =
    cycleRaw === "monthly"
      ? "monthly"
      : cycleRaw === "annual" || cycleRaw === "annually" || cycleRaw === "yearly"
        ? "annual"
        : null;
  if (!dealId || !planId || !seatBand || !cycle) {
    return {
      ok: false,
      status: 400,
      message: "Checkout session is missing the upgrade package.",
    };
  }
  const [deal] = await db
    .select()
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  if (!deal) {
    return { ok: false, status: 404, message: "Deal not found." };
  }
  const upgraded = await upgradeDealStripeSubscription({
    deal,
    planId,
    cycle,
    seatBand,
    collectDifference: false,
    ...couponHoldFromMetadata(session.metadata),
  });
  if (!upgraded.ok && upgraded.status !== 409) {
    return { ok: false, status: upgraded.status, message: upgraded.message };
  }
  if (upgraded.ok) {
    await applySubscriptionToCompany(cid, upgraded.subscription, { dealId });
  }
  const status = await getCompanyBillingStatus(cid);
  if (!status) {
    return { ok: false, status: 404, message: "Company not found" };
  }
  return { ok: true, status, paidDealId: dealId };
}

export async function syncCompanyBillingFromCheckoutSession(params: {
  companyId: string;
  checkoutSessionId: string;
}): Promise<
  | { ok: true; status: CompanyBillingStatus; paidDealId: string | null }
  | { ok: false; status: number; message: string }
> {
  if (!getStripeConfig()) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cid = normalizeCompanyId(params.companyId);
  const sessionId = String(params.checkoutSessionId ?? "").trim();
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }
  if (!sessionId.startsWith("cs_")) {
    return { ok: false, status: 400, message: "Invalid checkout session id" };
  }

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription", "subscription.latest_invoice", "invoice"],
    });
    if (
      session.mode === "payment" &&
      String(session.metadata?.billingScope ?? "") === "deal_upgrade"
    ) {
      return syncDealUpgradeCheckoutSession({ companyId: cid, session });
    }
    if (session.mode !== "subscription") {
      return {
        ok: false,
        status: 400,
        message: "Checkout session is not a subscription.",
      };
    }

    const metaCompany = String(session.metadata?.companyId ?? "").trim();
    const refCompany = String(session.client_reference_id ?? "").trim();
    const sessionCompany = normalizeCompanyId(metaCompany || refCompany);
    if (!sessionCompany || sessionCompany !== cid) {
      return {
        ok: false,
        status: 403,
        message: "Checkout session does not belong to this company.",
      };
    }
    if (session.status !== "complete") {
      return {
        ok: false,
        status: 409,
        message: "Checkout is not complete yet.",
      };
    }

    const subRef = session.subscription;
    const subId = typeof subRef === "string" ? subRef : subRef?.id;
    if (!subId) {
      return {
        ok: false,
        status: 409,
        message: "Subscription is not ready yet. Try again in a moment.",
      };
    }

    const sub =
      typeof subRef === "string"
        ? await stripe.subscriptions.retrieve(subId, {
            expand: ["items.data.price"],
          })
        : (subRef as Stripe.Subscription);
    const sessionDealId = String(session.metadata?.dealId ?? "").trim();
    await applySubscriptionToCompany(cid, sub, { dealId: sessionDealId });
    await syncDealSubscriptionsAfterCompanyPayment(cid);

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;

    // Stripe generates the subscription invoice automatically — persist it in our DB.
    try {
      const sessionInvoice = (
        session as { invoice?: string | Stripe.Invoice | null }
      ).invoice;
      if (sessionInvoice && typeof sessionInvoice !== "string") {
        await upsertBillingInvoiceFromStripe({
          companyId: cid,
          invoice: sessionInvoice,
          markPaid: sessionInvoice.status === "paid",
        });
      } else if (typeof sessionInvoice === "string" && sessionInvoice.trim()) {
        const inv = await stripe.invoices.retrieve(sessionInvoice.trim());
        await upsertBillingInvoiceFromStripe({
          companyId: cid,
          invoice: inv,
          markPaid: inv.status === "paid",
        });
      }
      await persistInvoicesForSubscription({
        companyId: cid,
        subscriptionId: subId,
        customerId,
      });
    } catch (invErr) {
      console.warn("sync checkout invoice snapshot:", invErr);
    }

    await recordBillingEvent({
      companyId: cid,
      eventType: "checkout.session.synced",
      stripeSubscriptionId: subId,
      stripeCustomerId: customerId,
      message: "Checkout session synced from success redirect",
      payload: { sessionId },
    });

    if (customerId) {
      try {
        await syncCompanyPaymentMethodsFromStripe(cid);
      } catch (pmErr) {
        console.warn("sync checkout payment methods:", pmErr);
      }
    }

    const status = await getCompanyBillingStatus(cid);
    if (!status) {
      return { ok: false, status: 404, message: "Company not found" };
    }
    const paidDealId =
      normalizeCompanyId(String(session.metadata?.dealId ?? "")) ||
      normalizeCompanyId(String(sub.metadata?.dealId ?? "")) ||
      null;
    return { ok: true, status, paidDealId };
  } catch (err) {
    console.error("syncCompanyBillingFromCheckoutSession:", err);
    const msg =
      err instanceof Error ? err.message : "Could not sync checkout session";
    return { ok: false, status: 502, message: msg };
  }
}

async function findCompanyIdForStripeCustomer(
  customerId: string,
): Promise<string | null> {
  const id = String(customerId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.stripeCustomerId, id))
    .limit(1);
  if (row?.id) return row.id;
  const [deal] = await db
    .select({ organizationId: addDealForm.organizationId })
    .from(addDealForm)
    .where(eq(addDealForm.stripePayerCustomerId, id))
    .limit(1);
  return normalizeCompanyId(String(deal?.organizationId ?? ""));
}

async function findCompanyIdForSubscription(
  subscriptionId: string,
): Promise<string | null> {
  const id = String(subscriptionId ?? "").trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.stripeSubscriptionId, id))
    .limit(1);
  if (row?.id) return row.id;
  try {
    const { findCompanyIdForDealSubscription } = await import(
      "./dealBilling.service.js"
    );
    return findCompanyIdForDealSubscription(id);
  } catch (err) {
    console.warn("findCompanyIdForSubscription deal lookup:", err);
    return null;
  }
}

export type CompanyBillingPaymentMethodDto = {
  id: string;
  stripePaymentMethodId: string;
  stripeCustomerId: string | null;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  funding: string | null;
  country: string | null;
  fingerprint: string | null;
  billingName: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  billingAddress: unknown;
  isDefault: boolean;
  livemode: boolean;
  stripeCreatedAt: string | null;
  /** Full Stripe PaymentMethod object snapshot. */
  stripePayload: unknown;
  detachedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function stripeIdRef(
  value: string | { id?: string | null } | null | undefined,
): string | null {
  if (typeof value === "string") {
    const s = value.trim();
    return s || null;
  }
  if (value && typeof value === "object" && typeof value.id === "string") {
    const s = value.id.trim();
    return s || null;
  }
  return null;
}

function sameStripeCustomer(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return true;
  return left === right;
}

type PaymentMethodIdentity = {
  stripePaymentMethodId: string;
  stripeCustomerId: string | null;
  fingerprint: string | null;
  addedByUserId?: string | null;
  isDefault: boolean;
  createdAt: Date;
};

function paymentMethodFingerprintKey(
  row: Pick<PaymentMethodIdentity, "fingerprint" | "addedByUserId">,
): string {
  const fingerprint = row.fingerprint?.trim() ?? "";
  if (!fingerprint) return "";
  return `${row.addedByUserId ?? ""}:${fingerprint}`;
}

/**
 * Keep the default method, then the one on the company Stripe customer,
 * then the one saved first.
 */
function preferPaymentMethodRow<T extends PaymentMethodIdentity>(
  a: T,
  b: T,
  preferredCustomerId?: string | null,
): T {
  if (a.isDefault !== b.isDefault) return a.isDefault ? a : b;
  const preferred = String(preferredCustomerId ?? "").trim();
  if (preferred) {
    const aOnCompany = String(a.stripeCustomerId ?? "").trim() === preferred;
    const bOnCompany = String(b.stripeCustomerId ?? "").trim() === preferred;
    if (aOnCompany !== bOnCompany) return aOnCompany ? a : b;
  }
  const aTime = a.createdAt.getTime();
  const bTime = b.createdAt.getTime();
  if (aTime !== bTime) return aTime < bTime ? a : b;
  return a.stripePaymentMethodId <= b.stripePaymentMethodId ? a : b;
}

function duplicatePaymentMethodLosers<T extends PaymentMethodIdentity>(
  rows: T[],
  preferredCustomerId?: string | null,
): { keep: T[]; drop: { loser: T; winner: T }[] } {
  const keep: T[] = [];
  const keepByFingerprint = new Map<string, T>();
  const drop: { loser: T; winner: T }[] = [];

  for (const row of rows) {
    const fingerprint = paymentMethodFingerprintKey(row);
    if (!fingerprint) {
      keep.push(row);
      continue;
    }
    const prev = keepByFingerprint.get(fingerprint);
    if (!prev) {
      keepByFingerprint.set(fingerprint, row);
      keep.push(row);
      continue;
    }
    const winner = preferPaymentMethodRow(prev, row, preferredCustomerId);
    const loser = winner === prev ? row : prev;
    if (winner !== prev) {
      const idx = keep.indexOf(prev);
      if (idx >= 0) keep[idx] = winner;
      keepByFingerprint.set(fingerprint, winner);
    }
    drop.push({ loser, winner });
  }

  return { keep, drop };
}

async function companyStripeCustomerId(companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ stripeCustomerId: companies.stripeCustomerId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const id = row?.stripeCustomerId?.trim() ?? "";
  return id || null;
}

async function detachStripePaymentMethod(
  stripePaymentMethodId: string,
): Promise<void> {
  const pmId = String(stripePaymentMethodId ?? "").trim();
  if (!pmId || !getStripeConfig()) return;
  try {
    const stripe = getStripeClient();
    await stripe.paymentMethods.detach(pmId);
  } catch (err) {
    console.warn("detach duplicate payment method:", pmId, err);
  }
}

/**
 * Hide a repeated card or bank account. Detach it in Stripe only when it is
 * attached to the same customer as the method we keep, so a deal-payer copy
 * of that card is not removed from the other customer.
 */
async function hideDuplicatePaymentMethod(params: {
  stripePaymentMethodId: string;
  customerId: string | null;
  keeperCustomerId: string | null;
}): Promise<void> {
  await markPaymentMethodDetached(params.stripePaymentMethodId);
  if (sameStripeCustomer(params.customerId, params.keeperCustomerId)) {
    await detachStripePaymentMethod(params.stripePaymentMethodId);
  }
}

function paymentMethodRowFields(
  pm: Stripe.PaymentMethod,
  opts?: { isDefault?: boolean },
) {
  const card = pm.card ?? null;
  const bank = pm.us_bank_account ?? null;
  const billing = pm.billing_details ?? null;
  const brand =
    card?.brand?.trim() ||
    bank?.bank_name?.trim() ||
    (pm.type === "link" ? "link" : null);
  const last4 = card?.last4?.trim() || bank?.last4?.trim() || null;
  const fingerprint =
    card?.fingerprint?.trim() || bank?.fingerprint?.trim() || null;
  const country = card?.country?.trim() || null;
  const funding = card?.funding?.trim() || null;

  return {
    stripePaymentMethodId: pm.id,
    stripeCustomerId: stripeIdRef(pm.customer),
    type: (pm.type || "card").trim() || "card",
    brand,
    last4,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
    funding,
    country,
    fingerprint,
    billingName: billing?.name?.trim() || null,
    billingEmail: billing?.email?.trim() || null,
    billingPhone: billing?.phone?.trim() || null,
    billingAddress: billing?.address ?? null,
    isDefault: Boolean(opts?.isDefault),
    livemode: Boolean(pm.livemode),
    stripeCreatedAt:
      typeof pm.created === "number" ? new Date(pm.created * 1000) : null,
    stripePayload: pm as unknown as Record<string, unknown>,
    detachedAt: null as Date | null,
    updatedAt: new Date(),
  };
}

export async function upsertPaymentMethodFromStripe(params: {
  companyId: string;
  paymentMethod: Stripe.PaymentMethod;
  isDefault?: boolean;
  addedByUserId?: string | null;
}): Promise<void> {
  const cid = normalizeCompanyId(params.companyId);
  if (!cid || !params.paymentMethod?.id) return;
  const fields = paymentMethodRowFields(params.paymentMethod, {
    isDefault: params.isDefault,
  });
  const ownerFromMetadata = normalizeCompanyId(
    String(params.paymentMethod.metadata?.payerUserId ?? ""),
  );
  const ownerFromCustomer = await userIdForStripeCustomer(fields.stripeCustomerId);
  const requestedOwner =
    normalizeCompanyId(params.addedByUserId ?? "") ??
    ownerFromMetadata ??
    ownerFromCustomer;

  const [existingOwner] = await db
    .select({ addedByUserId: companyBillingPaymentMethods.addedByUserId })
    .from(companyBillingPaymentMethods)
    .where(
      eq(
        companyBillingPaymentMethods.stripePaymentMethodId,
        params.paymentMethod.id,
      ),
    )
    .limit(1);
  const ownerId = existingOwner?.addedByUserId ?? requestedOwner;

  const fingerprint = fields.fingerprint?.trim() ?? "";
  if (fingerprint) {
    const others = await db
      .select({
        stripePaymentMethodId:
          companyBillingPaymentMethods.stripePaymentMethodId,
        stripeCustomerId: companyBillingPaymentMethods.stripeCustomerId,
        fingerprint: companyBillingPaymentMethods.fingerprint,
        addedByUserId: companyBillingPaymentMethods.addedByUserId,
        isDefault: companyBillingPaymentMethods.isDefault,
        createdAt: companyBillingPaymentMethods.createdAt,
      })
      .from(companyBillingPaymentMethods)
      .where(
        and(
          eq(companyBillingPaymentMethods.companyId, cid),
          eq(companyBillingPaymentMethods.fingerprint, fingerprint),
          ne(
            companyBillingPaymentMethods.stripePaymentMethodId,
            params.paymentMethod.id,
          ),
          isNull(companyBillingPaymentMethods.detachedAt),
          ownerId
            ? eq(companyBillingPaymentMethods.addedByUserId, ownerId)
            : isNull(companyBillingPaymentMethods.addedByUserId),
        ),
      );
    if (others.length > 0) {
      const preferredCustomerId = await companyStripeCustomerId(cid);
      const bestOther = others.reduce((best, row) =>
        preferPaymentMethodRow(best, row, preferredCustomerId),
      );
      const incoming: PaymentMethodIdentity = {
        stripePaymentMethodId: params.paymentMethod.id,
        stripeCustomerId: fields.stripeCustomerId,
        fingerprint,
        addedByUserId: ownerId,
        isDefault: Boolean(params.isDefault),
        createdAt: new Date(),
      };
      const winner = preferPaymentMethodRow(
        bestOther,
        incoming,
        preferredCustomerId,
      );
      if (winner.stripePaymentMethodId !== params.paymentMethod.id) {
        await hideDuplicatePaymentMethod({
          stripePaymentMethodId: params.paymentMethod.id,
          customerId: fields.stripeCustomerId,
          keeperCustomerId: bestOther.stripeCustomerId,
        });
        return;
      }
      for (const row of others) {
        await hideDuplicatePaymentMethod({
          stripePaymentMethodId: row.stripePaymentMethodId,
          customerId: row.stripeCustomerId,
          keeperCustomerId: fields.stripeCustomerId,
        });
      }
    }
  }

  await db
    .insert(companyBillingPaymentMethods)
    .values({
      companyId: cid,
      ...fields,
      addedByUserId: ownerId,
    })
    .onConflictDoUpdate({
      target: companyBillingPaymentMethods.stripePaymentMethodId,
      set: {
        companyId: cid,
        ...fields,
        addedByUserId: ownerId,
      },
    });

  if (params.isDefault) {
    await db
      .update(companyBillingPaymentMethods)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(companyBillingPaymentMethods.companyId, cid),
          ne(
            companyBillingPaymentMethods.stripePaymentMethodId,
            params.paymentMethod.id,
          ),
          eq(companyBillingPaymentMethods.isDefault, true),
          ownerId
            ? eq(companyBillingPaymentMethods.addedByUserId, ownerId)
            : isNull(companyBillingPaymentMethods.addedByUserId),
        ),
      );
  }
}

async function assignPaymentMethodOwner(params: {
  companyId: string;
  stripePaymentMethodId: string;
  userId: string;
}): Promise<void> {
  const cid = normalizeCompanyId(params.companyId);
  const userId = normalizeCompanyId(params.userId);
  const pmId = String(params.stripePaymentMethodId ?? "").trim();
  if (!cid || !userId || !pmId) return;
  await db
    .update(companyBillingPaymentMethods)
    .set({ addedByUserId: userId, updatedAt: new Date() })
    .where(
      and(
        eq(companyBillingPaymentMethods.companyId, cid),
        eq(companyBillingPaymentMethods.stripePaymentMethodId, pmId),
        isNull(companyBillingPaymentMethods.addedByUserId),
      ),
    );
  if (!getStripeConfig()) return;
  try {
    const stripe = getStripeClient();
    await stripe.paymentMethods.update(pmId, {
      metadata: { payerUserId: userId, companyId: cid },
    });
  } catch (err) {
    console.warn("assignPaymentMethodOwner metadata:", err);
  }
}

async function markPaymentMethodDetached(
  stripePaymentMethodId: string,
): Promise<void> {
  const pmId = String(stripePaymentMethodId ?? "").trim();
  if (!pmId) return;
  await db
    .update(companyBillingPaymentMethods)
    .set({
      isDefault: false,
      detachedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companyBillingPaymentMethods.stripePaymentMethodId, pmId));
}

async function resolveDefaultPaymentMethodId(
  customerId: string,
): Promise<string | null> {
  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || ("deleted" in customer && customer.deleted)) return null;
  return stripeIdRef(customer.invoice_settings?.default_payment_method);
}

async function syncDefaultPaymentMethodFlags(params: {
  companyId: string;
  customerId: string;
}): Promise<void> {
  const defaultPmId = await resolveDefaultPaymentMethodId(params.customerId);
  if (!defaultPmId) return;
  const [ownerRow] = await db
    .select({ addedByUserId: companyBillingPaymentMethods.addedByUserId })
    .from(companyBillingPaymentMethods)
    .where(eq(companyBillingPaymentMethods.stripePaymentMethodId, defaultPmId))
    .limit(1);
  const ownerId = ownerRow?.addedByUserId ?? null;
  await db
    .update(companyBillingPaymentMethods)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(companyBillingPaymentMethods.companyId, params.companyId),
        eq(companyBillingPaymentMethods.isDefault, true),
        ne(companyBillingPaymentMethods.stripePaymentMethodId, defaultPmId),
        ownerId
          ? eq(companyBillingPaymentMethods.addedByUserId, ownerId)
          : isNull(companyBillingPaymentMethods.addedByUserId),
      ),
    );
  await db
    .update(companyBillingPaymentMethods)
    .set({ isDefault: true, updatedAt: new Date() })
    .where(
      and(
        eq(companyBillingPaymentMethods.companyId, params.companyId),
        eq(companyBillingPaymentMethods.stripePaymentMethodId, defaultPmId),
        isNull(companyBillingPaymentMethods.detachedAt),
      ),
    );
}

export async function listCompanyPaymentMethods(
  companyId: string,
  opts?: { includeDetached?: boolean; userId?: string | null },
): Promise<CompanyBillingPaymentMethodDto[]> {
  const cid = normalizeCompanyId(companyId);
  if (!cid) return [];
  const userId = normalizeCompanyId(opts?.userId ?? "");

  const rows = await db
    .select()
    .from(companyBillingPaymentMethods)
    .where(
      and(
        eq(companyBillingPaymentMethods.companyId, cid),
        ...(opts?.includeDetached
          ? []
          : [isNull(companyBillingPaymentMethods.detachedAt)]),
        ...(userId
          ? [eq(companyBillingPaymentMethods.addedByUserId, userId)]
          : []),
      ),
    )
    .orderBy(
      desc(companyBillingPaymentMethods.isDefault),
      desc(companyBillingPaymentMethods.createdAt),
    );

  const activeRows = rows.filter((row) => !row.detachedAt);
  const seenFingerprints = new Set<string>();
  let hasDuplicateFingerprint = false;
  for (const row of activeRows) {
    const fingerprint = paymentMethodFingerprintKey(row);
    if (!fingerprint) continue;
    if (seenFingerprints.has(fingerprint)) {
      hasDuplicateFingerprint = true;
      break;
    }
    seenFingerprints.add(fingerprint);
  }

  let visibleRows = rows;
  if (hasDuplicateFingerprint) {
    const detachedRows = opts?.includeDetached
      ? rows.filter((row) => row.detachedAt)
      : [];
    const preferredCustomerId = await companyStripeCustomerId(cid);
    const { keep, drop } = duplicatePaymentMethodLosers(
      activeRows,
      preferredCustomerId,
    );
    for (const { loser, winner } of drop) {
      await hideDuplicatePaymentMethod({
        stripePaymentMethodId: loser.stripePaymentMethodId,
        customerId: loser.stripeCustomerId,
        keeperCustomerId: winner.stripeCustomerId,
      });
    }
    visibleRows = [...keep, ...detachedRows];
  }

  return visibleRows.map((row) => ({
    id: row.id,
    stripePaymentMethodId: row.stripePaymentMethodId,
    stripeCustomerId: row.stripeCustomerId,
    type: row.type,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    funding: row.funding,
    country: row.country,
    fingerprint: row.fingerprint,
    billingName: row.billingName,
    billingEmail: row.billingEmail,
    billingPhone: row.billingPhone,
    billingAddress: row.billingAddress,
    isDefault: row.isDefault,
    livemode: row.livemode,
    stripeCreatedAt: row.stripeCreatedAt
      ? row.stripeCreatedAt.toISOString()
      : null,
    stripePayload: row.stripePayload,
    detachedAt: row.detachedAt ? row.detachedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Pull all PaymentMethods for the company Stripe customer into the local DB.
 * Safe to call after portal return / checkout when webhooks may be delayed.
 */
export async function syncCompanyPaymentMethodsFromStripe(
  companyId: string,
  opts?: { actorUserId?: string | null },
): Promise<
  | { ok: true; paymentMethods: CompanyBillingPaymentMethodDto[] }
  | { ok: false; status: number; message: string }
> {
  if (!getStripeConfig()) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }

  const cid = normalizeCompanyId(companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  const [co] = await db
    .select({
      id: companies.id,
      stripeCustomerId: companies.stripeCustomerId,
    })
    .from(companies)
    .where(eq(companies.id, cid))
    .limit(1);
  if (!co) {
    return { ok: false, status: 404, message: "Company not found" };
  }
  const payerRows = await db
    .select({
      stripePayerCustomerId: addDealForm.stripePayerCustomerId,
    })
    .from(addDealForm)
    .where(
      and(
        eq(addDealForm.organizationId, cid),
        isNotNull(addDealForm.stripePayerCustomerId),
      ),
    );
  const actorUserId = normalizeCompanyId(opts?.actorUserId ?? "");
  let actorCustomerId = "";
  if (actorUserId) {
    const [actor] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, actorUserId))
      .limit(1);
    actorCustomerId = actor?.stripeCustomerId?.trim() ?? "";
  }
  const customerIds = [
    ...new Set(
      [
        co.stripeCustomerId?.trim() ?? "",
        ...payerRows.map((row) => row.stripePayerCustomerId?.trim() ?? ""),
        actorCustomerId,
      ].filter(Boolean),
    ),
  ];
  if (customerIds.length === 0) {
    return { ok: true, paymentMethods: [] };
  }
  const customerId = co.stripeCustomerId?.trim() || customerIds[0];
  const listedCustomerIdSet = new Set(customerIds);

  try {
    const stripe = getStripeClient();
    const defaultPmId = await resolveDefaultPaymentMethodId(customerId);
    const activeIds = new Set<string>();
    const unreachableCustomers = new Set<string>();

    for (const listedCustomerId of customerIds) {
      try {
        const listed = await stripe.customers.listPaymentMethods(
          listedCustomerId,
          { limit: 100 },
        );
        for (const pm of listed.data) {
          activeIds.add(pm.id);
          await upsertPaymentMethodFromStripe({
            companyId: cid,
            paymentMethod: pm,
            isDefault: defaultPmId ? pm.id === defaultPmId : false,
            addedByUserId:
              actorUserId && listedCustomerId === actorCustomerId
                ? actorUserId
                : undefined,
          });
        }
      } catch (listErr) {
        const missing =
          listErr instanceof Stripe.errors.StripeInvalidRequestError &&
          listErr.code === "resource_missing";
        if (!missing) throw listErr;
        unreachableCustomers.add(listedCustomerId);
      }
    }

    const existing = await db
      .select({
        stripePaymentMethodId:
          companyBillingPaymentMethods.stripePaymentMethodId,
        stripeCustomerId: companyBillingPaymentMethods.stripeCustomerId,
        detachedAt: companyBillingPaymentMethods.detachedAt,
      })
      .from(companyBillingPaymentMethods)
      .where(eq(companyBillingPaymentMethods.companyId, cid));

    for (const row of existing) {
      const owner = row.stripeCustomerId?.trim() ?? "";
      if (owner && unreachableCustomers.has(owner)) continue;
      if (owner && !listedCustomerIdSet.has(owner)) continue;
      if (!activeIds.has(row.stripePaymentMethodId) && !row.detachedAt) {
        await markPaymentMethodDetached(row.stripePaymentMethodId);
      }
    }

    if (defaultPmId && customerId) {
      await syncDefaultPaymentMethodFlags({ companyId: cid, customerId });
    }

    await recordBillingEvent({
      companyId: cid,
      eventType: "payment_method.synced",
      stripeCustomerId: customerId,
      message: `Synced ${activeIds.size} payment method(s) from Stripe`,
      payload: {
        count: activeIds.size,
        defaultPaymentMethodId: defaultPmId,
      },
    });

    try {
      const { refreshDealSaasSubscriptionsFromStripe } = await import(
        "./dealBilling.service.js"
      );
      await refreshDealSaasSubscriptionsFromStripe(cid);
    } catch (subErr) {
      console.warn(
        "syncCompanyPaymentMethodsFromStripe deal subscriptions:",
        subErr,
      );
    }

    const paymentMethods = await listCompanyPaymentMethods(cid, {
      includeDetached: false,
      ...(actorUserId ? { userId: actorUserId } : {}),
    });
    return { ok: true, paymentMethods };
  } catch (err) {
    console.error("syncCompanyPaymentMethodsFromStripe:", err);
    const msg =
      err instanceof Error
        ? err.message
        : "Could not sync payment methods from Stripe";
    return { ok: false, status: 502, message: msg };
  }
}

export type ExtraCompanyUserPayResult =
  | { ok: true; extraUsersPaid: number; amountDueCents: number }
  | { ok: false; status: number; message: string };

export type ExtraCompanyUserCheckoutResult =
  | { ok: true; url: string; extraUsersToPay: number; amountDueCents: number }
  | { ok: false; status: number; message: string };

async function resolveExtraCompanyUserCharge(params: {
  companyId: string;
  dealId: string;
  allowedDealIds?: string[] | null;
  quantity?: number;
}): Promise<
  | {
      ok: true;
      dealId: string;
      dealName: string;
      extraUsersToPay: number;
      amountDueCents: number;
      description: string;
    }
  | { ok: false; status: number; message: string }
> {
  const cid = normalizeCompanyId(params.companyId);
  const {
    descriptionForExtraCompanyUserCharge,
    getDealCompanyUserSnapshot,
    extraCompanyUsersToCharge,
  } = await import("./dealExtraCompanyUser.service.js");
  const snapshot = await getDealCompanyUserSnapshot(params.dealId);
  if (!snapshot) {
    return { ok: false, status: 404, message: "Deal not found" };
  }
  if (
    snapshot.organizationId &&
    cid &&
    snapshot.organizationId.toLowerCase() !== cid
  ) {
    return { ok: false, status: 404, message: "Deal not found" };
  }
  if (
    params.allowedDealIds &&
    !params.allowedDealIds.some(
      (id) => id.toLowerCase() === snapshot.dealId,
    )
  ) {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  if (!dealSaasBillingHasStarted(snapshot)) {
    return {
      ok: false,
      status: 400,
      message: dealSaasBillingNotYetDueMessage(snapshot),
    };
  }
  const extraUsersToPay = extraCompanyUsersToCharge(snapshot);
  if (extraUsersToPay <= 0) {
    return {
      ok: false,
      status: 400,
      message: "No extra Co-GPs need the $10 payment for this deal.",
    };
  }
  return {
    ok: true,
    dealId: snapshot.dealId,
    dealName: snapshot.dealName,
    extraUsersToPay,
    amountDueCents: extraUsersToPay * snapshot.extraUserFeeCents,
    description: descriptionForExtraCompanyUserCharge(snapshot, extraUsersToPay),
  };
}

/**
 * One-time $10-per-extra-company-user Checkout (deal already billed).
 */
export async function createExtraCompanyUserCheckoutSession(params: {
  companyId: string;
  actorUserId: string;
  dealId: string;
  quantity?: number;
  allowedDealIds?: string[] | null;
}): Promise<ExtraCompanyUserCheckoutResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }
  const cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }
  const charge = await resolveExtraCompanyUserCharge({
    companyId: cid,
    dealId: params.dealId,
    allowedDealIds: params.allowedDealIds,
    quantity: params.quantity,
  });
  if (!charge.ok) return charge;

  const frontend = resolveFrontendOrigin();
  if (!frontend) {
    return {
      ok: false,
      status: 503,
      message: "BASE_URL must be set so Stripe can redirect after checkout.",
    };
  }

  try {
    const customerId = await ensureDealPayerStripeCustomer({
      companyId: cid,
      dealId: charge.dealId,
      actorUserId: params.actorUserId,
    });
    const stripe = getStripeClient();
    const {
      extraCompanyUserCheckoutLineItems,
    } = await import("./dealExtraCompanyUser.service.js");
    const checkoutCustomerId = await customerIdShowingSavedCards(
      stripe,
      customerId,
      cid,
      params.actorUserId,
    );
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: checkoutCustomerId,
      payment_method_types: ["card", "us_bank_account"],
      ...CHECKOUT_SAVED_PAYMENT_METHODS,
      line_items: extraCompanyUserCheckoutLineItems(
        charge.extraUsersToPay,
        charge.description,
      ),
      success_url: `${frontend}/deals/${encodeURIComponent(charge.dealId)}?tab=deal_members&extraCompanyUser=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/deals/${encodeURIComponent(charge.dealId)}?tab=deal_members&extraCompanyUser=cancel`,
      client_reference_id: cid,
      metadata: {
        companyId: cid,
        dealId: charge.dealId,
        dealName: charge.dealName,
        billingScope: "extra_company_user",
        extraCompanyUsers: String(charge.extraUsersToPay),
        extraUserComment: charge.description.slice(0, 500),
        payerUserId: params.actorUserId,
      },
      payment_intent_data: {
        description: charge.description,
        metadata: {
          companyId: cid,
          dealId: charge.dealId,
          dealName: charge.dealName,
          billingScope: "extra_company_user",
          extraCompanyUsers: String(charge.extraUsersToPay),
          extraUserComment: charge.description.slice(0, 500),
          payerUserId: params.actorUserId,
        },
      },
    });
    if (!session.url) {
      return {
        ok: false,
        status: 502,
        message: "Stripe did not return a checkout URL.",
      };
    }
    return {
      ok: true,
      url: session.url,
      extraUsersToPay: charge.extraUsersToPay,
      amountDueCents: charge.amountDueCents,
    };
  } catch (err) {
    console.error("createExtraCompanyUserCheckoutSession:", err);
    const msg =
      err instanceof Error ? err.message : "Could not create extra user checkout";
    return { ok: false, status: 502, message: msg };
  }
}

export async function payExtraCompanyUserWithSavedMethod(params: {
  companyId: string;
  actorUserId: string;
  dealId: string;
  paymentMethodId: string;
  quantity?: number;
  allowedDealIds?: string[] | null;
}): Promise<ExtraCompanyUserPayResult> {
  const cfg = getStripeConfig();
  if (!cfg) {
    return {
      ok: false,
      status: 503,
      message: "Stripe is not configured on the server.",
    };
  }
  const cid = normalizeCompanyId(params.companyId);
  if (!cid) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }
  const rawPm = String(params.paymentMethodId ?? "").trim();
  if (!rawPm) {
    return {
      ok: false,
      status: 400,
      message: "Select a saved payment method, or pay in Stripe.",
    };
  }

  const charge = await resolveExtraCompanyUserCharge({
    companyId: cid,
    dealId: params.dealId,
    allowedDealIds: params.allowedDealIds,
    quantity: params.quantity,
  });
  if (!charge.ok) return charge;

  try {
    const methods = await listCompanyPaymentMethods(cid, {
      userId: params.actorUserId,
    });
    const found = methods.find(
      (m) => m.stripePaymentMethodId === rawPm || m.id === rawPm,
    );
    if (!found?.stripePaymentMethodId) {
      return {
        ok: false,
        status: 400,
        message:
          "That payment method is not available. Choose another, or pay in Stripe.",
      };
    }
    const paymentMethodId = found.stripePaymentMethodId;
    const payerPayment = await customerForSavedDealPayment({
      companyId: cid,
      dealId: charge.dealId,
      actorUserId: params.actorUserId,
      paymentMethodId,
    });
    const customerId = payerPayment.customerId;
    const stripe = getStripeClient();

    const intent = await stripe.paymentIntents.create({
      amount: charge.amountDueCents,
      currency: "usd",
      customer: customerId,
      payment_method: payerPayment.paymentMethodId,
      confirm: true,
      off_session: true,
      description: charge.description,
      metadata: {
        companyId: cid,
        dealId: charge.dealId,
        dealName: charge.dealName,
        billingScope: "extra_company_user",
        extraCompanyUsers: String(charge.extraUsersToPay),
        extraUserComment: charge.description.slice(0, 500),
        payerUserId: params.actorUserId,
      },
    });
    const status = String(intent.status ?? "").toLowerCase();
    if (status !== "succeeded") {
      return {
        ok: false,
        status: 402,
        message:
          "This payment method needs extra verification or was declined. Pay in Stripe instead.",
      };
    }
    const { creditExtraCompanyUsersPaid } = await import(
      "./dealExtraCompanyUser.service.js"
    );
    await creditExtraCompanyUsersPaid({
      dealId: charge.dealId,
      quantity: charge.extraUsersToPay,
      paymentRef: intent.id,
    });
    return {
      ok: true,
      extraUsersPaid: charge.extraUsersToPay,
      amountDueCents: charge.amountDueCents,
    };
  } catch (err) {
    console.error("payExtraCompanyUserWithSavedMethod:", err);
    if (err instanceof Stripe.errors.StripeCardError) {
      return {
        ok: false,
        status: 402,
        message:
          err.message || "The card was declined. Pay in Stripe or try another method.",
      };
    }
    const msg =
      err instanceof Error ? err.message : "Could not pay for extra company users";
    return { ok: false, status: 502, message: msg };
  }
}

export async function syncExtraCompanyUserFromCheckoutSession(params: {
  companyId: string;
  sessionId: string;
  allowedDealIds?: string[] | null;
}): Promise<ExtraCompanyUserPayResult> {
  const cid = normalizeCompanyId(params.companyId);
  const sessionId = String(params.sessionId ?? "").trim();
  if (!cid || !sessionId.startsWith("cs_")) {
    return { ok: false, status: 400, message: "Missing checkout session." };
  }
  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (String(session.metadata?.billingScope ?? "") !== "extra_company_user") {
      return { ok: false, status: 400, message: "Not an extra company user payment." };
    }
    const dealId = String(session.metadata?.dealId ?? "").trim();
    const extraUsers = Number.parseInt(
      String(session.metadata?.extraCompanyUsers ?? "0"),
      10,
    );
    if (!dealId || !Number.isFinite(extraUsers) || extraUsers <= 0) {
      return { ok: false, status: 400, message: "Checkout session is missing extra user details." };
    }
    if (
      params.allowedDealIds &&
      !params.allowedDealIds.some((id) => id.toLowerCase() === dealId.toLowerCase())
    ) {
      return { ok: false, status: 403, message: "Forbidden" };
    }
    if (String(session.payment_status ?? "").toLowerCase() !== "paid") {
      return {
        ok: false,
        status: 402,
        message: "Extra company user payment is not complete yet.",
      };
    }
    const { creditExtraCompanyUsersPaid } = await import(
      "./dealExtraCompanyUser.service.js"
    );
    await creditExtraCompanyUsersPaid({
      dealId,
      quantity: extraUsers,
      paymentRef: session.id,
    });
    return {
      ok: true,
      extraUsersPaid: extraUsers,
      amountDueCents: extraUsers * 1000,
    };
  } catch (err) {
    console.error("syncExtraCompanyUserFromCheckoutSession:", err);
    const msg =
      err instanceof Error ? err.message : "Could not sync extra user payment";
    return { ok: false, status: 502, message: msg };
  }
}

export async function handleStripeWebhookEvent(
  event: Stripe.Event,
): Promise<void> {
  // Idempotency: claim event id first so concurrent Stripe retries are no-ops.
  // If processing throws, release the claim so Stripe can retry successfully.
  const claimed = await claimStripeEvent({
    eventId: event.id,
    eventType: event.type,
    message: "webhook received",
    payload: { livemode: event.livemode },
  });
  if (!claimed) {
    return;
  }

  try {
    await processStripeWebhookEvent(event);
  } catch (err) {
    try {
      await db
        .delete(companyBillingEvents)
        .where(eq(companyBillingEvents.stripeEventId, event.id));
    } catch (releaseErr) {
      console.error(
        "[stripe webhook] failed to release event claim after error:",
        releaseErr,
      );
    }
    throw err;
  }
}

async function processStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (
        session.mode === "payment" &&
        String(session.metadata?.billingScope ?? "") === "extra_company_user"
      ) {
        const dealId = String(session.metadata?.dealId ?? "").trim();
        const extraUsers = Number.parseInt(
          String(session.metadata?.extraCompanyUsers ?? "0"),
          10,
        );
        if (dealId && Number.isFinite(extraUsers) && extraUsers > 0) {
          const { creditExtraCompanyUsersPaid } = await import(
            "./dealExtraCompanyUser.service.js"
          );
          await creditExtraCompanyUsersPaid({
            dealId,
            quantity: extraUsers,
            paymentRef: session.id,
          });
        }
        return;
      }
      if (
        session.mode === "payment" &&
        String(session.metadata?.billingScope ?? "") === "deal_upgrade"
      ) {
        const companyId = normalizeCompanyId(
          String(session.metadata?.companyId ?? session.client_reference_id ?? ""),
        );
        if (!companyId) return;
        const synced = await syncDealUpgradeCheckoutSession({
          companyId,
          session,
        });
        if (!synced.ok) {
          console.warn(
            "[stripe webhook] deal upgrade checkout:",
            synced.message,
          );
        }
        return;
      }
      if (session.mode !== "subscription") return;
      const companyIdRaw =
        String(session.metadata?.companyId ?? "").trim() ||
        String(session.client_reference_id ?? "").trim();
      const companyId = normalizeCompanyId(companyIdRaw);
      const subRef = session.subscription;
      const subId = typeof subRef === "string" ? subRef : subRef?.id;
      if (!companyId || !subId) {
        console.warn(
          `[stripe webhook] ${event.type}: missing companyId/subId`,
          { companyIdRaw, subId },
        );
        return;
      }
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(subId);
      await applySubscriptionToCompany(companyId, sub);
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null;
      try {
        await persistInvoicesForSubscription({
          companyId,
          subscriptionId: subId,
          customerId,
        });
      } catch (invErr) {
        console.warn("[stripe webhook] persist invoice after checkout:", invErr);
      }
      if (customerId) {
        try {
          const payerUserId = normalizeCompanyId(
            String(
              session.metadata?.payerUserId ?? sub.metadata?.payerUserId ?? "",
            ),
          );
          await syncCompanyPaymentMethodsFromStripe(companyId, {
            actorUserId: payerUserId,
          });
          const pmId = stripeIdRef(sub.default_payment_method);
          if (payerUserId && pmId) {
            await assignPaymentMethodOwner({
              companyId,
              stripePaymentMethodId: pmId,
              userId: payerUserId,
            });
          }
        } catch (pmErr) {
          console.warn(
            "[stripe webhook] sync payment methods after checkout:",
            pmErr,
          );
        }
      }
      await syncDealSubscriptionsAfterCompanyPayment(companyId);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const fromMeta = String(sub.metadata?.companyId ?? "").trim();
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      const companyId =
        normalizeCompanyId(fromMeta) ||
        (await findCompanyIdForSubscription(sub.id)) ||
        (customerId ? await findCompanyIdForStripeCustomer(customerId) : null);
      if (!companyId) {
        console.warn(
          `[stripe webhook] ${event.type}: no company for subscription ${sub.id}`,
        );
        return;
      }
      await applySubscriptionToCompany(companyId, sub);
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const fromMeta = String(sub.metadata?.companyId ?? "").trim();
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      const companyId =
        normalizeCompanyId(fromMeta) ||
        (await findCompanyIdForSubscription(sub.id)) ||
        (customerId ? await findCompanyIdForStripeCustomer(customerId) : null);
      if (!companyId) return;
      try {
        const dealBilling = await import("./dealBilling.service.js");
        const dealId =
          String(sub.metadata?.dealId ?? "").trim() ||
          (await dealBilling.findDealIdForStripeSubscription(sub.id));
        if (dealId) {
          await dealBilling.clearDealSaasSubscription(dealId);
        }
        await dealBilling.refreshCompanyBillingFromDeals(companyId);
      } catch (err) {
        console.warn("[stripe webhook] deal subscription deleted:", err);
      }
      const [company] = await db
        .select({ stripeSubscriptionId: companies.stripeSubscriptionId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (company?.stripeSubscriptionId?.trim() === sub.id) {
        await clearCompanySubscription(companyId, { keepCustomer: true });
        try {
          const { refreshCompanyBillingFromDeals } = await import(
            "./dealBilling.service.js"
          );
          await refreshCompanyBillingFromDeals(companyId);
        } catch {
          /* already logged */
        }
      }
      return;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId =
        typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      const subId = subscriptionIdFromInvoice(inv);
      let companyId = customerId
        ? await findCompanyIdForStripeCustomer(customerId)
        : null;
      if (!companyId && subId) {
        companyId = await findCompanyIdForSubscription(subId);
      }
      if (!companyId && subId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(subId);
          companyId = normalizeCompanyId(sub.metadata?.companyId ?? null);
        } catch {
          /* ignore */
        }
      }
      if (!companyId) {
        console.warn(
          `[stripe webhook] ${event.type}: no company for invoice ${inv.id}`,
        );
        return;
      }
      await upsertBillingInvoiceFromStripe({
        companyId,
        invoice: inv,
        markPaid: true,
      });

      if (String(inv.metadata?.billingScope ?? "") === "deal_upgrade") {
        const dealId = normalizeCompanyId(String(inv.metadata?.dealId ?? ""));
        const planId = normalizeBillingPlanId(inv.metadata?.planId);
        const seatBand = normalizeBillingSeatBand(inv.metadata?.seatBand);
        const cycleRaw = String(inv.metadata?.billingCycle ?? "").trim();
        const cycle: StripeBillingCycle | null =
          cycleRaw === "monthly"
            ? "monthly"
            : cycleRaw === "annual" ||
                cycleRaw === "annually" ||
                cycleRaw === "yearly"
              ? "annual"
              : null;
        if (dealId && planId && seatBand && cycle) {
          const [deal] = await db
            .select()
            .from(addDealForm)
            .where(eq(addDealForm.id, dealId))
            .limit(1);
          if (deal?.stripeSubscriptionId) {
            const upgraded = await upgradeDealStripeSubscription({
              deal,
              planId,
              cycle,
              seatBand,
              collectDifference: false,
              ...couponHoldFromMetadata(inv.metadata),
            });
            if (upgraded.ok) {
              await applySubscriptionToCompany(companyId, upgraded.subscription, {
                dealId,
              });
            }
          }
        }
      }

      if (subId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscriptionToCompany(companyId, sub);
        } catch (err) {
          console.warn("[stripe webhook] invoice.paid sub refresh:", err);
          await db
            .update(companies)
            .set({
              stripeLastPaymentError: null,
              stripeLastPaymentFailedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(companies.id, companyId));
        }
      } else {
        await db
          .update(companies)
          .set({
            stripeLastPaymentError: null,
            stripeLastPaymentFailedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
      }
      return;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const customerId =
        typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
      const subId = subscriptionIdFromInvoice(inv);
      let companyId = customerId
        ? await findCompanyIdForStripeCustomer(customerId)
        : null;
      if (!companyId && subId) {
        companyId = await findCompanyIdForSubscription(subId);
      }
      if (!companyId && subId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(subId);
          companyId = normalizeCompanyId(sub.metadata?.companyId ?? null);
        } catch {
          /* ignore */
        }
      }
      if (!companyId) {
        console.warn(
          `[stripe webhook] ${event.type}: no company for invoice ${inv.id}`,
        );
        return;
      }

      const failMsg =
        inv.last_finalization_error?.message?.trim() ||
        "Invoice payment failed. Update your payment method in Manage billing.";

      await upsertBillingInvoiceFromStripe({
        companyId,
        invoice: inv,
        markFailed: true,
        paymentFailureMessage: failMsg,
      });

      const [row] = await db
        .select({ status: companies.stripeSubscriptionStatus })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const current = String(row?.status ?? "none");
      const canMarkPastDue = new Set([
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "incomplete",
        "none",
      ]).has(current);

      if (subId) {
        try {
          const stripe = getStripeClient();
          const sub = await stripe.subscriptions.retrieve(subId);
          await applySubscriptionToCompany(companyId, sub);
        } catch (err) {
          console.warn("[stripe webhook] invoice.payment_failed sub refresh:", err);
        }
      }

      await db
        .update(companies)
        .set({
          ...(canMarkPastDue ? { stripeSubscriptionStatus: "past_due" } : {}),
          stripeLastPaymentError: failMsg,
          stripeLastPaymentFailedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
      return;
    }
    case "payment_method.attached":
    case "payment_method.updated":
    case "payment_method.automatically_updated": {
      const pm = event.data.object as Stripe.PaymentMethod;
      const customerId = stripeIdRef(pm.customer);
      const companyId = customerId
        ? await findCompanyIdForStripeCustomer(customerId)
        : null;
      if (!companyId || !customerId) {
        console.warn(
          `[stripe webhook] ${event.type}: no company for payment method ${pm.id}`,
        );
        return;
      }
      let isDefault = false;
      try {
        const defaultPmId = await resolveDefaultPaymentMethodId(customerId);
        isDefault = Boolean(defaultPmId && defaultPmId === pm.id);
      } catch (err) {
        console.warn(
          `[stripe webhook] ${event.type}: could not resolve default PM:`,
          err,
        );
      }
      await upsertPaymentMethodFromStripe({
        companyId,
        paymentMethod: pm,
        isDefault,
      });
      return;
    }
    case "payment_method.detached": {
      const pm = event.data.object as Stripe.PaymentMethod;
      await markPaymentMethodDetached(pm.id);
      return;
    }
    case "customer.updated": {
      const customer = event.data.object as Stripe.Customer;
      const companyId = await findCompanyIdForStripeCustomer(customer.id);
      if (!companyId) return;
      try {
        await syncDefaultPaymentMethodFlags({
          companyId,
          customerId: customer.id,
        });
      } catch (err) {
        console.warn("[stripe webhook] customer.updated default PM sync:", err);
      }
      return;
    }
    case "payment_intent.succeeded":
    case "payment_intent.processing":
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const customerId = stripeIdRef(pi.customer);
      let companyId = customerId
        ? await findCompanyIdForStripeCustomer(customerId)
        : null;
      const metaCompany = normalizeCompanyId(
        String(pi.metadata?.companyId ?? "").trim(),
      );
      if (metaCompany) companyId = metaCompany;

      const invoiceId = stripeIdRef(
        (pi as Stripe.PaymentIntent & { invoice?: string | { id?: string } | null })
          .invoice,
      );

      if (invoiceId) {
        try {
          const stripe = getStripeClient();
          const inv = await stripe.invoices.retrieve(invoiceId);
          const subId = subscriptionIdFromInvoice(inv);
          if (!companyId && customerId) {
            companyId = await findCompanyIdForStripeCustomer(customerId);
          }
          if (!companyId && subId) {
            companyId = await findCompanyIdForSubscription(subId);
          }
          if (companyId && subId) {
            const sub = await stripe.subscriptions.retrieve(subId);
            await applySubscriptionToCompany(companyId, sub);
          }
          if (companyId) {
            if (event.type === "payment_intent.succeeded") {
              await upsertBillingInvoiceFromStripe({
                companyId,
                invoice: inv,
                markPaid: true,
              });
              await db
                .update(companies)
                .set({
                  stripeLastPaymentError: null,
                  stripeLastPaymentFailedAt: null,
                  updatedAt: new Date(),
                })
                .where(eq(companies.id, companyId));
            } else if (event.type === "payment_intent.processing") {
              // ACH / bank transfers settle asynchronously.
              await db
                .update(companies)
                .set({
                  stripeLastPaymentError: null,
                  updatedAt: new Date(),
                })
                .where(eq(companies.id, companyId));
            } else {
              const failMsg =
                pi.last_payment_error?.message?.trim() ||
                "Payment failed. Try another card or bank account.";
              await upsertBillingInvoiceFromStripe({
                companyId,
                invoice: inv,
                markFailed: true,
                paymentFailureMessage: failMsg,
              });
              await db
                .update(companies)
                .set({
                  stripeLastPaymentError: failMsg,
                  stripeLastPaymentFailedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(companies.id, companyId));
            }
          }
        } catch (err) {
          console.warn(`[stripe webhook] ${event.type} invoice sync:`, err);
        }
      } else if (companyId && event.type === "payment_intent.payment_failed") {
        const failMsg =
          pi.last_payment_error?.message?.trim() ||
          "Payment failed. Try another card or bank account.";
        await db
          .update(companies)
          .set({
            stripeLastPaymentError: failMsg,
            stripeLastPaymentFailedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
      }

      if (companyId && customerId && event.type === "payment_intent.succeeded") {
        try {
          await syncCompanyPaymentMethodsFromStripe(companyId);
        } catch (pmErr) {
          console.warn(
            "[stripe webhook] payment_intent.succeeded PM sync:",
            pmErr,
          );
        }
      }
      return;
    }
    case "setup_intent.succeeded": {
      const si = event.data.object as Stripe.SetupIntent;
      const customerId = stripeIdRef(si.customer);
      const companyId =
        normalizeCompanyId(String(si.metadata?.companyId ?? "").trim()) ||
        (customerId ? await findCompanyIdForStripeCustomer(customerId) : null);
      const payerUserId = normalizeCompanyId(
        String(si.metadata?.payerUserId ?? ""),
      );
      if (!companyId || !customerId) return;
      try {
        const stripe = getStripeClient();
        await syncCompanyPaymentMethodsFromStripe(companyId, {
          actorUserId: payerUserId,
        });
        const pmId = stripeIdRef(si.payment_method);
        if (pmId && payerUserId) {
          await assignPaymentMethodOwner({
            companyId,
            stripePaymentMethodId: pmId,
            userId: payerUserId,
          });
        }
        if (pmId) {
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: pmId },
          });
          await syncDefaultPaymentMethodFlags({ companyId, customerId });
        }
      } catch (err) {
        console.warn("[stripe webhook] setup_intent.succeeded:", err);
      }
      return;
    }
    default:
      return;
  }
}
