import type { Request, Response } from "express";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  assertDealIdReadableOrAssignedParticipant,
  resolveDealViewerScope,
} from "../../services/deal/dealAccess.service.js";
import { requestedOrganizationIdFromRequest } from "../../services/org/orgResolution.service.js";
import { resolveLpViewerEmailNorm } from "../../services/deal/dealLpViewerIdentity.service.js";
import { sendInvestmentCommitmentNotifications } from "../../services/deal/investmentCommitmentEmail.service.js";

function bodyString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    return bodyString(v[v.length - 1]);
  }
  if (v != null) return String(v);
  return "";
}

/**
 * POST /deals/:dealId/lp-investors/my-invest-now-commitment-complete
 * Sends the investor confirmation and sponsor notification after Finish.
 */
export async function postDealLpInvestorMyInvestNowCommitmentComplete(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId =
    typeof req.params.dealId === "string"
      ? req.params.dealId
      : req.params.dealId?.[0];
  if (!dealId?.trim()) {
    res.status(400).json({ message: "Missing deal id" });
    return;
  }

  try {
    const scope = await resolveDealViewerScope(
      user.id,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (
      !(await assertDealIdReadableOrAssignedParticipant(dealId.trim(), scope))
    ) {
      res.status(404).json({ message: "Deal not found" });
      return;
    }

    const emailNorm = await resolveLpViewerEmailNorm(user.id, user.email);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const result = await sendInvestmentCommitmentNotifications({
      dealId: dealId.trim(),
      viewerUserId: user.id,
      viewerEmailNorm: emailNorm,
      investmentId:
        bodyString(b.investment_id ?? b.investmentId).trim() || undefined,
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({
      investmentId: result.investmentId,
      investorEmailSent: result.investorEmailSent,
      sponsorEmailSent: result.sponsorEmailSent,
      investorEmailSkipped: result.investorEmailSkipped,
      sponsorEmailSkipped: result.sponsorEmailSkipped,
    });
  } catch (err) {
    console.warn("postDealLpInvestorMyInvestNowCommitmentComplete:", err);
    res.status(500).json({
      message: "Could not send investment commitment emails.",
    });
  }
}
