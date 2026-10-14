import type { Request, Response } from "express";
import Stripe from "stripe";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  createCompanyBillingPortalSession,
  createCompanyCheckoutSession,
  createCompanySetupIntent,
  createCompanySubscriptionPaymentElement,
  createExtraCompanyUserCheckoutSession,
  getCompanyBillingStatus,
  listCompanyPaymentMethods,
  listCompanyStripeInvoices,
  payCompanyDealWithSavedMethod,
  payExtraCompanyUserWithSavedMethod,
  resolveCompanyBillingAccess,
  syncCompanyBillingFromCheckoutSession,
  syncCompanyPaymentMethodsFromStripe,
  syncCompanySubscriptionPayment,
  syncExtraCompanyUserFromCheckoutSession,
  userCanManageCompanyBilling,
} from "../../services/billing/companyBilling.service.js";
import {
  listDealBillingForAllOrganizations,
  listDealBillingForCompany,
  listPlatformOrganizationBilling,
  updateDealBillingCycle,
  updateDealSaasBillingStartsAt,
  getPlatformSaasBillingStartAlert,
  dealHasRedeemedSaasCoupon,
} from "../../services/billing/dealBilling.service.js";
import { getStripePublicConfig } from "../../config/stripe.config.js";
import { releaseBillingPaymentHold } from "../../middleware/billingPaymentLock.js";
import {
  createPlatformCoupon,
  deactivatePlatformCoupon,
  listPlatformCoupons,
  listPlatformCouponUsage,
  lookupActivePromotionCode,
} from "../../services/billing/platformCoupon.service.js";
import { isPlatformAdminRole } from "../../constants/roles.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/schema.js";
import { eq } from "drizzle-orm";

function paramStr(v: string | string[] | undefined): string {
  if (v == null) return "";
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

function bodyString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
}

async function jwtUserIsPlatformAdmin(user: {
  id?: string;
  userRole?: string;
}): Promise<boolean> {
  if (isPlatformAdminRole(user.userRole)) return true;
  const id = String(user.id ?? "").trim();
  if (!id) return false;
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return isPlatformAdminRole(row?.role);
}

function extraCompanyUsersFromBody(body: Record<string, unknown>): number | undefined {
  const raw = body.extraCompanyUsers ?? body.extra_company_users ?? body.quantity;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? Math.max(0, n) : undefined;
  }
  return undefined;
}

/**
 * GET /billing/config
 * Public Stripe readiness (no secrets).
 */
export async function getBillingConfig(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(200).json(getStripePublicConfig());
}

/**
 * GET /billing/start-date
 * Authenticated: hardcoded platform SaaS billing start (see saasBillingStartDate.ts).
 */
export async function getBillingStartDate(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const alert = await getPlatformSaasBillingStartAlert();
    res.status(200).json({
      saasBillingStartsAt: alert.startsAt
        ? alert.startsAt.toISOString()
        : null,
      updatedAt: alert.updatedAt ? alert.updatedAt.toISOString() : null,
    });
  } catch (err) {
    console.error("getBillingStartDate:", err);
    res.status(500).json({ message: "Could not load billing start date" });
  }
}

/**
 * GET /companies/:companyId/billing
 */
export async function getCompanyBilling(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canView) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const status = await getCompanyBillingStatus(companyId, {
    dealIds: access.dealIds,
    canManage: access.canManage,
    canPay: access.canPay,
    viewerScope: access.viewerScope,
  });
  if (!status) {
    res.status(404).json({ message: "Company not found" });
    return;
  }
  res.status(200).json(status);
}

/**
 * POST /companies/:companyId/billing/checkout
 * Body: {
 *   planId: "starter" | "running" | "growth",
 *   seatBand?: "5" | "10" | "10plus",
 *   billingCycle: "monthly" | "annual" | "annually" | "yearly",
 *   dealId: uuid
 * }
 */
export async function postCompanyBillingCheckout(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const planId = bodyString(body.planId ?? body.plan_id);
  const seatBand = bodyString(body.seatBand ?? body.seat_band ?? body.seats);
  const billingCycle = bodyString(
    body.billingCycle ?? body.billing_cycle ?? body.cycle,
  );
  const dealId = bodyString(body.dealId ?? body.deal_id);
  const extraCompanyUsers = extraCompanyUsersFromBody(body);
  const promotionCode = bodyString(body.promotionCode ?? body.promotion_code);

  const result = await createCompanyCheckoutSession({
    companyId,
    actorUserId: user.id,
    planId,
    seatBand: seatBand || undefined,
    billingCycle,
    dealId,
    extraCompanyUsers,
    promotionCode: promotionCode || undefined,
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ url: result.url });
}

/**
 * POST /companies/:companyId/billing/release-payment
 * Drop an abandoned Checkout hold so Upgrade plan can start payment.
 */
export async function postCompanyBillingReleasePayment(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dealId = bodyString(body.dealId ?? body.deal_id);
  if (dealId) {
    releaseBillingPaymentHold(companyId, dealId);
  }
  res.status(204).end();
}

/**
 * POST /companies/:companyId/billing/pay-saved
 * Start deal SaaS using a saved card / bank account (or the caller can use Checkout).
 */
export async function postCompanyBillingPaySaved(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const planId = bodyString(body.planId ?? body.plan_id);
  const seatBand = bodyString(body.seatBand ?? body.seat_band ?? body.seats);
  const billingCycle = bodyString(
    body.billingCycle ?? body.billing_cycle ?? body.cycle,
  );
  const dealId = bodyString(body.dealId ?? body.deal_id);
  const paymentMethodId = bodyString(
    body.paymentMethodId ??
      body.payment_method_id ??
      body.stripePaymentMethodId,
  );
  const extraCompanyUsers = extraCompanyUsersFromBody(body);
  const promotionCode = bodyString(body.promotionCode ?? body.promotion_code);

  const result = await payCompanyDealWithSavedMethod({
    companyId,
    actorUserId: user.id,
    planId,
    seatBand: seatBand || undefined,
    billingCycle,
    dealId,
    extraCompanyUsers,
    paymentMethodId,
    promotionCode: promotionCode || undefined,
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    ...(result.status ?? {}),
    paidDealId: result.paidDealId,
  });
}

/**
 * POST /companies/:companyId/billing/payment-element
 * Creates incomplete subscription + returns Payment Element clientSecret (card + ACH).
 */
export async function postCompanyBillingPaymentElement(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const planId = bodyString(body.planId ?? body.plan_id);
  const seatBand = bodyString(body.seatBand ?? body.seat_band ?? body.seats);
  const billingCycle = bodyString(
    body.billingCycle ?? body.billing_cycle ?? body.cycle,
  );
  const dealId = bodyString(body.dealId ?? body.deal_id);
  const extraCompanyUsers = extraCompanyUsersFromBody(body);

  const result = await createCompanySubscriptionPaymentElement({
    companyId,
    actorUserId: user.id,
    planId,
    seatBand: seatBand || undefined,
    billingCycle,
    dealId,
    extraCompanyUsers,
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    clientSecret: result.clientSecret,
    subscriptionId: result.subscriptionId,
    customerId: result.customerId,
    publishableKey: result.publishableKey,
    paymentIntentId: result.paymentIntentId,
    invoiceId: result.invoiceId,
    planId: result.planId,
    seatBand: result.seatBand,
    billingCycle: result.billingCycle,
    priceId: result.priceId,
  });
}

/**
 * POST /companies/:companyId/billing/setup-intent
 * Save card / ACH for future use via Payment Element.
 */
export async function postCompanyBillingSetupIntent(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const can = await userCanManageCompanyBilling(
    user.id,
    user.userRole,
    companyId,
  );
  if (!can) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const result = await createCompanySetupIntent({
    companyId,
    actorUserId: user.id,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    clientSecret: result.clientSecret,
    setupIntentId: result.setupIntentId,
    customerId: result.customerId,
    publishableKey: result.publishableKey,
  });
}

/**
 * POST /companies/:companyId/billing/sync-payment
 * Body: { subscriptionId?: string, paymentIntentId?: string }
 */
export async function postCompanyBillingSyncPayment(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const subscriptionId = bodyString(
    body.subscriptionId ?? body.subscription_id,
  );
  const paymentIntentId = bodyString(
    body.paymentIntentId ?? body.payment_intent_id,
  );

  const result = await syncCompanySubscriptionPayment({
    companyId,
    subscriptionId: subscriptionId || undefined,
    paymentIntentId: paymentIntentId || undefined,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    ...result.status,
    canManage: access.canManage,
    canPay: access.canPay,
    viewerScope: access.viewerScope,
  });
}

/**
 * POST /companies/:companyId/billing/portal
 */
export async function postCompanyBillingPortal(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const result = await createCompanyBillingPortalSession({
    companyId,
    actorUserId: user.id,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ url: result.url });
}

/**
 * POST /companies/:companyId/billing/sync-checkout
 * Body: { sessionId: "cs_..." }
 * Called after Stripe redirects back with session_id (local + production).
 */
export async function postCompanyBillingSyncCheckout(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = bodyString(
    body.sessionId ?? body.session_id ?? body.checkoutSessionId,
  );
  const result = await syncCompanyBillingFromCheckoutSession({
    companyId,
    checkoutSessionId: sessionId,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    ...result.status,
    paidDealId: result.paidDealId,
    canManage: access.canManage,
    canPay: access.canPay,
    viewerScope: access.viewerScope,
  });
}

/**
 * GET /companies/:companyId/billing/invoices
 */
export async function getCompanyBillingInvoices(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canView) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const result = await listCompanyStripeInvoices(companyId, {
    dealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ invoices: result.invoices });
}

/**
 * GET /billing/deals
 * Platform admin: every deal across every organization.
 */
export async function getPlatformBillingDeals(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  if (!(await jwtUserIsPlatformAdmin(user))) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  try {
    const deals = await listDealBillingForAllOrganizations();
    res.status(200).json({
      deals,
      canManage: true,
      canPay: false,
      viewerScope: "all_deals",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] list platform deal billing failed:", message);
    res.status(500).json({
      message:
        "Could not load deal billing. Confirm the database has deal SaaS billing columns, then retry.",
    });
  }
}

/**
 * GET /billing/organizations
 * Platform admin: every organization, deals, and total paid.
 */
export async function getPlatformBillingOrganizations(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  if (!(await jwtUserIsPlatformAdmin(user))) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  try {
    const organizations = await listPlatformOrganizationBilling();
    res.status(200).json({
      organizations,
      canManage: true,
      canPay: false,
      viewerScope: "all_deals",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] list platform organization billing failed:", message);
    res.status(500).json({
      message: "Could not load organization billing.",
    });
  }
}

/**
 * GET /companies/:companyId/billing/deals
 * Org admin / platform admin: every deal. Lead sponsors: deals they lead.
 */
export async function getCompanyBillingDeals(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canView) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  try {
    const deals = await listDealBillingForCompany(companyId, access.dealIds);
    res.status(200).json({
      deals,
      canManage: access.canManage,
      canPay: access.canPay,
      viewerScope: access.viewerScope,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[billing] list deal billing failed:", message);
    res.status(500).json({
      message:
        "Could not load deal billing. Confirm the database has deal SaaS billing columns, then retry.",
    });
  }
}

/**
 * POST /companies/:companyId/billing/deals/:dealId/cycle
 * Body: { billingCycle: "monthly" | "annual" | "annually" | "yearly" }
 */
export async function postCompanyBillingDealCycle(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const dealId = paramStr(req.params.dealId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const billingCycle = bodyString(
    body.billingCycle ?? body.billing_cycle ?? body.cycle,
  );
  const result = await updateDealBillingCycle({
    companyId,
    dealId,
    billingCycle,
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ deal: result.deal });
}

/**
 * POST /companies/:companyId/billing/deals/:dealId/start-date
 * Platform admin: set when SaaS billing starts for this deal.
 * Body: { saasBillingStartsAt: "YYYY-MM-DD" | ISO datetime }
 */
export async function postCompanyBillingDealStartDate(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  if (!(await jwtUserIsPlatformAdmin(user))) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const dealId = paramStr(req.params.dealId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const saasBillingStartsAt = bodyString(
    body.saasBillingStartsAt ?? body.saas_billing_starts_at ?? body.date,
  );
  const result = await updateDealSaasBillingStartsAt({
    companyId,
    dealId,
    saasBillingStartsAt,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ deal: result.deal });
}

/**
 * GET /companies/:companyId/billing/payment-methods
 */
export async function getCompanyBillingPaymentMethods(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay && !access.canManage) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const includeDetached =
    String(req.query.includeDetached ?? "").trim() === "1" ||
    String(req.query.includeDetached ?? "").trim().toLowerCase() === "true";

  const paymentMethods = await listCompanyPaymentMethods(companyId, {
    includeDetached,
  });
  res.status(200).json({ paymentMethods });
}

/**
 * POST /companies/:companyId/billing/sync-payment-methods
 * Pulls current Stripe PaymentMethods into the local DB (portal return).
 */
export async function postCompanyBillingSyncPaymentMethods(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const can = await userCanManageCompanyBilling(
    user.id,
    user.userRole,
    companyId,
  );
  if (!can) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const result = await syncCompanyPaymentMethodsFromStripe(companyId);
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ paymentMethods: result.paymentMethods });
}

/**
 * POST /companies/:companyId/billing/extra-company-user
 * One-time $10-per-extra-company-user Checkout for a deal that is already billed.
 */
export async function postExtraCompanyUserCheckout(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await createExtraCompanyUserCheckoutSession({
    companyId,
    actorUserId: user.id,
    dealId: bodyString(body.dealId ?? body.deal_id),
    quantity: extraCompanyUsersFromBody(body),
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    url: result.url,
    extraUsersToPay: result.extraUsersToPay,
    amountDueCents: result.amountDueCents,
  });
}

/**
 * POST /companies/:companyId/billing/extra-company-user/pay-saved
 */
export async function postExtraCompanyUserPaySaved(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await payExtraCompanyUserWithSavedMethod({
    companyId,
    actorUserId: user.id,
    dealId: bodyString(body.dealId ?? body.deal_id),
    paymentMethodId: bodyString(
      body.paymentMethodId ??
        body.payment_method_id ??
        body.stripePaymentMethodId,
    ),
    quantity: extraCompanyUsersFromBody(body),
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    extraUsersPaid: result.extraUsersPaid,
    amountDueCents: result.amountDueCents,
  });
}

/**
 * POST /companies/:companyId/billing/extra-company-user/sync-checkout
 */
export async function postExtraCompanyUserSyncCheckout(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const companyId = paramStr(req.params.companyId);
  const access = await resolveCompanyBillingAccess(
    user.id,
    user.userRole,
    companyId,
  );
  if (!access.canPay) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await syncExtraCompanyUserFromCheckoutSession({
    companyId,
    sessionId: bodyString(body.sessionId ?? body.session_id),
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({
    extraUsersPaid: result.extraUsersPaid,
    amountDueCents: result.amountDueCents,
  });
}

function optionalPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const n = Math.floor(raw);
    return n > 0 ? n : undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function stripeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return err.message || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

async function requirePlatformAdmin(
  req: Request,
  res: Response,
): Promise<boolean> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return false;
  }
  if (!(await jwtUserIsPlatformAdmin(user))) {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }
  return true;
}

/** POST /billing/coupons/preview — any signed-in user can check a code. */
export async function postPreviewPlatformCoupon(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = bodyString(body.code ?? body.promotionCode ?? body.promotion_code);
  const dealId = bodyString(body.dealId ?? body.deal_id);
  try {
    if (dealId && (await dealHasRedeemedSaasCoupon(dealId))) {
      res.status(400).json({ message: "This deal has already used a coupon." });
      return;
    }
    const looked = await lookupActivePromotionCode(code);
    if (!looked.ok) {
      res.status(400).json({ message: looked.message });
      return;
    }
    res.status(200).json({ coupon: looked.preview });
  } catch (err) {
    console.error("[billing] preview coupon failed:", err);
    res.status(502).json({
      message: stripeErrorMessage(err, "Could not check that coupon."),
    });
  }
}

/** GET /billing/coupons — platform admin Stripe coupons and promotion codes. */
export async function getPlatformCoupons(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const coupons = await listPlatformCoupons();
    res.status(200).json({ coupons });
  } catch (err) {
    console.error("[billing] list coupons failed:", err);
    res.status(500).json({
      message: stripeErrorMessage(err, "Could not load coupons."),
    });
  }
}

/**
 * POST /billing/coupons
 * Body: name, code, discountType percent|amount, percentOff | amountOff,
 * duration once|repeating|forever, durationInMonths, maxRedemptions, redeemBy (YYYY-MM-DD)
 */
export async function postPlatformCoupon(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requirePlatformAdmin(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = bodyString(body.name);
  const code = bodyString(body.code).toUpperCase();
  const discountType = bodyString(body.discountType ?? body.discount_type);
  const durationRaw = bodyString(body.duration) || "once";
  const duration =
    durationRaw === "forever" || durationRaw === "repeating" || durationRaw === "once"
      ? durationRaw
      : "";

  if (!name) {
    res.status(400).json({ message: "Enter a coupon name." });
    return;
  }
  if (!/^[A-Z0-9-]{3,40}$/.test(code)) {
    res.status(400).json({
      message: "Code must be 3–40 letters, numbers, or dashes.",
    });
    return;
  }
  if (!duration) {
    res.status(400).json({ message: "Choose how long the discount lasts." });
    return;
  }

  const durationInMonths = optionalPositiveInt(
    body.durationInMonths ?? body.duration_in_months,
  );
  if (duration === "repeating" && !durationInMonths) {
    res.status(400).json({ message: "Enter how many months the discount repeats." });
    return;
  }

  let percentOff: number | undefined;
  let amountOffCents: number | undefined;
  if (discountType === "amount") {
    const dollars = Number(body.amountOff ?? body.amount_off);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      res.status(400).json({ message: "Enter an amount off greater than zero." });
      return;
    }
    amountOffCents = Math.round(dollars * 100);
  } else {
    const pct = Number(body.percentOff ?? body.percent_off);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      res.status(400).json({ message: "Percent off must be between 1 and 100." });
      return;
    }
    percentOff = pct;
  }

  let redeemBy: number | undefined;
  const redeemByRaw = bodyString(body.redeemBy ?? body.redeem_by);
  if (redeemByRaw) {
    const end = new Date(`${redeemByRaw}T23:59:59.000Z`);
    if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
      res.status(400).json({ message: "Redeem-by date must be in the future." });
      return;
    }
    redeemBy = Math.floor(end.getTime() / 1000);
  }

  try {
    const coupon = await createPlatformCoupon({
      name,
      code,
      percentOff,
      amountOffCents,
      duration,
      durationInMonths,
      maxRedemptions: optionalPositiveInt(
        body.maxRedemptions ?? body.max_redemptions,
      ),
      redeemBy,
    });
    res.status(201).json({ coupon });
  } catch (err) {
    console.error("[billing] create coupon failed:", err);
    res.status(502).json({
      message: stripeErrorMessage(err, "Could not create the coupon."),
    });
  }
}

/** GET /billing/coupons/usage — orgs and the coupons applied on their invoices. */
export async function getPlatformCouponUsage(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    const usage = await listPlatformCouponUsage();
    res.status(200).json(usage);
  } catch (err) {
    console.error("[billing] coupon usage failed:", err);
    res.status(500).json({
      message: stripeErrorMessage(err, "Could not load coupon usage."),
    });
  }
}

/** POST /billing/coupons/:couponId/deactivate */
export async function postDeactivatePlatformCoupon(
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await requirePlatformAdmin(req, res))) return;
  const couponId = paramStr(req.params.couponId);
  if (!couponId) {
    res.status(400).json({ message: "Coupon id is required." });
    return;
  }
  try {
    await deactivatePlatformCoupon(couponId);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[billing] deactivate coupon failed:", err);
    res.status(502).json({
      message: stripeErrorMessage(err, "Could not deactivate the coupon."),
    });
  }
}
