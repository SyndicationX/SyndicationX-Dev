import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  COMPANY_ADMIN,
  COMPANY_USER,
  INVESTOR,
  isCompanyAdminRole,
  isPlatformAdminRole,
} from "../../constants/roles.js";
import { db, pool } from "../../database/db.js";
import { users } from "../../schema/auth.schema/signin.js";
import { resolveDealViewerScope } from "../deal/dealAccess.service.js";
import {
  listDealIdsWhereViewerIsCoSponsor,
  listEquivalentPortalUserIdsForUser,
  viewerIsLeadOrAdminSponsorOnAnyDeal,
  viewerShouldSeeOnlySelfCreatedContacts,
} from "../deal/dealMemberScope.service.js";
import { syncOutsideSponsorsIntoOrganizationContacts } from "../deal/dealMember.service.js";
import { listAddDealFormsForViewer } from "../deal/dealForm.service.js";
import {
  visibleDealIdsCache,
  contactDirectoryCache,
  invalidateContactDirectoryCache,
} from "../cache/listReadCache.js";
import {
  normalizeOrganizationUuid,
  resolveActiveOrganizationIdForUser,
  resolveOrganizationIdForUserId,
  resolvePortalRoleInOrganization,
  userHasAccessToOrganization,
} from "../org/orgResolution.service.js";
import {
  companies,
  dealLpInvestor,
  userCompanyMembership,
} from "../../schema/schema.js";
import {
  contact,
  type ContactInsert,
  type ContactRow,
} from "../../schema/contact.schema.js";
import { syncOrganizationContactLabels } from "./organizationContactLabels.service.js";
import { type ContactOfferingVisibility } from "./contactOfferingVisibility.service.js";
import { queueGhlContactRowSync } from "../ghl/ghlContactSync.service.js";
import {
  canonicalUsPhoneKey10,
  parseUsPhoneToE164,
} from "../../utils/usPhone.js";
import { searchWhere, searchableColumn } from "../../common/pagination.js";

export type ContactListSort = "name" | "createdAt";

function contactListOrderBy(sort: ContactListSort = "createdAt") {
  if (sort === "name") {
    return [
      asc(sql`lower(trim(${contact.firstName}))`),
      asc(sql`lower(trim(${contact.lastName}))`),
      asc(sql`lower(trim(${contact.email}))`),
    ];
  }
  return [desc(contact.createdAt)];
}

/** Concat first + last for `contact.full_name` (trimmed, single space). */
export function buildContactFullName(
  firstName: string,
  lastName: string,
): string {
  return [firstName, lastName]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Thrown when a non-empty phone is not a valid U.S. NANP number. */
export class ContactInvalidPhoneError extends Error {
  constructor() {
    super("Enter a valid 10-digit U.S. phone number, or leave phone blank.");
    this.name = "ContactInvalidPhoneError";
  }
}

function normalizeContactPhoneForWrite(raw: string): string {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  const e164 = parseUsPhoneToE164(t);
  if (!e164) throw new ContactInvalidPhoneError();
  return e164;
}

/** First + last name, else email, else username — for CRM "owner" display */
export async function getUserDisplayNameById(
  userId: string,
): Promise<string> {
  const [u] = await db
    .select({
      email: users.email,
      username: users.username,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return "";
  const fn = u.firstName?.trim() ?? "";
  const ln = u.lastName?.trim() ?? "";
  const full = [fn, ln].filter(Boolean).join(" ");
  if (full) return full;
  return u.email?.trim() || u.username?.trim() || "";
}

/** Exporter profile for members export audit emails (user admin). */
export async function getUserContactsExportAuditFields(
  userId: string,
): Promise<{ email: string; displayName: string; orgName: string }> {
  const rows = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      orgName: companies.name,
    })
    .from(users)
    .leftJoin(companies, eq(users.organizationId, companies.id))
    .where(eq(users.id, userId))
    .limit(1);
  const r = rows[0];
  if (!r) {
    return { email: "", displayName: "", orgName: "" };
  }
  const display =
    [r.firstName, r.lastName].filter(Boolean).join(" ").trim() || r.email;
  const org = r.orgName?.trim() || "";
  return { email: r.email, displayName: display, orgName: org };
}

export type CreateContactInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  note: string;
  tags: string[];
  lists: string[];
  owners: string[];
  importSource?: "manual" | "csv" | "excel" | "invite_link" | "portal_signup" | "ghl";
};

export const SELF_REGISTERED_CONTACT_ADDED_BY_LABEL = "Self Registered";
export const UNASSIGNED_CONTACT_OWNER_LABEL = "Unassigned";

export type ContactCreatorUserSnapshot = {
  id: string;
  role: string | null;
  organizationId: string | null;
  email: string | null;
};

/** Thrown when another contact in the same company scope already uses this email or phone. */
export class ContactScopeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactScopeConflictError";
  }
}

async function userIdsInOrganization(organizationId: string): Promise<string[]> {
  const oid = normalizeOrganizationUuid(organizationId);
  if (!oid) return [];
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .leftJoin(
        userCompanyMembership,
        and(
          eq(userCompanyMembership.userId, users.id),
          eq(userCompanyMembership.companyId, oid),
        ),
      )
      .where(
        or(
          eq(users.organizationId, oid),
          eq(userCompanyMembership.companyId, oid),
        ),
      );
    return [...new Set(rows.map((r) => r.id).filter(Boolean))];
  } catch (err) {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.organizationId, oid));
    return rows.map((r) => r.id);
  }
}

function normalizeContactEmailForScope(e: string): string {
  return e.trim().toLowerCase();
}

/**
 * Keep denormalized `deal_lp_investor.email` in sync when CRM contact email changes.
 * Matches roster rows keyed by this contact id, the previous email literal, or a
 * portal user whose login email was the previous contact email.
 */
async function syncDealLpInvestorEmailForContactUpdate(params: {
  contactId: string;
  previousEmail: string;
  nextEmail: string;
}): Promise<void> {
  const contactId = String(params.contactId ?? "").trim();
  const nextStored = String(params.nextEmail ?? "").trim();
  if (!contactId || !nextStored.includes("@")) return;

  const prev = normalizeContactEmailForScope(params.previousEmail);
  const next = normalizeContactEmailForScope(nextStored);
  const memberKeys = new Set<string>([contactId.toLowerCase()]);
  if (prev.includes("@")) memberKeys.add(prev);
  if (next.includes("@")) memberKeys.add(next);

  const userEmails = [prev, next].filter((e) => e.includes("@"));
  if (userEmails.length > 0) {
    const linkedUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`lower(trim(${users.email})) in (${sql.join(
          userEmails.map((e) => sql`${e}`),
          sql`, `,
        )})`,
      );
    for (const u of linkedUsers) {
      const id = String(u.id ?? "").trim().toLowerCase();
      if (id) memberKeys.add(id);
    }
  }

  const [contactRow] = await db
    .select({
      firstName: contact.firstName,
      lastName: contact.lastName,
      fullName: contact.fullName,
    })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  const first = String(contactRow?.firstName ?? "").trim().toLowerCase();
  const last = String(contactRow?.lastName ?? "").trim().toLowerCase();
  const full = String(contactRow?.fullName ?? "").trim().toLowerCase();
  const personName = `${first} ${last}`.trim() || full;
  if (first && last) {
    const namedUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        sql`lower(trim(${users.firstName})) = ${first} AND lower(trim(${users.lastName})) = ${last}`,
      );
    for (const u of namedUsers) {
      const id = String(u.id ?? "").trim().toLowerCase();
      if (id) memberKeys.add(id);
    }
  }

  const keys = [...memberKeys];
  const memberMatch = sql`lower(trim(${dealLpInvestor.contactMemberId})) in (${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )})`;
  const emailMatch = prev.includes("@")
    ? sql`lower(trim(${dealLpInvestor.email})) = ${prev}`
    : undefined;
  const nameMatch = personName
    ? sql`lower(trim(${dealLpInvestor.investorName})) = ${personName}`
    : undefined;

  await db
    .update(dealLpInvestor)
    .set({
      email: nextStored,
      updatedAt: new Date(),
    })
    .where(
      nameMatch && emailMatch
        ? sql`${memberMatch} OR ${emailMatch} OR ${nameMatch}`
        : nameMatch
          ? sql`${memberMatch} OR ${nameMatch}`
          : emailMatch
            ? sql`${memberMatch} OR ${emailMatch}`
            : memberMatch,
    );
}

/**
 * Latest CRM `contact` row for this email (signup form prefill). If multiple orgs
 * share the same email, the most recently created row wins.
 */
export async function findContactByEmailForSignupPrefill(
  email: string,
): Promise<{ firstName: string; lastName: string; phone: string } | null> {
  const norm = normalizeContactEmailForScope(email);
  if (!norm || !norm.includes("@")) return null;
  const rows = await db
    .select({
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
    })
    .from(contact)
    .where(sql`lower(trim(${contact.email})) = ${norm}`)
    .orderBy(desc(contact.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const fn = String(r.firstName ?? "").trim();
  const ln = String(r.lastName ?? "").trim();
  const phoneRaw = String(r.phone ?? "").trim();
  if (!fn && !ln && !phoneRaw) return null;
  return {
    firstName: fn,
    lastName: ln,
    phone: phoneRaw,
  };
}

/**
 * Selected company for CRM writes and lists: membership, primary org, or a
 * deal in that company where this user is lead, admin, or co-sponsor.
 */
async function viewerMayUseOrganizationForContacts(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  if (await userHasAccessToOrganization(userId, organizationId)) return true;
  if (await viewerIsLeadOrAdminSponsorOnAnyDeal(userId, organizationId)) {
    return true;
  }
  const coDeals = await listDealIdsWhereViewerIsCoSponsor(
    userId,
    organizationId,
  );
  return coDeals.length > 0;
}

/**
 * Prefer `users.role` from DB over JWT so listing and access stay correct after role changes.
 * Org id matches {@link resolveOrganizationIdForUserId} (same as insert) so list and create stay aligned.
 */
async function getViewerContactScopeContext(
  viewerUserId: string,
  jwtRoleFallback: string | null | undefined,
  requestedOrganizationId?: string | null,
): Promise<{
  roleForScope: string;
  viewerEmailNorm: string;
  organizationId: string | null;
}> {
  const [row] = await db
    .select({
      email: users.email,
      role: users.role,
      organizationId: users.organizationId,
    })
    .from(users)
    .where(eq(users.id, viewerUserId))
    .limit(1);
  const dbRole = String(row?.role ?? "").trim();
  const primaryRole = dbRole || String(jwtRoleFallback ?? "").trim();
  const preloaded = row
    ? {
        organizationId: row.organizationId,
        role: row.role,
      }
    : null;
  const requested = normalizeOrganizationUuid(requestedOrganizationId);
  let organizationId = await resolveActiveOrganizationIdForUser(
    viewerUserId,
    requestedOrganizationId,
    preloaded,
  );
  // Platform admins are not members of customer companies. A requested
  // organization id still scopes Customers → Contacts to that company.
  if (isPlatformAdminRole(primaryRole) && requested) {
    organizationId = requested;
  } else if (
    requested &&
    organizationId !== requested &&
    (await viewerMayUseOrganizationForContacts(viewerUserId, requested))
  ) {
    organizationId = requested;
  }
  const roleForScope = isPlatformAdminRole(primaryRole)
    ? primaryRole
    : await resolvePortalRoleInOrganization(viewerUserId, organizationId, {
        organizationId: preloaded?.organizationId ?? null,
        role: primaryRole,
      });

  return {
    roleForScope,
    viewerEmailNorm: normalizeContactEmailForScope(row?.email ?? ""),
    organizationId,
  };
}

/**
 * Same visibility strip as company admin / sponsor team: org CRM pool including
 * portal-linked contacts (`is_portal_user`), excluding only the viewer’s own email.
 */
function fullOrgContactListVisibilityWhere(viewerEmailNorm: string): SQL {
  if (!viewerEmailNorm || !viewerEmailNorm.includes("@")) return sql`true`;
  return sql`lower(trim(${contact.email})) <> ${viewerEmailNorm}`;
}

/**
 * Role-based All Contacts visibility (non–platform-admin).
 * - **Company admin**, **Company member**, or **Lead Sponsor / Admin sponsor**:
 *   same org pool;
 *   include portal + external member contacts; exclude own email only.
 *   Company Admin and Company Member accounts are removed afterward.
 * - **Everyone else** (e.g. LP, co-sponsor): external only
 *   (`is_portal_user` false); exclude own email.
 *   Invite-link signups (`users.referred_by_user_id` = this viewer) are added back in
 *   {@link buildContactsScopeWhere} so they still appear under the inviter.
 */
function contactsVisibilityWhereForRole(
  roleForScope: string,
  viewerEmailNorm: string,
): SQL {
  if (
    isCompanyAdminRole(roleForScope) ||
    String(roleForScope ?? "").trim() === COMPANY_USER
  ) {
    return fullOrgContactListVisibilityWhere(viewerEmailNorm);
  }
  const nonPortal = eq(contact.isPortalUser, false);
  const outsideSponsorCopy = sql`${contact.importSource} in ('deal_sponsor', 'deal_org_move')`;
  const visibleContact = or(nonPortal, outsideSponsorCopy)!;
  if (!viewerEmailNorm || !viewerEmailNorm.includes("@")) return visibleContact;
  const notSelf = sql`lower(trim(${contact.email})) <> ${viewerEmailNorm}`;
  return and(visibleContact, notSelf)!;
}

/** True if a portal `users` row exists for this email (any role). */
export async function contactEmailMatchesPortalUser(
  email: string,
): Promise<boolean> {
  const e = normalizeContactEmailForScope(email);
  if (!e || !e.includes("@")) return false;
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(trim(${users.email})) = ${e}`)
    .limit(1);
  return Boolean(u);
}

/**
 * When someone becomes a portal user, mark matching CRM contacts (`is_portal_user`).
 * Non–company-admin All Contacts lists still hide these rows; company admins see them.
 */
export async function markContactsAsPortalUserByEmailNorm(
  emailNorm: string,
): Promise<void> {
  const e = normalizeContactEmailForScope(emailNorm);
  if (!e || !e.includes("@")) return;
  await db
    .update(contact)
    .set({ isPortalUser: true })
    .where(sql`lower(trim(${contact.email})) = ${e}`);
}

/**
 * Self-serve investor signup (no company): ensure a CRM row exists for platform
 * contacts with `created_by` = the new portal user.
 */
/** CRM rows for self-registered investors — platform admin visibility only. */
export function isPlatformAdminOnlyContactRow(
  row: Pick<ContactRow, "platformAdminOnly">,
): boolean {
  return Boolean(row.platformAdminOnly);
}

function excludePlatformAdminOnlyContactsWhere(): SQL {
  return eq(contact.platformAdminOnly, false);
}

/**
 * CRM rows whose person answered Yes to "Do you want to be visible to users?".
 * Keyed on the answer alone: a contact a sponsor added opts in on the same row
 * they already own, so it never carries `platform_admin_only`.
 */
function optedInSelfRegisteredContactsWhere(): SQL {
  return eq(contact.visibleToUsers, true);
}

export function isOptedInSelfRegisteredContactRow(
  row: Pick<ContactRow, "platformAdminOnly" | "visibleToUsers">,
): boolean {
  return Boolean(row.visibleToUsers);
}

/**
 * Platform contacts that belong to one company: rows stored on that company,
 * legacy rows created by a member, and self-signups invited by a member.
 */
async function platformContactsForOrganizationWhere(orgId: string): Promise<SQL> {
  const memberIds = await userIdsInOrganization(orgId);
  const legacyMemberContacts =
    memberIds.length > 0
      ? and(
          isNull(contact.organizationId),
          inArray(contact.createdBy, memberIds),
        )!
      : null;
  const orgScope = legacyMemberContacts
    ? or(eq(contact.organizationId, orgId), legacyMemberContacts)!
    : eq(contact.organizationId, orgId);
  return or(orgScope, contactsReferredByOrganizationMembersWhere(orgId))!;
}

/**
 * Platform Contacts section.
 * Company users see opted-in self-registered rows only (`visible_to_users`).
 * Platform admins see every self-registered row, plus any org contact who
 * answered Yes to “visible to users”. A No keeps that person on the org list
 * only. Own row is omitted.
 * Pass `organizationId` to limit the list to one company (Customers → organization).
 */
export async function listPlatformVisibleContacts(
  viewerUserId: string,
  sort: ContactListSort = "createdAt",
  viewerRole?: string | null,
  organizationId?: string | null,
): Promise<ContactRow[]> {
  const [viewer] = await db
    .select({ email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, viewerUserId))
    .limit(1);
  const viewerEmailNorm = normalizeContactEmailForScope(viewer?.email ?? "");
  const role = String(viewer?.role ?? viewerRole ?? "").trim();
  const visibility = isPlatformAdminRole(role)
    ? or(
        eq(contact.platformAdminOnly, true),
        eq(contact.visibleToUsers, true),
      )!
    : optedInSelfRegisteredContactsWhere();
  const parts: SQL[] = [visibility];
  if (viewerEmailNorm.includes("@")) {
    parts.push(sql`lower(trim(${contact.email})) <> ${viewerEmailNorm}`);
  }
  const orgId = normalizeOrganizationUuid(organizationId);
  if (orgId) {
    parts.push(await platformContactsForOrganizationWhere(orgId));
  }
  parts.push(excludeCompanyStaffFromContactsWhere(orgId));
  return db
    .select()
    .from(contact)
    .where(and(...parts)!)
    .orderBy(...contactListOrderBy(sort));
}

export async function listPlatformVisibleContactsCached(
  viewerUserId: string,
  sort: ContactListSort = "createdAt",
  viewerRole?: string | null,
  organizationId?: string | null,
): Promise<ContactRow[]> {
  const orgKey = normalizeOrganizationUuid(organizationId) ?? "";
  const key = [
    "platform",
    viewerUserId,
    String(viewerRole ?? ""),
    sort,
    orgKey,
  ].join(":");
  const cached = contactDirectoryCache.get(key) as ContactRow[] | undefined;
  if (cached) return cached;
  const rows = await listPlatformVisibleContacts(
    viewerUserId,
    sort,
    viewerRole,
    orgKey || null,
  );
  contactDirectoryCache.set(key, rows);
  return rows;
}

function buildOrganizationContactsWhere(
  orgId: string,
  viewerUserId: string,
  memberIds: string[],
): SQL {
  const ids = [...new Set([...memberIds, viewerUserId])];
  return or(
    eq(contact.organizationId, orgId),
    eq(contact.createdBy, viewerUserId),
    and(isNull(contact.organizationId), inArray(contact.createdBy, ids))!,
  )!;
}

async function contactRowBelongsToOrganization(
  row: ContactRow,
  orgId: string,
  viewerUserId: string,
): Promise<boolean> {
  if (row.organizationId === orgId) return true;
  if (viewerUserId === row.createdBy) return true;
  if (!row.organizationId) {
    const memberIds = await userIdsInOrganization(orgId);
    return memberIds.includes(row.createdBy);
  }
  return false;
}

export async function ensureSelfRegisteredInvestorContact(params: {
  userId: string;
  emailNorm: string;
  firstName: string;
  lastName: string;
  phone: string;
}): Promise<string | null> {
  const userId = String(params.userId ?? "").trim();
  const emailNorm = normalizeContactEmailForScope(params.emailNorm);
  if (!userId || !emailNorm || !emailNorm.includes("@")) return null;

  let phoneStored = "";
  try {
    phoneStored = normalizeContactPhoneForWrite(params.phone);
  } catch {
    phoneStored = "";
  }

  const firstName = String(params.firstName ?? "").trim();
  const lastName = String(params.lastName ?? "").trim();

  const [existing] = await db
    .select()
    .from(contact)
    .where(sql`lower(trim(${contact.email})) = ${emailNorm}`)
    .limit(1);

  if (existing) {
    const sponsorOwned = existing.createdBy !== userId;
    const nextFirstName = firstName || existing.firstName;
    const nextLastName = lastName || existing.lastName;
    const [updated] = await db
      .update(contact)
      .set({
        isPortalUser: true,
        ...(sponsorOwned
          ? {}
          : { platformAdminOnly: true, visibleToUsers: existing.visibleToUsers }),
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        ...(firstName || lastName
          ? { fullName: buildContactFullName(nextFirstName, nextLastName) }
          : {}),
        ...(phoneStored ? { phone: phoneStored } : {}),
      })
      .where(eq(contact.id, existing.id))
      .returning();
    if (updated) queueGhlContactRowSync(updated);
    return sponsorOwned ? null : String(updated?.id ?? existing.id).trim() || null;
  }

  const insertFirstName = firstName || "—";
  const insertLastName = lastName || "—";
  const [inserted] = await db
    .insert(contact)
    .values({
      firstName: insertFirstName,
      lastName: insertLastName,
      fullName: buildContactFullName(insertFirstName, insertLastName),
      email: emailNorm,
      phone: phoneStored,
      note: "",
      tags: [],
      lists: [],
      owners: [],
      status: "active",
      createdBy: userId,
      organizationId: null,
      isPortalUser: true,
      platformAdminOnly: true,
      visibleToUsers: false,
      relationship506b: "NO",
      importSource: "portal_signup",
    })
    .returning();
  if (inserted) queueGhlContactRowSync(inserted);
  return String(inserted?.id ?? "").trim() || null;
}

/**
 * The CRM row that stands for this account: their own self-registered row when
 * they have one, otherwise the row a sponsor added for the same email. The
 * Personal details visibility answer is stored on whichever row this returns.
 */
async function findAccountContactId(
  userId: string,
  emailNorm?: string,
): Promise<string | null> {
  const uid = String(userId ?? "").trim();
  if (!uid) return null;

  const [own] = await db
    .select({ id: contact.id })
    .from(contact)
    .where(
      and(eq(contact.createdBy, uid), eq(contact.platformAdminOnly, true)),
    )
    .limit(1);
  if (own) return String(own.id).trim() || null;

  let email = normalizeContactEmailForScope(emailNorm ?? "");
  if (!email) {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, uid))
      .limit(1);
    email = normalizeContactEmailForScope(user?.email ?? "");
  }
  if (!email || !email.includes("@")) return null;

  const [byEmail] = await db
    .select({ id: contact.id })
    .from(contact)
    .where(sql`lower(trim(${contact.email})) = ${email}`)
    .limit(1);
  return byEmail ? String(byEmail.id).trim() || null : null;
}

/**
 * Current answer to "Do you want to be visible to users?" for this account.
 * `exists` reports whether any CRM row represents them yet.
 */
export async function getSelfRegisteredContactVisibility(
  userId: string,
): Promise<{ exists: boolean; visibleToUsers: boolean }> {
  const contactId = await findAccountContactId(userId);
  if (!contactId) return { exists: false, visibleToUsers: false };
  const [row] = await db
    .select({ visibleToUsers: contact.visibleToUsers })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return {
    exists: Boolean(row),
    visibleToUsers: Boolean(row?.visibleToUsers),
  };
}

export async function setSelfRegisteredContactVisibleToUsers(params: {
  userId: string;
  emailNorm: string;
  firstName: string;
  lastName: string;
  phone: string;
  visibleToUsers: boolean;
}): Promise<void> {
  const uid = String(params.userId ?? "").trim();
  if (!uid) return;
  const contactId =
    (await findAccountContactId(uid, params.emailNorm)) ??
    (await ensureSelfRegisteredInvestorContact({
      userId: uid,
      emailNorm: params.emailNorm,
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
    }));
  if (!contactId) return;
  const [updated] = await db
    .update(contact)
    .set({ visibleToUsers: params.visibleToUsers })
    .where(eq(contact.id, contactId))
    .returning();
  if (updated) {
    invalidateContactDirectoryCache();
    queueGhlContactRowSync(updated);
  }
}

export function isSelfRegisteredInvestorContactRow(
  row: ContactRow,
  creator: ContactCreatorUserSnapshot | null | undefined,
): boolean {
  if (isPlatformAdminOnlyContactRow(row)) return true;
  if (!row.isPortalUser || row.organizationId) return false;
  if (!creator || creator.id !== row.createdBy) return false;
  if (String(creator.role ?? "").trim() !== INVESTOR) return false;
  if (creator.organizationId) return false;
  const contactEmail = normalizeContactEmailForScope(row.email);
  const creatorEmail = normalizeContactEmailForScope(creator.email ?? "");
  return Boolean(
    contactEmail && creatorEmail && contactEmail === creatorEmail,
  );
}

/**
 * `dealAdderName` (see {@link resolveDealAdderNamesByContactIdForViewer}) stands in
 * for the owner of a self-registered contact that a sponsor put on a deal.
 */
export function resolveContactDisplayFields(
  row: ContactRow,
  creator: ContactCreatorUserSnapshot | null | undefined,
  createdByDisplayNameFromUser: string,
  dealAdderName?: string,
): { createdByDisplayName: string; owners: string[] } {
  if (isSelfRegisteredInvestorContactRow(row, creator)) {
    const fallbackOwner =
      dealAdderName?.trim() || UNASSIGNED_CONTACT_OWNER_LABEL;
    return {
      createdByDisplayName: SELF_REGISTERED_CONTACT_ADDED_BY_LABEL,
      owners: row.owners?.length > 0 ? row.owners : [fallbackOwner],
    };
  }
  return {
    createdByDisplayName: createdByDisplayNameFromUser,
    owners: row.owners ?? [],
  };
}

function portalUserDisplayName(row: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  username: string | null;
}): string {
  const full = [row.firstName, row.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return full || String(row.email ?? "").trim() || String(row.username ?? "").trim();
}

/**
 * Contacts whose portal account signed up through one of these users' invite
 * links (`users.referred_by_user_id`). Used so that person still appears on
 * the inviter's contacts list when portal users are otherwise hidden.
 */
function contactsReferredByUserIdsWhere(userIds: string[]): SQL | null {
  const ids = [
    ...new Set(userIds.map((id) => String(id).trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return null;
  return sql`exists (
    select 1
    from "users" invitee
    where lower(trim(invitee.email)) = lower(trim(${contact.email}))
      and position('@' in trim(invitee.email)) > 1
      and invitee.referred_by_user_id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  )`;
}

/**
 * Portal users who signed up through an invite link shared by someone in this
 * company (contacts page, deal invite, or offering link).
 */
function contactsReferredByOrganizationMembersWhere(orgId: string): SQL {
  const oid = String(orgId ?? "").trim();
  return sql`exists (
    select 1
    from "users" invitee
    inner join "users" sponsor on sponsor.id = invitee.referred_by_user_id
    where lower(trim(invitee.email)) = lower(trim(${contact.email}))
      and position('@' in trim(invitee.email)) > 1
      and (
        sponsor.organization_id = ${oid}::uuid
        or exists (
          select 1
          from "user_company_membership" membership
          where membership.user_id = sponsor.id
            and membership.company_id = ${oid}::uuid
        )
      )
  )`;
}

export type ContactInvitedBy = {
  userId: string;
  displayName: string;
};

/**
 * Person who brought this contact in via an invite link
 * (`users.referred_by_user_id`), including a deal or offering link
 * (`contact.referred_by_deal_id` + the sponsor who created the row).
 * Contacts added by hand stay blank.
 */
export async function resolveInvitedByDisplayNameByContactId(
  rows: Array<Pick<ContactRow, "id" | "email" | "createdBy" | "referredByDealId">>,
): Promise<Map<string, ContactInvitedBy>> {
  const invitedBy = new Map<string, ContactInvitedBy>();
  if (rows.length === 0) return invitedBy;

  const emails = [
    ...new Set(
      rows
        .map((row) => normalizeContactEmailForScope(row.email))
        .filter((email) => email.includes("@")),
    ),
  ];
  const portalByEmail = new Map<
    string,
    { id: string; referredByUserId: string | null }
  >();
  if (emails.length > 0) {
    const portalUsers = await db
      .select({
        id: users.id,
        email: users.email,
        referredByUserId: users.referredByUserId,
      })
      .from(users)
      .where(
        sql`lower(trim(${users.email})) in (${sql.join(
          emails.map((email) => sql`${email}`),
          sql`, `,
        )})`,
      );
    for (const user of portalUsers) {
      const email = normalizeContactEmailForScope(user.email ?? "");
      if (!email) continue;
      portalByEmail.set(email, {
        id: String(user.id),
        referredByUserId: user.referredByUserId ?? null,
      });
    }
  }

  const inviterIdByContactId = new Map<string, string>();
  const inviterIds = new Set<string>();
  for (const row of rows) {
    const contactId = String(row.id).trim().toLowerCase();
    if (!contactId) continue;
    const portal = portalByEmail.get(normalizeContactEmailForScope(row.email));
    const referrerId = String(portal?.referredByUserId ?? "").trim();
    const dealId = String(row.referredByDealId ?? "").trim();
    const creatorId = String(row.createdBy ?? "").trim();
    const inviterId =
      referrerId || (dealId && creatorId ? creatorId : "");
    if (!inviterId) continue;
    inviterIdByContactId.set(contactId, inviterId);
    inviterIds.add(inviterId);
  }
  if (inviterIds.size === 0) return invitedBy;

  const inviters = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      username: users.username,
    })
    .from(users)
    .where(inArray(users.id, [...inviterIds]));
  const nameById = new Map(
    inviters.map((user) => [String(user.id), portalUserDisplayName(user)]),
  );
  for (const [contactId, inviterId] of inviterIdByContactId) {
    const name = nameById.get(inviterId)?.trim() ?? "";
    if (!name && !inviterId) continue;
    invitedBy.set(contactId, {
      userId: inviterId,
      displayName: name,
    });
  }
  return invitedBy;
}

/**
 * First person who invited this contact into `organizationId`.
 * A signup link counts only for the inviter's own company. A CRM row or deal
 * counts only when that row or deal belongs to this company.
 */
export async function resolveFirstOrganizationInviterByContactId(
  rows: Array<Pick<ContactRow, "id" | "email">>,
  organizationId: string,
): Promise<Map<string, ContactInvitedBy>> {
  const invitedBy = new Map<string, ContactInvitedBy>();
  const orgId = normalizeOrganizationUuid(organizationId);
  if (!orgId || rows.length === 0) return invitedBy;

  const emails = [
    ...new Set(
      rows
        .map((row) => normalizeContactEmailForScope(row.email))
        .filter((email) => email.includes("@")),
    ),
  ];
  if (emails.length === 0) return invitedBy;

  const found = await pool.query<{ email: string; inviter_id: string }>(
    `WITH events AS (
       SELECT lower(trim(invitee.email)) AS email,
              invitee.referred_by_user_id AS inviter_id,
              invitee.created_at AS at
       FROM users invitee
       INNER JOIN users sponsor ON sponsor.id = invitee.referred_by_user_id
       WHERE lower(trim(invitee.email)) = ANY($2::text[])
         AND sponsor.organization_id = $1::uuid

       UNION ALL

       SELECT lower(trim(c.email)) AS email,
              c.created_by AS inviter_id,
              c.created_at AS at
       FROM contact c
       INNER JOIN users creator ON creator.id = c.created_by
       WHERE lower(trim(c.email)) = ANY($2::text[])
         AND (
           c.organization_id = $1::uuid
           OR (
             c.organization_id IS NULL
             AND creator.organization_id = $1::uuid
           )
         )
         AND (
           creator.organization_id = $1::uuid
           OR EXISTS (
             SELECT 1
             FROM user_company_membership membership
             WHERE membership.user_id = creator.id
               AND membership.company_id = $1::uuid
           )
         )

       UNION ALL

       SELECT lower(trim(c.email)) AS email,
              c.created_by AS inviter_id,
              c.created_at AS at
       FROM contact c
       INNER JOIN add_deal_form deal ON deal.id = c.referred_by_deal_id
       WHERE lower(trim(c.email)) = ANY($2::text[])
         AND deal.organization_id = $1::uuid
         AND c.created_by IS NOT NULL

       UNION ALL

       SELECT lower(trim(investor.email)) AS email,
              investor.added_by AS inviter_id,
              investor.created_at AS at
       FROM deal_lp_investor investor
       INNER JOIN add_deal_form deal ON deal.id = investor.deal_id
       WHERE deal.organization_id = $1::uuid
         AND investor.added_by IS NOT NULL
         AND position('@' in trim(coalesce(investor.email, ''))) > 1
         AND lower(trim(investor.email)) = ANY($2::text[])
     )
     SELECT DISTINCT ON (email) email, inviter_id
     FROM events
     WHERE inviter_id IS NOT NULL
     ORDER BY email, at ASC NULLS LAST`,
    [orgId, emails],
  );

  const inviterIds = [
    ...new Set(
      found.rows.map((row) => String(row.inviter_id ?? "").trim()).filter(Boolean),
    ),
  ];
  if (inviterIds.length === 0) return invitedBy;

  const inviters = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      username: users.username,
    })
    .from(users)
    .where(inArray(users.id, inviterIds));
  const nameById = new Map(
    inviters.map((user) => [String(user.id), portalUserDisplayName(user)]),
  );
  const inviterByEmail = new Map<string, ContactInvitedBy>();
  for (const row of found.rows) {
    const email = normalizeContactEmailForScope(row.email ?? "");
    const inviterId = String(row.inviter_id ?? "").trim();
    if (!email || !inviterId) continue;
    inviterByEmail.set(email, {
      userId: inviterId,
      displayName: nameById.get(inviterId)?.trim() ?? "",
    });
  }

  for (const row of rows) {
    const contactId = String(row.id).trim().toLowerCase();
    const email = normalizeContactEmailForScope(row.email);
    const inviter = inviterByEmail.get(email);
    if (!contactId || !inviter?.userId) continue;
    invitedBy.set(contactId, inviter);
  }
  return invitedBy;
}

export async function loadContactCreatorUsersById(
  userIds: string[],
): Promise<Map<string, ContactCreatorUserSnapshot>> {
  const ids = [...new Set(userIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      organizationId: users.organizationId,
      email: users.email,
    })
    .from(users)
    .where(inArray(users.id, ids));

  const map = new Map<string, ContactCreatorUserSnapshot>();
  for (const row of rows) {
    const id = String(row.id).trim();
    if (!id) continue;
    map.set(id, {
      id,
      role: row.role ?? null,
      organizationId: row.organizationId ?? null,
      email: row.email ?? null,
    });
  }
  return map;
}

/**
 * Contacts are scoped by the **creator’s** organization: all contacts whose
 * `created_by` is a user in that org share one pool for unique email / phone.
 * Creators with no `organization_id` (platform admin) use a global pool.
 */
async function assertContactEmailPhoneUniqueForCreatorScope(params: {
  creatorUserId: string;
  email: string;
  phone: string;
  excludeContactId?: string;
  /**
   * Existing row’s org on update; omit on insert (derived from creator).
   * `null` = legacy row with no org column set — use creator’s org member list only.
   */
  existingContactOrganizationId?: string | null;
}): Promise<void> {
  const emailNorm = normalizeContactEmailForScope(params.email);
  const phoneTrim = String(params.phone ?? "").trim();
  const phoneCanonical = phoneTrim ? canonicalUsPhoneKey10(phoneTrim) : null;

  const orgId =
    params.existingContactOrganizationId !== undefined
      ? params.existingContactOrganizationId
      : await resolveOrganizationIdForUserId(params.creatorUserId);

  let scopePredicate: SQL;
  if (
    await viewerShouldSeeOnlySelfCreatedContacts(
      params.creatorUserId,
      undefined,
      orgId,
    )
  ) {
    scopePredicate = eq(contact.createdBy, params.creatorUserId);
  } else if (!orgId) {
    scopePredicate = sql`true`;
  } else {
    const memberIds = await userIdsInOrganization(orgId);
    if (memberIds.length === 0) {
      scopePredicate = sql`false`;
    } else {
      scopePredicate = or(
        eq(contact.organizationId, orgId),
        and(isNull(contact.organizationId), inArray(contact.createdBy, memberIds))!,
      )!;
    }
  }

  const emailMatch = sql`lower(trim(${contact.email})) = ${emailNorm}`;
  const phoneMatch =
    phoneCanonical
      ? sql`right(regexp_replace(coalesce(${contact.phone}, ''), '[^0-9]', '', 'g'), 10) = ${phoneCanonical}`
      : sql`false`;

  const conflictClause = or(emailMatch, phoneMatch);
  if (!conflictClause) {
    throw new Error("CONTACT_SCOPE_BUILD_FAILED");
  }
  const parts: SQL[] = [scopePredicate, conflictClause];
  if (params.excludeContactId)
    parts.push(ne(contact.id, params.excludeContactId));

  const dup = await db
    .select({ id: contact.id })
    .from(contact)
    .where(and(...parts))
    .limit(1);

  if (dup[0]) {
    throw new ContactScopeConflictError(
      "A contact in your company already uses this email or phone number.",
    );
  }
}

export async function insertContact(params: {
  input: CreateContactInput;
  createdByUserId: string;
  /** Selected company workspace. Falls back to the creator's primary company. */
  organizationId?: string | null;
}): Promise<ContactRow> {
  const phoneStored = normalizeContactPhoneForWrite(params.input.phone);
  const requestedOrg = normalizeOrganizationUuid(params.organizationId);
  const primaryOrg = await resolveOrganizationIdForUserId(params.createdByUserId);
  const organizationId =
    requestedOrg &&
    (await viewerMayUseOrganizationForContacts(
      params.createdByUserId,
      requestedOrg,
    ))
      ? requestedOrg
      : primaryOrg;
  await assertContactEmailPhoneUniqueForCreatorScope({
    creatorUserId: params.createdByUserId,
    email: params.input.email,
    phone: phoneStored,
    existingContactOrganizationId: organizationId,
  });

  const isPortalUser = await contactEmailMatchesPortalUser(params.input.email);
  const row: ContactInsert = {
    firstName: params.input.firstName,
    lastName: params.input.lastName,
    fullName: buildContactFullName(
      params.input.firstName,
      params.input.lastName,
    ),
    email: params.input.email,
    phone: phoneStored,
    note: params.input.note,
    tags: params.input.tags,
    lists: params.input.lists,
    owners: params.input.owners,
    status: "active",
    createdBy: params.createdByUserId,
    organizationId: organizationId ?? null,
    isPortalUser,
    relationship506b: "NO",
    importSource: params.input.importSource ?? "manual",
  };
  const [inserted] = await db.insert(contact).values(row).returning();
  if (!inserted) throw new Error("INSERT_CONTACT_FAILED");
  await syncOrganizationContactLabels({
    organizationId: organizationId ?? null,
    tags: params.input.tags,
    lists: params.input.lists,
  });
  queueGhlContactRowSync(inserted);
  return inserted;
}

/**
 * CRM `contact.id` values for investors associated with this Lead / Admin /
 * Co-sponsor (Investors-tab **Sponsor name**):
 *
 * 1. `deal_lp_investor.added_by` / `deal_member.added_by` is this viewer
 *    (or an equivalent portal account) — any deal; the viewer does **not**
 *    have to already be on that deal roster.
 * 2. When `includeSameOrganization` is set, the adder belongs to the same
 *    company, so investors still show if the Lead/Admin/Co-sponsor has not
 *    been added to the deal yet.
 * 3. Contacts this viewer (or equivalent) created.
 */
async function listCrmContactIdsAssociatedWithSponsorViewer(
  viewerUserId: string,
  opts?: { includeSameOrganization?: boolean; organizationId?: string | null },
): Promise<string[]> {
  const uid = String(viewerUserId ?? "").trim();
  if (!uid) return [];
  const viewerEquivalents = await listEquivalentPortalUserIdsForUser(uid);
  const sponsorIds =
    viewerEquivalents.length > 0 ? viewerEquivalents : [uid];
  const requestedOrg = normalizeOrganizationUuid(opts?.organizationId);
  const orgId = opts?.includeSameOrganization
    ? (requestedOrg ?? (await resolveOrganizationIdForUserId(uid)) ?? null)
    : null;

  const res = await pool.query<{ contact_id: string }>(
    `WITH sponsors AS (
       SELECT unnest($1::uuid[]) AS user_id
     ),
     effective AS (
       SELECT lp.deal_id, lp.contact_member_id, lp.email, lp.added_by
       FROM deal_lp_investor lp
       WHERE lp.added_by IS NOT NULL
         AND lp.is_draft = false
         AND trim(coalesce(lp.contact_member_id, '')) <> ''
       UNION ALL
       SELECT dm.deal_id, dm.contact_member_id, NULL::text AS email, dm.added_by
       FROM deal_member dm
       WHERE dm.added_by IS NOT NULL
         AND dm.is_draft = false
         AND trim(coalesce(dm.contact_member_id, '')) <> ''
         AND lower(trim(dm.deal_member_role)) IN (
           'lp investor', 'lp investors', 'lp_investor', 'lp_investors'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM deal_lp_investor lp
           WHERE lp.deal_id = dm.deal_id
             AND lp.is_draft = false
             AND lower(trim(lp.contact_member_id)) =
                   lower(trim(dm.contact_member_id))
             AND lp.added_by IS NOT NULL
         )
     ),
     matched AS (
       SELECT e.contact_member_id, e.email
       FROM effective e
       INNER JOIN sponsors s ON e.added_by = s.user_id
       UNION
       SELECT e.contact_member_id, e.email
       FROM effective e
       INNER JOIN users adder ON adder.id = e.added_by
       WHERE $2::uuid IS NOT NULL
         AND (
           adder.organization_id = $2::uuid
           OR EXISTS (
             SELECT 1
             FROM user_company_membership adder_membership
             WHERE adder_membership.user_id = adder.id
               AND adder_membership.company_id = $2::uuid
           )
         )
     ),
     raw_keys AS (
       SELECT DISTINCT lower(trim(contact_member_id)) AS k
       FROM matched
       WHERE trim(coalesce(contact_member_id, '')) <> ''
     ),
     by_id AS (
       SELECT c.id::text AS contact_id
       FROM contact c
       INNER JOIN raw_keys rk ON lower(trim(c.id::text)) = rk.k
     ),
     by_user_email AS (
       SELECT c.id::text AS contact_id
       FROM raw_keys rk
       INNER JOIN users u ON lower(trim(u.id::text)) = rk.k
       INNER JOIN contact c
         ON lower(trim(c.email)) = lower(trim(u.email))
       WHERE trim(coalesce(u.email, '')) <> ''
         AND position('@' in trim(u.email)) > 1
     ),
     by_user_name_org AS (
       SELECT c.id::text AS contact_id
       FROM raw_keys rk
       INNER JOIN users u ON lower(trim(u.id::text)) = rk.k
       INNER JOIN contact c
         ON lower(trim(coalesce(c.first_name, ''))) =
              lower(trim(coalesce(u.first_name, '')))
        AND lower(trim(coalesce(c.last_name, ''))) =
              lower(trim(coalesce(u.last_name, '')))
        AND (
          c.organization_id IS NOT DISTINCT FROM u.organization_id
          OR c.organization_id IS NULL
        )
       WHERE trim(coalesce(u.first_name, '')) <> ''
         AND trim(coalesce(u.last_name, '')) <> ''
         AND (
           lower(trim(coalesce(u.email, ''))) LIKE 'redacted%'
           OR position('@' in lower(trim(coalesce(u.email, '')))) < 1
         )
     ),
     by_lp_email AS (
       SELECT c.id::text AS contact_id
       FROM matched e
       INNER JOIN contact c
         ON lower(trim(c.email)) = lower(trim(e.email))
       WHERE trim(coalesce(e.email, '')) <> ''
         AND position('@' in trim(e.email)) > 1
     ),
     by_created AS (
       SELECT c.id::text AS contact_id
       FROM contact c
       INNER JOIN sponsors s ON c.created_by = s.user_id
     )
     SELECT DISTINCT contact_id FROM by_id
     UNION
     SELECT DISTINCT contact_id FROM by_user_email
     UNION
     SELECT DISTINCT contact_id FROM by_user_name_org
     UNION
     SELECT DISTINCT contact_id FROM by_lp_email
     UNION
     SELECT DISTINCT contact_id FROM by_created`,
    [sponsorIds, orgId],
  );

  return [
    ...new Set(
      res.rows
        .map((r) => String(r.contact_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * CRM `contact.id` values a Co-sponsor may see and edit:
 * - contacts for investors whose **Sponsor name** on a co-sponsor deal resolves to
 *   this viewer (Investor → Sponsor/Co-sponsor via `deal_lp_investor.added_by` /
 *   `deal_member.added_by`, including equivalent portal accounts)
 * - contacts the current co-sponsor (or equivalent) created (`created_by`)
 *
 * This is the deal investor relationship, not “any co-sponsor on the deal” and not
 * contact-table provenance alone.
 */
async function listCrmContactIdsOnViewerCoSponsorDeals(
  viewerUserId: string,
): Promise<string[]> {
  return listCrmContactIdsAssociatedWithSponsorViewer(viewerUserId, {
    includeSameOrganization: false,
  });
}

function inContactIdsSql(ids: string[]): SQL | null {
  const uniq = [
    ...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)),
  ];
  if (uniq.length === 0) return null;
  return inArray(contact.id, uniq);
}

/** Company-wide sponsor association (condition 2), not a random company user. */
async function viewerIncludesSameOrganizationAssociatedInvestors(
  viewerUserId: string,
  roleForScope: string | null | undefined,
  organizationId?: string | null,
): Promise<boolean> {
  if (isCompanyAdminRole(roleForScope)) return true;
  if (
    await viewerIsLeadOrAdminSponsorOnAnyDeal(viewerUserId, organizationId)
  ) {
    return true;
  }
  return false;
}

/**
 * Company Admin and Company Member accounts belong on Org Members.
 * A company list hides staff of that company. The platform-wide list hides
 * every company admin and company member, except a sponsor copy that lives in
 * a company they do not belong to.
 */
const CONTACT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Contacts created by people who belong to this company (primary org or
 * membership). Company admin and lead sponsors of that company use this to
 * see contacts a member filed while co-sponsoring another company.
 */
function contactsCreatedByOrganizationMembersWhere(orgId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM users creator
    WHERE creator.id = ${contact.createdBy}
      AND (
        creator.organization_id = ${orgId}::uuid
        OR EXISTS (
          SELECT 1
          FROM user_company_membership creator_membership
          WHERE creator_membership.user_id = creator.id
            AND creator_membership.company_id = ${orgId}::uuid
        )
      )
  )`;
}

/**
 * Contacts created or invited by a Co-sponsor who does not belong to the
 * company being listed. That other company does not see the rows.
 * The co-sponsor's own company still sees them, including its company admin
 * and lead sponsors. `exemptUserIds` keeps the co-sponsor's own rows visible
 * when he is the viewer. The co-sponsor's own contact card stays on the list.
 * Pass null to apply this on the platform-wide list, matching each contact's company.
 */
function excludeOutsideCoSponsorContactsWhere(
  orgId: string | null,
  exemptUserIds: string[] = [],
): SQL {
  const dealOrgMatch = orgId
    ? sql`f.organization_id = ${orgId}::uuid`
    : sql`f.organization_id IS NOT DISTINCT FROM ${contact.organizationId}`;
  const sponsorOutsideListedCompany = orgId
    ? sql`sponsor.organization_id IS DISTINCT FROM ${orgId}::uuid
        AND NOT EXISTS (
          SELECT 1
          FROM user_company_membership sponsor_membership
          WHERE sponsor_membership.user_id = sponsor.id
            AND sponsor_membership.company_id = ${orgId}::uuid
        )`
    : sql`sponsor.organization_id IS DISTINCT FROM ${contact.organizationId}
        AND NOT EXISTS (
          SELECT 1
          FROM user_company_membership sponsor_membership
          WHERE sponsor_membership.user_id = sponsor.id
            AND sponsor_membership.company_id = ${contact.organizationId}
        )`;
  const dealOrgMatchAny = orgId
    ? sql`f_lead.organization_id = ${orgId}::uuid`
    : sql`f_lead.organization_id IS NOT DISTINCT FROM ${contact.organizationId}`;
  const exempt = [
    ...new Set(
      exemptUserIds
        .map((id) => String(id ?? "").trim())
        .filter((id) => CONTACT_UUID_RE.test(id)),
    ),
  ];
  const exemptSql =
    exempt.length > 0
      ? sql`AND sponsor.id NOT IN (${sql.join(
          exempt.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  const coSponsorOnDeal = sql`(
    EXISTS (
      SELECT 1
      FROM deal_member dm
      WHERE dm.deal_id = f.id
        AND dm.is_draft = false
        AND replace(lower(trim(dm.deal_member_role)), '_', ' ') IN ('co-sponsor', 'co sponsor')
        AND (
          lower(trim(dm.contact_member_id)) = lower(sponsor.id::text)
          OR EXISTS (
            SELECT 1
            FROM contact sponsor_contact
            WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(dm.contact_member_id))
              AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM deal_investment di
      WHERE di.deal_id = f.id
        AND di.is_draft = false
        AND trim(di.contact_id) <> '__portal_investment_autosave__'
        AND replace(lower(trim(di.investor_role)), '_', ' ') IN ('co-sponsor', 'co sponsor')
        AND (
          lower(trim(di.contact_id)) = lower(sponsor.id::text)
          OR EXISTS (
            SELECT 1
            FROM contact sponsor_contact
            WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(di.contact_id))
              AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
          )
        )
    )
  )`;
  const leadOrAdminOnCompanyDeal = sql`(
    EXISTS (
      SELECT 1
      FROM deal_member lead_dm
      WHERE lead_dm.deal_id = f_lead.id
        AND lead_dm.is_draft = false
        AND (
          lower(trim(lead_dm.deal_member_role)) IN (
            'lead sponsor', 'lead_sponsor', 'admin sponsor', 'admin_sponsor'
          )
          OR (
            position('lead' in lower(trim(lead_dm.deal_member_role))) > 0
            AND position('sponsor' in lower(trim(lead_dm.deal_member_role))) > 0
          )
        )
        AND (
          lower(trim(lead_dm.contact_member_id)) = lower(sponsor.id::text)
          OR EXISTS (
            SELECT 1
            FROM contact sponsor_contact
            WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(lead_dm.contact_member_id))
              AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM deal_investment lead_di
      WHERE lead_di.deal_id = f_lead.id
        AND lead_di.is_draft = false
        AND trim(lead_di.contact_id) <> '__portal_investment_autosave__'
        AND (
          lower(trim(lead_di.investor_role)) IN (
            'lead sponsor', 'lead_sponsor', 'admin sponsor', 'admin_sponsor'
          )
          OR (
            position('lead' in lower(trim(lead_di.investor_role))) > 0
            AND position('sponsor' in lower(trim(lead_di.investor_role))) > 0
          )
        )
        AND (
          lower(trim(lead_di.contact_id)) = lower(sponsor.id::text)
          OR EXISTS (
            SELECT 1
            FROM contact sponsor_contact
            WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(lead_di.contact_id))
              AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
          )
        )
    )
  )`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM users sponsor
    WHERE position('@' in trim(coalesce(sponsor.email, ''))) > 1
      AND lower(trim(${contact.email})) <> lower(trim(sponsor.email))
      ${exemptSql}
      AND (
        ${contact.createdBy} = sponsor.id
        OR EXISTS (
          SELECT 1
          FROM users invitee
          WHERE lower(trim(invitee.email)) = lower(trim(${contact.email}))
            AND position('@' in trim(coalesce(invitee.email, ''))) > 1
            AND invitee.referred_by_user_id = sponsor.id
        )
      )
      AND EXISTS (
        SELECT 1
        FROM add_deal_form f
        WHERE ${dealOrgMatch}
          AND ${sponsorOutsideListedCompany}
          AND ${coSponsorOnDeal}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM add_deal_form f_lead
        WHERE ${dealOrgMatchAny}
          AND ${leadOrAdminOnCompanyDeal}
      )
  )`;
}

/** Detail view: same hide rule as the Contacts list. */
async function contactIsPrivateToAnotherCoSponsor(
  viewerUserId: string,
  row: ContactRow,
  organizationId: string | null,
): Promise<boolean> {
  const contactId = String(row.id ?? "").trim();
  if (!CONTACT_UUID_RE.test(contactId)) return false;
  const equivalentIds = await listEquivalentPortalUserIdsForUser(viewerUserId);
  const exempt =
    equivalentIds.length > 0 ? equivalentIds : [viewerUserId];
  const visibleToViewer = excludeOutsideCoSponsorContactsWhere(
    organizationId,
    exempt,
  );
  const found = await db
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), sql`NOT (${visibleToViewer})`)!)
    .limit(1);
  return found.length > 0;
}

function excludeCompanyStaffFromContactsWhere(orgId: string | null): SQL {
  const staffRole = sql`lower(trim(u.role)) in (${COMPANY_ADMIN}, ${COMPANY_USER})`;
  const membershipRole = sql`lower(trim(m.role)) in (${COMPANY_ADMIN}, ${COMPANY_USER})`;
  const staffOfListedCompany = orgId
    ? sql`(
        (${staffRole} AND u.organization_id = ${orgId}::uuid)
        OR EXISTS (
          SELECT 1
          FROM user_company_membership m
          WHERE m.user_id = u.id
            AND m.company_id = ${orgId}::uuid
            AND ${membershipRole}
        )
      )`
    : sql`(
        ${staffRole}
        AND NOT (
          ${contact.importSource} in ('deal_sponsor', 'deal_org_move')
          AND ${contact.organizationId} IS NOT NULL
          AND u.organization_id IS DISTINCT FROM ${contact.organizationId}
          AND NOT EXISTS (
            SELECT 1
            FROM user_company_membership m
            WHERE m.user_id = u.id
              AND m.company_id = ${contact.organizationId}
              AND ${membershipRole}
          )
        )
      )`;
  return sql`NOT EXISTS (
    SELECT 1
    FROM users u
    WHERE lower(trim(u.email)) = lower(trim(${contact.email}))
      AND position('@' in trim(coalesce(u.email, ''))) > 1
      AND ${staffOfListedCompany}
  )`;
}

async function ensureOutsideSponsorsAreOrganizationContacts(
  organizationId: string | null,
  requestedByUserId: string,
): Promise<void> {
  const orgId = normalizeOrganizationUuid(organizationId);
  if (!orgId) return;
  await syncOutsideSponsorsIntoOrganizationContacts(orgId, requestedByUserId);
}

/**
 * All Contacts list:
 * - **platform_admin**: company CRM for the requested organization (Customers)
 *   or the active workspace. With no company selected the list is empty.
 *   Self-signups are not mixed in; they are served by {@link listPlatformVisibleContacts}.
 * - Users tied to a company: contacts with **`organization_id` = viewer’s org**, plus **legacy**
 *   rows (`organization_id` null) whose `created_by` is anyone in that org.
 * - No company / org: only contacts they created themselves.
 *
 * Self-registered investors who opted in (**`visible_to_users`**) are not mixed in here;
 * they are served separately by {@link listPlatformVisibleContacts}.
 *
 * **Lead / Admin** (and company admin / company member): CRM rows for investors whose
 * Investors-tab **Sponsor name** (`added_by`) is this viewer, or (same selected
 * company) belongs to that company. Contacts a co-sponsor added stay on that
 * co-sponsor's list only. Co-sponsors see only investors whose Sponsor name is
 * them, plus contacts they created — not the rest of the org CRM and not
 * another co-sponsor's contacts. Lead or admin status is judged on deals of
 * the selected company, not the viewer's primary company.
 *
 * Other roles see external CRM rows only, plus investors they personally added.
 */
async function buildContactsScopeWhere(
  viewerUserId: string,
  viewerRole: string | null | undefined,
  requestedOrganizationId?: string | null,
): Promise<SQL | null> {
  const ctx = await getViewerContactScopeContext(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
  );
  await ensureOutsideSponsorsAreOrganizationContacts(
    ctx.organizationId,
    viewerUserId,
  );
  const sponsorTeamSeesFullCrm = await viewerIsLeadOrAdminSponsorOnAnyDeal(
    viewerUserId,
    ctx.organizationId,
  );
  const coSponsorNarrow = await viewerShouldSeeOnlySelfCreatedContacts(
    viewerUserId,
    ctx.roleForScope,
    ctx.organizationId,
  );
  const includeSameOrganization =
    isCompanyAdminRole(ctx.roleForScope) || sponsorTeamSeesFullCrm;

  const vis =
    isCompanyAdminRole(ctx.roleForScope) ||
    isPlatformAdminRole(ctx.roleForScope) ||
    sponsorTeamSeesFullCrm ||
    coSponsorNarrow
      ? fullOrgContactListVisibilityWhere(ctx.viewerEmailNorm)
      : contactsVisibilityWhereForRole(ctx.roleForScope, ctx.viewerEmailNorm);

  const associatedInvestorIds =
    await listCrmContactIdsAssociatedWithSponsorViewer(viewerUserId, {
      includeSameOrganization,
      organizationId: ctx.organizationId,
    });
  const associatedIdsSql = inContactIdsSql(associatedInvestorIds);
  const notPlatformAdminOnlyOrAssociated = associatedIdsSql
    ? or(eq(contact.platformAdminOnly, false), associatedIdsSql)!
    : excludePlatformAdminOnlyContactsWhere();
  const visOrAssociated = associatedIdsSql
    ? or(vis, associatedIdsSql)!
    : vis;

  const equivalentIds = await listEquivalentPortalUserIdsForUser(viewerUserId);
  const referrerIds =
    equivalentIds.length > 0 ? equivalentIds : [viewerUserId];
  const invitedByViewer = contactsReferredByUserIdsWhere(referrerIds);
  const visForList = invitedByViewer ? or(vis, invitedByViewer)! : vis;
  const visOrAssociatedForList = invitedByViewer
    ? or(visOrAssociated, invitedByViewer)!
    : visOrAssociated;

  const orgId = ctx.organizationId;

  if (isPlatformAdminRole(ctx.roleForScope)) {
    const requestedOrg = normalizeOrganizationUuid(requestedOrganizationId);
    // All Contacts is every company. A company id is only applied when a
    // caller asks for one company, such as Customers → Contacts.
    if (!requestedOrg) {
      return and(
        fullOrgContactListVisibilityWhere(ctx.viewerEmailNorm),
        excludeCompanyStaffFromContactsWhere(null),
        excludeOutsideCoSponsorContactsWhere(null, referrerIds),
      )!;
    }
    if (!orgId) {
      return null;
    }
    const memberIds = await userIdsInOrganization(orgId);
    const legacyMemberContacts =
      memberIds.length > 0
        ? and(
            isNull(contact.organizationId),
            inArray(contact.createdBy, memberIds),
          )!
        : null;
    const orgScope = legacyMemberContacts
      ? or(eq(contact.organizationId, orgId), legacyMemberContacts)!
      : eq(contact.organizationId, orgId);
    const orgList = and(
      orgScope,
      excludePlatformAdminOnlyContactsWhere(),
      visForList,
      excludeCompanyStaffFromContactsWhere(orgId),
    )!;
    return and(
      or(orgList, contactsReferredByOrganizationMembersWhere(orgId))!,
      excludeCompanyStaffFromContactsWhere(orgId),
      excludeOutsideCoSponsorContactsWhere(orgId, referrerIds),
    )!;
  }

  if (!orgId) {
    const creatorIds = referrerIds;
    if (!associatedIdsSql) {
      return and(
        inArray(contact.createdBy, creatorIds),
        visForList,
        excludePlatformAdminOnlyContactsWhere(),
        excludeCompanyStaffFromContactsWhere(null),
      )!;
    }
    return and(
      or(inArray(contact.createdBy, creatorIds), associatedIdsSql)!,
      visOrAssociatedForList,
      notPlatformAdminOnlyOrAssociated,
      excludeCompanyStaffFromContactsWhere(null),
    )!;
  }

  const memberIds = await userIdsInOrganization(orgId);

  const orgScope = buildOrganizationContactsWhere(orgId, viewerUserId, memberIds);
  const orgOrAssociated = associatedIdsSql
    ? or(orgScope, associatedIdsSql)!
    : orgScope;
  const homeCompanyAdminOrLead =
    isCompanyAdminRole(ctx.roleForScope) || sponsorTeamSeesFullCrm;
  const scopeForList =
    homeCompanyAdminOrLead
      ? or(orgOrAssociated, contactsCreatedByOrganizationMembersWhere(orgId))!
      : orgOrAssociated;

  const parts: SQL[] = [
    scopeForList,
    visOrAssociatedForList,
    notPlatformAdminOnlyOrAssociated,
    excludeCompanyStaffFromContactsWhere(orgId),
    excludeOutsideCoSponsorContactsWhere(orgId, referrerIds),
  ];
  if (coSponsorNarrow) {
    // Same gate as getContact: created by this co-sponsor, or an investor
    // whose Sponsor name is this co-sponsor. Sponsor copies of other people's
    // contacts stay out of the list so a denied detail is not clickable.
    const creatorIds = referrerIds;
    if (!associatedIdsSql) {
      parts.push(inArray(contact.createdBy, creatorIds));
    } else {
      parts.push(
        or(inArray(contact.createdBy, creatorIds), associatedIdsSql)!,
      );
    }
  }

  return and(...parts)!;
}

/**
 * Contacts who signed up through an invite link owned by a member of this
 * company (contacts-page link, deal invite, or offering link).
 * Not filtered by CRM portal-user visibility — this feeds the Customers
 * member dropdown.
 */
export async function listInviteeContactsForOrganization(
  organizationId: string,
): Promise<ContactRow[]> {
  const orgId = String(organizationId ?? "").trim();
  if (!orgId) return [];
  const found = await pool.query<{ id: string }>(
    `SELECT DISTINCT ON (lower(trim(c.email))) c.id
     FROM contact c
     INNER JOIN users invitee
       ON lower(trim(invitee.email)) = lower(trim(c.email))
     INNER JOIN users sponsor
       ON sponsor.id = invitee.referred_by_user_id
     WHERE position('@' in trim(invitee.email)) > 1
       AND (
         sponsor.organization_id = $1::uuid
         OR c.organization_id = $1::uuid
         OR EXISTS (
           SELECT 1
           FROM user_company_membership membership
           WHERE membership.user_id = sponsor.id
             AND membership.company_id = $1::uuid
         )
       )
       AND NOT (
         sponsor.organization_id IS DISTINCT FROM $1::uuid
         AND NOT EXISTS (
           SELECT 1
           FROM user_company_membership sponsor_membership
           WHERE sponsor_membership.user_id = sponsor.id
             AND sponsor_membership.company_id = $1::uuid
         )
         AND EXISTS (
           SELECT 1
           FROM add_deal_form f
           WHERE f.organization_id = $1::uuid
             AND (
               EXISTS (
                 SELECT 1
                 FROM deal_member dm
                 WHERE dm.deal_id = f.id
                   AND dm.is_draft = false
                   AND replace(lower(trim(dm.deal_member_role)), '_', ' ') IN ('co-sponsor', 'co sponsor')
                   AND (
                     lower(trim(dm.contact_member_id)) = lower(sponsor.id::text)
                     OR EXISTS (
                       SELECT 1
                       FROM contact sponsor_contact
                       WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(dm.contact_member_id))
                         AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
                     )
                   )
               )
               OR EXISTS (
                 SELECT 1
                 FROM deal_investment di
                 WHERE di.deal_id = f.id
                   AND di.is_draft = false
                   AND trim(di.contact_id) <> '__portal_investment_autosave__'
                   AND replace(lower(trim(di.investor_role)), '_', ' ') IN ('co-sponsor', 'co sponsor')
                   AND (
                     lower(trim(di.contact_id)) = lower(sponsor.id::text)
                     OR EXISTS (
                       SELECT 1
                       FROM contact sponsor_contact
                       WHERE lower(trim(sponsor_contact.id::text)) = lower(trim(di.contact_id))
                         AND lower(trim(sponsor_contact.email)) = lower(trim(sponsor.email))
                     )
                   )
               )
             )
         )
       )
     ORDER BY lower(trim(c.email)),
       c.platform_admin_only ASC,
       c.created_at ASC NULLS LAST`,
    [orgId],
  );
  const ids = found.rows.map((row) => String(row.id)).filter(Boolean);
  if (ids.length === 0) return [];
  return db.select().from(contact).where(inArray(contact.id, ids));
}

export async function listContactsForViewerScoped(
  viewerUserId: string,
  viewerRole: string | null | undefined,
  requestedOrganizationId?: string | null,
  sort: ContactListSort = "createdAt",
): Promise<ContactRow[]> {
  const where = await buildContactsScopeWhere(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
  );
  if (!where) return [];
  const rows = await db
    .select()
    .from(contact)
    .where(where)
    .orderBy(...contactListOrderBy(sort));
  return dedupeOrgScopedContactsByEmail(
    rows,
    normalizeOrganizationUuid(requestedOrganizationId),
  );
}

function contactCreatedAtMs(row: ContactRow): number {
  const raw = row.createdAt;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * One row per email. Platform admin otherwise sees both the company CRM row
 * and the offering-link / self-signup row for the same person.
 */
function dedupeOrgScopedContactsByEmail(
  rows: ContactRow[],
  orgId: string | null,
): ContactRow[] {
  const indexByEmail = new Map<string, number>();
  const out: ContactRow[] = [];
  const prefer = (current: ContactRow, next: ContactRow): ContactRow => {
    const rank = (row: ContactRow) => {
      const inOrg =
        orgId &&
        String(row.organizationId ?? "").trim().toLowerCase() === orgId
          ? 1
          : 0;
      const crm = row.platformAdminOnly ? 0 : 2;
      return crm + inOrg;
    };
    const currentRank = rank(current);
    const nextRank = rank(next);
    if (currentRank !== nextRank) return nextRank > currentRank ? next : current;
    return contactCreatedAtMs(current) <= contactCreatedAtMs(next)
      ? current
      : next;
  };
  for (const row of rows) {
    const email = normalizeContactEmailForScope(String(row.email ?? ""));
    if (!email.includes("@")) {
      out.push(row);
      continue;
    }
    const existingIndex = indexByEmail.get(email);
    if (existingIndex == null) {
      indexByEmail.set(email, out.length);
      out.push(row);
      continue;
    }
    const current = out[existingIndex];
    if (!current) continue;
    out[existingIndex] = prefer(current, row);
  }
  return out;
}

/** Columns the Contacts search box matches against. */
const contactSearchColumns = [
  searchableColumn(contact.fullName),
  searchableColumn(contact.firstName),
  searchableColumn(contact.lastName),
  searchableColumn(contact.email),
  searchableColumn(contact.phone),
  searchableColumn(contact.note),
  searchableColumn(contact.accreditationStatus),
  sql`coalesce(${contact.tags}::text, '')`,
  sql`coalesce(${contact.lists}::text, '')`,
  sql`coalesce(${contact.owners}::text, '')`,
];

/** A `jsonb` string array (tags / lists / owners) containing `value`, case-insensitively. */
function jsonbArrayContainsIgnoreCase(
  column: typeof contact.tags | typeof contact.owners | typeof contact.lists,
  value: string,
): SQL {
  return sql`exists (
    select 1 from jsonb_array_elements_text(${column}) as elem(v)
    where lower(trim(elem.v)) = ${value.trim().toLowerCase()}
  )`;
}

/**
 * Adds the opted-in self-registered investors a company user is allowed to see
 * to an existing CRM scope.
 *
 * Mirrors what the Contacts page used to do after fetching both lists: skip the
 * viewer's own contact row, and skip anyone whose email already exists as a CRM
 * contact in the organization so the directory shows one row per person.
 * Platform admins keep these rows on their own tab, so the scope is unchanged
 * for them.
 */
async function widenScopeWithOptedInSelfRegistered(
  scope: SQL,
  viewerUserId: string,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<SQL> {
  const ctx = await getViewerContactScopeContext(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
  );
  if (isPlatformAdminRole(ctx.roleForScope)) return scope;

  const parts: SQL[] = [optedInSelfRegisteredContactsWhere()];
  if (ctx.viewerEmailNorm.includes("@")) {
    parts.push(sql`lower(trim(${contact.email})) <> ${ctx.viewerEmailNorm}`);
  }
  if (ctx.organizationId) {
    parts.push(sql`not exists (
      select 1 from ${contact} as crm
      where crm.organization_id = ${ctx.organizationId}
        and crm.platform_admin_only = false
        and lower(trim(crm.email)) = lower(trim(${contact.email}))
    )`);
  }
  const equivalentIds = await listEquivalentPortalUserIdsForUser(viewerUserId);
  const exempt = equivalentIds.length > 0 ? equivalentIds : [viewerUserId];
  return and(
    or(scope, and(...parts)!)!,
    excludeOutsideCoSponsorContactsWhere(ctx.organizationId, exempt),
  )!;
}

export type ContactListFilters = {
  /** Active / Archived tab; omit for both. */
  status?: string;
  tag?: string;
  owner?: string;
  /** Exact label, or `"na"` for contacts with no accreditation set. */
  accreditation?: string;
  /** `ALL_OFFERINGS` | `HIDE_OFFERINGS` | `506B_ONLY` | `506C_ONLY`, or `"unset"`. */
  offeringVisibility?: string;
};

function contactListFilterWhere(filters: ContactListFilters): SQL[] {
  const parts: SQL[] = [];
  if (filters.status) parts.push(eq(contact.status, filters.status));
  if (filters.tag) {
    parts.push(jsonbArrayContainsIgnoreCase(contact.tags, filters.tag));
  }
  if (filters.owner) {
    parts.push(jsonbArrayContainsIgnoreCase(contact.owners, filters.owner));
  }
  const accreditation = filters.accreditation?.trim();
  if (accreditation === "na") {
    parts.push(sql`coalesce(trim(${contact.accreditationStatus}), '') = ''`);
  } else if (accreditation) {
    parts.push(
      sql`lower(trim(coalesce(${contact.accreditationStatus}, ''))) = ${accreditation.toLowerCase()}`,
    );
  }
  const visibility = filters.offeringVisibility?.trim();
  if (visibility === "unset") {
    parts.push(isNull(contact.showOfferingsVisibility));
  } else if (visibility) {
    parts.push(eq(contact.showOfferingsVisibility, visibility));
  }
  return parts;
}

/**
 * One page of the viewer's CRM list, with search, filters and counts applied in
 * SQL so the caller only enriches the rows it is about to return.
 *
 * `total` counts the rows matching every filter; `activeTotal` / `archivedTotal`
 * ignore the status filter so the Active / Archived tab badges stay correct
 * while one of the tabs is being viewed.
 */
export async function listContactsPageForViewer(params: {
  viewerUserId: string;
  viewerRole?: string | null;
  requestedOrganizationId?: string | null;
  sort?: ContactListSort;
  search?: string;
  filters?: ContactListFilters;
  /**
   * Fold opted-in self-registered investors into the same result set, matching
   * the merged directory the Contacts page used to assemble in the browser.
   */
  includeOptedInSelfRegistered?: boolean;
  limit: number;
  offset: number;
}): Promise<{
  rows: ContactRow[];
  total: number;
  activeTotal: number;
  archivedTotal: number;
}> {
  const baseScope = await buildContactsScopeWhere(
    params.viewerUserId,
    params.viewerRole,
    params.requestedOrganizationId,
  );
  if (!baseScope) {
    return { rows: [], total: 0, activeTotal: 0, archivedTotal: 0 };
  }
  const scope = params.includeOptedInSelfRegistered
    ? await widenScopeWithOptedInSelfRegistered(
        baseScope,
        params.viewerUserId,
        params.viewerRole,
        params.requestedOrganizationId,
      )
    : baseScope;

  const filters = params.filters ?? {};
  const search = searchWhere(contactSearchColumns, params.search ?? "");
  const withoutStatus: SQL[] = [scope];
  if (search) withoutStatus.push(search);
  withoutStatus.push(...contactListFilterWhere({ ...filters, status: undefined }));

  const where = filters.status
    ? and(...withoutStatus, eq(contact.status, filters.status))!
    : and(...withoutStatus)!;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(contact)
      .where(where)
      .orderBy(...contactListOrderBy(params.sort))
      .limit(params.limit)
      .offset(params.offset),
    db
      .select({
        status: contact.status,
        n: sql<number>`count(*)::int`,
      })
      .from(contact)
      .where(and(...withoutStatus)!)
      .groupBy(contact.status),
  ]);

  let activeTotal = 0;
  let archivedTotal = 0;
  for (const row of counted) {
    const n = Number(row.n ?? 0);
    if (String(row.status ?? "").trim().toLowerCase() === "archived") {
      archivedTotal += n;
    } else {
      activeTotal += n;
    }
  }
  const total = filters.status === "archived"
    ? archivedTotal
    : filters.status === "active"
      ? activeTotal
      : activeTotal + archivedTotal;

  return { rows, total, activeTotal, archivedTotal };
}

/**
 * Every contact id matching the current filters, for "select all" and CSV
 * export, which must act on the whole result set rather than the loaded page.
 */
export async function listContactIdsForViewerFilters(params: {
  viewerUserId: string;
  viewerRole?: string | null;
  requestedOrganizationId?: string | null;
  search?: string;
  filters?: ContactListFilters;
  includeOptedInSelfRegistered?: boolean;
}): Promise<string[]> {
  const baseScope = await buildContactsScopeWhere(
    params.viewerUserId,
    params.viewerRole,
    params.requestedOrganizationId,
  );
  if (!baseScope) return [];
  const scope = params.includeOptedInSelfRegistered
    ? await widenScopeWithOptedInSelfRegistered(
        baseScope,
        params.viewerUserId,
        params.viewerRole,
        params.requestedOrganizationId,
      )
    : baseScope;
  const parts: SQL[] = [scope];
  const search = searchWhere(contactSearchColumns, params.search ?? "");
  if (search) parts.push(search);
  parts.push(...contactListFilterWhere(params.filters ?? {}));
  const rows = await db
    .select({ id: contact.id })
    .from(contact)
    .where(and(...parts)!);
  return rows.map((r) => String(r.id));
}

/**
 * Distinct deals per CRM contact for the Contacts "Deals" column.
 *
 * A contact is on a deal through an investment, a deal member row, or an LP
 * roster row. Those keys may be the CRM `contact.id` or a portal `users.id`
 * with the same email. The count matches {@link listDealsForContactForViewer}
 * and is scoped to deals visible to this viewer.
 */
async function listVisibleDealIdsForContactEnrichment(params: {
  viewerUserId: string;
  jwtUserRole: string | undefined;
  requestedOrganizationId?: string | null;
}): Promise<{ unrestricted: true } | { unrestricted: false; dealIds: string[] }> {
  const scope = await resolveDealViewerScope(
    params.viewerUserId,
    params.jwtUserRole,
    params.requestedOrganizationId,
  );
  if (scope.isPlatformAdmin || scope.seesAllDeals) {
    return { unrestricted: true };
  }
  const cacheKey = [
    params.viewerUserId,
    String(params.jwtUserRole ?? ""),
    String(params.requestedOrganizationId ?? ""),
  ].join(":");
  const cached = visibleDealIdsCache.get(cacheKey);
  if (cached) return { unrestricted: false, dealIds: cached };
  const visibleDeals = await listAddDealFormsForViewer(scope);
  const dealIds = [
    ...new Set(
      visibleDeals.map((d) => String(d.id ?? "").trim()).filter(Boolean),
    ),
  ];
  visibleDealIdsCache.set(cacheKey, dealIds);
  return { unrestricted: false, dealIds };
}

export async function countDealInvestmentsByContactIdForViewer(params: {
  viewerUserId: string;
  jwtUserRole: string | undefined;
  contactIds: string[];
  requestedOrganizationId?: string | null;
}): Promise<Map<string, number>> {
  const keys = [
    ...new Set(
      params.contactIds.map((id) => id.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const result = new Map<string, number>();
  for (const k of keys) result.set(k, 0);
  if (keys.length === 0) return result;

  const idParams = sql.join(keys.map((k) => sql`${k}`), sql`, `);

  const visibility = await listVisibleDealIdsForContactEnrichment(params);
  if (!visibility.unrestricted && visibility.dealIds.length === 0) return result;

  const dealInList = () =>
    sql.join(
      (visibility.unrestricted ? [] : visibility.dealIds).map((id) => sql`${id}`),
      sql`, `,
    );
  const investmentDealFilter = visibility.unrestricted
    ? sql``
    : sql`AND di.deal_id IN (${dealInList()})`;
  const memberDealFilter = visibility.unrestricted
    ? sql``
    : sql`AND dm.deal_id IN (${dealInList()})`;
  const lpDealFilter = visibility.unrestricted
    ? sql``
    : sql`AND lp.deal_id IN (${dealInList()})`;

  const executed = await db.execute(sql`
    WITH contact_keys AS (
      SELECT
        lower(trim(c.id::text)) AS contact_key,
        lower(trim(c.email)) AS email_norm
      FROM contact c
      WHERE lower(trim(c.id::text)) IN (${idParams})
    ),
    roster_ids AS (
      SELECT contact_key, contact_key AS roster_id
      FROM contact_keys
      UNION
      SELECT ck.contact_key, lower(trim(other.id::text))
      FROM contact_keys ck
      INNER JOIN contact other
        ON lower(trim(other.email)) = ck.email_norm
      WHERE ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
      UNION
      SELECT ck.contact_key, lower(trim(u.id::text))
      FROM contact_keys ck
      INNER JOIN users u
        ON lower(trim(u.email)) = ck.email_norm
      WHERE ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
    ),
    links AS (
      SELECT r.contact_key, di.deal_id::text AS deal_id
      FROM deal_investment di
      INNER JOIN roster_ids r
        ON lower(trim(di.contact_id)) = r.roster_id
      WHERE di.is_draft = false
        ${investmentDealFilter}
      UNION ALL
      SELECT r.contact_key, dm.deal_id::text
      FROM deal_member dm
      INNER JOIN roster_ids r
        ON lower(trim(dm.contact_member_id)) = r.roster_id
      WHERE dm.is_draft = false
        ${memberDealFilter}
      UNION ALL
      SELECT r.contact_key, lp.deal_id::text
      FROM deal_lp_investor lp
      INNER JOIN roster_ids r
        ON lower(trim(lp.contact_member_id)) = r.roster_id
      WHERE lp.is_draft = false
        ${lpDealFilter}
      UNION ALL
      SELECT ck.contact_key, lp.deal_id::text
      FROM deal_lp_investor lp
      INNER JOIN contact_keys ck
        ON lower(trim(lp.email)) = ck.email_norm
      WHERE lp.is_draft = false
        AND ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
        ${lpDealFilter}
    )
    SELECT links.contact_key AS cid, COUNT(DISTINCT links.deal_id)::int AS cnt
    FROM links
    INNER JOIN add_deal_form d ON d.id::text = links.deal_id
    GROUP BY links.contact_key
  `);
  fillDealCountMapFromExecute(result, executed);
  return result;
}

/** One deal this contact is on, scoped to deals the viewer can see. */
export type ContactDealSummary = {
  dealId: string;
  dealName: string;
  /** Stored roster role (`deal_member`, LP row, or investment). Empty when unset. */
  contactRole: string;
  /** Company that owns the deal (`companies.name`). Empty when unset. */
  dealOrganization: string;
  /**
   * Last time the contact’s portal user opened a `/deals/:id` page.
   * ISO timestamp, or null when they have never opened that deal.
   */
  lastWentAt: string | null;
};

/**
 * Deals linked to one CRM contact: investment, deal member, or LP roster.
 * Role prefers the deal-member role, then the LP role, then the investment role.
 * Organization is the deal’s company name.
 */
export async function listDealsForContactForViewer(params: {
  viewerUserId: string;
  jwtUserRole: string | undefined;
  contactId: string;
  requestedOrganizationId?: string | null;
}): Promise<ContactDealSummary[]> {
  const key = params.contactId.trim().toLowerCase();
  if (!key) return [];

  const visibility = await listVisibleDealIdsForContactEnrichment(params);
  if (!visibility.unrestricted && visibility.dealIds.length === 0) return [];

  const dealFilter = visibility.unrestricted
    ? sql``
    : sql`AND d.id IN (${sql.join(
        visibility.dealIds.map((id) => sql`${id}`),
        sql`, `,
      )})`;

  const executed = await db.execute(sql`
    WITH contact_keys AS (
      SELECT
        lower(trim(c.id::text)) AS contact_key,
        lower(trim(c.email)) AS email_norm
      FROM contact c
      WHERE lower(trim(c.id::text)) = ${key}
    ),
    roster_ids AS (
      SELECT contact_key AS roster_id
      FROM contact_keys
      UNION
      SELECT lower(trim(other.id::text))
      FROM contact_keys ck
      INNER JOIN contact other
        ON lower(trim(other.email)) = ck.email_norm
      WHERE ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
      UNION
      SELECT lower(trim(u.id::text))
      FROM contact_keys ck
      INNER JOIN users u
        ON lower(trim(u.email)) = ck.email_norm
      WHERE ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
    ),
    links AS (
      SELECT di.deal_id::text AS deal_id,
             NULLIF(trim(di.investor_role), '') AS role,
             3 AS priority
      FROM deal_investment di
      INNER JOIN roster_ids r
        ON lower(trim(di.contact_id)) = r.roster_id
      WHERE di.is_draft = false
      UNION ALL
      SELECT dm.deal_id::text,
             NULLIF(trim(dm.deal_member_role), ''),
             1
      FROM deal_member dm
      INNER JOIN roster_ids r
        ON lower(trim(dm.contact_member_id)) = r.roster_id
      WHERE dm.is_draft = false
      UNION ALL
      SELECT lp.deal_id::text,
             NULLIF(trim(lp.role), ''),
             2
      FROM deal_lp_investor lp
      INNER JOIN roster_ids r
        ON lower(trim(lp.contact_member_id)) = r.roster_id
      WHERE lp.is_draft = false
      UNION ALL
      SELECT lp.deal_id::text,
             NULLIF(trim(lp.role), ''),
             2
      FROM deal_lp_investor lp
      INNER JOIN contact_keys ck
        ON lower(trim(lp.email)) = ck.email_norm
      WHERE lp.is_draft = false
        AND ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
    ),
    ranked AS (
      SELECT
        deal_id,
        (ARRAY_AGG(role ORDER BY priority ASC)
          FILTER (WHERE role IS NOT NULL))[1] AS contact_role
      FROM links
      GROUP BY deal_id
    )
    SELECT
      d.id::text AS deal_id,
      d.deal_name AS deal_name,
      COALESCE(ranked.contact_role, '') AS contact_role,
      COALESCE(co.name, '') AS deal_organization,
      visit.last_went_at AS last_went_at
    FROM ranked
    INNER JOIN add_deal_form d ON d.id::text = ranked.deal_id
    LEFT JOIN companies co ON co.id = d.organization_id
    LEFT JOIN LATERAL (
      SELECT MAX(n.updated_at) AS last_went_at
      FROM contact_keys ck
      INNER JOIN users u
        ON lower(trim(u.email)) = ck.email_norm
      INNER JOIN user_page_navigations n
        ON n.user_id = u.id
      WHERE ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
        AND position(('/deals/' || d.id::text) in n.page_path) > 0
    ) visit ON TRUE
    WHERE TRUE
      ${dealFilter}
    ORDER BY lower(trim(d.deal_name)) ASC, d.id ASC
  `);

  const raw = executed as unknown as { rows?: unknown[] } | unknown[];
  const list = Array.isArray(raw) ? raw : (raw.rows ?? []);
  const out: ContactDealSummary[] = [];
  for (const row of list) {
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const dealId = String(r.deal_id ?? r.dealId ?? "").trim();
    if (!dealId) continue;
    const lastRaw = r.last_went_at ?? r.lastWentAt;
    let lastWentAt: string | null = null;
    if (lastRaw instanceof Date && !Number.isNaN(lastRaw.getTime())) {
      lastWentAt = lastRaw.toISOString();
    } else if (typeof lastRaw === "string" && lastRaw.trim()) {
      const parsed = new Date(lastRaw);
      lastWentAt = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    out.push({
      dealId,
      dealName: String(r.deal_name ?? r.dealName ?? "").trim(),
      contactRole: String(r.contact_role ?? r.contactRole ?? "").trim(),
      dealOrganization: String(
        r.deal_organization ?? r.dealOrganization ?? "",
      ).trim(),
      lastWentAt,
    });
  }
  return out;
}

/**
 * Portal user who first put each contact on a deal (`deal_member.added_by` /
 * `deal_lp_investor.added_by`), keyed by lowercased contact id. Roster keys may be
 * the CRM `contact.id` or a portal `users.id`, so both are matched (same bridge as
 * the Deals column). Scoped to deals visible to this viewer.
 *
 * Used for the Owners column of self-registered contacts, which have no CRM owner.
 */
export async function resolveDealAdderNamesByContactIdForViewer(params: {
  viewerUserId: string;
  jwtUserRole: string | undefined;
  contactIds: string[];
  requestedOrganizationId?: string | null;
}): Promise<Map<string, string>> {
  const keys = [
    ...new Set(
      params.contactIds.map((id) => id.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const result = new Map<string, string>();
  if (keys.length === 0) return result;

  const visibility = await listVisibleDealIdsForContactEnrichment(params);

  let memberDealFilter = sql``;
  let lpDealFilter = sql``;
  if (!visibility.unrestricted) {
    const dealIds = visibility.dealIds;
    if (dealIds.length === 0) return result;
    const dealIdParams = sql.join(
      dealIds.map((id) => sql`${id}`),
      sql`, `,
    );
    memberDealFilter = sql`AND dm.deal_id IN (${dealIdParams})`;
    lpDealFilter = sql`AND lp.deal_id IN (${dealIdParams})`;
  }

  const idParams = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );

  const executed = await db.execute(sql`
    WITH contact_keys AS (
      SELECT
        lower(trim(c.id::text)) AS contact_key,
        lower(trim(c.email)) AS email_norm
      FROM contact c
      WHERE lower(trim(c.id::text)) IN (${idParams})
    ),
    links AS (
      SELECT ck.contact_key, dm.added_by::text AS adder_id, dm.created_at
      FROM deal_member dm
      INNER JOIN contact_keys ck
        ON lower(trim(dm.contact_member_id)) = ck.contact_key
      WHERE dm.is_draft = false
        AND dm.added_by IS NOT NULL
        ${memberDealFilter}
      UNION ALL
      SELECT ck.contact_key, dm.added_by::text AS adder_id, dm.created_at
      FROM deal_member dm
      INNER JOIN users u
        ON u.id::text = trim(both from dm.contact_member_id)
      INNER JOIN contact_keys ck
        ON lower(trim(u.email)) = ck.email_norm
      WHERE dm.is_draft = false
        AND dm.added_by IS NOT NULL
        AND ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
        ${memberDealFilter}
      UNION ALL
      SELECT ck.contact_key, lp.added_by::text AS adder_id, lp.created_at
      FROM deal_lp_investor lp
      INNER JOIN contact_keys ck
        ON lower(trim(lp.contact_member_id)) = ck.contact_key
      WHERE lp.is_draft = false
        AND lp.added_by IS NOT NULL
        ${lpDealFilter}
      UNION ALL
      SELECT ck.contact_key, lp.added_by::text AS adder_id, lp.created_at
      FROM deal_lp_investor lp
      INNER JOIN users u
        ON u.id::text = trim(both from lp.contact_member_id)
      INNER JOIN contact_keys ck
        ON lower(trim(u.email)) = ck.email_norm
      WHERE lp.is_draft = false
        AND lp.added_by IS NOT NULL
        AND ck.email_norm <> ''
        AND position('@' in ck.email_norm) > 1
        ${lpDealFilter}
    ),
    ranked AS (
      SELECT
        contact_key,
        adder_id,
        row_number() OVER (
          PARTITION BY contact_key
          ORDER BY created_at ASC
        ) AS rn
      FROM links
    )
    SELECT contact_key AS cid, adder_id AS adder
    FROM ranked
    WHERE rn = 1
  `);

  const adderIdByContactKey = new Map<string, string>();
  const raw = executed as unknown as { rows?: unknown[] } | unknown[];
  const list = Array.isArray(raw) ? raw : (raw.rows ?? []);
  for (const row of list) {
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const cid = String(r.cid ?? r.CID ?? "").trim().toLowerCase();
    const adder = String(r.adder ?? r.ADDER ?? "").trim();
    if (cid && adder) adderIdByContactKey.set(cid, adder);
  }

  const nameByAdderId = new Map<string, string>();
  await Promise.all(
    [...new Set(adderIdByContactKey.values())].map(async (adderId) => {
      nameByAdderId.set(adderId, (await getUserDisplayNameById(adderId)).trim());
    }),
  );

  for (const [cid, adderId] of adderIdByContactKey) {
    const name = nameByAdderId.get(adderId) ?? "";
    if (name) result.set(cid, name);
  }
  return result;
}

function fillDealCountMapFromExecute(
  result: Map<string, number>,
  executed: unknown,
): void {
  const raw = executed as unknown as
    | { rows?: unknown[] }
    | unknown[];
  const list = Array.isArray(raw) ? raw : (raw.rows ?? []);
  for (const row of list) {
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const cid = String(r.cid ?? r.CID ?? "").trim().toLowerCase();
    const n = Number(r.cnt ?? r.CNT);
    if (cid) result.set(cid, Number.isFinite(n) ? n : 0);
  }
}

/**
 * CRM contacts for All Contacts. Scoped to the viewer's active organization;
 * **platform_admin** sees that company CRM only (self-signups stay on Platform Contacts).
 */
export async function listContactsForViewer(
  viewerUserId: string,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
  sort: ContactListSort = "createdAt",
): Promise<ContactRow[]> {
  return listContactsForViewerScoped(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
    sort,
  );
}

/**
 * Contacts the viewer may see, limited to the requested ids.
 * The contacts table asks for deal counts by id, so this must not depend on
 * scanning a directory that was loaded for a different company.
 */
export async function listViewerContactsByIds(params: {
  viewerUserId: string;
  viewerRole?: string | null;
  requestedOrganizationId?: string | null;
  contactIds: string[];
}): Promise<ContactRow[]> {
  const ids = [
    ...new Set(params.contactIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (ids.length === 0) return [];

  const orgWhere = await buildContactsScopeWhere(
    params.viewerUserId,
    params.viewerRole,
    params.requestedOrganizationId,
  );
  const orgRows = orgWhere
    ? await db
        .select()
        .from(contact)
        .where(and(orgWhere, inArray(contact.id, ids)))
    : [];

  const [viewer] = await db
    .select({ email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, params.viewerUserId))
    .limit(1);
  const role = String(viewer?.role ?? params.viewerRole ?? "").trim();
  const viewerEmailNorm = normalizeContactEmailForScope(viewer?.email ?? "");
  const platformVisibility = isPlatformAdminRole(role)
    ? or(eq(contact.platformAdminOnly, true), eq(contact.visibleToUsers, true))!
    : optedInSelfRegisteredContactsWhere();
  const platformParts: SQL[] = [platformVisibility, inArray(contact.id, ids)];
  if (viewerEmailNorm.includes("@")) {
    platformParts.push(
      sql`lower(trim(${contact.email})) <> ${viewerEmailNorm}`,
    );
  }
  const platformRows = await db
    .select()
    .from(contact)
    .where(and(...platformParts)!);

  const byId = new Map<string, ContactRow>();
  for (const row of [...orgRows, ...platformRows]) {
    byId.set(String(row.id).trim().toLowerCase(), row);
  }
  return [...byId.values()];
}

export type OrganizationContactCountOption = {
  organizationId: string;
  name: string;
  contactCount: number;
};

/**
 * Every company, with how many CRM contacts belong to that company.
 * A direct count so the platform-admin filter does not depend on loading
 * the full contact directory.
 */
export async function listOrganizationsWithContactCountsForViewer(): Promise<
  OrganizationContactCountOption[]
> {
  const res = await pool.query<{
    id: string;
    name: string | null;
    contact_count: number | string;
  }>(
    `SELECT co.id::text AS id,
            co.name,
            COUNT(c.id)::int AS contact_count
     FROM companies co
     LEFT JOIN contact c
       ON c.organization_id = co.id
      AND c.platform_admin_only = false
     GROUP BY co.id, co.name
     ORDER BY lower(co.name) ASC`,
  );
  return res.rows
    .map((row) => {
      const organizationId = String(row.id ?? "").trim();
      const name = String(row.name ?? "").trim();
      const parsed = Number(row.contact_count);
      return {
        organizationId,
        name: name || "Untitled organization",
        contactCount: Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
      };
    })
    .filter((row) => row.organizationId.length > 0);
}

export async function listContactsForViewerCached(
  viewerUserId: string,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
  sort: ContactListSort = "createdAt",
): Promise<ContactRow[]> {
  const key = [
    "org",
    viewerUserId,
    String(viewerRole ?? ""),
    String(requestedOrganizationId ?? ""),
    sort,
  ].join(":");
  const cached = contactDirectoryCache.get(key) as ContactRow[] | undefined;
  if (cached) return cached;
  const rows = await listContactsForViewer(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
    sort,
  );
  contactDirectoryCache.set(key, rows);
  return rows;
}

export async function getContactById(
  contactId: string,
): Promise<ContactRow | undefined> {
  const [row] = await db
    .select()
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row;
}

async function viewerCanAccessContactCreator(
  viewerUserId: string,
  createdByUserId: string,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<boolean> {
  const ctx = await getViewerContactScopeContext(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
  );
  if (isPlatformAdminRole(ctx.roleForScope)) {
    if (!ctx.organizationId) return false;
    return userHasAccessToOrganization(createdByUserId, ctx.organizationId);
  }
  if (viewerUserId === createdByUserId) return true;
  const orgId = ctx.organizationId;
  if (!orgId) return false;
  if (await userHasAccessToOrganization(createdByUserId, orgId)) return true;
  const creatorOrgId = await resolveOrganizationIdForUserId(createdByUserId);
  return creatorOrgId === orgId;
}

async function contactIdIsSponsorAssociatedInvestor(
  viewerUserId: string,
  contactId: string,
  includeSameOrganization: boolean,
  organizationId?: string | null,
): Promise<boolean> {
  const id = String(contactId ?? "").trim();
  if (!id) return false;
  const dealRelatedIds = await listCrmContactIdsAssociatedWithSponsorViewer(
    viewerUserId,
    { includeSameOrganization, organizationId },
  );
  return dealRelatedIds.includes(id);
}

/** Same rules as list scope: creator, shared `organization_id`, or legacy creator-org match. */
async function viewerCanAccessContactRow(
  viewerUserId: string,
  row: ContactRow,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<boolean> {
  const ctx = await getViewerContactScopeContext(
    viewerUserId,
    viewerRole,
    requestedOrganizationId,
  );
  const includeSameOrganization =
    await viewerIncludesSameOrganizationAssociatedInvestors(
      viewerUserId,
      ctx.roleForScope,
      ctx.organizationId,
    );
  if (
    await contactIsPrivateToAnotherCoSponsor(
      viewerUserId,
      row,
      ctx.organizationId,
    )
  ) {
    return false;
  }
  if (isPlatformAdminRole(ctx.roleForScope)) return true;
  if (isPlatformAdminOnlyContactRow(row)) {
    if (isOptedInSelfRegisteredContactRow(row)) return true;
    return contactIdIsSponsorAssociatedInvestor(
      viewerUserId,
      row.id,
      includeSameOrganization,
      ctx.organizationId,
    );
  }
  if (
    await viewerShouldSeeOnlySelfCreatedContacts(
      viewerUserId,
      ctx.roleForScope,
      ctx.organizationId,
    )
  ) {
    const equivalentIds = await listEquivalentPortalUserIdsForUser(
      viewerUserId,
    );
    const creatorSet = new Set(
      (equivalentIds.length > 0 ? equivalentIds : [viewerUserId]).map((id) =>
        String(id).toLowerCase(),
      ),
    );
    if (creatorSet.has(String(row.createdBy ?? "").toLowerCase())) return true;
    const dealRelatedIds =
      await listCrmContactIdsOnViewerCoSponsorDeals(viewerUserId);
    return dealRelatedIds.includes(String(row.id ?? "").trim());
  }
  if (viewerUserId === row.createdBy) return true;
  const viewerOrg = ctx.organizationId;
  if (
    viewerOrg &&
    row.organizationId &&
    row.organizationId === viewerOrg
  ) {
    return true;
  }
  const contactOrgDiffers =
    Boolean(viewerOrg) &&
    Boolean(row.organizationId) &&
    row.organizationId !== viewerOrg;
  if (contactOrgDiffers && viewerOrg) {
    const creatorBelongsToViewerCompany =
      (await userHasAccessToOrganization(row.createdBy, viewerOrg)) ||
      (await resolveOrganizationIdForUserId(row.createdBy)) === viewerOrg;
    const viewerIsHomeAdminOrLead =
      isCompanyAdminRole(ctx.roleForScope) ||
      (await viewerIsLeadOrAdminSponsorOnAnyDeal(viewerUserId, viewerOrg));
    if (creatorBelongsToViewerCompany && viewerIsHomeAdminOrLead) return true;
  }
  if (
    await contactIdIsSponsorAssociatedInvestor(
      viewerUserId,
      row.id,
      includeSameOrganization,
      ctx.organizationId,
    )
  )
    return true;
  if (contactOrgDiffers) return false;
  return viewerCanAccessContactCreator(
    viewerUserId,
    row.createdBy,
    viewerRole,
    requestedOrganizationId,
  );
}

export type UpdateContactFieldsInput = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  note: string;
  tags: string[];
  lists: string[];
  owners: string[];
  lastEditReason: string;
};

export async function updateContactFieldsForViewer(
  viewerUserId: string,
  contactId: string,
  fields: UpdateContactFieldsInput,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;

  const emailToStore = fields.email;
  const phoneStored = normalizeContactPhoneForWrite(fields.phone);
  await assertContactEmailPhoneUniqueForCreatorScope({
    creatorUserId: row.createdBy,
    email: emailToStore,
    phone: phoneStored,
    excludeContactId: contactId,
    existingContactOrganizationId: row.organizationId,
  });

  const isPortalUser = await contactEmailMatchesPortalUser(emailToStore);
  const [updated] = await db
    .update(contact)
    .set({
      firstName: fields.firstName,
      lastName: fields.lastName,
      fullName: buildContactFullName(fields.firstName, fields.lastName),
      email: emailToStore,
      phone: phoneStored,
      note: fields.note,
      tags: fields.tags,
      lists: fields.lists,
      owners: fields.owners,
      lastEditReason: fields.lastEditReason || null,
      isPortalUser,
    })
    .where(eq(contact.id, contactId))
    .returning();
  if (!updated) return null;
  await syncDealLpInvestorEmailForContactUpdate({
    contactId,
    previousEmail: row.email,
    nextEmail: updated.email,
  });
  const orgForLabels =
    updated.organizationId ??
    (await resolveOrganizationIdForUserId(row.createdBy));
  await syncOrganizationContactLabels({
    organizationId: orgForLabels,
    tags: fields.tags,
    lists: fields.lists,
  });
  queueGhlContactRowSync(updated);
  return updated;
}

export async function patchContactStatusForViewer(
  viewerUserId: string,
  contactId: string,
  status: "active" | "suspended",
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  const [updated] = await db
    .update(contact)
    .set({ status })
    .where(eq(contact.id, contactId))
    .returning();
  return updated ?? null;
}

export async function markContactInvitationEmailSent(
  contactId: string,
): Promise<ContactRow | null> {
  const id = String(contactId ?? "").trim();
  if (!id) return null;
  const [updated] = await db
    .update(contact)
    .set({ invitationEmailSent: true })
    .where(eq(contact.id, id))
    .returning();
  return updated ?? null;
}

export type { ContactOfferingVisibility };

/**
 * Read-only lookup. Someone who opted in to platform visibility is readable by
 * any user, matching the list scope; editing them still needs owner access, so
 * the write paths keep using {@link viewerCanAccessContactRow} on its own.
 */
export async function getContactForViewer(
  viewerUserId: string,
  contactId: string,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (isOptedInSelfRegisteredContactRow(row)) {
    const ctx = await getViewerContactScopeContext(
      viewerUserId,
      viewerRole,
      requestedOrganizationId,
    );
    if (
      await contactIsPrivateToAnotherCoSponsor(
        viewerUserId,
        row,
        ctx.organizationId,
      )
    ) {
      return null;
    }
    return row;
  }
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  return row;
}

export async function patchContactShowOfferingsForViewer(
  viewerUserId: string,
  contactId: string,
  showOfferingsVisibility: ContactOfferingVisibility | null,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  const [updated] = await db
    .update(contact)
    .set({ showOfferingsVisibility })
    .where(eq(contact.id, contactId))
    .returning();
  return updated ?? null;
}

export async function patchContactAccreditationStatusForViewer(
  viewerUserId: string,
  contactId: string,
  accreditationStatus: string | null,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  const [updated] = await db
    .update(contact)
    .set({ accreditationStatus })
    .where(eq(contact.id, contactId))
    .returning();
  return updated ?? null;
}

export async function patchContactKnownSinceForViewer(
  viewerUserId: string,
  contactId: string,
  knownSince: string | null,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  const [updated] = await db
    .update(contact)
    .set({ knownSince })
    .where(eq(contact.id, contactId))
    .returning();
  return updated ?? null;
}

export type ContactRelationship506b = "YES" | "NO";

export async function patchContactRelationship506bForViewer(
  viewerUserId: string,
  contactId: string,
  relationship506b: ContactRelationship506b | null,
  viewerRole?: string | null,
  requestedOrganizationId?: string | null,
): Promise<ContactRow | null> {
  const row = await getContactById(contactId);
  if (!row) return null;
  if (
    !(await viewerCanAccessContactRow(
      viewerUserId,
      row,
      viewerRole,
      requestedOrganizationId,
    ))
  )
    return null;
  const [updated] = await db
    .update(contact)
    .set({ relationship506b })
    .where(eq(contact.id, contactId))
    .returning();
  return updated ?? null;
}
