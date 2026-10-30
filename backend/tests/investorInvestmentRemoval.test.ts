import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  associatedSponsorSoftCommitmentIds,
  blocksLastLeadSponsorRemoval,
  isSoftCommitmentStatus,
  parseRemovalRequest,
  planInvestorRemoval,
  REMOVED_INVESTMENT_STATUS,
  runRemovalUnitOfWork,
  type RemovalInvestment,
  type RemovalLp,
  type RemovalMember,
} from "../src/services/deal/investorInvestmentRemoval.plan.js";

const USER_ACCOUNT = "user-account-1";

function investment(
  patch: Partial<RemovalInvestment> & Pick<RemovalInvestment, "id" | "contactId">,
): RemovalInvestment {
  const row: RemovalInvestment = {
    id: patch.id,
    contactId: patch.contactId,
    profileId: patch.profileId ?? "individual",
    userInvestorProfileId: patch.userInvestorProfileId ?? null,
    status: patch.status ?? "Soft committed",
    removedAt: patch.removedAt ?? null,
    investorUnlinkedAt: patch.investorUnlinkedAt ?? null,
    previous: {},
  };
  row.previous = {
    id: row.id,
    contactId: row.contactId,
    profileId: row.profileId,
    status: row.status,
    commitmentAmount: patch.previous?.commitmentAmount ?? "1000",
  };
  return row;
}

function lp(contactId: string, id = "lp-1"): RemovalLp {
  return {
    id,
    contactId,
    removedAt: null,
    committedAmount: "1000",
    previous: { id, contactId, committed_amount: "1000" },
  };
}

function member(contactId: string, keep = false): RemovalMember {
  return {
    id: "member-1",
    contactId,
    keepBecauseCompanyUser: keep,
    previous: { id: "member-1", contactId, dealMemberRole: "LP Investor" },
  };
}

describe("investor and investment removal", () => {
  it("requires a reason and a confirmation checkbox", () => {
    assert.equal(parseRemovalRequest({ action: "remove_investment" }).ok, false);
    assert.equal(
      parseRemovalRequest({
        action: "remove_investment",
        reason: "Duplicate entry",
        confirmed: false,
      }).ok,
      false,
    );
    const ok = parseRemovalRequest({
      action: "remove_investor",
      reason: "  Left the offering  ",
      confirmed: true,
    });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.reason, "Left the offering");
  });

  it("removes the investment and only its sponsor soft commitments", () => {
    const selected = investment({
      id: "inv-a",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-1",
      status: "Signed",
    });
    const softSame = investment({
      id: "soft-a",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-1",
      status: "Soft commitment",
    });
    const hardSame = investment({
      id: "hard-a",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-1",
      status: "Funds fully received",
    });
    const otherProfile = investment({
      id: "other-profile",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-2",
      status: "Soft committed",
    });
    const otherInvestor = investment({
      id: "inv-b",
      contactId: "contact-b",
      userInvestorProfileId: "profile-book-1",
      status: "Soft committed",
    });

    assert.deepEqual(
      associatedSponsorSoftCommitmentIds(selected, [
        selected,
        softSame,
        hardSame,
        otherProfile,
        otherInvestor,
      ]),
      ["soft-a"],
    );
    assert.equal(isSoftCommitmentStatus("soft committed"), true);

    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Entered on the wrong class",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected, softSame, hardSame, otherProfile, otherInvestor],
      lp: lp("contact-a"),
      member: member("contact-a"),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(planned.plan.affectedIds, ["inv-a"]);
    assert.equal(
      planned.plan.mutations.some((item) => item.id === "soft-a"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.id === "hard-a"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.id === "other-profile"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.id === "inv-b"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "soft_delete_lp"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "delete_roster_member"),
      false,
    );
    assert.equal(planned.plan.affectedIds.includes(USER_ACCOUNT), false);
    assert.equal(planned.plan.previousValues.investments.length, 1);
    assert.equal(
      planned.plan.mutations.some(
        (item) => item.type === "clear_lp_soft_commitment",
      ),
      false,
    );
    assert.equal(
      planned.plan.previousValues.investments[0]?.commitmentAmount,
      "1000",
    );
    assert.equal(planned.plan.reason, "Entered on the wrong class");
    assert.equal(planned.plan.actorUserId, "sponsor-1");
    assert.equal(REMOVED_INVESTMENT_STATUS, "Removed");
    assert.equal(
      planned.plan.mutations.every((item) => item.type !== "soft_delete_lp"),
      true,
    );
    assert.equal(
      planned.plan.mutations.every((item) => item.type !== "delete_roster_member"),
      true,
    );
  });

  it("does not remove every investment when the request is not for one investment row", () => {
    const first = investment({
      id: "inv-a",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-1",
      status: "Soft committed",
    });
    const second = investment({
      id: "inv-b",
      contactId: "contact-a",
      userInvestorProfileId: "profile-book-1",
      status: "Soft commitment",
    });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Wrong row",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "lp", id: "lp-1" },
      investments: [first, second],
      lp: lp("contact-a"),
      member: member("contact-a"),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.status, 400);
  });

  it("keeps the investor when that was the only investment", () => {
    const selected = investment({
      id: "inv-a",
      contactId: "contact-a",
      status: "Soft committed",
    });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Withdrawn",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected],
      lp: lp("contact-a"),
      member: member("contact-a"),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["soft_delete_investment"],
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "soft_delete_lp"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "delete_roster_member"),
      false,
    );
  });

  it("clears a roster commitment and keeps that amount in the removal log", () => {
    const alreadyRemoved = investment({
      id: "inv-a",
      contactId: "contact-a",
      status: "Open to investment",
      removedAt: "2026-10-23T14:08:53.763Z",
    });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Clear the remaining roster amount",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Josh Kelfer",
      removedRole: "LP Investor",
      target: { kind: "lp", id: "lp-1" },
      investments: [alreadyRemoved],
      lp: lp("contact-a"),
      member: null,
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.status, 400);
  });

  it("clears a removed investment's committed amount without removing the investor", () => {
    const alreadyRemoved = investment({
      id: "inv-a",
      contactId: "contact-a",
      status: "Removed",
      removedAt: "2026-10-29T12:00:00.000Z",
    });
    const other = investment({
      id: "inv-b",
      contactId: "contact-a",
      status: "Soft committed",
    });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Drop the amount that is still showing",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [alreadyRemoved, other],
      lp: lp("contact-a"),
      member: member("contact-a"),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["release_investment_commitment"],
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "soft_delete_lp"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "delete_roster_member"),
      false,
    );
  });

  it("logs the roster commitment when the removed investment is not a soft commitment", () => {
    const selected = investment({
      id: "inv-a",
      contactId: "contact-a",
      status: "Open to investment",
    });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Removing the commitment",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Josh Kelfer",
      removedRole: "lp_investors",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected],
      lp: lp("contact-a"),
      member: null,
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["soft_delete_investment"],
    );
    assert.equal(
      planned.plan.previousValues.investments[0]?.commitmentAmount,
      "1000",
    );
    assert.equal(planned.plan.previousValues.lpInvestors.length, 0);
  });

  it("removes the investor after that investment was already removed", () => {
    const alreadyRemoved = investment({
      id: "inv-a",
      contactId: "contact-a",
      status: "Removed",
      removedAt: "2026-10-29T12:00:00.000Z",
    });
    const planned = planInvestorRemoval({
      action: "remove_investor",
      reason: "Take the investor off the deal",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [alreadyRemoved],
      lp: lp("contact-a"),
      member: member("contact-a"),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["unlink_investor"],
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "soft_delete_investment"),
      false,
    );
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "soft_delete_lp"),
      false,
    );
  });

  it("removes the investor association without deleting the account or other investments", () => {
    const selected = investment({
      id: "inv-a",
      contactId: USER_ACCOUNT,
      status: "Signed",
    });
    const shared = investment({
      id: "inv-shared",
      contactId: USER_ACCOUNT,
      userInvestorProfileId: "other-book",
      status: "Soft committed",
    });
    const planned = planInvestorRemoval({
      action: "remove_investor",
      reason: "Wrong person on this profile",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected, shared],
      lp: lp(USER_ACCOUNT),
      member: member(USER_ACCOUNT),
      investmentIdsWithMoney: ["inv-a"],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["unlink_investor"],
    );
    assert.deepEqual(planned.plan.affectedIds, ["inv-a"]);
    assert.equal(planned.plan.affectedIds.includes(USER_ACCOUNT), false);
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "delete_roster_member"),
      false,
    );
  });

  it("keeps a company-user roster row and does not delete the user when the last investment association is removed", () => {
    const selected = investment({ id: "inv-a", contactId: "contact-a" });
    const planned = planInvestorRemoval({
      action: "remove_investor",
      reason: "No longer participating",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected],
      lp: lp("contact-a"),
      member: member("contact-a", true),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["unlink_investor"],
    );
    assert.equal(blocksLastLeadSponsorRemoval({
      deletesRosterMember: false,
      contactId: "contact-a",
      leadContactIds: ["contact-a"],
    }), false);
  });

  it("follows the lead-sponsor rule when the roster row would be deleted", () => {
    const selected = investment({ id: "inv-a", contactId: "contact-a", status: "Signed" });
    const planned = planInvestorRemoval({
      action: "remove_investor",
      reason: "Replaced",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "Lead Sponsor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected],
      lp: null,
      member: member("contact-a", false),
      investmentIdsWithMoney: [],
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(
      planned.plan.mutations.some((item) => item.type === "delete_roster_member"),
      false,
    );
    assert.deepEqual(
      planned.plan.mutations.map((item) => item.type),
      ["unlink_investor"],
    );
    assert.equal(
      blocksLastLeadSponsorRemoval({
        deletesRosterMember: true,
        contactId: "contact-a",
        leadContactIds: ["contact-a"],
      }),
      true,
    );
    assert.equal(
      blocksLastLeadSponsorRemoval({
        deletesRosterMember: true,
        contactId: "contact-a",
        leadContactIds: ["contact-a", "contact-b"],
      }),
      false,
    );
  });

  it("refuses to remove an investment that has payments", () => {
    const selected = investment({ id: "inv-a", contactId: "contact-a" });
    const planned = planInvestorRemoval({
      action: "remove_investment",
      reason: "Mistake",
      confirmed: true,
      actorUserId: "sponsor-1",
      removedName: "Ada",
      removedRole: "LP Investor",
      target: { kind: "investment", id: "inv-a" },
      investments: [selected],
      lp: lp("contact-a"),
      member: null,
      investmentIdsWithMoney: ["inv-a"],
    });
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.status, 409);
  });

  it("rolls back the data change when the audit insert fails", async () => {
    const state = {
      investments: ["inv-a", "inv-b"],
      audits: [] as string[],
    };
    await assert.rejects(
      () =>
        runRemovalUnitOfWork(
          async (work) => {
            const before = {
              investments: [...state.investments],
              audits: [...state.audits],
            };
            try {
              await work();
            } catch (err) {
              state.investments = before.investments;
              state.audits = before.audits;
              throw err;
            }
          },
          {
            applyMutations: async () => {
              state.investments = state.investments.filter((id) => id !== "inv-a");
            },
            writeAudit: async () => {
              throw new Error("audit log failed");
            },
          },
        ),
      /audit log failed/,
    );
    assert.deepEqual(state.investments, ["inv-a", "inv-b"]);
    assert.deepEqual(state.audits, []);
  });

  it("writes the audit log only after the data change, in the same transaction", async () => {
    const order: string[] = [];
    await runRemovalUnitOfWork(
      async (work) => {
        order.push("begin");
        await work();
        order.push("commit");
      },
      {
        applyMutations: async () => {
          order.push("mutate");
        },
        writeAudit: async () => {
          order.push("audit");
        },
      },
    );
    assert.deepEqual(order, ["begin", "mutate", "audit", "commit"]);
  });
});
