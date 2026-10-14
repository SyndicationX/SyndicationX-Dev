import type { CoSponsorVisibleInvestorMatchKeys } from "../deal/dealLpInvestor.service.js";
import { listCoSponsorVisibleInvestorMatchKeys } from "../deal/dealLpInvestor.service.js";
import type {
  DistributionSetupBundle,
  InvestorDistributionPayment,
  PriorDistributionRecord,
} from "./distributionSetup.types.js";

export function investorPaymentVisibleToCoSponsorKeys(
  payment: Pick<
    InvestorDistributionPayment,
    "investorId" | "contactId" | "userEmail"
  >,
  keys: CoSponsorVisibleInvestorMatchKeys,
): boolean {
  const invId = String(payment.investorId ?? "")
    .trim()
    .toLowerCase();
  const contactId = String(payment.contactId ?? "")
    .trim()
    .toLowerCase();
  const email = String(payment.userEmail ?? "")
    .trim()
    .toLowerCase();
  if (invId && keys.investmentIds.has(invId)) return true;
  if (contactId && keys.contactIds.has(contactId)) return true;
  if (invId && keys.contactIds.has(invId)) return true;
  if (email.includes("@") && keys.emails.has(email)) return true;
  return false;
}

function scopePriorForCoSponsor(
  prior: PriorDistributionRecord,
  keys: CoSponsorVisibleInvestorMatchKeys,
): PriorDistributionRecord {
  const stored = prior.investorPayments;
  if (!stored?.length) return prior;
  const visible = stored.filter((p) =>
    investorPaymentVisibleToCoSponsorKeys(p, keys),
  );
  return {
    ...prior,
    investorPayments: visible,
    ...(visible.length === 0
      ? { investorPaymentsHiddenForViewer: true }
      : {}),
  };
}

/**
 * Co-sponsors see the same completed runs, but only payment lines for
 * investors they already see on the Investors tab (Sponsor name).
 * Lead / admin / unscoped viewers get the full bundle.
 */
export async function scopeDistributionSetupBundleForViewer(
  dealId: string,
  viewerUserId: string | null | undefined,
  bundle: DistributionSetupBundle,
): Promise<DistributionSetupBundle> {
  const keys = await listCoSponsorVisibleInvestorMatchKeys(
    dealId,
    viewerUserId,
  );
  if (!keys) return bundle;
  return {
    ...bundle,
    priorDistributions: bundle.priorDistributions.map((prior) =>
      scopePriorForCoSponsor(prior, keys),
    ),
  };
}

export async function coSponsorMayAccessInvestorPayment(params: {
  dealId: string;
  viewerUserId: string | null | undefined;
  investorId: string;
  contactId?: string;
  userEmail?: string;
}): Promise<boolean> {
  const keys = await listCoSponsorVisibleInvestorMatchKeys(
    params.dealId,
    params.viewerUserId,
  );
  if (!keys) return true;
  return investorPaymentVisibleToCoSponsorKeys(
    {
      investorId: params.investorId,
      ...(params.contactId ? { contactId: params.contactId } : {}),
      ...(params.userEmail ? { userEmail: params.userEmail } : {}),
    },
    keys,
  );
}
