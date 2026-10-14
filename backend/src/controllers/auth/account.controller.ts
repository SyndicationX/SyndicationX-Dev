import type { Request, Response } from "express";
import { getValidJwtUser } from "../../middleware/jwtUser.js";
import {
  changePasswordForUser,
  getOwnProfile,
  parseVisibleToUsersFlag,
  updateOwnProfile,
} from "../../services/auth/account.service.js";
import { grantOfferingPreviewInvestorAccess } from "../../services/deal/offeringPreviewInvestorAccess.service.js";

export async function getMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const jwtUser = await getValidJwtUser(req);
    if (!jwtUser?.id) {
      res.status(401).json({ message: "Authorization required" });
      return;
    }
    const result = await getOwnProfile(jwtUser.id);
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json({ user: result.user });
  } catch (err) {
    console.error("getMyProfile:", err);
    res.status(500).json({
      message: "Could not load profile. Please try again.",
    });
  }
}

export async function postOfferingPreviewAccessClaim(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const jwtUser = await getValidJwtUser(req);
    if (!jwtUser?.id) {
      res.status(401).json({ message: "Authorization required" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const previewToken =
      typeof body.previewToken === "string"
        ? body.previewToken
        : typeof body.preview === "string"
          ? body.preview
          : "";
    const sponsorRef =
      typeof body.sponsorRef === "string"
        ? body.sponsorRef
        : typeof body.offeringPreviewSponsorRef === "string"
          ? body.offeringPreviewSponsorRef
          : "";
    const result = await grantOfferingPreviewInvestorAccess({
      userId: jwtUser.id,
      previewToken,
      sponsorRef,
    });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }

    const profile = await getOwnProfile(jwtUser.id);
    res.status(200).json({
      dealId: result.dealId,
      ...(profile.ok ? { userDetails: [profile.user] } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("OFFERING_PREVIEW_SECRET")) {
      res.status(503).json({ message: "Preview links are not configured." });
      return;
    }
    console.error("postOfferingPreviewAccessClaim:", err);
    res.status(500).json({
      message: "Could not add this offering to your account.",
    });
  }
}

export async function postChangePassword(req: Request, res: Response): Promise<void> {
  try {
    const jwtUser = await getValidJwtUser(req);
    if (!jwtUser?.id) {
      res.status(401).json({ message: "Authorization required" });
      return;
    }

    const body = req.body as {
      currentPassword?: unknown;
      newPassword?: unknown;
    };
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    const result = await changePasswordForUser(
      jwtUser.id,
      currentPassword,
      newPassword,
    );

    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }

    res.status(200).json({
      message: "Password updated",
      user: result.user,
    });
  } catch (err) {
    console.error("postChangePassword:", err);
    res.status(500).json({
      message: "Could not change password. Please try again.",
    });
  }
}

export async function patchMyProfile(req: Request, res: Response): Promise<void> {
  try {
    const jwtUser = await getValidJwtUser(req);
    if (!jwtUser?.id) {
      res.status(401).json({ message: "Authorization required" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: {
      firstName?: string;
      lastName?: string;
      phone?: string;
      companyName?: string;
      username?: string;
      visibleToUsers?: boolean;
      startSyndicating?: boolean;
    } = {};
    if (typeof body.firstName === "string") patch.firstName = body.firstName;
    if (typeof body.lastName === "string") patch.lastName = body.lastName;
    if (typeof body.phone === "string") patch.phone = body.phone;
    if (typeof body.companyName === "string") patch.companyName = body.companyName;
    if (typeof body.username === "string") patch.username = body.username;
    if (typeof body.userName === "string" && patch.username === undefined) {
      patch.username = body.userName;
    }
    const visibleToUsers = parseVisibleToUsersFlag(
      body.visibleToUsers ?? body.visible_to_users,
    );
    if (visibleToUsers !== undefined) patch.visibleToUsers = visibleToUsers;
    const startSyndicating = parseVisibleToUsersFlag(
      body.startSyndicating ?? body.start_syndicating,
    );
    if (startSyndicating !== undefined) patch.startSyndicating = startSyndicating;

    const result = await updateOwnProfile(jwtUser.id, patch);

    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }

    res.status(200).json({
      message: "Profile updated",
      user: result.user,
      joinedExistingCompany: result.joinedExistingCompany,
      startedSyndicating: result.startedSyndicating,
    });
  } catch (err) {
    console.error("patchMyProfile:", err);
    res.status(500).json({
      message: "Could not update profile. Please try again.",
    });
  }
}
