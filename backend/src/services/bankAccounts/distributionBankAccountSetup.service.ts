import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database/db.js";
import { addDealForm } from "../../schema/deal.schema/add-deal-form.schema.js";
import {
  dealInvestment,
  investorDistributionPayouts,
  userInvestorProfiles,
} from "../../schema/schema.js";
import { parseDistributionSetupDocument } from "../distributionSetup/distributionSetup.mapper.js";
import { listActiveBankAccountsForUsers } from "./investorBankAccountRecords.service.js";
import {
  resolveBankAccountSetupStatus,
  type BankAccountSetupStatus,
} from "./bankAccountSetup.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DistributionBankAccountSetupLine = {
  investmentId: string;
  status: BankAccountSetupStatus;
};

function uuid(value: string): string | null {
  const t = value.trim();
  return UUID_RE.test(t) ? t : null;
}

/**
 * Per investment line: Set Up when an eligible active bank account is on file.
 * A payout already tied to one account checks that account only.
 */
export async function listDistributionBankAccountSetup(params: {
  dealId: string;
  distributionId: string;
}): Promise<DistributionBankAccountSetupLine[]> {
  const dealId = uuid(params.dealId);
  const distributionId = params.distributionId.trim();
  if (!dealId || !distributionId) return [];

  const [deal] = await db
    .select({
      distributionSetupJson: addDealForm.distributionSetupJson,
    })
    .from(addDealForm)
    .where(eq(addDealForm.id, dealId))
    .limit(1);
  const parsed = parseDistributionSetupDocument(
    deal?.distributionSetupJson ?? "{}",
  );
  const prior = (parsed.priorDistributions ?? []).find(
    (row) => row.id === distributionId,
  );
  const investmentIds = [
    ...new Set(
      (prior?.investorPayments ?? [])
        .map((line) => uuid(String(line.investorId ?? "")))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (investmentIds.length === 0) return [];

  const [investments, payouts] = await Promise.all([
    db
      .select({
        id: dealInvestment.id,
        profileId: dealInvestment.userInvestorProfileId,
        investorUserId: userInvestorProfiles.userId,
      })
      .from(dealInvestment)
      .leftJoin(
        userInvestorProfiles,
        eq(userInvestorProfiles.id, dealInvestment.userInvestorProfileId),
      )
      .where(
        and(
          eq(dealInvestment.dealId, dealId),
          inArray(dealInvestment.id, investmentIds),
        ),
      ),
    db
      .select({
        investmentId: investorDistributionPayouts.investmentId,
        accountId: investorDistributionPayouts.stripeConnectedAccountId,
        investorUserId: investorDistributionPayouts.investorUserId,
        profileId: investorDistributionPayouts.userInvestorProfileId,
      })
      .from(investorDistributionPayouts)
      .where(
        and(
          eq(investorDistributionPayouts.dealId, dealId),
          eq(investorDistributionPayouts.distributionId, distributionId),
          inArray(investorDistributionPayouts.investmentId, investmentIds),
        ),
      ),
  ]);

  const userIds = [
    ...investments.map((row) => row.investorUserId),
    ...payouts.map((row) => row.investorUserId),
  ].filter((id): id is string => Boolean(id));
  const accountsByUser = await listActiveBankAccountsForUsers(userIds);
  const investmentById = new Map(investments.map((row) => [row.id, row]));
  const payoutByInvestment = new Map(
    payouts.map((row) => [row.investmentId, row]),
  );

  return investmentIds.map((investmentId) => {
    const investment = investmentById.get(investmentId);
    const payout = payoutByInvestment.get(investmentId);
    const userId = investment?.investorUserId || payout?.investorUserId || "";
    const profileId = investment?.profileId || payout?.profileId || "";
    const accounts = userId ? (accountsByUser.get(userId) ?? []) : [];
    const associatedAccountId = payout?.accountId?.trim() || null;
    return {
      investmentId,
      status: resolveBankAccountSetupStatus({
        accounts,
        associatedAccountId,
        profileId,
      }),
    };
  });
}
