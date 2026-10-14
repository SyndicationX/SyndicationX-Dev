import type { NextFunction, Request, Response } from "express";
import { getValidJwtUser, type JwtUserPayload } from "./jwtUser.js";

export type AuthenticatedRequest = Request & {
  portalUser?: JwtUserPayload;
};

/**
 * Requires a valid access JWT (DB-backed jti). Sets `req.portalUser` on success.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  req.portalUser = user;
  next();
}

const PUBLIC_API_ROUTES: ReadonlyArray<{
  method: string;
  path: RegExp;
}> = [
  { method: "POST", path: /^\/auth\/signin$/ },
  { method: "POST", path: /^\/auth\/refresh$/ },
  { method: "POST", path: /^\/auth\/logout$/ },
  { method: "GET", path: /^\/auth\/deal-invite\/verify$/ },
  { method: "GET", path: /^\/auth\/signup\/prefill$/ },
  { method: "POST", path: /^\/auth\/signup(?:\/[^/]+)?$/ },
  { method: "POST", path: /^\/auth\/forgot-password$/ },
  { method: "POST", path: /^\/auth\/reset-password$/ },
  { method: "GET", path: /^\/public\/company-branding\/[^/]+$/ },
  { method: "GET", path: /^\/public\/offering-preview$/ },
];

function apiPath(req: Request): string {
  const pathname = req.originalUrl.split("?")[0] ?? "/";
  const withoutPrefix = pathname.replace(/^\/api\/v1(?=\/|$)/, "");
  return withoutPrefix || "/";
}

/**
 * Authentication boundary for `/api/v1`.
 *
 * Only endpoints needed before sign-in are public. Controllers and services
 * remain responsible for role, organization, and resource-level authorization.
 */
export async function requireApiAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const method = req.method.toUpperCase();
  const path = apiPath(req);
  const isPublic = PUBLIC_API_ROUTES.some(
    (route) => route.method === method && route.path.test(path),
  );
  if (isPublic) {
    next();
    return;
  }
  await requireAuth(req, res, next);
}
