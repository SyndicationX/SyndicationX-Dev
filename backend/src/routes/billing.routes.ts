import { Router } from "express";
import {
  getBillingConfig,
  getCompanyBilling,
  getCompanyBillingInvoices,
  getCompanyBillingPaymentMethods,
  postCompanyBillingCheckout,
  postCompanyBillingPaymentElement,
  postCompanyBillingPortal,
  postCompanyBillingSetupIntent,
  postCompanyBillingSyncCheckout,
  postCompanyBillingSyncPayment,
  postCompanyBillingSyncPaymentMethods,
} from "../controllers/billing/companyBilling.controller.js";

const router = Router();

router.get("/billing/config", getBillingConfig);
router.get("/companies/:companyId/billing", getCompanyBilling);
router.get("/companies/:companyId/billing/invoices", getCompanyBillingInvoices);
router.get(
  "/companies/:companyId/billing/payment-methods",
  getCompanyBillingPaymentMethods,
);
router.post(
  "/companies/:companyId/billing/checkout",
  postCompanyBillingCheckout,
);
router.post(
  "/companies/:companyId/billing/payment-element",
  postCompanyBillingPaymentElement,
);
router.post(
  "/companies/:companyId/billing/setup-intent",
  postCompanyBillingSetupIntent,
);
router.post(
  "/companies/:companyId/billing/sync-payment",
  postCompanyBillingSyncPayment,
);
router.post("/companies/:companyId/billing/portal", postCompanyBillingPortal);
router.post(
  "/companies/:companyId/billing/sync-checkout",
  postCompanyBillingSyncCheckout,
);
router.post(
  "/companies/:companyId/billing/sync-payment-methods",
  postCompanyBillingSyncPaymentMethods,
);

export default router;
