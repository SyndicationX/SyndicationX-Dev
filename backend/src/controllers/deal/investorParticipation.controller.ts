import type { Request, Response } from "express";
import { getValidJwtUser, type JwtUserPayload } from "../../middleware/jwtUser.js";
import {
  assertDealIdReadableOrAssignedParticipant,
  resolveDealViewerScope,
} from "../../services/deal/dealAccess.service.js";
import {
  deleteMySoftCommittedDeal,
  deleteMySoftCommittedProfile,
  listMyInvestorParticipation,
  setMyDealArchived,
  setMyProfileArchived,
} from "../../services/deal/investorParticipation.service.js";
import { requestedOrganizationIdFromRequest } from "../../services/org/orgResolution.service.js";

function paramString(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length > 0) return String(value[0] ?? "").trim();
  return "";
}

function bodyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return bodyString(value[value.length - 1]);
  }
  if (value != null) return String(value);
  return "";
}

function bodyArchived(value: unknown): boolean | null {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewerCanReadDeal(
  req: Request,
  user: JwtUserPayload,
  dealId: string,
): Promise<boolean> {
  if (!user.id) return false;
  const scope = await resolveDealViewerScope(
    user.id,
    user.userRole,
    requestedOrganizationIdFromRequest(req),
  );
  return assertDealIdReadableOrAssignedParticipant(dealId, scope);
}

export async function getMyInvestorParticipation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const state = await listMyInvestorParticipation(user.id);
    res.status(200).json(state);
  } catch (err) {
    console.error("getMyInvestorParticipation:", err);
    res.status(500).json({ message: "Could not load your investing deals." });
  }
}

export async function patchMyInvestorDealParticipation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId = paramString(req.params.dealId);
  if (!UUID_RE.test(dealId)) {
    res.status(400).json({ message: "Missing deal id" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const archived = bodyArchived(body.archived);
  if (archived == null) {
    res.status(400).json({ message: "Choose archive or restore." });
    return;
  }
  try {
    if (!(await viewerCanReadDeal(req, user, dealId))) {
      res.status(404).json({ message: "Deal not found" });
      return;
    }
    const result = await setMyDealArchived({
      userId: user.id,
      dealId,
      archived,
      reason: bodyString(body.reason),
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({
      ok: true,
      archived,
      sponsorNotified: result.sponsorNotified,
    });
  } catch (err) {
    console.error("patchMyInvestorDealParticipation:", err);
    res.status(500).json({ message: "Could not update this deal." });
  }
}

export async function deleteMyInvestorDealParticipation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId = paramString(req.params.dealId);
  if (!UUID_RE.test(dealId)) {
    res.status(400).json({ message: "Missing deal id" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    if (!(await viewerCanReadDeal(req, user, dealId))) {
      res.status(404).json({ message: "Deal not found" });
      return;
    }
    const result = await deleteMySoftCommittedDeal({
      userId: user.id,
      dealId,
      reason: bodyString(body.reason),
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({ ok: true, sponsorNotified: result.sponsorNotified });
  } catch (err) {
    console.error("deleteMyInvestorDealParticipation:", err);
    res.status(500).json({ message: "Could not delete this soft commitment." });
  }
}

export async function patchMyInvestorProfileParticipation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId = paramString(req.params.dealId);
  const investmentId = paramString(req.params.investmentId);
  if (!UUID_RE.test(dealId) || !UUID_RE.test(investmentId)) {
    res.status(400).json({ message: "Missing deal or profile." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const archived = bodyArchived(body.archived);
  if (archived == null) {
    res.status(400).json({ message: "Choose archive or restore." });
    return;
  }
  try {
    if (!(await viewerCanReadDeal(req, user, dealId))) {
      res.status(404).json({ message: "Deal not found" });
      return;
    }
    const result = await setMyProfileArchived({
      userId: user.id,
      dealId,
      investmentId,
      archived,
      reason: bodyString(body.reason),
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({
      ok: true,
      archived,
      sponsorNotified: result.sponsorNotified,
    });
  } catch (err) {
    console.error("patchMyInvestorProfileParticipation:", err);
    res.status(500).json({ message: "Could not update this profile." });
  }
}

export async function deleteMyInvestorProfileParticipation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId = paramString(req.params.dealId);
  const investmentId = paramString(req.params.investmentId);
  if (!UUID_RE.test(dealId) || !UUID_RE.test(investmentId)) {
    res.status(400).json({ message: "Missing deal or profile." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    if (!(await viewerCanReadDeal(req, user, dealId))) {
      res.status(404).json({ message: "Deal not found" });
      return;
    }
    const result = await deleteMySoftCommittedProfile({
      userId: user.id,
      dealId,
      investmentId,
      reason: bodyString(body.reason),
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({ ok: true, sponsorNotified: result.sponsorNotified });
  } catch (err) {
    console.error("deleteMyInvestorProfileParticipation:", err);
    res.status(500).json({ message: "Could not delete this profile." });
  }
}
