import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInvestmentCommitmentInvestorEmailHtml,
  buildInvestmentCommitmentInvestorEmailText,
  buildInvestmentCommitmentSponsorEmailHtml,
  buildInvestmentCommitmentSponsorEmailText,
  type InvestmentCommitmentEmailVars,
} from "../src/functions/investmentCommitmentEmail.template.js";

const baseVars: InvestmentCommitmentEmailVars = {
  dealName: "Oak Street Fund",
  investorDisplayName: "Alex Investor",
  investorEmail: "alex@example.com",
  sponsorDisplayName: "Sam Sponsor",
  commitmentAmount: "$50,000.00",
  commitmentDate: "October 13, 2026",
  portalUrl: "https://example.com/investments",
  senderBrand: "SyndicationX",
};

describe("investment commitment email templates", () => {
  it("identifies a soft commitment in both investor and sponsor emails", () => {
    const vars = { ...baseVars, commitmentKind: "soft" as const };

    const investorText = buildInvestmentCommitmentInvestorEmailText(vars);
    const investorHtml = buildInvestmentCommitmentInvestorEmailHtml(vars);
    const sponsorText = buildInvestmentCommitmentSponsorEmailText(vars);
    const sponsorHtml = buildInvestmentCommitmentSponsorEmailHtml(vars);

    assert.match(investorText, /soft investment commitment/i);
    assert.match(investorText, /sponsor has also been notified/i);
    assert.match(investorHtml, /Soft investment commitment saved/);
    assert.match(sponsorText, /soft investment commitment/i);
    assert.match(sponsorHtml, /New soft investment commitment/);
    assert.match(sponsorHtml, /Alex Investor/);
    assert.match(sponsorHtml, /\$50,000\.00/);
  });

  it("keeps the completed commitment wording as the default", () => {
    const investorText = buildInvestmentCommitmentInvestorEmailText(baseVars);
    const sponsorText = buildInvestmentCommitmentSponsorEmailText(baseVars);

    assert.match(investorText, /investment commitment.*confirmed/is);
    assert.doesNotMatch(investorText, /soft investment commitment/i);
    assert.match(sponsorText, /has committed to an investment/i);
  });
});
