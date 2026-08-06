import { Router } from "express";
// Investor contributions: workflow — Stripe Checkout disabled for now
// import {
//   postInvestorInvestmentCheckout,
//   postInvestorInvestmentCheckoutSync,
// } from "../controllers/payments/investorCheckout.controller.js";
import {
  getDistributionPayouts,
  getInvestorConnectOnboardingStatus,
  postDistributionPayouts,
  postInvestorConnectOnboarding,
} from "../controllers/payments/investorDistributionPayout.controller.js";

const router = Router();

// Investor contributions: workflow — Stripe Checkout disabled for now
// router.post(
//   "/deals/:dealId/investments/:investmentId/checkout",
//   postInvestorInvestmentCheckout,
// );
// router.post(
//   "/investing/investment-payments/sync-checkout",
//   postInvestorInvestmentCheckoutSync,
// );
router.post(
  "/investing/profiles/:profileId/stripe-connect/onboarding",
  postInvestorConnectOnboarding,
);
router.get(
  "/investing/profiles/:profileId/stripe-connect/status",
  getInvestorConnectOnboardingStatus,
);
router.get(
  "/deals/:dealId/distributions/:distributionId/payouts",
  getDistributionPayouts,
);
router.post(
  "/deals/:dealId/distributions/:distributionId/payouts",
  postDistributionPayouts,
);

export default router;
