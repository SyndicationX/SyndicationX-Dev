import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { dealMember } from "../../schema/deal.schema/deal-member.schema.js";
import { dealMemberRemovalLogs } from "../../schema/deal.schema/deal-member-removal-log.schema.js";
import {
  dealInvestment,
  type DealInvestmentRow,
} from "../../schema/deal.schema/deal-investment.schema.js";
import {
  dealLpInvestor,
  type DealLpInvestorRow,
} from "../../schema/deal.schema/deal-lp-investor.schema.js";
import {
  investorCheckoutPayments,
  investorDistributionPayouts,
} from "../../schema/stripeInvestorPayments.schema.js";
import {
  committedNumericFromDealInvestmentRow,
  isDealCompanyUserStoredRole,
  isLpInvestorRole,
  isRetiredDealInvestment,
  loadRosterAddedByMaps,
  mapContactIdsToCanonicalCommitmentKeys,
  resolveInvestorRowAddedByUserId,
} from "./dealInvestment.service.js";
import {
  LEAD_SPONSOR_REQUIRED_MESSAGE,
  leadSponsorContactKeysForDeal,
} from "./dealMember.service.js";
import {
  listCoSponsorPortalUserIdsOnDeal,
  resolveViewerDealMemberRoleOnDeal,
} from "./dealMemberScope.service.js";
import {
  blocksLastLeadSponsorRemoval,
  planInvestorRemoval,
  REMOVED_INVESTMENT_STATUS,
  runRemovalUnitOfWork,
  type RemovalAction,
  type RemovalInvestment,
  type RemovalLp,
  type RemovalMember,
  type RemovalMutation,
  type RemovalPlan,
} from "./investorInvestmentRemoval.plan.js";

export class InvestorRemovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InvestorRemovalError";
  }
}

function snapshot(row: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

function toInvestment(row: DealInvestmentRow): RemovalInvestment {
  return {
    id: row.id,
    contactId: row.contactId,
    profileId: row.profileId,
    userInvestorProfileId: row.userInvestorProfileId,
    status: row.status,
    removedAt: row.removedAt,
    investorUnlinkedAt: row.investorUnlinkedAt,
    previous: snapshot(row),
  };
}

function toLp(row: DealLpInvestorRow): RemovalLp {
  return {
    id: row.id,
    contactId: row.contactMemberId,
    removedAt: row.removedAt,
    committedAmount: row.committed_amount,
    previous: snapshot(row),
  };
}

function toMember(row: typeof dealMember.$inferSelect): RemovalMember {
  return {
    id: row.id,
    contactId: row.contactMemberId,
    keepBecauseCompanyUser: isDealCompanyUserStoredRole(row.dealMemberRole),
    previous: snapshot(row),
  };
}

const CO_SPONSOR_INVESTOR_REMOVAL_MESSAGE =
  "Lead and admin sponsors cannot remove an investor added by a co-sponsor.";

/**
 * Lead and admin sponsors keep the full roster, but a co-sponsor's investors
 * stay with that co-sponsor. `added_by` is the Sponsor name on the investor.
 */
async function leadOrAdminRemovingCoSponsorInvestor(params: {
  dealId: string;
  actorUserId: string;
  contactId: string;
  rowId: string;
}): Promise<boolean> {
  const role = await resolveViewerDealMemberRoleOnDeal(
    params.dealId,
    params.actorUserId,
  );
  if (role !== "lead_sponsor" && role !== "admin_sponsor") return false;
  const contactId = params.contactId.trim();
  const rowId = params.rowId.trim();
  if (!contactId && !rowId) return false;
  const [maps, coSponsorIds] = await Promise.all([
    loadRosterAddedByMaps(params.dealId),
    listCoSponsorPortalUserIdsOnDeal(params.dealId),
  ]);
  const rawToCanonical = await mapContactIdsToCanonicalCommitmentKeys([
    contactId,
    ...maps.byContactKey.keys(),
  ]);
  const addedBy = resolveInvestorRowAddedByUserId(
    { id: rowId, contactId },
    maps.byContactKey,
    maps.byLpRowId,
    rawToCanonical,
  );
  if (!addedBy) return false;
  const coSponsors = new Set(
    coSponsorIds.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  return coSponsors.has(addedBy.trim().toLowerCase());
}

async function actorName(userId: string): Promise<string> {
  const [row] = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return "";
  const full = [row.firstName, row.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return full || row.username?.trim() || row.email?.trim() || "";
}

async function investmentIdsWithMoney(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const [payoutRows, paymentRows] = await Promise.all([
    db
      .select({ investmentId: investorDistributionPayouts.investmentId })
      .from(investorDistributionPayouts)
      .where(inArray(investorDistributionPayouts.investmentId, ids)),
    db
      .select({
        investmentId: investorCheckoutPayments.investmentId,
        status: investorCheckoutPayments.status,
      })
      .from(investorCheckoutPayments)
      .where(inArray(investorCheckoutPayments.investmentId, ids)),
  ]);
  const blocked = new Set<string>();
  for (const row of payoutRows) {
    if (row.investmentId) blocked.add(row.investmentId);
  }
  for (const row of paymentRows) {
    const status = String(row.status ?? "").trim().toLowerCase();
    if (
      row.investmentId &&
      (status === "succeeded" || status === "processing" || status === "paid")
    ) {
      blocked.add(row.investmentId);
    }
  }
  return [...blocked];
}

async function syncLpCommitmentToOpenInvestments(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dealId: string,
  contactId: string,
): Promise<void> {
  const contact = contactId.trim();
  if (!contact) return;
  const rows = await tx
    .select()
    .from(dealInvestment)
    .where(
      and(
        eq(dealInvestment.dealId, dealId),
        sql`lower(${dealInvestment.contactId}) = ${contact.toLowerCase()}`,
      ),
    );
  let total = 0;
  for (const row of rows) {
    if (isRetiredDealInvestment(row)) continue;
    if (!isLpInvestorRole(row.investor_role)) continue;
    total += committedNumericFromDealInvestmentRow(row);
  }
  const stored =
    !Number.isFinite(total) || total <= 0
      ? "0"
      : String(Math.round(total * 100) / 100);
  await tx
    .update(dealLpInvestor)
    .set({ committed_amount: stored, updatedAt: new Date() })
    .where(
      and(
        eq(dealLpInvestor.dealId, dealId),
        sql`lower(${dealLpInvestor.contactMemberId}) = ${contact.toLowerCase()}`,
        isNull(dealLpInvestor.removedAt),
      ),
    );
}

async function applyMutation(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dealId: string,
  plan: RemovalPlan,
  mutation: RemovalMutation,
): Promise<void> {
  const now = new Date();
  if (mutation.type === "soft_delete_investment") {
    const updated = await tx
      .update(dealInvestment)
      .set({
        status: REMOVED_INVESTMENT_STATUS,
        removedAt: now,
        removedByUserId: plan.actorUserId,
        removalReason: plan.reason,
        removalAction: plan.action,
      })
      .where(
        and(
          eq(dealInvestment.id, mutation.id),
          eq(dealInvestment.dealId, dealId),
          isNull(dealInvestment.removedAt),
        ),
      )
      .returning({ id: dealInvestment.id });
    if (updated.length !== 1) {
      throw new InvestorRemovalError(
        "This investment changed before it could be removed.",
        409,
      );
    }
    return;
  }
  if (mutation.type === "release_investment_commitment") {
    const updated = await tx
      .update(dealInvestment)
      .set({
        status: REMOVED_INVESTMENT_STATUS,
      })
      .where(
        and(eq(dealInvestment.id, mutation.id), eq(dealInvestment.dealId, dealId)),
      )
      .returning({ id: dealInvestment.id });
    if (updated.length !== 1) {
      throw new InvestorRemovalError(
        "This investment changed before its committed amount could be removed.",
        409,
      );
    }
    return;
  }
  if (mutation.type === "unlink_investor") {
    const updated = await tx
      .update(dealInvestment)
      .set({
        investorUnlinkedAt: now,
        investorUnlinkedByUserId: plan.actorUserId,
        investorUnlinkReason: plan.reason,
      })
      .where(
        and(
          eq(dealInvestment.id, mutation.id),
          eq(dealInvestment.dealId, dealId),
          isNull(dealInvestment.investorUnlinkedAt),
        ),
      )
      .returning({ id: dealInvestment.id });
    if (updated.length !== 1) {
      throw new InvestorRemovalError(
        "This investor changed before the association could be removed.",
        409,
      );
    }
    return;
  }
  if (mutation.type === "soft_delete_lp") {
    const updated = await tx
      .update(dealLpInvestor)
      .set({
        removedAt: now,
        removedByUserId: plan.actorUserId,
        removalReason: plan.reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(dealLpInvestor.id, mutation.id),
          eq(dealLpInvestor.dealId, dealId),
          isNull(dealLpInvestor.removedAt),
        ),
      )
      .returning({ id: dealLpInvestor.id });
    if (updated.length !== 1) {
      throw new InvestorRemovalError(
        "This investor changed before the association could be removed.",
        409,
      );
    }
    return;
  }
  if (mutation.type === "clear_lp_soft_commitment") {
    const updated = await tx
      .update(dealLpInvestor)
      .set({ committed_amount: "", updatedAt: now })
      .where(
        and(
          eq(dealLpInvestor.id, mutation.id),
          eq(dealLpInvestor.dealId, dealId),
          isNull(dealLpInvestor.removedAt),
        ),
      )
      .returning({ id: dealLpInvestor.id });
    if (updated.length !== 1) {
      throw new InvestorRemovalError(
        "The sponsor soft commitment changed before it could be updated.",
        409,
      );
    }
    return;
  }
  const deleted = await tx
    .delete(dealMember)
    .where(and(eq(dealMember.id, mutation.id), eq(dealMember.dealId, dealId)))
    .returning({ id: dealMember.id });
  if (deleted.length !== 1) {
    throw new InvestorRemovalError(
      "This investor's deal role changed before it could be removed.",
      409,
    );
  }
}

export async function removeInvestorOrInvestment(params: {
  dealId: string;
  rowId: string;
  actorUserId: string;
  action: RemovalAction;
  reason: string;
  confirmed: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const dealId = params.dealId.trim();
  const rowId = params.rowId.trim();
  const actorUserId = params.actorUserId.trim();
  if (!dealId || !rowId) {
    return { ok: false, status: 400, message: "Missing deal id or row id." };
  }

  try {
    const [investment] = await db
      .select()
      .from(dealInvestment)
      .where(and(eq(dealInvestment.id, rowId), eq(dealInvestment.dealId, dealId)))
      .limit(1);

    let lpRow: DealLpInvestorRow | undefined;
    let target: { kind: "investment" | "lp"; id: string };
    if (investment) {
      target = { kind: "investment", id: investment.id };
    } else {
      const [lp] = await db
        .select()
        .from(dealLpInvestor)
        .where(and(eq(dealLpInvestor.id, rowId), eq(dealLpInvestor.dealId, dealId)))
        .limit(1);
      if (!lp) {
        return { ok: false, status: 404, message: "Investor or investment not found." };
      }
      lpRow = lp;
      target = { kind: "lp", id: lp.id };
    }

    const contactId = (investment?.contactId ?? lpRow?.contactMemberId ?? "").trim();
    const contactInvestments = contactId
      ? await db
          .select()
          .from(dealInvestment)
          .where(
            and(
              eq(dealInvestment.dealId, dealId),
              eq(dealInvestment.contactId, contactId),
            ),
          )
      : [];
    const investmentsForPlan =
      investment && !contactInvestments.some((row) => row.id === investment.id)
        ? [investment, ...contactInvestments]
        : contactInvestments;

    const coSponsorOwned = await leadOrAdminRemovingCoSponsorInvestor({
      dealId,
      actorUserId,
      contactId,
      rowId: lpRow?.id ?? rowId,
    });
    if (coSponsorOwned) {
      return {
        ok: false,
        status: 403,
        message: CO_SPONSOR_INVESTOR_REMOVAL_MESSAGE,
      };
    }

    const [contactLp, contactMember, moneyIds, leads, deletedByName] =
      await Promise.all([
        lpRow
          ? Promise.resolve([lpRow])
          : contactId
            ? db
                .select()
                .from(dealLpInvestor)
                .where(
                  and(
                    eq(dealLpInvestor.dealId, dealId),
                    eq(dealLpInvestor.contactMemberId, contactId),
                  ),
                )
                .limit(1)
            : Promise.resolve([] as DealLpInvestorRow[]),
        contactId
          ? db
              .select()
              .from(dealMember)
              .where(
                and(
                  eq(dealMember.dealId, dealId),
                  eq(dealMember.contactMemberId, contactId),
                ),
              )
              .limit(1)
          : Promise.resolve([]),
        investmentIdsWithMoney(investmentsForPlan.map((row) => row.id)),
        leadSponsorContactKeysForDeal(dealId),
        actorName(actorUserId),
      ]);

    const investments = investmentsForPlan.map(toInvestment);
    const money = new Set(moneyIds);

    const lp = contactLp[0] ? toLp(contactLp[0]) : null;
    const member = contactMember[0] ? toMember(contactMember[0]) : null;
    const planned = planInvestorRemoval({
      action: params.action,
      reason: params.reason,
      confirmed: params.confirmed,
      actorUserId,
      removedName:
        investment?.contactDisplayName?.trim() ||
        lpRow?.investorName?.trim() ||
        contactLp[0]?.investorName?.trim() ||
        "",
      removedRole:
        investment?.investor_role?.trim() ||
        lpRow?.role?.trim() ||
        contactLp[0]?.role?.trim() ||
        String(member?.previous.dealMemberRole ?? "") ||
        "",
      target,
      investments,
      lp,
      member,
      investmentIdsWithMoney: [...money].filter(
        (id): id is string => typeof id === "string",
      ),
    });
    if (!planned.ok) return planned;

    if (
      blocksLastLeadSponsorRemoval({
        deletesRosterMember: planned.plan.mutations.some(
          (item) => item.type === "delete_roster_member",
        ),
        contactId: planned.plan.removedContactId,
        leadContactIds: [...leads],
      })
    ) {
      return { ok: false, status: 400, message: LEAD_SPONSOR_REQUIRED_MESSAGE };
    }

    const plan = planned.plan;
    await db.transaction(async (tx) => {
      await runRemovalUnitOfWork(
        async (work) => {
          await work();
        },
        {
          applyMutations: async () => {
            for (const mutation of plan.mutations) {
              await applyMutation(tx, dealId, plan, mutation);
            }
            if (plan.action === "remove_investment") {
              await syncLpCommitmentToOpenInvestments(
                tx,
                dealId,
                plan.removedContactId,
              );
            }
          },
          writeAudit: async () => {
            await tx.insert(dealMemberRemovalLogs).values({
              dealId,
              removedRowId: rowId,
              removedContactId: plan.removedContactId,
              removedName: plan.removedName,
              removedRole: plan.removedRole,
              deletedByUserId: actorUserId,
              deletedByName,
              removedSnapshot: plan.previousValues,
              action: plan.action,
              reason: plan.reason,
              affectedIds: plan.affectedIds,
              confirmed: true,
            });
          },
        },
      );
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof InvestorRemovalError) {
      return { ok: false, status: err.status, message: err.message };
    }
    throw err;
  }
}
