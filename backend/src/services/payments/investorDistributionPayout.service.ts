import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "../../database/db.js";
import { resolveFrontendOrigin } from "../../config/stripe.config.js";
import {
  dealInvestment,
  investorDistributionPayouts,
  userInvestorProfiles,
  users,
} from "../../schema/schema.js";
import { getStripeClient } from "../billing/companyBilling.service.js";
import { getDistributionSetupBundle } from "../distributionSetup/distributionSetup.service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return UUID_RE.test(value) ? value : null;
}

function payoutStatusForAccount(account: Stripe.Account): string {
  if (account.payouts_enabled && account.details_submitted) return "ready";
  if (account.requirements?.disabled_reason) return "restricted";
  if (account.details_submitted) return "pending";
  return "onboarding";
}

async function syncConnectAccount(account: Stripe.Account): Promise<void> {
  await db
    .update(userInvestorProfiles)
    .set({
      stripeConnectDetailsSubmitted: Boolean(account.details_submitted),
      stripeConnectChargesEnabled: Boolean(account.charges_enabled),
      stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled),
      stripeConnectStatus: payoutStatusForAccount(account),
      stripeConnectUpdatedAt: new Date(),
    })
    .where(eq(userInvestorProfiles.stripeConnectAccountId, account.id));
}

export type ConnectOnboardingResult =
  | {
      ok: true;
      url: string;
      accountId: string;
      status: string;
      payoutsEnabled: boolean;
    }
  | { ok: false; status: number; message: string };

/** Hosted Stripe Connect onboarding for one profile owned by the signed-in user. */
export async function createInvestorConnectOnboardingLink(params: {
  profileId: string;
  investorUserId: string;
}): Promise<ConnectOnboardingResult> {
  const profileId = uuid(params.profileId);
  const userId = uuid(params.investorUserId);
  if (!profileId || !userId) {
    return { ok: false, status: 400, message: "Invalid investor profile" };
  }

  const [row] = await db
    .select({
      id: userInvestorProfiles.id,
      userId: userInvestorProfiles.userId,
      profileName: userInvestorProfiles.profileName,
      stripeConnectAccountId: userInvestorProfiles.stripeConnectAccountId,
      email: users.email,
    })
    .from(userInvestorProfiles)
    .innerJoin(users, eq(users.id, userInvestorProfiles.userId))
    .where(
      and(
        eq(userInvestorProfiles.id, profileId),
        eq(userInvestorProfiles.userId, userId),
      ),
    )
    .limit(1);
  if (!row) {
    return { ok: false, status: 404, message: "Investor profile not found" };
  }

  const frontend = resolveFrontendOrigin();
  if (!frontend) {
    return {
      ok: false,
      status: 503,
      message: "BASE_URL must be configured for Stripe Connect onboarding.",
    };
  }

  const stripe = getStripeClient();
  try {
    let accountId = row.stripeConnectAccountId?.trim() || "";
    let account: Stripe.Account;
    if (!accountId) {
      account = await stripe.accounts.create(
        {
          type: "express",
          country: "US",
          email: row.email,
          capabilities: {
            transfers: { requested: true },
          },
          business_profile: {
            product_description:
              "Investor distributions from private investment offerings",
          },
          metadata: {
            flow: "investor_distribution_recipient",
            investorUserId: userId,
            userInvestorProfileId: profileId,
          },
        },
        { idempotencyKey: `investor_connect_${profileId}` },
      );
      accountId = account.id;
      await db
        .update(userInvestorProfiles)
        .set({
          stripeConnectAccountId: accountId,
          stripeConnectStatus: payoutStatusForAccount(account),
          stripeConnectDetailsSubmitted: Boolean(account.details_submitted),
          stripeConnectChargesEnabled: Boolean(account.charges_enabled),
          stripeConnectPayoutsEnabled: Boolean(account.payouts_enabled),
          stripeConnectUpdatedAt: new Date(),
        })
        .where(eq(userInvestorProfiles.id, profileId));
    } else {
      account = await stripe.accounts.retrieve(accountId);
      await syncConnectAccount(account);
    }

    const encodedProfile = encodeURIComponent(profileId);
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${frontend}/investing/profiles?stripe_connect=refresh&profile_id=${encodedProfile}`,
      return_url: `${frontend}/investing/profiles?stripe_connect=return&profile_id=${encodedProfile}`,
      collection_options: {
        fields: "eventually_due",
        future_requirements: "include",
      },
    });

    return {
      ok: true,
      url: link.url,
      accountId,
      status: payoutStatusForAccount(account),
      payoutsEnabled: Boolean(account.payouts_enabled),
    };
  } catch (err) {
    console.error("createInvestorConnectOnboardingLink:", err);
    return {
      ok: false,
      status: 502,
      message:
        err instanceof Error
          ? err.message
          : "Could not start Stripe Connect onboarding",
    };
  }
}

export async function getInvestorConnectStatus(params: {
  profileId: string;
  investorUserId: string;
}): Promise<
  | {
      ok: true;
      accountId: string | null;
      status: string;
      detailsSubmitted: boolean;
      payoutsEnabled: boolean;
    }
  | { ok: false; status: number; message: string }
> {
  const profileId = uuid(params.profileId);
  const userId = uuid(params.investorUserId);
  if (!profileId || !userId) {
    return { ok: false, status: 400, message: "Invalid investor profile" };
  }
  const [profile] = await db
    .select()
    .from(userInvestorProfiles)
    .where(
      and(
        eq(userInvestorProfiles.id, profileId),
        eq(userInvestorProfiles.userId, userId),
      ),
    )
    .limit(1);
  if (!profile) {
    return { ok: false, status: 404, message: "Investor profile not found" };
  }

  const accountId = profile.stripeConnectAccountId?.trim() || null;
  if (!accountId) {
    return {
      ok: true,
      accountId: null,
      status: "not_started",
      detailsSubmitted: false,
      payoutsEnabled: false,
    };
  }

  try {
    const account = await getStripeClient().accounts.retrieve(accountId);
    await syncConnectAccount(account);
    return {
      ok: true,
      accountId,
      status: payoutStatusForAccount(account),
      detailsSubmitted: Boolean(account.details_submitted),
      payoutsEnabled: Boolean(account.payouts_enabled),
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message:
        err instanceof Error
          ? err.message
          : "Could not retrieve Stripe Connect status",
    };
  }
}

type PayoutLineResult = {
  investmentId: string;
  investorName: string;
  amountCents: number;
  status: string;
  message?: string;
};

export type ExecuteDistributionPayoutsResult =
  | {
      ok: true;
      results: PayoutLineResult[];
      initiated: number;
      skipped: number;
      failed: number;
    }
  | { ok: false; status: number; message: string };

/**
 * Transfers each distribution line to its investor's connected account, then
 * creates a standard ACH payout from that account to its verified bank.
 * Pass `investmentIds` to pay one (or a subset of) investor lines.
 */
export async function executeDistributionPayouts(params: {
  dealId: string;
  distributionId: string;
  initiatedByUserId: string;
  /** When set, only these investment / investor line ids are paid. */
  investmentIds?: string[];
}): Promise<ExecuteDistributionPayoutsResult> {
  const dealId = uuid(params.dealId);
  const initiatedByUserId = uuid(params.initiatedByUserId);
  const distributionId = String(params.distributionId ?? "").trim();
  if (!dealId || !initiatedByUserId || !distributionId) {
    return {
      ok: false,
      status: 400,
      message: "Invalid deal, distribution, or initiating user.",
    };
  }

  const onlyInvestmentIds = new Set(
    (params.investmentIds ?? [])
      .map((id) => uuid(id))
      .filter((id): id is string => Boolean(id)),
  );
  if ((params.investmentIds?.length ?? 0) > 0 && onlyInvestmentIds.size === 0) {
    return {
      ok: false,
      status: 400,
      message: "Invalid investment id for payout.",
    };
  }

  const bundle = await getDistributionSetupBundle(dealId);
  const distribution = bundle?.priorDistributions.find(
    (row) => row.id === distributionId,
  );
  if (!bundle || !distribution) {
    return { ok: false, status: 404, message: "Distribution not found" };
  }
  if (!distribution.investorPayments?.length) {
    return {
      ok: false,
      status: 409,
      message: "This distribution has no persisted investor payment lines.",
    };
  }

  const stripe = getStripeClient();
  const results: PayoutLineResult[] = [];
  const paymentLines =
    onlyInvestmentIds.size > 0
      ? distribution.investorPayments.filter((line) => {
          const id = uuid(line.investorId);
          return id != null && onlyInvestmentIds.has(id);
        })
      : distribution.investorPayments;

  if (onlyInvestmentIds.size > 0 && paymentLines.length === 0) {
    return {
      ok: false,
      status: 404,
      message: "Investor payment line not found on this distribution.",
    };
  }

  for (const line of paymentLines) {
    const investmentId = uuid(line.investorId);
    const amount = Number(String(line.payment ?? "").replace(/[$,\s]/g, ""));
    const amountCents = Math.round(amount * 100);
    const investorName = line.investorName || "Investor";
    if (!investmentId || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      results.push({
        investmentId: line.investorId,
        investorName,
        amountCents: Math.max(0, amountCents || 0),
        status: "skipped",
        message: "Invalid investment id or payout amount.",
      });
      continue;
    }

    const [investment] = await db
      .select({
        id: dealInvestment.id,
        userInvestorProfileId: dealInvestment.userInvestorProfileId,
        profileUserId: userInvestorProfiles.userId,
        connectAccountId: userInvestorProfiles.stripeConnectAccountId,
        connectStatus: userInvestorProfiles.stripeConnectStatus,
        payoutsEnabled: userInvestorProfiles.stripeConnectPayoutsEnabled,
      })
      .from(dealInvestment)
      .leftJoin(
        userInvestorProfiles,
        eq(userInvestorProfiles.id, dealInvestment.userInvestorProfileId),
      )
      .where(
        and(
          eq(dealInvestment.id, investmentId),
          eq(dealInvestment.dealId, dealId),
        ),
      )
      .limit(1);

    const profileId = uuid(investment?.userInvestorProfileId);
    const investorUserId = uuid(investment?.profileUserId);
    const accountId = String(investment?.connectAccountId ?? "").trim();
    if (
      !investment ||
      !profileId ||
      !investorUserId ||
      !accountId ||
      !investment.payoutsEnabled
    ) {
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: "skipped",
        message:
          "Investor must complete Stripe Connect bank onboarding before payout.",
      });
      continue;
    }

    await db
      .insert(investorDistributionPayouts)
      .values({
        dealId,
        distributionId,
        investmentId,
        userInvestorProfileId: profileId,
        investorUserId,
        initiatedByUserId,
        amountCents,
        currency: "usd",
        stripeConnectedAccountId: accountId,
        status: "pending",
      })
      .onConflictDoNothing();

    const [local] = await db
      .select()
      .from(investorDistributionPayouts)
      .where(
        and(
          eq(investorDistributionPayouts.dealId, dealId),
          eq(investorDistributionPayouts.distributionId, distributionId),
          eq(investorDistributionPayouts.investmentId, investmentId),
        ),
      )
      .limit(1);
    if (!local) {
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: "failed",
        message: "Could not create the local payout record.",
      });
      continue;
    }
    if (local.status === "paid" || local.status === "processing") {
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: local.status,
      });
      continue;
    }
    if (local.amountCents !== amountCents) {
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: "failed",
        message:
          "The distribution amount changed after payout preparation. Create a new distribution run.",
      });
      continue;
    }

    const isRetry =
      local.status === "failed" ||
      local.status === "canceled" ||
      local.status === "reversed";

    try {
      let transferId =
        isRetry && local.status === "reversed"
          ? ""
          : local.stripeTransferId?.trim() || "";
      if (!transferId) {
        const transfer = await stripe.transfers.create(
          {
            amount: amountCents,
            currency: "usd",
            destination: accountId,
            transfer_group: `distribution_${distributionId}`,
            metadata: {
              flow: "investor_distribution",
              payoutRecordId: local.id,
              dealId,
              distributionId,
              investmentId,
            },
          },
          {
            idempotencyKey: isRetry
              ? `distribution_transfer_${local.id}_${local.updatedAt.getTime()}`
              : `distribution_transfer_${local.id}`,
          },
        );
        transferId = transfer.id;
        await db
          .update(investorDistributionPayouts)
          .set({
            stripeTransferId: transferId,
            status: "transferred",
            initiatedAt: new Date(),
            failureCode: null,
            failureMessage: null,
            updatedAt: new Date(),
          })
          .where(eq(investorDistributionPayouts.id, local.id));
      }

      // Failed/canceled payouts keep their Stripe id; clear so a new ACH can be created.
      let payoutId = isRetry ? "" : local.stripePayoutId?.trim() || "";
      if (!payoutId) {
        const payout = await stripe.payouts.create(
          {
            amount: amountCents,
            currency: "usd",
            method: "standard",
            metadata: {
              flow: "investor_distribution",
              payoutRecordId: local.id,
              dealId,
              distributionId,
              investmentId,
              transferId,
            },
          },
          {
            stripeAccount: accountId,
            idempotencyKey: isRetry
              ? `distribution_payout_${local.id}_${local.updatedAt.getTime()}`
              : `distribution_payout_${local.id}`,
          },
        );
        payoutId = payout.id;
      }

      await db
        .update(investorDistributionPayouts)
        .set({
          stripeTransferId: transferId,
          stripePayoutId: payoutId,
          status: "processing",
          initiatedAt: local.initiatedAt ?? new Date(),
          failureCode: null,
          failureMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(investorDistributionPayouts.id, local.id));
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: "processing",
      });
    } catch (err) {
      const stripeError = err as Stripe.errors.StripeError;
      const message =
        err instanceof Error ? err.message : "Stripe payout creation failed";
      await db
        .update(investorDistributionPayouts)
        .set({
          status: "failed",
          failureCode: stripeError?.code ?? null,
          failureMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(investorDistributionPayouts.id, local.id));
      results.push({
        investmentId,
        investorName,
        amountCents,
        status: "failed",
        message,
      });
    }
  }

  return {
    ok: true,
    results,
    initiated: results.filter((r) => r.status === "processing").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

export async function listDistributionPayouts(params: {
  dealId: string;
  distributionId: string;
}) {
  const dealId = uuid(params.dealId);
  const distributionId = String(params.distributionId ?? "").trim();
  if (!dealId || !distributionId) return [];
  return db
    .select()
    .from(investorDistributionPayouts)
    .where(
      and(
        eq(investorDistributionPayouts.dealId, dealId),
        eq(investorDistributionPayouts.distributionId, distributionId),
      ),
    );
}

/** Handles Connect account/payout events; false means unrelated event. */
export async function handleDistributionConnectWebhookEvent(
  event: Stripe.Event,
): Promise<boolean> {
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;
    const [profile] = await db
      .select({ id: userInvestorProfiles.id })
      .from(userInvestorProfiles)
      .where(eq(userInvestorProfiles.stripeConnectAccountId, account.id))
      .limit(1);
    if (!profile) return false;
    await syncConnectAccount(account);
    return true;
  }

  if (
    event.type === "payout.paid" ||
    event.type === "payout.failed" ||
    event.type === "payout.canceled"
  ) {
    const payout = event.data.object as Stripe.Payout;
    const [local] = await db
      .select()
      .from(investorDistributionPayouts)
      .where(eq(investorDistributionPayouts.stripePayoutId, payout.id))
      .limit(1);
    if (!local) return false;
    const status =
      event.type === "payout.paid"
        ? "paid"
        : event.type === "payout.canceled"
          ? "canceled"
          : "failed";
    await db
      .update(investorDistributionPayouts)
      .set({
        status,
        failureCode: payout.failure_code ?? null,
        failureMessage: payout.failure_message ?? null,
        paidAt: status === "paid" ? new Date() : local.paidAt,
        updatedAt: new Date(),
      })
      .where(eq(investorDistributionPayouts.id, local.id));
    return true;
  }

  if (event.type === "transfer.reversed") {
    const transfer = event.data.object as Stripe.Transfer;
    const [local] = await db
      .select()
      .from(investorDistributionPayouts)
      .where(eq(investorDistributionPayouts.stripeTransferId, transfer.id))
      .limit(1);
    if (!local) return false;
    await db
      .update(investorDistributionPayouts)
      .set({
        status: "reversed",
        failureMessage: "Stripe transfer was reversed.",
        updatedAt: new Date(),
      })
      .where(eq(investorDistributionPayouts.id, local.id));
    return true;
  }

  return false;
}
