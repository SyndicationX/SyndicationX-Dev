import type { Request, Response } from "express";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  createCompanyBillingPortalSession,
  createCompanyCheckoutSession,
  createCompanySetupIntent,
  createCompanySubscriptionPaymentElement,
  getCompanyBillingStatus,
  listCompanyPaymentMethods,
  listCompanyStripeInvoices,
  resolveCompanyBillingAccess,
  syncCompanyBillingFromCheckoutSession,
  syncCompanyPaymentMethodsFromStripe,
  syncCompanySubscriptionPayment,
  userCanManageCompanyBilling,
} from "../../services/billing/companyBilling.service.js";
import { listDealBillingForCompany } from "../../services/billing/dealBilling.service.js";
import { getStripePublicConfig } from "../../config/stripe.config.js";

function paramStr(v: string | string[] | undefined): string {
  if (v == null) return "";
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

function bodyString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
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

  const result = await createCompanyCheckoutSession({
    companyId,
    actorUserId: user.id,
    planId,
    seatBand: seatBand || undefined,
    billingCycle,
    dealId,
    allowedDealIds: access.dealIds,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json({ url: result.url });
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

  const result = await createCompanySubscriptionPaymentElement({
    companyId,
    actorUserId: user.id,
    planId,
    seatBand: seatBand || undefined,
    billingCycle,
    dealId,
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
  const can = await userCanManageCompanyBilling(
    user.id,
    user.userRole,
    companyId,
  );
  if (!can) {
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
  const can = await userCanManageCompanyBilling(
    user.id,
    user.userRole,
    companyId,
  );
  if (!can) {
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
