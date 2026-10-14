import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAddDealFormIncomplete } from "../src/services/deal/dealFormCompleteness.service.js";

process.env.JWT_SECRET_KEY =
  process.env.JWT_SECRET_KEY ??
  "test-jwt-secret-key-at-least-32-chars-long!!";

const savedDeal = {
  dealStage: "capital_raising",
  secType: "506(b)",
  owningEntityName: "Acme Holdings LLC",
  propertyName: "Acme Tower",
};

describe("deal form completeness", () => {
  it("treats a saved deal with a placeholder city as complete", () => {
    const withPlaceholderCity = { ...savedDeal, city: "Pending" };
    assert.equal(isAddDealFormIncomplete(withPlaceholderCity), false);
  });

  it("flags deals abandoned mid-wizard", () => {
    assert.equal(
      isAddDealFormIncomplete({ ...savedDeal, secType: "Pending" }),
      true,
    );
    assert.equal(
      isAddDealFormIncomplete({ ...savedDeal, owningEntityName: "Pending" }),
      true,
    );
    assert.equal(
      isAddDealFormIncomplete({ ...savedDeal, propertyName: "pending" }),
      true,
    );
  });

  it("keeps Draft-stage deals out of investor-visible lists", () => {
    assert.equal(
      isAddDealFormIncomplete({ ...savedDeal, dealStage: "draft" }),
      true,
    );
  });

  it("accepts a fully completed deal", () => {
    assert.equal(isAddDealFormIncomplete(savedDeal), false);
  });
});
