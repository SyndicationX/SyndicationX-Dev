import type { NextFunction, Request, Response } from "express";
import { getValidJwtUser } from "./jwtUser.js";
import { viewerHasCrossOrgColleagueViewOnlyAccess } from "../services/deal/crossOrgColleagueDeal.service.js";

const DEAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Investor actions on their own commitment stay open. Syndication management does not. */
function isInvestorSelfServicePath(path: string): boolean {
  return /\/my-[a-z0-9-]+/i.test(path);
}

/**
 * Org syndicators may open a peer's deal from another organization, but only
 * the sponsor on that deal can change it.
 */
export async function blockCrossOrgColleagueDealMutations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS"
  ) {
    next();
    return;
  }
  const path = `${req.originalUrl || ""} ${req.path || ""}`;
  if (isInvestorSelfServicePath(path)) {
    next();
    return;
  }
  const rawId = req.params.dealId;
  const dealId = typeof rawId === "string" ? rawId.trim() : "";
  // `/deals/esign-templates/*` also passes through the parameterized router
  // prefix. It is not a deal id and must not trigger cross-org deal lookups.
  if (!DEAL_UUID_RE.test(dealId)) {
    next();
    return;
  }
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    next();
    return;
  }
  if (
    await viewerHasCrossOrgColleagueViewOnlyAccess(
      dealId,
      user.id,
      user.userRole,
    )
  ) {
    res.status(403).json({
      message: "You can view this deal. Only the sponsor can make changes.",
    });
    return;
  }
  next();
}
