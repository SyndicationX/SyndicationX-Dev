import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDealFundApprovedEmailHtml,
  buildDealFundApprovedEmailText,
  buildDealFundApprovedSponsorEmailHtml,
  buildDealFundApprovedSponsorEmailText,
  type DealFundApprovedTemplateVars,
} from "../src/functions/dealFundApprovedEmail.template.js";

const vars: DealFundApprovedTemplateVars = {
  dealName: "Oak Street Fund",
  investorDisplayName: "Alex Investor",
  investorEmail: "alex@example.com",
  sponsorDisplayName: "Sam Sponsor",
  portalDealUrl: "https://example.com/deals/oak-street",
  senderBrand: "SyndicationX",
};

describe("funded investment email templates", () => {
  it("notifies the investor that funding was approved", () => {
    assert.match(buildDealFundApprovedEmailText(vars), /Fund approved/i);
    assert.match(buildDealFundApprovedEmailHtml(vars), /Oak Street Fund/);
  });

  it("notifies the sponsor that their investor is funded", () => {
    const text = buildDealFundApprovedSponsorEmailText(vars);
    const html = buildDealFundApprovedSponsorEmailHtml(vars);

    assert.match(text, /Hello Sam Sponsor/);
    assert.match(text, /Alex Investor is now funded for Oak Street Fund/);
    assert.match(html, /Investor funded/);
    assert.match(html, /Alex Investor/);
  });
});
