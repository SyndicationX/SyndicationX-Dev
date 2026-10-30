import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bankDetailsArePresent,
  isEligibleActiveBankAccount,
  resolveBankAccountSetupStatus,
  savedProfileBankDetailsPresent,
} from "../src/services/bankAccounts/bankAccountSetup.js";
import {
  maskKeepLast4,
  redactBankAccountAuditChanges,
} from "../src/services/bankAccounts/bankAccountAudit.js";

const ready = {
  id: "acct_ready",
  detailsPresent: true,
  profileIds: ["profile-a"],
};
const other = {
  id: "acct_other",
  detailsPresent: true,
  profileIds: ["profile-b"],
};

describe("bank account setup", () => {
  it("is set up when the profile has an eligible active account", () => {
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [ready],
        profileId: "profile-a",
      }),
      "set_up",
    );
  });

  it("is not set up when the only account is deleted or has no details", () => {
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [{ ...ready, deleted: true }],
        profileId: "profile-a",
      }),
      "not_set_up",
    );
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [{ ...ready, detailsPresent: false }],
        profileId: "profile-a",
      }),
      "not_set_up",
    );
    assert.equal(isEligibleActiveBankAccount({ ...ready, deleted: true }), false);
  });

  it("uses a bank saved on another profile of the same investor", () => {
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [other],
        profileId: "profile-a",
      }),
      "set_up",
    );
  });

  it("uses a profile bank when the payout account is no longer on file", () => {
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [ready],
        profileId: "profile-a",
        associatedAccountId: "acct_missing",
      }),
      "set_up",
    );
    assert.equal(
      resolveBankAccountSetupStatus({
        accounts: [ready],
        profileId: "profile-a",
        associatedAccountId: "acct_ready",
      }),
      "set_up",
    );
  });

  it("counts bank name and routing saved on the investor profile", () => {
    assert.equal(
      savedProfileBankDetailsPresent({
        achBankName: "First National",
        achRoutingNumber: "021000021",
        achAccountNumber: "",
      }),
      true,
    );
    assert.equal(
      savedProfileBankDetailsPresent({
        achBankName: "",
        achRoutingNumber: "",
        achAccountNumber: "",
      }),
      false,
    );
  });

  it("treats details on file as setup without requiring ACH to be enabled", () => {
    assert.equal(
      bankDetailsArePresent({
        accountId: "acct_1",
        detailsSubmitted: true,
        payoutsEnabled: false,
        status: "pending",
      }),
      true,
    );
    assert.equal(
      bankDetailsArePresent({
        accountId: "acct_1",
        detailsSubmitted: false,
        payoutsEnabled: false,
        status: "not_started",
      }),
      false,
    );
  });
});

describe("bank account audit redaction", () => {
  it("keeps the record id and masks routing and account numbers", () => {
    assert.equal(maskKeepLast4("021000021"), "••••0021");
    const redacted = redactBankAccountAuditChanges({
      bankAccountRecordId: "acct_123",
      routingNumber: "021000021",
      achAccountNumber: "123456789",
      accountHolderName: "Ada Investor",
      nested: { account_number: "999988887777" },
    }) as Record<string, unknown>;
    assert.equal(redacted.bankAccountRecordId, "acct_123");
    assert.equal(redacted.routingNumber, "••••0021");
    assert.equal(redacted.achAccountNumber, "••••6789");
    assert.equal(redacted.accountHolderName, "Ada Investor");
    assert.deepEqual(redacted.nested, { account_number: "••••7777" });
  });
});
