import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { pool } from "../src/database/db.js";
import {
  insertDealInvestment,
  loadRosterAddedByMaps,
  LP_INVESTOR_ROLE_STORED,
  mapContactIdsToCanonicalCommitmentKeys,
  resolveInvestorRowAddedByUserId,
} from "../src/services/deal/dealInvestment.service.js";
import { listMergedLpInvestorsForDeal } from "../src/services/deal/dealLpInvestor.service.js";
import {
  listCoSponsorPortalUserIdsOnDeal,
  resolveViewerDealMemberRoleOnDeal,
} from "../src/services/deal/dealMemberScope.service.js";
import { REMOVED_INVESTMENT_STATUS } from "../src/services/deal/investorInvestmentRemoval.plan.js";
import { removeInvestorOrInvestment } from "../src/services/deal/investorInvestmentRemoval.service.js";

after(async () => {
  await pool.end();
});

describe("Invest Now investment on a sponsor deal", () => {
  it("stores a new investment, shows it to the sponsor, and Remove Investment only marks that row", async () => {
    const found = await pool.query<{
      investment_id: string;
      deal_id: string;
      contact_id: string;
      contact_display_name: string;
      profile_id: string;
      user_investor_profile_id: string | null;
      investor_class: string;
      offering_id: string;
      lp_id: string;
      added_by: string | null;
    }>(`
      SELECT di.id AS investment_id,
             di.deal_id,
             di.contact_id,
             di.contact_display_name,
             di.profile_id,
             di.user_investor_profile_id,
             di.investor_class,
             di.offering_id,
             lp.id AS lp_id,
             lp.added_by
        FROM deal_investment di
        JOIN deal_lp_investor lp
          ON lp.deal_id = di.deal_id
         AND lower(lp.contact_member_id) = lower(di.contact_id)
       WHERE di.removed_at IS NULL
         AND di.investor_unlinked_at IS NULL
         AND di.is_draft = false
         AND lp.removed_at IS NULL
         AND lp.is_draft = false
         AND lower(di.investor_role) IN ('lp_investors', 'lp investor', 'lp investors')
       ORDER BY di.created_at DESC
       LIMIT 30
    `);
    assert.ok(
      found.rows.length > 0,
      "Need one open LP investment that is already on the Investors tab.",
    );

    let seed = found.rows[0];
    let actorId = "";
    for (const candidate of found.rows) {
      const addedByMaps = await loadRosterAddedByMaps(candidate.deal_id);
      const rawToCanonical = await mapContactIdsToCanonicalCommitmentKeys([
        candidate.contact_id,
        ...addedByMaps.byContactKey.keys(),
      ]);
      const sponsorWhoAdded = resolveInvestorRowAddedByUserId(
        { id: candidate.lp_id, contactId: candidate.contact_id },
        addedByMaps.byContactKey,
        addedByMaps.byLpRowId,
        rawToCanonical,
      );
      const chosen = (sponsorWhoAdded || candidate.added_by || "").trim();
      if (!chosen) continue;
      const user = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1::uuid LIMIT 1`,
        [chosen],
      );
      const userId = user.rows[0]?.id ?? "";
      if (!userId) continue;
      const [role, coSponsorIds] = await Promise.all([
        resolveViewerDealMemberRoleOnDeal(candidate.deal_id, userId),
        listCoSponsorPortalUserIdsOnDeal(candidate.deal_id),
      ]);
      const coSponsors = new Set(
        coSponsorIds.map((id) => id.trim().toLowerCase()),
      );
      const leadBlocked =
        (role === "lead_sponsor" || role === "admin_sponsor") &&
        coSponsors.has(userId.trim().toLowerCase());
      if (leadBlocked) continue;
      seed = candidate;
      actorId = userId;
      break;
    }
    assert.ok(
      actorId,
      "Need a sponsor who is allowed to remove this investor's investment.",
    );

    const membersBefore = await pool.query(
      `SELECT id FROM deal_member
        WHERE deal_id = $1::uuid
          AND lower(contact_member_id) = lower($2)`,
      [seed.deal_id, seed.contact_id],
    );

    const created = await insertDealInvestment({
      dealId: seed.deal_id,
      input: {
        offeringId: seed.offering_id ?? "",
        contactId: seed.contact_id,
        contactDisplayName:
          seed.contact_display_name?.trim() || "Invest Now scenario",
        profileId: seed.profile_id?.trim() || "individual",
        userInvestorProfileId: seed.user_investor_profile_id,
        investor_role: LP_INVESTOR_ROLE_STORED,
        fundApproved: false,
        status: "Soft committed",
        investorClass: seed.investor_class ?? "",
        docSignedDate: null,
        commitmentAmount: "2500",
        extraContributionAmounts: [],
        documentStoragePath: null,
        fundingMethod: "wire_transfer",
      },
    });

    try {
      assert.notEqual(created.id, seed.investment_id);

      const storedNew = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM deal_investment WHERE id = $1::uuid`,
        [created.id],
      );
      assert.equal(storedNew.rows.length, 1);
      assert.equal(storedNew.rows[0]?.status, "Soft committed");

      const sponsorBefore = await listMergedLpInvestorsForDeal(seed.deal_id);
      assert.equal(
        sponsorBefore.some((row) => row.id === created.id),
        true,
        "The new investment should appear on the sponsor deal.",
      );
      assert.equal(
        sponsorBefore.some((row) => row.id === seed.investment_id),
        true,
      );

      const removed = await removeInvestorOrInvestment({
        dealId: seed.deal_id,
        rowId: created.id,
        actorUserId: actorId,
        action: "remove_investment",
        reason: "Invest Now scenario: remove this investment only",
        confirmed: true,
      });
      assert.equal(
        removed.ok,
        true,
        removed.ok ? "" : `${removed.status} ${removed.message}`,
      );

      const afterDeleteAttempt = await pool.query<{
        id: string;
        status: string;
        removed_at: Date | null;
      }>(
        `SELECT id, status, removed_at FROM deal_investment WHERE id = $1::uuid`,
        [created.id],
      );
      assert.equal(afterDeleteAttempt.rows.length, 1);
      assert.equal(afterDeleteAttempt.rows[0]?.status, REMOVED_INVESTMENT_STATUS);
      assert.ok(afterDeleteAttempt.rows[0]?.removed_at);

      const original = await pool.query<{ removed_at: Date | null }>(
        `SELECT removed_at FROM deal_investment WHERE id = $1::uuid`,
        [seed.investment_id],
      );
      assert.equal(original.rows[0]?.removed_at ?? null, null);

      const sponsorAfter = await listMergedLpInvestorsForDeal(seed.deal_id);
      const removedRow = sponsorAfter.find((row) => row.id === created.id);
      assert.equal(removedRow?.status, REMOVED_INVESTMENT_STATUS);
      assert.equal(
        sponsorAfter.some(
          (row) =>
            String(row.contactId ?? "").trim().toLowerCase() ===
            seed.contact_id.trim().toLowerCase(),
        ),
        true,
        "Remove Investment should leave the investor on the Investors tab.",
      );

      const lpAfter = await pool.query<{
        removed_at: Date | null;
        committed_amount: string;
      }>(
        `SELECT removed_at, committed_amount FROM deal_lp_investor WHERE id = $1::uuid`,
        [seed.lp_id],
      );
      assert.equal(lpAfter.rows[0]?.removed_at ?? null, null);
      const openSum = await pool.query<{ total: string }>(
        `SELECT coalesce(sum(
            coalesce(
              nullif(regexp_replace(coalesce(commitment_amount, ''), '[^0-9.-]', '', 'g'), ''),
              '0'
            )::double precision
          ), 0)::text AS total
           FROM deal_investment
          WHERE deal_id = $1::uuid
            AND lower(contact_id) = lower($2)
            AND removed_at IS NULL
            AND investor_unlinked_at IS NULL
            AND lower(trim(coalesce(status, ''))) <> 'removed'
            AND lower(investor_role) IN ('lp_investors', 'lp investor', 'lp investors')`,
        [seed.deal_id, seed.contact_id],
      );
      assert.equal(
        Number(lpAfter.rows[0]?.committed_amount || 0),
        Number(openSum.rows[0]?.total || 0),
      );
      const removedAmount = await pool.query<{ commitment_amount: string }>(
        `SELECT commitment_amount FROM deal_investment WHERE id = $1::uuid`,
        [created.id],
      );
      assert.equal(removedAmount.rows[0]?.commitment_amount ?? "", "2500");

      const membersAfter = await pool.query(
        `SELECT id FROM deal_member
          WHERE deal_id = $1::uuid
            AND lower(contact_member_id) = lower($2)`,
        [seed.deal_id, seed.contact_id],
      );
      assert.equal(membersAfter.rows.length, membersBefore.rows.length);
    } finally {
      await pool.query(
        `DELETE FROM deal_member_removal_logs WHERE removed_row_id = $1::uuid`,
        [created.id],
      );
      await pool.query(`DELETE FROM deal_investment WHERE id = $1::uuid`, [
        created.id,
      ]);
    }
  });
});
