import type { Request, Response } from "express";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  COMPANY_USER,
  DEAL_PARTICIPANT,
  LEGACY_USER,
  PLATFORM_USER,
  isCompanyAdminRole,
  isPlatformAdminRole,
} from "../../constants/roles.js";
import { viewerIsDealSponsorOnAnyDeal } from "../../services/deal/dealMemberScope.service.js";
import { listDealIdsFromSponsorDealMemberForEmail } from "../../services/investing/lpInvestorAccess.service.js";
import {
  FEEDBACK_STATUS_PENDING,
  FEEDBACK_STATUS_REVIEWED,
  FEEDBACK_STATUS_RESOLVED,
  type FeedbackReviewAction,
  type FeedbackStatus,
} from "../../schema/feedback.schema.js";
import {
  countFeedbackByStatus,
  countPendingFeedback,
  countPendingFeedbackForUser,
  createUserFeedback,
  displayNameFromUser,
  ensureFeedbackPageCatalog,
  getFeedbackForViewer,
  getUserById,
  listFeedbackAlertsForUser,
  listFeedbackForAdmin,
  listFeedbackPageForAdmin,
  listMyFeedback,
  listMyFeedbackPage,
  replaceFeedbackPageCatalog,
  reviewUserFeedback,
  setUserFeedbackPriority,
  setUserFeedbackType,
  updateUserFeedback,
  type FeedbackPageCatalogItem,
} from "../../services/feedback/feedback.service.js";
import { pageEnvelope, parsePageQuery } from "../../common/pagination.js";

function actorRole(
  actor: { role: string | null },
  jwt: { userRole?: string },
): string {
  return String(actor.role ?? "").trim() || String(jwt.userRole ?? "").trim();
}

async function requireActor(req: Request, res: Response) {
  const jwtUser = await getValidJwtUser(req);
  if (!jwtUser?.id) {
    res.status(401).json({ message: "Authorization required" });
    return null;
  }
  const actor = await getUserById(jwtUser.id);
  if (!actor) {
    res.status(401).json({ message: "User not found" });
    return null;
  }
  return { jwtUser, actor };
}

async function actorMayUseFeedback(
  actor: { role: string | null; email?: string | null },
  jwtUser: { userRole?: string; email?: string },
): Promise<boolean> {
  const role = actorRole(actor, jwtUser);
  if (isPlatformAdminRole(role) || isCompanyAdminRole(role)) return true;
  if (role === COMPANY_USER || role === PLATFORM_USER || role === LEGACY_USER) {
    return true;
  }
  if (role === DEAL_PARTICIPANT) {
    const email = String(actor.email ?? jwtUser.email ?? "")
      .trim()
      .toLowerCase();
    const deals = await listDealIdsFromSponsorDealMemberForEmail(email);
    return deals.length > 0;
  }
  return false;
}

async function requireFeedbackUser(req: Request, res: Response) {
  const ctx = await requireActor(req, res);
  if (!ctx) return null;
  if (await actorMayUseFeedback(ctx.actor, ctx.jwtUser)) return ctx;
  res.status(403).json({ message: "Not allowed" });
  return null;
}

function parseStatus(raw: unknown): FeedbackStatus | undefined {
  const s = String(raw ?? "").trim();
  if (
    s === FEEDBACK_STATUS_PENDING ||
    s === FEEDBACK_STATUS_REVIEWED ||
    s === FEEDBACK_STATUS_RESOLVED
  ) {
    return s;
  }
  return undefined;
}

function parseReviewAction(raw: unknown): FeedbackReviewAction | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "reviewed" || s === "resolved") return s;
  return null;
}

/**
 * GET /feedback/catalog — pages and editable sub-pages for the feedback form.
 */
export async function getFeedbackCatalogHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;
  try {
    const pages = await ensureFeedbackPageCatalog();
    res.status(200).json({ pages });
  } catch (err) {
    console.error("getFeedbackCatalogHandler:", err);
    res.status(500).json({ message: "Could not load feedback pages" });
  }
}

/**
 * PUT /feedback/catalog — platform admin updates page / sub-page options.
 */
export async function putFeedbackCatalogHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  if (!isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  const body = req.body as { pages?: unknown };
  if (!Array.isArray(body.pages)) {
    res.status(400).json({ message: "pages is required" });
    return;
  }

  try {
    const pages = await replaceFeedbackPageCatalog(
      body.pages as FeedbackPageCatalogItem[],
    );
    res.status(200).json({ pages });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not save page options";
    res.status(400).json({ message });
  }
}

/**
 * POST /feedback — authenticated user submits feedback (status Pending).
 */
export async function postFeedbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;

  const body = req.body as Record<string, unknown>;
  try {
    const feedback = await createUserFeedback({
      userId: ctx.actor.id,
      username: displayNameFromUser(ctx.actor),
      userEmail: String(ctx.actor.email ?? ctx.jwtUser.email ?? "")
        .trim()
        .toLowerCase(),
      pageKey: String(body.pageKey ?? "").trim(),
      subPageKey: String(body.subPageKey ?? "").trim(),
      subPageOther: String(body.subPageOther ?? "").trim(),
      description: String(body.description ?? ""),
    });
    res.status(201).json({ feedback });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not submit feedback";
    const status =
      message.startsWith("Select") ||
      message.startsWith("Enter") ||
      message.includes("required")
        ? 400
        : 500;
    if (status === 500) console.error("postFeedbackHandler:", err);
    res.status(status).json({ message });
  }
}

/**
 * GET /feedback/pending-count — sidebar badge.
 * Platform admin: all pending. Other feedback users: their own pending.
 */
export async function getPendingFeedbackCountHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;
  try {
    const pendingCount = isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))
      ? await countPendingFeedback()
      : await countPendingFeedbackForUser(ctx.actor.id);
    res.status(200).json({ pendingCount });
  } catch (err) {
    console.error("getPendingFeedbackCountHandler:", err);
    res.status(500).json({ message: "Could not load pending count" });
  }
}

/**
 * PATCH /feedback/:id — submitter edits their own feedback while it is still Pending.
 */
export async function patchFeedbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;
  if (isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }
  if (!(await viewerIsDealSponsorOnAnyDeal(ctx.actor.id))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  const feedbackId = String(req.params.id ?? "").trim();
  if (!feedbackId) {
    res.status(400).json({ message: "Feedback id is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  try {
    const feedback = await updateUserFeedback({
      feedbackId,
      userId: ctx.actor.id,
      pageKey: String(body.pageKey ?? "").trim(),
      subPageKey: String(body.subPageKey ?? "").trim(),
      subPageOther: String(body.subPageOther ?? "").trim(),
      description: String(body.description ?? ""),
    });
    res.status(200).json({ feedback });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not update feedback";
    const status =
      message === "Feedback not found"
        ? 404
        : message === "Not allowed" ||
            message === "This feedback can no longer be edited"
          ? 403
          : message.startsWith("Select") ||
              message.startsWith("Enter") ||
              message.includes("required")
            ? 400
            : 500;
    if (status === 500) console.error("patchFeedbackHandler:", err);
    res.status(status).json({ message });
  }
}

/**
 * PATCH /feedback/:id/priority — platform admin sets P0–P3.
 */
export async function patchFeedbackPriorityHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  if (!isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  const feedbackId = String(req.params.id ?? "").trim();
  if (!feedbackId) {
    res.status(400).json({ message: "Feedback id is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  try {
    const feedback = await setUserFeedbackPriority({
      feedbackId,
      priority: body.priority,
    });
    res.status(200).json({ feedback });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not update priority";
    const status =
      message === "Feedback not found"
        ? 404
        : message.startsWith("Select")
          ? 400
          : 500;
    if (status === 500) console.error("patchFeedbackPriorityHandler:", err);
    res.status(status).json({ message });
  }
}

/**
 * PATCH /feedback/:id/type — platform admin sets Feature Request / Bug Report / Change Request.
 */
export async function patchFeedbackTypeHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  if (!isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  const feedbackId = String(req.params.id ?? "").trim();
  if (!feedbackId) {
    res.status(400).json({ message: "Feedback id is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  try {
    const feedback = await setUserFeedbackType({
      feedbackId,
      feedbackType: body.feedbackType ?? body.type,
    });
    res.status(200).json({ feedback });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not update feedback type";
    const status =
      message === "Feedback not found"
        ? 404
        : message.startsWith("Select")
          ? 400
          : 500;
    if (status === 500) console.error("patchFeedbackTypeHandler:", err);
    res.status(status).json({ message });
  }
}

/**
 * GET /feedback — platform admin lists all feedback.
 */
export async function getFeedbackListHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  if (!isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  try {
    const status = parseStatus(req.query.status);
    const pageQuery = parsePageQuery(req, { defaultSortId: "createdAt" });
    if (!pageQuery.paginated) {
      const items = await listFeedbackForAdmin(status);
      res.status(200).json({ items, ...pageEnvelope(pageQuery, items.length) });
      return;
    }
    const [{ rows, total }, counts] = await Promise.all([
      listFeedbackPageForAdmin({
        status,
        search: pageQuery.search,
        sortId: pageQuery.sortId,
        sortDir: pageQuery.sortDir,
        limit: pageQuery.pageSize,
        offset: pageQuery.offset,
      }),
      countFeedbackByStatus(pageQuery.search),
    ]);
    res
      .status(200)
      .json({ items: rows, counts, ...pageEnvelope(pageQuery, total) });
  } catch (err) {
    console.error("getFeedbackListHandler:", err);
    res.status(500).json({ message: "Could not load feedback" });
  }
}

/**
 * GET /feedback/mine — the signed-in user's own submissions.
 */
export async function getMyFeedbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;
  try {
    const pageQuery = parsePageQuery(req, { defaultSortId: "createdAt" });
    if (!pageQuery.paginated) {
      const items = await listMyFeedback(ctx.actor.id);
      res.status(200).json({ items, ...pageEnvelope(pageQuery, items.length) });
      return;
    }
    const { rows, total } = await listMyFeedbackPage({
      userId: ctx.actor.id,
      search: pageQuery.search,
      sortId: pageQuery.sortId,
      sortDir: pageQuery.sortDir,
      limit: pageQuery.pageSize,
      offset: pageQuery.offset,
    });
    res.status(200).json({ items: rows, ...pageEnvelope(pageQuery, total) });
  } catch (err) {
    console.error("getMyFeedbackHandler:", err);
    res.status(500).json({ message: "Could not load feedback" });
  }
}

/**
 * GET /feedback/item/:id — submitter or platform admin.
 */
export async function getFeedbackItemHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  const feedbackId = String(req.params.id ?? "").trim();
  if (!feedbackId) {
    res.status(400).json({ message: "Feedback id is required" });
    return;
  }
  try {
    const feedback = await getFeedbackForViewer(
      feedbackId,
      ctx.actor.id,
      isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser)),
    );
    if (!feedback) {
      res.status(404).json({ message: "Feedback not found" });
      return;
    }
    res.status(200).json({ feedback });
  } catch (err) {
    console.error("getFeedbackItemHandler:", err);
    res.status(500).json({ message: "Could not load feedback" });
  }
}

/**
 * GET /feedback/my-alerts — notification source for submitter and platform admins.
 */
export async function getMyFeedbackAlertsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireFeedbackUser(req, res);
  if (!ctx) return;
  try {
    const items = await listFeedbackAlertsForUser({
      userId: ctx.actor.id,
      isPlatformAdmin: isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser)),
    });
    res.status(200).json({ items });
  } catch (err) {
    console.error("getMyFeedbackAlertsHandler:", err);
    res.status(500).json({ message: "Could not load feedback alerts" });
  }
}

/**
 * POST /feedback/:id/review — platform admin marks feedback Reviewed or Resolved.
 */
export async function postReviewFeedbackHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const ctx = await requireActor(req, res);
  if (!ctx) return;
  if (!isPlatformAdminRole(actorRole(ctx.actor, ctx.jwtUser))) {
    res.status(403).json({ message: "Not allowed" });
    return;
  }

  const feedbackId = String(req.params.id ?? "").trim();
  if (!feedbackId) {
    res.status(400).json({ message: "Feedback id is required" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const action = parseReviewAction(body.action ?? body.status);
  if (!action) {
    res.status(400).json({ message: "Select Mark as Reviewed or Mark as Resolved" });
    return;
  }

  try {
    const feedback = await reviewUserFeedback({
      feedbackId,
      reviewerUserId: ctx.actor.id,
      reviewerName: displayNameFromUser(ctx.actor),
      action,
      adminResponse: String(body.adminResponse ?? body.resolutionNotes ?? ""),
    });
    res.status(200).json({ feedback });
  } catch (err) {
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : "Could not review feedback";
    const status =
      message === "Feedback not found"
        ? 404
        : message.startsWith("Enter") || message.includes("too long")
          ? 400
          : 500;
    if (status === 500) console.error("postReviewFeedbackHandler:", err);
    res.status(status).json({ message });
  }
}
