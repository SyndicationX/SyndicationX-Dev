import type { Request, Response } from "express";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  resolveDealViewerScope,
  viewerHasSyndicationDealWorkspaceAccess,
} from "../../services/deal/dealAccess.service.js";
import { getAddDealFormById } from "../../services/deal/dealForm.service.js";
import { requestedOrganizationIdFromRequest } from "../../services/org/orgResolution.service.js";
import {
  createInvestorConnectOnboardingLink,
  executeDistributionPayouts,
  getInvestorConnectStatus,
  listDistributionPayouts,
} from "../../services/payments/investorDistributionPayout.service.js";

function param(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
}

async function requireSyndicationDealAccess(
  req: Request,
  dealId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; message: string }
> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    return { ok: false, status: 401, message: "Authorization required" };
  }
  const deal = await getAddDealFormById(dealId);
  if (!deal) return { ok: false, status: 404, message: "Deal not found" };
  const scope = await resolveDealViewerScope(
    user.id,
    user.userRole,
    requestedOrganizationIdFromRequest(req),
  );
  if (!(await viewerHasSyndicationDealWorkspaceAccess(deal, scope))) {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  return { ok: true, userId: user.id };
}

/** POST /investing/profiles/:profileId/stripe-connect/onboarding */
export async function postInvestorConnectOnboarding(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const result = await createInvestorConnectOnboardingLink({
    profileId: param(req.params.profileId),
    investorUserId: user.id,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json(result);
}

/** GET /investing/profiles/:profileId/stripe-connect/status */
export async function getInvestorConnectOnboardingStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const result = await getInvestorConnectStatus({
    profileId: param(req.params.profileId),
    investorUserId: user.id,
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json(result);
}

/** POST /deals/:dealId/distributions/:distributionId/payouts */
export async function postDistributionPayouts(
  req: Request,
  res: Response,
): Promise<void> {
  const dealId = param(req.params.dealId);
  const distributionId = param(req.params.distributionId);
  const access = await requireSyndicationDealAccess(req, dealId);
  if (!access.ok) {
    res.status(access.status).json({ message: access.message });
    return;
  }
  const body =
    req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const investmentIds: string[] = [];
  const single = String(body.investmentId ?? body.investment_id ?? "").trim();
  if (single) investmentIds.push(single);
  const many = body.investmentIds ?? body.investment_ids;
  if (Array.isArray(many)) {
    for (const id of many) {
      const t = String(id ?? "").trim();
      if (t) investmentIds.push(t);
    }
  }
  const result = await executeDistributionPayouts({
    dealId,
    distributionId,
    initiatedByUserId: access.userId,
    ...(investmentIds.length ? { investmentIds } : {}),
  });
  if (!result.ok) {
    res.status(result.status).json({ message: result.message });
    return;
  }
  res.status(200).json(result);
}

/** GET /deals/:dealId/distributions/:distributionId/payouts */
export async function getDistributionPayouts(
  req: Request,
  res: Response,
): Promise<void> {
  const dealId = param(req.params.dealId);
  const distributionId = param(req.params.distributionId);
  const access = await requireSyndicationDealAccess(req, dealId);
  if (!access.ok) {
    res.status(access.status).json({ message: access.message });
    return;
  }
  const rows = await listDistributionPayouts({ dealId, distributionId });
  res.status(200).json({
    payouts: rows.map((row) => ({
      id: row.id,
      investmentId: row.investmentId,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      initiatedAt: row.initiatedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
}
