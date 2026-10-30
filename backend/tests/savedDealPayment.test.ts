import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Stripe from "stripe";
import {
  SAVED_CARD_USE_NEW_METHOD_MESSAGE,
  decideSavedDealPayment,
  paymentMethodForExistingSubscription,
  stripeCustomerIdOf,
} from "../src/services/billing/companyBilling.service.js";

/** Active saved cards in company_billing_payment_methods, and the deal payer each company bills. */
const SAVED_PAYMENTS = [
  {
    company: "Dkojak",
    brand: "mastercard",
    last4: "4131",
    paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
    cardCustomer: "cus_VNykXDYvaBhDOR",
    dealPayer: "cus_VQbC4t99BCpCf8",
  },
  {
    company: "Dkojak",
    brand: "mastercard",
    last4: "4131",
    paymentMethodId: "pm_1UNCnuJjaO3gJemwiGU9Y2Fm",
    cardCustomer: "cus_VNykXDYvaBhDOR",
    dealPayer: "cus_VQbC4t99BCpCf8",
  },
  {
    company: "Massive Capital",
    brand: "visa",
    last4: "1234",
    paymentMethodId: "pm_massive_1234",
    cardCustomer: "cus_UvupSLIMRa30Zp",
    dealPayer: "cus_VOikLBJpvDmGOh",
  },
  {
    company: "Massive Capital",
    brand: "visa",
    last4: "6647",
    paymentMethodId: "pm_massive_6647",
    cardCustomer: "cus_UvupSLIMRa30Zp",
    dealPayer: "cus_VOikLBJpvDmGOh",
  },
  {
    company: "Czechmex Properties, LLC",
    brand: "mastercard",
    last4: "2166",
    paymentMethodId: "pm_czechmex_2166",
    cardCustomer: "cus_VNwMkuFKONUDVw",
    dealPayer: "cus_new_deal_payer",
  },
] as const;

describe("every saved payment in the database", () => {
  for (const saved of SAVED_PAYMENTS) {
    it(`charges ${saved.company} ${saved.brand} ${saved.last4} once on the customer that holds it`, () => {
      const decision = decideSavedDealPayment({
        payerCustomerId: saved.dealPayer,
        attachedCustomerId: saved.cardCustomer,
        paymentMethodId: saved.paymentMethodId,
        ownedCustomerIds: [saved.cardCustomer, saved.dealPayer],
      });
      assert.deepEqual(decision, {
        action: "charge",
        customerId: saved.cardCustomer,
        paymentMethodId: saved.paymentMethodId,
      });
    });
  }

  it("charges Douglas when Stripe returns the company customer as an object", () => {
    const attached = stripeCustomerIdOf({
      id: "cus_VNykXDYvaBhDOR",
    } as Stripe.Customer);
    const decision = decideSavedDealPayment({
      payerCustomerId: "cus_VQbC4t99BCpCf8",
      attachedCustomerId: attached,
      paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
      ownedCustomerIds: ["cus_VNykXDYvaBhDOR", "cus_VQbC4t99BCpCf8"],
    });
    assert.deepEqual(decision, {
      action: "charge",
      customerId: "cus_VNykXDYvaBhDOR",
      paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
    });
  });
});

describe("cards that are not saved for this company", () => {
  it("does not charge a card on someone else's Stripe customer", () => {
    const decision = decideSavedDealPayment({
      payerCustomerId: "cus_VQbC4t99BCpCf8",
      attachedCustomerId: "cus_someone_else",
      paymentMethodId: "pm_other",
      ownedCustomerIds: ["cus_VNykXDYvaBhDOR", "cus_VQbC4t99BCpCf8"],
    });
    assert.equal(decision.action, "reject");
    if (decision.action !== "reject") return;
    assert.equal(decision.message, SAVED_CARD_USE_NEW_METHOD_MESSAGE);
  });
});

describe("saved card that can be charged once", () => {
  it("charges the deal payer when the card is already on that customer", () => {
    const decision = decideSavedDealPayment({
      payerCustomerId: "cus_VQbC4t99BCpCf8",
      attachedCustomerId: "cus_VQbC4t99BCpCf8",
      paymentMethodId: "pm_on_deal",
      ownedCustomerIds: ["cus_VNykXDYvaBhDOR", "cus_VQbC4t99BCpCf8"],
    });
    assert.deepEqual(decision, {
      action: "charge",
      customerId: "cus_VQbC4t99BCpCf8",
      paymentMethodId: "pm_on_deal",
    });
  });

  it("attaches an unattached card to the deal payer once", () => {
    const decision = decideSavedDealPayment({
      payerCustomerId: "cus_VQbC4t99BCpCf8",
      attachedCustomerId: "",
      paymentMethodId: "pm_new",
      ownedCustomerIds: ["cus_VNykXDYvaBhDOR"],
    });
    assert.deepEqual(decision, {
      action: "attach",
      customerId: "cus_VQbC4t99BCpCf8",
      paymentMethodId: "pm_new",
    });
  });

  it("treats a missing customer as unattached", () => {
    const decision = decideSavedDealPayment({
      payerCustomerId: "cus_VQbC4t99BCpCf8",
      attachedCustomerId: stripeCustomerIdOf(null),
      paymentMethodId: "pm_new",
    });
    assert.equal(decision.action, "attach");
  });
});

describe("existing subscription is not charged twice", () => {
  it("does not move a saved company card onto a subscription on another customer", async () => {
    const stripe = {
      subscriptions: {
        retrieve: async () => ({ customer: "cus_VQbC4t99BCpCf8" }),
      },
    } as unknown as Stripe;
    const paymentMethodId = await paymentMethodForExistingSubscription({
      stripe,
      subscriptionId: "sub_existing",
      paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
      paymentMethodCustomerId: "cus_VNykXDYvaBhDOR",
    });
    assert.equal(paymentMethodId, undefined);
  });

  it("uses the card once when it already belongs to the subscription customer", async () => {
    const stripe = {
      subscriptions: {
        retrieve: async () => ({ customer: { id: "cus_VNykXDYvaBhDOR" } }),
      },
    } as unknown as Stripe;
    const paymentMethodId = await paymentMethodForExistingSubscription({
      stripe,
      subscriptionId: "sub_existing",
      paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
      paymentMethodCustomerId: "cus_VNykXDYvaBhDOR",
    });
    assert.equal(paymentMethodId, "pm_1UPB7zJjaO3gJemwloUfVGvO");
  });

  it("keeps the selected card when the subscription has no customer yet", async () => {
    const stripe = {
      subscriptions: {
        retrieve: async () => ({ customer: null }),
      },
    } as unknown as Stripe;
    const paymentMethodId = await paymentMethodForExistingSubscription({
      stripe,
      subscriptionId: "sub_existing",
      paymentMethodId: "pm_1UPB7zJjaO3gJemwloUfVGvO",
      paymentMethodCustomerId: "cus_VNykXDYvaBhDOR",
    });
    assert.equal(paymentMethodId, "pm_1UPB7zJjaO3gJemwloUfVGvO");
  });
});
