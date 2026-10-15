import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANY_ADMIN,
  COMPANY_USER,
  INVESTOR,
  PLATFORM_ADMIN,
  PLATFORM_USER,
} from "../src/constants/roles.js";
import {
  PII_EMAIL_REDACTED,
  PII_PHONE_REDACTED,
  coSponsorOwnedContactVisibleToViewer,
  isLeadOrAdminDealViewerRole,
  redactCoSponsorInvestorEmailAndPhone,
  redactContactEmailAndPhone,
  viewerSeesOnlyOwnContactsInSelectedCompany,
} from "../src/services/privacy/coSponsorPiiRedaction.js";

const CO_SPONSOR = "co-sponsor-user";
const LEAD = "lead-user";

test("other users do not receive a co-sponsor's contacts; his company admin and lead still do", () => {
  const viewers = [COMPANY_USER, PLATFORM_USER, INVESTOR];
  for (const role of viewers) {
    assert.equal(
      coSponsorOwnedContactVisibleToViewer({
        createdByUserId: CO_SPONSOR,
        viewerIdsLower: new Set([role.toLowerCase()]),
        creatorIsPrivateCoSponsorInSelectedCompany: true,
      }),
      false,
      role,
    );
  }
  assert.equal(
    coSponsorOwnedContactVisibleToViewer({
      createdByUserId: CO_SPONSOR,
      viewerIdsLower: new Set(["company-b-admin"]),
      creatorIsPrivateCoSponsorInSelectedCompany: true,
      viewerIsCompanyAdminOrLeadOfCreatorCompany: true,
    }),
    true,
  );
  assert.equal(
    coSponsorOwnedContactVisibleToViewer({
      createdByUserId: CO_SPONSOR,
      viewerIdsLower: new Set([CO_SPONSOR]),
      creatorIsPrivateCoSponsorInSelectedCompany: true,
    }),
    true,
  );
  assert.equal(
    coSponsorOwnedContactVisibleToViewer({
      createdByUserId: LEAD,
      viewerIdsLower: new Set(["company-admin"]),
      creatorIsPrivateCoSponsorInSelectedCompany: false,
    }),
    true,
  );
  const masked = redactContactEmailAndPhone({
    email: "ada@example.com",
    phone: "+15555550100",
  });
  assert.equal(masked.email, PII_EMAIL_REDACTED);
  assert.equal(masked.phone, PII_PHONE_REDACTED);
  assert.equal(masked.email.includes("ada@"), false);
});

test("contact narrowing uses the selected company role, not another company's lead role", () => {
  assert.equal(
    viewerSeesOnlyOwnContactsInSelectedCompany({
      roleInSelectedCompany: COMPANY_USER,
      isLeadOrAdminSponsorInSelectedCompany: false,
      isCoSponsorInSelectedCompany: true,
    }),
    true,
  );
  assert.equal(
    viewerSeesOnlyOwnContactsInSelectedCompany({
      roleInSelectedCompany: COMPANY_ADMIN,
      isLeadOrAdminSponsorInSelectedCompany: false,
      isCoSponsorInSelectedCompany: true,
    }),
    false,
  );
  assert.equal(
    viewerSeesOnlyOwnContactsInSelectedCompany({
      roleInSelectedCompany: PLATFORM_USER,
      isLeadOrAdminSponsorInSelectedCompany: true,
      isCoSponsorInSelectedCompany: true,
    }),
    false,
  );
  assert.equal(
    viewerSeesOnlyOwnContactsInSelectedCompany({
      roleInSelectedCompany: PLATFORM_ADMIN,
      isLeadOrAdminSponsorInSelectedCompany: false,
      isCoSponsorInSelectedCompany: true,
    }),
    false,
  );
  assert.equal(
    viewerSeesOnlyOwnContactsInSelectedCompany({
      roleInSelectedCompany: COMPANY_USER,
      isLeadOrAdminSponsorInSelectedCompany: false,
      isCoSponsorInSelectedCompany: false,
    }),
    false,
  );
});

test("lead and admin sponsors see co-sponsor investors with only email and phone redacted", () => {
  assert.equal(isLeadOrAdminDealViewerRole("lead_sponsor"), true);
  assert.equal(isLeadOrAdminDealViewerRole("admin_sponsor"), true);
  assert.equal(isLeadOrAdminDealViewerRole("co_sponsor"), false);
  const investor = {
    displayName: "Ada Investor",
    userEmail: "ada@example.com",
    userPhone: "+15555550100",
    committed: "$25,000",
    investorClass: "Class A",
    addedByEmail: "cosponsor@example.com",
    addedByUserId: CO_SPONSOR,
    addedByIsCoSponsorOnDeal: true,
  };
  const viewers = [new Set([LEAD]), new Set(["admin-user"])];
  for (const viewerIds of viewers) {
    const row = redactCoSponsorInvestorEmailAndPhone(investor, viewerIds);
    assert.equal(row.displayName, "Ada Investor");
    assert.equal(row.committed, "$25,000");
    assert.equal(row.investorClass, "Class A");
    assert.equal(row.addedByEmail, "cosponsor@example.com");
    assert.equal(row.userEmail, "redacted");
    assert.equal(row.userPhone, "redacted");
  }
});

test("a co-sponsor still sees their own investor email and phone", () => {
  const row = redactCoSponsorInvestorEmailAndPhone(
    {
      displayName: "Own Investor",
      userEmail: "own@example.com",
      userPhone: "+15555550101",
      addedByUserId: CO_SPONSOR,
      addedByIsCoSponsorOnDeal: true,
    },
    new Set([CO_SPONSOR]),
  );
  assert.equal(row.userEmail, "own@example.com");
  assert.equal(row.userPhone, "+15555550101");
});

test("investors not added by a co-sponsor keep email and phone for lead sponsors", () => {
  const row = redactCoSponsorInvestorEmailAndPhone(
    {
      displayName: "Lead Investor",
      userEmail: "lead-lp@example.com",
      userPhone: "+15555550102",
      committed: "$10",
      addedByUserId: LEAD,
      addedByIsCoSponsorOnDeal: false,
    },
    new Set([LEAD]),
  );
  assert.equal(row.userEmail, "lead-lp@example.com");
  assert.equal(row.userPhone, "+15555550102");
  assert.equal(row.committed, "$10");
});
