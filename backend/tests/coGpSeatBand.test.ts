import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExtraUserBilling,
  coGpSeatBandIsUpgrade,
  coGpSeatBandNeedsUpgrade,
  economicPlanIdForDeal,
  includedCoGpsForSeatBand,
  isCoGpStoredRole,
  planIdForCoGpCount,
  suggestedSeatBandForCoGpCount,
  suggestedSeatBandForDeal,
  catalogPackagePriceCents,
  priceGapCents,
} from "../src/services/billing/dealExtraCompanyUser.service.js";

test("counts only Co-Sponsor roles as Co-GPs", () => {
  assert.equal(isCoGpStoredRole("Co-Sponsor"), true);
  assert.equal(isCoGpStoredRole("Co Sponsor"), true);
  assert.equal(isCoGpStoredRole("General Partner"), false);
  assert.equal(isCoGpStoredRole("Lead Sponsor"), false);
  assert.equal(isCoGpStoredRole("Team Member"), false);
});

test("suggests the smallest Co-GP package that contains the roster", () => {
  assert.equal(suggestedSeatBandForCoGpCount(0), "5");
  assert.equal(suggestedSeatBandForCoGpCount(5), "5");
  assert.equal(suggestedSeatBandForCoGpCount(6), "10");
  assert.equal(suggestedSeatBandForCoGpCount(10), "10");
  assert.equal(suggestedSeatBandForCoGpCount(11), "10plus");
});

test("11 co-sponsors on the 10+ package are not extra users", () => {
  assert.equal(includedCoGpsForSeatBand("10plus"), null);
  const members = Array.from({ length: 11 }, (_, index) => ({
    contactId: `co-${index}`,
    name: `Co-sponsor ${index + 1}`,
    isCoGp: true,
    createdAtMs: index,
  }));
  const billing = buildExtraUserBilling({
    members,
    includedCoGps: includedCoGpsForSeatBand("10plus"),
    paid: 0,
  });
  assert.equal(billing.coGpCount, 11);
  assert.equal(billing.coGpsToCharge.length, 0);
});

test("selects the co-sponsor package from the roster count", () => {
  assert.equal(suggestedSeatBandForDeal("starter", 0), "5");
  assert.equal(suggestedSeatBandForDeal("starter", 1), "5");
  assert.equal(suggestedSeatBandForDeal("starter", 5), "5");
  assert.equal(suggestedSeatBandForDeal("starter", 6), "10");
  assert.equal(suggestedSeatBandForDeal("starter", 10), "10");
  assert.equal(suggestedSeatBandForDeal("starter", 11), "10plus");
  assert.equal(suggestedSeatBandForDeal("running", 4), "5");
  assert.equal(suggestedSeatBandForDeal("running", 6), "10");
  assert.equal(suggestedSeatBandForDeal("growth", 12), "10plus");
  assert.equal(coGpSeatBandNeedsUpgrade("5", 2, "starter"), false);
  assert.equal(coGpSeatBandNeedsUpgrade("5", 6, "starter"), true);
  assert.equal(coGpSeatBandNeedsUpgrade("10", 2, "starter"), false);
});

test("requires an upgrade only when the roster exceeds the current package", () => {
  assert.equal(coGpSeatBandNeedsUpgrade("5", 5), false);
  assert.equal(coGpSeatBandNeedsUpgrade("5", 6), true);
  assert.equal(coGpSeatBandNeedsUpgrade("10", 10), false);
  assert.equal(coGpSeatBandNeedsUpgrade("10", 11), true);
  assert.equal(coGpSeatBandNeedsUpgrade("10plus", 25), false);
});

test("picks the lowest plan that covers offering size and co-sponsors", () => {
  assert.equal(planIdForCoGpCount(5), "starter");
  assert.equal(planIdForCoGpCount(6), "running");
  assert.equal(planIdForCoGpCount(10), "running");
  assert.equal(planIdForCoGpCount(11), "starter");
  assert.equal(economicPlanIdForDeal(3_000_000, 6), "running");
  assert.equal(economicPlanIdForDeal(3_000_000, 5), "starter");
  assert.equal(economicPlanIdForDeal(3_000_000, 11), "starter");
  assert.equal(economicPlanIdForDeal(4_000_000, 2), "running");
  assert.equal(economicPlanIdForDeal(4_000_000, 11), "running");
  assert.equal(economicPlanIdForDeal(6_000_000, 4), "growth");
  assert.equal(economicPlanIdForDeal(6_000_000, 11), "growth");
  assert.equal(economicPlanIdForDeal(1_000_000, 12), "starter");
});

test("upgrade difference is the new package price minus the package already paid", () => {
  const paid = catalogPackagePriceCents("starter", "annual", "5");
  const starterTen = catalogPackagePriceCents("starter", "annual", "10");
  const runningTen = catalogPackagePriceCents("running", "annual", "10");
  assert.equal(paid, 149_000);
  assert.equal(starterTen, 169_000);
  assert.equal((starterTen ?? 0) - (paid ?? 0), 20_000);
  assert.equal((runningTen ?? 0) - (paid ?? 0), 70_000);
  assert.equal(catalogPackagePriceCents("growth", "annual", "10plus"), 289_000);
  assert.equal(priceGapCents(4_900, 14_900), 10_000);
  assert.equal(priceGapCents(14_900, 14_900), 0);
});

test("allows a voluntary move to a larger Co-Sponsor package", () => {
  assert.equal(coGpSeatBandIsUpgrade("5", "10"), true);
  assert.equal(coGpSeatBandIsUpgrade("5", "10plus"), true);
  assert.equal(coGpSeatBandIsUpgrade("10", "10plus"), true);
  assert.equal(coGpSeatBandIsUpgrade("10", "5"), false);
  assert.equal(coGpSeatBandIsUpgrade("10", "10"), false);
});
