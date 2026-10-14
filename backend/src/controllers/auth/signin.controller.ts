import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { signInWithPassword } from "../../services/auth/auth.service.js";
import { linkPortalSessionToAuthTokens } from "../../services/auth/token.service.js";
import { startUserPortalSession } from "../../services/platform/userActivity.service.js";
import { applyInvestorInviteAfterAuth } from "../../services/contact/investorInviteLink.service.js";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { setRefreshTokenCookie } from "../../utils/authCookies.js";

type SigninBody = {
  email?: unknown;
  password?: unknown;
  inviteRef?: unknown;
};

export async function postSignin(req: Request, res: Response): Promise<void> {
  const body = req.body as SigninBody;
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email.trim()) {
    res.status(401).json({ message: "Email is required" });
    return;
  }
  if (!password) {
    res.status(401).json({ message: "Password is required" });
    return;
  }

  const result = await signInWithPassword(email, password, req);

  if (!result.ok) {
    const status =
      result.message === "An error occurred during login. Please try again."
        ? 500
        : 401;
    res.status(status).json({ message: result.message });
    return;
  }

  let activitySessionId: string | undefined;
  try {
    const userId = String(
      (result.userDetails[0] as { id?: string } | undefined)?.id ?? "",
    ).trim();
    if (userId) {
      activitySessionId = await startUserPortalSession(userId);
      if (activitySessionId) {
        await linkPortalSessionToAuthTokens(
          result.accessTokenId,
          result.refreshTokenId,
          activitySessionId,
        );
      }
    }
  } catch (err) {
    console.error("startUserPortalSession after signin:", err);
  }

  const inviteRef =
    typeof body.inviteRef === "string" ? body.inviteRef.trim() : "";
  if (inviteRef) {
    try {
      const userId = String(
        (result.userDetails[0] as { id?: string } | undefined)?.id ?? "",
      ).trim();
      if (userId) {
        const [row] = await db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            phone: users.phone,
            role: users.role,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        if (row) {
          await applyInvestorInviteAfterAuth({
            inviteRef,
            userId,
            emailNorm: String(row.email ?? "").trim().toLowerCase(),
            firstName: String(row.firstName ?? "").trim(),
            lastName: String(row.lastName ?? "").trim(),
            phone: String(row.phone ?? "").trim(),
            role: String(row.role ?? "").trim(),
          });
        }
      }
    } catch (err) {
      console.error("applyInvestorInviteAfterAuth after signin:", err);
    }
  }

  setRefreshTokenCookie(res, result.refreshToken);

  res.status(200).json({
    message: result.message,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    token: result.accessToken,
    userDetails: result.userDetails,
    ...(activitySessionId ? { activitySessionId } : {}),
  });
}
