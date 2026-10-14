import bcrypt from "bcrypt";
import { and, eq, getTableColumns, ne, sql } from "drizzle-orm";
import { db } from "../../database/db.js";
import {
  companies,
  userCompanyMembership,
  users,
  type UserRow,
} from "../../schema/schema.js";
import { enrichUserRecordForDealParticipant } from "../deal/dealParticipantProfile.service.js";
import { mergeLpInvestorFlagsIntoUserPayload } from "../investing/lpInvestorAccess.service.js";
import { serializeUserForClient } from "../user/userAdmin.service.js";
import { parseUsPhoneToE164 } from "../../utils/usPhone.js";
import {
  listUserCompanyMemberships,
  upsertUserCompanyMembership,
} from "./userCompanyMembership.service.js";
import { revokeAllUserAuthTokens } from "./token.service.js";
import {
  COMPANY_NAME_TAKEN_MESSAGE,
  ensureCompanyByName,
  isCompanyNameTaken,
} from "../company/company.service.js";
import {
  COMPANY_ADMIN,
  isCompanyAdminRole,
  isInvestorPortalRole,
} from "../../constants/roles.js";
import {
  getSelfRegisteredContactVisibility,
  setSelfRegisteredContactVisibleToUsers,
} from "../contact/contact.service.js";
const BCRYPT_ROUNDS = 10;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 16;
/** Matches `users.username` varchar length; shown in UI as "Account name". */
const ACCOUNT_NAME_MIN = 1;
const ACCOUNT_NAME_MAX = 100;

function validateOwnProfileUsername(
  raw: string,
):
  | { ok: true; username: string }
  | { ok: false; status: number; message: string } {
  const username = String(raw ?? "").trim();
  if (username.length < ACCOUNT_NAME_MIN || username.length > ACCOUNT_NAME_MAX) {
    return {
      ok: false,
      status: 400,
      message: `Account name must be between ${ACCOUNT_NAME_MIN} and ${ACCOUNT_NAME_MAX} characters`,
    };
  }
  if (username.toLowerCase().startsWith("invited_")) {
    return {
      ok: false,
      status: 400,
      message: "Account name is not available",
    };
  }
  return { ok: true, username };
}

function userDetailsShape(u: Record<string, unknown>): Record<string, unknown> {
  return {
    ...u,
    organization_name: "",
  };
}

export function parseVisibleToUsersFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return undefined;
}

/**
 * "Do you want to be visible to users?" is on Personal details for every
 * account. The answer lives on the account's own CRM row, so the payload
 * carries whatever that row currently holds.
 */
async function attachIndividualSignupVisibility(
  userId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const selfRegistered = await getSelfRegisteredContactVisibility(userId);
  payload.canSetVisibleToUsers = true;
  payload.visibleToUsers = selfRegistered.visibleToUsers;
  return payload;
}

async function userDetailsShapeWithDealParticipant(
  u: Record<string, unknown>,
  userId: string,
): Promise<Record<string, unknown>> {
  const base = userDetailsShape(u);
  const memberships = await listUserCompanyMemberships(userId);
  if (memberships.length > 0) {
    base.memberships = memberships;
    if (
      (base.organization_id == null || String(base.organization_id).trim() === "") &&
      memberships[0]?.companyId
    ) {
      base.organization_id = memberships[0].companyId;
      if (String(base.companyName ?? "").trim() === "") {
        base.companyName = memberships[0].companyName;
        base.organization_name = memberships[0].companyName;
      }
    }
  }
  const enriched = await enrichUserRecordForDealParticipant(base, userId);
  const withLp = await mergeLpInvestorFlagsIntoUserPayload(enriched, {
    email: u.email as string | undefined,
    portalRole: u.role as string | undefined,
    userId,
  });
  return attachIndividualSignupVisibility(userId, withLp);
}

export async function changePasswordForUser(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<
  | { ok: true; user: Record<string, unknown> }
  | { ok: false; status: number; message: string }
> {
  if (!currentPassword || !newPassword) {
    return {
      ok: false,
      status: 400,
      message: "Current password and new password are required",
    };
  }
  if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
    return {
      ok: false,
      status: 400,
      message: `New password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
    };
  }
  if (currentPassword === newPassword) {
    return {
      ok: false,
      status: 400,
      message: "New password must be different from your current password",
    };
  }

  let row: UserRow | undefined;
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    row = rows[0] as UserRow | undefined;
  } catch (err) {
    console.error("changePasswordForUser: load user failed", err);
    return {
      ok: false,
      status: 500,
      message: "Could not load your account. Please try again.",
    };
  }
  if (!row) {
    return { ok: false, status: 404, message: "User not found" };
  }

  let match = false;
  try {
    match = await bcrypt.compare(currentPassword, row.passwordHash);
  } catch (err) {
    console.error("changePasswordForUser: bcrypt.compare failed", err);
    return {
      ok: false,
      status: 400,
      message:
        "Could not verify your current password. If this continues, contact support.",
    };
  }
  if (!match) {
    return { ok: false, status: 400, message: "Current password is incorrect" };
  }

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  } catch (err) {
    console.error("changePasswordForUser: bcrypt.hash failed", err);
    return {
      ok: false,
      status: 500,
      message: "Could not process the new password. Please try again.",
    };
  }

  try {
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await revokeAllUserAuthTokens(userId);
  } catch (err) {
    console.error("changePasswordForUser: update failed", err);
    return {
      ok: false,
      status: 500,
      message: "Could not save your new password. Please try again.",
    };
  }

  type UserWithOrgName = UserRow & { orgName: string | null };
  let withOrg: UserWithOrgName | undefined;
  try {
    const rows = await db
      .select({
        ...getTableColumns(users),
        orgName: companies.name,
      })
      .from(users)
      .leftJoin(companies, eq(users.organizationId, companies.id))
      .where(eq(users.id, userId))
      .limit(1);
    withOrg = rows[0] as UserWithOrgName | undefined;
  } catch (err) {
    console.error("changePasswordForUser: reload user failed", err);
    return {
      ok: false,
      status: 500,
      message: "Password was updated but we could not reload your profile.",
    };
  }
  if (!withOrg) {
    return { ok: false, status: 500, message: "Could not update password" };
  }
  const { orgName, ...updated } = withOrg;
  return {
    ok: true,
    user: await userDetailsShapeWithDealParticipant(
      serializeUserForClient(updated as UserRow, orgName),
      userId,
    ),
  };
}

export type OwnProfilePatch = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  companyName?: string;
  username?: string;
  visibleToUsers?: boolean;
  /** Individual investor turning their account into a syndicating (company) account. */
  startSyndicating?: boolean;
};

/** True when someone else already administers this company. */
async function companyAlreadyHasAdmin(
  companyId: string,
  excludeUserId: string,
): Promise<boolean> {
  const [byRole] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, companyId),
        eq(users.role, COMPANY_ADMIN),
        ne(users.id, excludeUserId),
      ),
    )
    .limit(1);
  if (byRole) return true;
  try {
    const [byMembership] = await db
      .select({ userId: userCompanyMembership.userId })
      .from(userCompanyMembership)
      .where(
        and(
          eq(userCompanyMembership.companyId, companyId),
          eq(userCompanyMembership.role, COMPANY_ADMIN),
          ne(userCompanyMembership.userId, excludeUserId),
        ),
      )
      .limit(1);
    return Boolean(byMembership);
  } catch {
    return false;
  }
}

/** Current user profile for GET /auth/me (same shape as successful PATCH). */
export async function getOwnProfile(
  userId: string,
): Promise<
  | { ok: true; user: Record<string, unknown> }
  | { ok: false; status: number; message: string }
> {
  const [r] = await db
    .select({
      ...getTableColumns(users),
      orgName: companies.name,
    })
    .from(users)
    .leftJoin(companies, eq(users.organizationId, companies.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!r) {
    return { ok: false, status: 404, message: "User not found" };
  }
  const { orgName, ...row } = r;
  return {
    ok: true,
    user: await userDetailsShapeWithDealParticipant(
      serializeUserForClient(row as UserRow, orgName),
      userId,
    ),
  };
}

export async function updateOwnProfile(
  userId: string,
  patch: OwnProfilePatch,
): Promise<
  | {
      ok: true;
      user: Record<string, unknown>;
      /** True when `companyName` matched an existing company instead of creating one. */
      joinedExistingCompany: boolean;
      /** True when the investor account was upgraded to a syndicating (company) role. */
      startedSyndicating: boolean;
    }
  | { ok: false; status: number; message: string }
> {
  const hasFirst = patch.firstName !== undefined;
  const hasLast = patch.lastName !== undefined;
  const hasPhone = patch.phone !== undefined;
  const hasCompany = patch.companyName !== undefined;
  const hasUsername = patch.username !== undefined;
  const hasVisibleToUsers = patch.visibleToUsers !== undefined;
  const wantsSyndicating = patch.startSyndicating === true;
  if (
    !hasFirst &&
    !hasLast &&
    !hasPhone &&
    !hasCompany &&
    !hasUsername &&
    !hasVisibleToUsers &&
    !wantsSyndicating
  ) {
    return { ok: false, status: 400, message: "No profile fields to update" };
  }

  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) {
    return { ok: false, status: 404, message: "User not found" };
  }

  let companyJoinedExisting = false;
  let companyId = String(row.organizationId ?? "").trim() || null;
  let companyCreatedNow = false;
  if (hasCompany) {
    const name = (patch.companyName ?? "").trim();
    if (!name) {
      return { ok: false, status: 400, message: "Company name is required" };
    }
    if (isInvestorPortalRole(row.role)) {
      /**
       * Investors link by name: join the company when it already exists, else
       * create it. They never rename a company (it may belong to a sponsor org).
       */
      const resolved = await ensureCompanyByName(name);
      if (!resolved.ok) {
        return {
          ok: false,
          status: resolved.status,
          message: resolved.message,
        };
      }
      companyJoinedExisting = !resolved.created;
      companyCreatedNow = resolved.created;
      companyId = resolved.company.id;
      if (resolved.company.id !== row.organizationId) {
        await db
          .update(users)
          .set({ organizationId: resolved.company.id, updatedAt: new Date() })
          .where(eq(users.id, userId));
      }
    } else if (!row.organizationId) {
      return {
        ok: false,
        status: 400,
        message: "No organization to update",
      };
    } else if (!isCompanyAdminRole(row.role)) {
      return {
        ok: false,
        status: 403,
        message: "Only company administrators can update the company name",
      };
    } else {
      if (await isCompanyNameTaken(name, row.organizationId)) {
        return {
          ok: false,
          status: 409,
          message: COMPANY_NAME_TAKEN_MESSAGE,
        };
      }
      await db
        .update(companies)
        .set({ name, updatedAt: new Date() })
        .where(eq(companies.id, row.organizationId));
    }
  }

  const hasUserFieldUpdates = hasFirst || hasLast || hasPhone || hasUsername;
  if (hasUserFieldUpdates) {
    const setObj: {
      updatedAt: Date;
      firstName?: string;
      lastName?: string;
      phone?: string;
      username?: string;
    } = { updatedAt: new Date() };
    if (hasFirst) setObj.firstName = patch.firstName ?? "";
    if (hasLast) setObj.lastName = patch.lastName ?? "";
    if (hasUsername) {
      const validated = validateOwnProfileUsername(patch.username ?? "");
      if (!validated.ok) {
        return {
          ok: false,
          status: validated.status,
          message: validated.message,
        };
      }
      const current = String(row.username ?? "").trim();
      if (validated.username.toLowerCase() !== current.toLowerCase()) {
        const [existingUsername] = await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              sql`lower(${users.username}) = ${validated.username.toLowerCase()}`,
              ne(users.id, userId),
            ),
          )
          .limit(1);
        if (existingUsername) {
          return {
            ok: false,
            status: 409,
            message: "This account name is already taken",
          };
        }
        setObj.username = validated.username;
      }
    }
    if (hasPhone) {
      const raw = String(patch.phone ?? "").trim();
      if (!raw) {
        setObj.phone = "";
      } else {
        const e164 = parseUsPhoneToE164(raw);
        if (!e164) {
          return {
            ok: false,
            status: 400,
            message:
              "Enter a valid 10-digit U.S. phone number, or leave phone blank.",
          };
        }
        setObj.phone = e164;
      }
    }
    await db.update(users).set(setObj).where(eq(users.id, userId));
  }

  if (hasVisibleToUsers) {
    await setSelfRegisteredContactVisibleToUsers({
      userId,
      emailNorm: String(row.email ?? "").trim().toLowerCase(),
      firstName: hasFirst ? (patch.firstName ?? "") : row.firstName,
      lastName: hasLast ? (patch.lastName ?? "") : row.lastName,
      phone: hasPhone ? (patch.phone ?? "") : row.phone,
      visibleToUsers: patch.visibleToUsers === true,
    });
  }

  /**
   * "Do you want to start syndicating?" on My account → Company details. The
   * investor keeps the same login but moves to a company role, so the
   * syndicating workspace opens (mirrors the sponsor path at signup).
   */
  let startedSyndicating = false;
  if (wantsSyndicating && isInvestorPortalRole(row.role)) {
    if (!companyId) {
      return {
        ok: false,
        status: 400,
        message: "Add your company name before you start syndicating.",
      };
    }
    if (!companyCreatedNow && (await companyAlreadyHasAdmin(companyId, userId))) {
      /** Someone already runs this workspace — joining it needs their invite. */
      return {
        ok: false,
        status: 409,
        message:
          "This company already syndicates on SyndicationX. Ask one of its admins to invite you.",
      };
    }
    await db
      .update(users)
      .set({ role: COMPANY_ADMIN, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await upsertUserCompanyMembership(userId, companyId, COMPANY_ADMIN);
    startedSyndicating = true;
  }

  const [updated] = await db
    .select({
      ...getTableColumns(users),
      orgName: companies.name,
    })
    .from(users)
    .leftJoin(companies, eq(users.organizationId, companies.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!updated) {
    return { ok: false, status: 500, message: "Could not update profile" };
  }
  const { orgName, ...u } = updated;
  return {
    ok: true,
    user: await userDetailsShapeWithDealParticipant(
      serializeUserForClient(u as UserRow, orgName),
      userId,
    ),
    joinedExistingCompany: companyJoinedExisting,
    startedSyndicating,
  };
}
