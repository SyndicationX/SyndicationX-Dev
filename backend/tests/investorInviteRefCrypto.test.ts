import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decryptInvestorInviteRef,
  encryptInvestorInviteRef,
} from "../src/utils/investorInviteRefCrypto.js";

const SPONSOR = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const DEAL = "33333333-3333-4333-8333-333333333333";

describe("investor invite ref", () => {
  it("keeps a sponsor-only link readable", () => {
    const token = encryptInvestorInviteRef(SPONSOR);
    assert.deepEqual(decryptInvestorInviteRef(token), {
      sponsorUserId: SPONSOR,
      dealId: null,
      companyId: null,
    });
  });

  it("round-trips the company id with the sponsor", () => {
    const token = encryptInvestorInviteRef(SPONSOR, null, COMPANY);
    assert.deepEqual(decryptInvestorInviteRef(token), {
      sponsorUserId: SPONSOR,
      companyId: COMPANY,
      dealId: null,
    });
    assert.equal(encryptInvestorInviteRef(SPONSOR, null, COMPANY), token);
  });

  it("round-trips sponsor, company, and deal together", () => {
    const token = encryptInvestorInviteRef(SPONSOR, DEAL, COMPANY);
    assert.deepEqual(decryptInvestorInviteRef(token), {
      sponsorUserId: SPONSOR,
      companyId: COMPANY,
      dealId: DEAL,
    });
  });

  it("still reads older deal links that have no company", () => {
    const token = encryptInvestorInviteRef(SPONSOR, DEAL);
    assert.deepEqual(decryptInvestorInviteRef(token), {
      sponsorUserId: SPONSOR,
      dealId: DEAL,
      companyId: null,
    });
  });
});
