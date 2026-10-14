import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { contact } from "../../schema/contact.schema.js";

export const INACTIVE_PORTAL_USER_ROSTER_MESSAGE =
  "Inactive company users cannot be added to deal members or investors.";

export const ARCHIVED_CONTACT_ROSTER_MESSAGE =
  "Archived contacts cannot be added to deal members or investors.";

export const HIDDEN_PLATFORM_CONTACT_ROSTER_MESSAGE =
  "This investor is not visible on the platform and cannot be added to a deal.";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInactivePortalUserStatus(status: unknown): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "inactive" || s === "suspended";
}

export function isArchivedContactStatus(status: unknown): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "suspended" || s === "archived";
}

export class DealRosterEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealRosterEligibilityError";
  }
}

/** @deprecated Use DealRosterEligibilityError */
export class InactivePortalUserRosterError extends DealRosterEligibilityError {
  constructor(message = INACTIVE_PORTAL_USER_ROSTER_MESSAGE) {
    super(message);
    this.name = "InactivePortalUserRosterError";
  }
}

export function isDealRosterEligibilityError(
  err: unknown,
): err is DealRosterEligibilityError {
  return (
    err instanceof DealRosterEligibilityError ||
    err instanceof InactivePortalUserRosterError
  );
}

export function isInactivePortalUserRosterError(
  err: unknown,
): err is InactivePortalUserRosterError {
  return isDealRosterEligibilityError(err);
}

function isHiddenSelfRegisteredContact(row: {
  platformAdminOnly: boolean;
  visibleToUsers: boolean;
}): boolean {
  return Boolean(row.platformAdminOnly) && row.visibleToUsers !== true;
}

function idsEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Self-registered investors who did not opt in to platform visibility
 * cannot be added to deal investors or members by someone else
 * (including platform admins). The investor themselves can still join
 * (Invest Now).
 */
export async function assertEligibleForNewDealRosterAdd(
  contactMemberId: string,
  actorUserId?: string,
): Promise<void> {
  const cid = String(contactMemberId ?? "").trim();
  if (!cid || !UUID_RE.test(cid)) return;
  const actor = String(actorUserId ?? "").trim();
  if (actor && idsEqual(actor, cid)) return;

  const [byContactId] = await db
    .select({
      platformAdminOnly: contact.platformAdminOnly,
      visibleToUsers: contact.visibleToUsers,
      createdBy: contact.createdBy,
    })
    .from(contact)
    .where(eq(contact.id, cid))
    .limit(1);
  if (byContactId) {
    if (actor && idsEqual(actor, String(byContactId.createdBy ?? ""))) return;
    if (isHiddenSelfRegisteredContact(byContactId)) {
      throw new DealRosterEligibilityError(
        HIDDEN_PLATFORM_CONTACT_ROSTER_MESSAGE,
      );
    }
    return;
  }

  const [portalUser] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, cid))
    .limit(1);
  if (!portalUser) return;

  const emailNorm = String(portalUser.email ?? "")
    .trim()
    .toLowerCase();
  const emailMatch = emailNorm.includes("@")
    ? sql`lower(trim(${contact.email})) = ${emailNorm}`
    : undefined;
  const [selfRegistered] = await db
    .select({
      platformAdminOnly: contact.platformAdminOnly,
      visibleToUsers: contact.visibleToUsers,
      createdBy: contact.createdBy,
    })
    .from(contact)
    .where(
      and(
        eq(contact.platformAdminOnly, true),
        emailMatch
          ? or(eq(contact.createdBy, portalUser.id), emailMatch)!
          : eq(contact.createdBy, portalUser.id),
      ),
    )
    .limit(1);
  if (!selfRegistered) return;
  if (actor && idsEqual(actor, String(selfRegistered.createdBy ?? ""))) return;
  if (isHiddenSelfRegisteredContact(selfRegistered)) {
    throw new DealRosterEligibilityError(HIDDEN_PLATFORM_CONTACT_ROSTER_MESSAGE);
  }
}

/** @deprecated Use assertEligibleForNewDealRosterAdd */
export async function assertPortalUserActiveForNewDealRosterAdd(
  contactMemberId: string,
): Promise<void> {
  await assertEligibleForNewDealRosterAdd(contactMemberId);
}
