import assert from "node:assert/strict";
import test from "node:test";
import {
  coGpSeatBandIsUpgrade,
  coGpSeatBandNeedsUpgrade,
  isCoGpStoredRole,
  suggestedSeatBandForCoGpCount,
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

test("requires an upgrade only when the roster exceeds the current package", () => {
  assert.equal(coGpSeatBandNeedsUpgrade("5", 5), false);
  assert.equal(coGpSeatBandNeedsUpgrade("5", 6), true);
  assert.equal(coGpSeatBandNeedsUpgrade("10", 10), false);
  assert.equal(coGpSeatBandNeedsUpgrade("10", 11), true);
  assert.equal(coGpSeatBandNeedsUpgrade("10plus", 25), false);
});

test("allows a voluntary move to a larger Co-Sponsor package", () => {
  assert.equal(coGpSeatBandIsUpgrade("5", "10"), true);
  assert.equal(coGpSeatBandIsUpgrade("5", "10plus"), true);
  assert.equal(coGpSeatBandIsUpgrade("10", "10plus"), true);
  assert.equal(coGpSeatBandIsUpgrade("10", "5"), false);
  assert.equal(coGpSeatBandIsUpgrade("10", "10"), false);
});
