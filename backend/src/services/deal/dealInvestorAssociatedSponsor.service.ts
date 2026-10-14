import { isPortalUserSponsorOnDeal } from "./dealMemberScope.service.js";
import {
  loadRosterAddedByMaps,
  mapContactIdsToCanonicalCommitmentKeys,
  resolveDealLeadSponsorFallback,
  resolveInvestorRowAddedByUserId,
  resolveUserDisplayNamesByIds,
  resolveUserEmailsByIds,
} from "./dealInvestment.service.js";

export type DealInvestorAssociatedSponsor = {
  userId: string;
  email: string;
  name: string;
};

/**
 * Resolves the same deal-specific sponsor shown in the Investors tab
 * "Sponsor name" column. LP roster association wins over member roster;
 * signup referrers and invitation senders are intentionally not considered.
 */
export async function resolveDealInvestorAssociatedSponsor(params: {
  dealId: string;
  contactId: string;
  investmentId?: string;
  investorEmail?: string;
}): Promise<DealInvestorAssociatedSponsor | null> {
  const dealId = params.dealId.trim();
  const contactId = params.contactId.trim();
  const investorEmail = params.investorEmail?.trim().toLowerCase() ?? "";
  if (!dealId || !contactId) return null;

  const rosterMaps = await loadRosterAddedByMaps(dealId);
  const canonicalKeys = await mapContactIdsToCanonicalCommitmentKeys([
    contactId,
    ...rosterMaps.byContactKey.keys(),
  ]);
  const associatedUserId = resolveInvestorRowAddedByUserId(
    { id: params.investmentId, contactId },
    rosterMaps.byContactKey,
    rosterMaps.byLpRowId,
    canonicalKeys,
  );

  let userId = associatedUserId?.trim() ?? "";
  let fallbackName = "";
  let fallbackEmail = "";
  if (
    !userId ||
    !(await isPortalUserSponsorOnDeal(dealId, userId))
  ) {
    const lead = await resolveDealLeadSponsorFallback(dealId);
    userId = lead.userId?.trim() ?? "";
    fallbackName = lead.displayName?.trim() ?? "";
    fallbackEmail = lead.email?.trim().toLowerCase() ?? "";
  }
  if (!userId) return null;

  const key = userId.toLowerCase();
  const [names, emails] = await Promise.all([
    resolveUserDisplayNamesByIds([userId]),
    resolveUserEmailsByIds([userId]),
  ]);
  const email = (emails.get(key) ?? fallbackEmail).trim().toLowerCase();
  if (!email.includes("@") || email === investorEmail) return null;
  const name = (names.get(key) ?? fallbackName).trim() || email;
  return { userId, email, name };
}
