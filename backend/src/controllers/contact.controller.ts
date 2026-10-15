import type { Request, Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { getValidJwtUser } from "../middleware/jwtUser.js";
import { isPlatformAdminRole } from "../constants/roles.js";
import { db } from "../database/db.js";
import { users } from "../schema/auth.schema/signin.js";
import { companies } from "../schema/company.schema/company.js";
import { userCompanyMembership } from "../schema/company.schema/userCompanyMembership.schema.js";
import {
  ContactInvalidPhoneError,
  ContactScopeConflictError,
  countDealInvestmentsByContactIdForViewer,
  getContactForViewer,
  listDealsForContactForViewer,
  getUserDisplayNameById,
  insertContact,
  isSelfRegisteredInvestorContactRow,
  type ContactListFilters,
  listContactIdsForViewerFilters,
  listContactsForViewerCached,
  listViewerContactsByIds,
  listContactsPageForViewer,
  listInviteeContactsForOrganization,
  listPlatformVisibleContactsCached,
  loadContactCreatorUsersById,
  markContactInvitationEmailSent,
  patchContactShowOfferingsForViewer,
  patchContactAccreditationStatusForViewer,
  patchContactKnownSinceForViewer,
  patchContactRelationship506bForViewer,
  patchContactStatusForViewer,
  type ContactRelationship506b,
  resolveContactDisplayFields,
  resolveDealAdderNamesByContactIdForViewer,
  resolveFirstOrganizationInviterByContactId,
  resolveInvitedByDisplayNameByContactId,
  updateContactFieldsForViewer,
  type ContactOfferingVisibility,
} from "../services/contact/contact.service.js";
import { normalizeContactOfferingVisibility } from "../services/contact/contactOfferingVisibility.service.js";
import {
  deleteContactEmailTemplateForViewer,
  insertContactEmailTemplate,
  listContactEmailTemplatesForViewer,
  updateContactEmailTemplateForViewer,
} from "../services/contact/contactEmailTemplate.service.js";
import {
  getOrganizationIdForUser,
  listOrganizationContactListNames,
  listOrganizationContactTagNames,
} from "../services/contact/organizationContactLabels.service.js";
import {
  allowedOwnerNamesFromSponsors,
  filterOwnersToAllowedNames,
  listContactOwnerSponsorsForViewer,
} from "../services/contact/contactOwnerSponsors.service.js";
import {
  buildInvestorInviteLinkForDeal,
  buildInvestorInviteLinkForUser,
} from "../services/contact/investorInviteLink.service.js";
import {
  confirmContactImport,
  parseContactImportFile,
  previewContactImport,
  type ContactImportDuplicateMode,
  type ContactImportMapping,
} from "../services/contact/contactImport.service.js";
import {
  contactCanSendInvitationEmail,
  contactInvitationEmailBlockReason,
  sendContactInvitationEmailIfRequested,
} from "../services/contact/contactInvitationEmail.service.js";
import type {
  ContactEmailTemplateRow,
  ContactRow,
  EmailTemplateAttachment,
} from "../schema/contact.schema.js";
import {
  logSocContactDirectoryView,
  logSocContactLabelsRead,
  logSocContactWrite,
} from "../audit/index.js";
import {
  organizationIdFromRequestQuery,
  requestedOrganizationIdFromRequest,
  resolveActiveOrganizationIdForUser,
  userHasAccessToOrganization,
} from "../services/org/orgResolution.service.js";
import { invalidateContactDirectoryCache } from "../services/cache/listReadCache.js";
import { pageEnvelope, parsePageQuery } from "../common/pagination.js";

const ORG_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Company for CRM label tables: member’s org, or `?organizationId=` for platform admins. */
async function resolveOrganizationIdForContactLabels(
  req: Request,
  userId: string,
): Promise<string | null> {
  const q = req.query.organizationId ?? req.query.organization_id;
  const fromQuery =
    typeof q === "string"
      ? q.trim()
      : Array.isArray(q)
        ? String(q[0] ?? "").trim()
        : "";
  const [row] = await db
    .select({ role: users.role, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const role = String(row?.role ?? "").trim();
  const selfOrg = row?.organizationId ? String(row.organizationId).trim() : "";
  if (isPlatformAdminRole(role)) {
    if (fromQuery && ORG_UUID_RE.test(fromQuery)) return fromQuery;
    const requested = requestedOrganizationIdFromRequest(req);
    if (requested && ORG_UUID_RE.test(requested)) return requested;
    return null;
  }
  const requested = requestedOrganizationIdFromRequest(req);
  if (fromQuery && ORG_UUID_RE.test(fromQuery)) {
    if (await userHasAccessToOrganization(userId, fromQuery)) return fromQuery;
    return null;
  }
  const active = await resolveActiveOrganizationIdForUser(userId, requested, {
    organizationId: row?.organizationId ?? null,
    role: row?.role ?? null,
  });
  if (active) return active;
  if (selfOrg) return selfOrg;
  return getOrganizationIdForUser(userId);
}

function truthyQuery(v: unknown): boolean {
  const s = String(Array.isArray(v) ? v[0] : (v ?? ""))
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function contactListSortFromQuery(req: Request): "name" | "createdAt" {
  const sortRaw = String(req.query.sort ?? req.query.order ?? "")
    .trim()
    .toLowerCase();
  return sortRaw === "name" || sortRaw === "asc" || sortRaw === "alphabetical"
    ? "name"
    : "createdAt";
}

function queryString(v: unknown): string {
  return String(Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
}

/** Contacts toolbar filters; `"all"` (the default option) means "do not filter". */
function contactListFiltersFromQuery(req: Request): ContactListFilters {
  const notAll = (raw: string) =>
    raw && raw.toLowerCase() !== "all" ? raw : undefined;
  const status = queryString(req.query.status).toLowerCase();
  return {
    status: status === "active" || status === "archived" ? status : undefined,
    tag: notAll(queryString(req.query.tag)),
    owner: notAll(queryString(req.query.owner)),
    accreditation: notAll(queryString(req.query.accreditation)),
    offeringVisibility: notAll(queryString(req.query.offeringVisibility)),
  };
}

function parseIdListQuery(v: unknown, max = 100): string[] {
  const raw = Array.isArray(v) ? v.join(",") : String(v ?? "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function paramStr(v: string | string[] | undefined): string {
  if (v == null) return "";
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

function bodyString(v: unknown): string {
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

function bodyBoolean(v: unknown): boolean {
  return Boolean(v);
}

function bodyStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function bodyAttachment(v: unknown): EmailTemplateAttachment | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const fileName = bodyString(o.fileName).trim();
  const mimeType = bodyString(o.mimeType).trim();
  const dataBase64 = bodyString(o.dataBase64).trim();
  const sizeRaw = o.size;
  const size = typeof sizeRaw === "number" && Number.isFinite(sizeRaw)
    ? Math.max(0, Math.trunc(sizeRaw))
    : 0;
  if (!fileName || !dataBase64) return null;
  return {
    fileName,
    mimeType: mimeType || "application/octet-stream",
    size,
    dataBase64,
  };
}

function dedupeOwnersPreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function normalizeShowOfferingsVisibility(
  row: ContactRow,
): ContactOfferingVisibility | null {
  return normalizeContactOfferingVisibility(row.showOfferingsVisibility);
}

function formatKnownSince(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : null;
}

function normalizeRelationship506b(
  raw: unknown,
): ContactRelationship506b | null {
  if (raw == null || String(raw).trim() === "") return null;
  const s = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s()-]+/g, "_");
  if (
    s === "YES" ||
    s === "506B_YES" ||
    s === "506B" ||
    s === "TRUE" ||
    s === "1"
  )
    return "YES";
  if (s === "NO" || s === "FALSE" || s === "0") return "NO";
  return null;
}

function parseRelationship506bInput(
  raw: unknown,
): ContactRelationship506b | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === "") return null;
  const v = normalizeRelationship506b(raw);
  return v ?? undefined;
}

function mapContactToJson(row: ContactRow) {
  const showOfferingsVisibility = normalizeShowOfferingsVisibility(row);
  const accreditationStatus =
    row.accreditationStatus != null &&
    String(row.accreditationStatus).trim() !== ""
      ? String(row.accreditationStatus).trim()
      : null;
  const knownSince = formatKnownSince(row.knownSince);
  const relationship506b =
    normalizeRelationship506b(row.relationship506b) ?? "NO";
  return {
    id: row.id,
    organizationId: row.organizationId ?? null,
    organization_id: row.organizationId ?? null,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName:
      String(row.fullName ?? "").trim() ||
      [row.firstName, row.lastName]
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
        .join(" "),
    email: row.email,
    phone: row.phone,
    note: row.note,
    tags: row.tags ?? [],
    lists: row.lists ?? [],
    owners: row.owners ?? [],
    /** Internal — prefer `createdByDisplayName` in UI */
    createdBy: row.createdBy,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    status: row.status ?? "active",
    showOfferingsVisibility,
    show_offerings_visibility: showOfferingsVisibility,
    accreditationStatus,
    accreditation_status: accreditationStatus,
    knownSince,
    known_since: knownSince,
    relationship506b,
    relationship_506b: relationship506b,
    importSource: row.importSource ?? "manual",
    import_source: row.importSource ?? "manual",
    visibleToUsers: Boolean(row.visibleToUsers),
    visible_to_users: Boolean(row.visibleToUsers),
    platformAdminOnly: Boolean(row.platformAdminOnly),
    platform_admin_only: Boolean(row.platformAdminOnly),
    lastEditReason: row.lastEditReason?.trim() || undefined,
    invitationEmailSent: Boolean(row.invitationEmailSent),
    invitation_email_sent: Boolean(row.invitationEmailSent),
    canSendInvitationEmail: contactCanSendInvitationEmail(row),
    can_send_invitation_email: contactCanSendInvitationEmail(row),
    isPortalUser: Boolean(row.isPortalUser),
    is_portal_user: Boolean(row.isPortalUser),
  };
}

async function mapContactEmailTemplateToJsonWithName(
  row: ContactEmailTemplateRow,
) {
  const createdByDisplayName = (await getUserDisplayNameById(row.createdBy)).trim();
  return {
    id: row.id,
    organizationId: row.organizationId ?? null,
    organization_id: row.organizationId ?? null,
    name: row.name,
    subject: row.subject,
    body: row.body,
    attachment: row.attachment ?? null,
    archived: row.archived,
    createdBy: createdByDisplayName || row.createdBy,
    createdByUserId: row.createdBy,
    createdByDisplayName: createdByDisplayName || undefined,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt),
  };
}

async function loadOrganizationNamesById(
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [
    ...new Set(
      ids.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0),
    ),
  ];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const found = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(inArray(companies.id, unique));
  for (const row of found) {
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    names.set(String(row.id).trim().toLowerCase(), name);
  }
  return names;
}

/**
 * Company of the user who added the contact. Primary company wins. Membership
 * companies fill in when the adder has no primary organization.
 */
async function loadAddedByCompanyNameByUserId(
  creatorById: Map<string, { id: string; organizationId: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const creators = [...creatorById.values()];
  if (creators.length === 0) return out;
  const primaryNames = await loadOrganizationNamesById(
    creators.map((creator) => creator.organizationId),
  );
  const needsMembership: string[] = [];
  for (const creator of creators) {
    const primary = primaryNames.get(
      String(creator.organizationId ?? "").trim().toLowerCase(),
    );
    if (primary) {
      out.set(creator.id, primary);
    } else {
      needsMembership.push(creator.id);
    }
  }
  if (needsMembership.length === 0) return out;
  let memberships: { userId: string; companyName: string | null }[] = [];
  try {
    memberships = await db
      .select({
        userId: userCompanyMembership.userId,
        companyName: companies.name,
      })
      .from(userCompanyMembership)
      .innerJoin(companies, eq(userCompanyMembership.companyId, companies.id))
      .where(inArray(userCompanyMembership.userId, needsMembership));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('relation "user_company_membership" does not exist')) {
      throw err;
    }
  }
  const namesByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const userId = String(row.userId);
    const name = String(row.companyName ?? "").trim();
    if (!name) continue;
    const list = namesByUser.get(userId) ?? [];
    if (!list.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      list.push(name);
    }
    namesByUser.set(userId, list);
  }
  for (const userId of needsMembership) {
    const names = namesByUser.get(userId);
    if (names?.length) out.set(userId, names.join(", "));
  }
  return out;
}

async function mapContactsToJsonWithNames(
  rows: ContactRow[],
  dealCounts?: Map<string, number>,
  dealAdderNames?: Map<string, string>,
  organizationId?: string | null,
  _viewerUserId?: string | null,
) {
  const orgNameByIdPromise = loadOrganizationNamesById(
    rows.map((row) => row.organizationId),
  );
  const creatorById = await loadContactCreatorUsersById(
    rows.map((row) => row.createdBy),
  );

  const invitedByNameByContactId =
    await resolveInvitedByDisplayNameByContactId(rows);
  const orgId = String(organizationId ?? "").trim();
  const orgInviterByContactId = orgId
    ? await resolveFirstOrganizationInviterByContactId(rows, orgId)
    : null;

  const displayNameByCreatorId = new Map<string, string>();
  const creatorIdsNeedingName = [
    ...new Set(
      rows
        .filter(
          (row) =>
            !isSelfRegisteredInvestorContactRow(
              row,
              creatorById.get(row.createdBy) ?? null,
            ),
        )
        .map((row) => row.createdBy),
    ),
  ];
  await Promise.all(
    creatorIdsNeedingName.map(async (creatorId) => {
      const name = (await getUserDisplayNameById(creatorId)).trim();
      displayNameByCreatorId.set(creatorId, name);
    }),
  );

  const [orgNameById, addedByCompanyByUserId] = await Promise.all([
    orgNameByIdPromise,
    loadAddedByCompanyNameByUserId(creatorById),
  ]);

  const mapped = rows.map((row) => {
    const base = mapContactToJson(row);
    const { createdBy: _createdBy, ...rest } = base;
    const creator = creatorById.get(row.createdBy) ?? null;
    const idKey = String(row.id).trim().toLowerCase();
    const organizationName =
      orgNameById.get(String(row.organizationId ?? "").trim().toLowerCase()) ||
      undefined;
    const display = resolveContactDisplayFields(
      row,
      creator,
      displayNameByCreatorId.get(row.createdBy) ?? "",
      dealAdderNames?.get(idKey),
    );
    const dealCount = dealCounts?.get(idKey) ?? 0;
    const invitedBy = orgId
      ? orgInviterByContactId?.get(idKey)
      : invitedByNameByContactId.get(idKey);
    return {
      ...rest,
      owners: display.owners,
      organizationName,
      organization_name: organizationName,
      addedByCompanyName: addedByCompanyByUserId.get(row.createdBy) || undefined,
      added_by_company_name:
        addedByCompanyByUserId.get(row.createdBy) || undefined,
      createdByUserId: row.createdBy,
      created_by_user_id: row.createdBy,
      createdByDisplayName: display.createdByDisplayName || undefined,
      invitedByUserId: invitedBy?.userId || undefined,
      invited_by_user_id: invitedBy?.userId || undefined,
      invitedByDisplayName: invitedBy?.displayName?.trim() || undefined,
      invited_by_display_name: invitedBy?.displayName?.trim() || undefined,
      dealCount,
    };
  });
  return mapped;
}

async function mapContactToJsonWithNames(
  row: ContactRow,
  dealCounts?: Map<string, number>,
  dealAdderNames?: Map<string, string>,
  organizationId?: string | null,
  viewerUserId?: string | null,
) {
  const [mapped] = await mapContactsToJsonWithNames(
    [row],
    dealCounts,
    dealAdderNames,
    organizationId,
    viewerUserId,
  );
  return mapped;
}

/** GET /contacts/organization-tags — names from `organization_contact_tag`. */
export async function getOrganizationContactTags(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const orgId = await resolveOrganizationIdForContactLabels(req, user.id);
    if (!orgId) {
      res.status(403).json({ message: "No organization context for tags." });
      return;
    }
    const tags = await listOrganizationContactTagNames(orgId);
    logSocContactLabelsRead({
      actorUserId: user.id,
      organizationId: orgId,
      kind: "tags",
    });
    res.status(200).json({ tags });
  } catch (err) {
    console.error("getOrganizationContactTags:", err);
    res.status(500).json({ message: "Could not load organization tags" });
  }
}

/** GET /contacts/owner-sponsors — scoped sponsor options for the Owners dropdown. */
export async function getContactOwnerSponsors(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const orgId = await resolveOrganizationIdForContactLabels(req, user.id);
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const contactId = paramStr(
      (req.query.contactId ?? req.query.contact_id) as string | string[] | undefined,
    );
    const { sponsors, lockToListed } = await listContactOwnerSponsorsForViewer({
      viewerUserId: user.id,
      viewerRole: actor?.role ?? user.userRole,
      organizationId: orgId,
      contactId,
    });
    res.status(200).json({ sponsors, lockToListed });
  } catch (err) {
    console.error("getContactOwnerSponsors:", err);
    res.status(500).json({ message: "Could not load contact owners" });
  }
}

/** GET /contacts/investor-invite-link — this user's own investor signup link. */
export async function getInvestorInviteLink(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const link = await buildInvestorInviteLinkForUser(
      user.id,
      requestedOrganizationIdFromRequest(req),
    );
    if (!link) {
      res
        .status(403)
        .json({ message: "This account cannot share an investor invite link." });
      return;
    }
    res.status(200).json(link);
  } catch (err) {
    console.error("getInvestorInviteLink:", err);
    res.status(500).json({ message: "Could not build the invite link" });
  }
}

/** GET /deals/:dealId/investor-invite-link — unique to this lead / admin / co-sponsor. */
export async function getDealInvestorInviteLink(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const dealId = String(req.params.dealId ?? "").trim();
  try {
    const result = await buildInvestorInviteLinkForDeal(user.id, dealId);
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    res.status(200).json(result.link);
  } catch (err) {
    console.error("getDealInvestorInviteLink:", err);
    res.status(500).json({ message: "Could not build the invite link" });
  }
}

/** GET /contacts/organization-lists — names from `organization_contact_list`. */
export async function getOrganizationContactLists(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const orgId = await resolveOrganizationIdForContactLabels(req, user.id);
    if (!orgId) {
      res.status(403).json({ message: "No organization context for lists." });
      return;
    }
    const lists = await listOrganizationContactListNames(orgId);
    logSocContactLabelsRead({
      actorUserId: user.id,
      organizationId: orgId,
      kind: "lists",
    });
    res.status(200).json({ lists });
  } catch (err) {
    console.error("getOrganizationContactLists:", err);
    res.status(500).json({ message: "Could not load organization lists" });
  }
}

/**
 * GET /contacts/member-invitees?organizationId=
 * Signups that used a company member's invite link. Used by the platform-admin
 * Customers member dropdown.
 */
export async function getMemberInviteeContacts(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const orgId = requestedOrganizationIdFromRequest(req);
  if (!orgId) {
    res.status(400).json({ message: "Organization id required" });
    return;
  }
  try {
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const role = String(actor?.role ?? user.userRole ?? "").trim();
    if (!isPlatformAdminRole(role)) {
      const allowed = await userHasAccessToOrganization(user.id, orgId);
      if (!allowed) {
        res.status(403).json({ message: "Not allowed" });
        return;
      }
    }
    const rows = await listInviteeContactsForOrganization(orgId);
    const contacts = await mapContactsToJsonWithNames(
      rows,
      undefined,
      undefined,
      orgId,
      user.id,
    );
    res.status(200).json({ contacts });
  } catch (err) {
    console.error("getMemberInviteeContacts:", err);
    res.status(500).json({ message: "Could not load invited contacts" });
  }
}

export async function getContacts(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const requestedOrg = requestedOrganizationIdFromRequest(req);
    const sort = contactListSortFromQuery(req);
    const lean = truthyQuery(req.query.lean);
    const pageQuery = parsePageQuery(req);
    let total: number | null = null;
    let statusTotals: { activeTotal: number; archivedTotal: number } | null =
      null;
    let rows: ContactRow[];
    if (pageQuery.paginated) {
      const page = await listContactsPageForViewer({
        viewerUserId: user.id,
        viewerRole: user.userRole,
        requestedOrganizationId: requestedOrg,
        sort,
        search: pageQuery.search,
        filters: contactListFiltersFromQuery(req),
        includeOptedInSelfRegistered: truthyQuery(
          req.query.includePlatformContacts,
        ),
        limit: pageQuery.pageSize,
        offset: pageQuery.offset,
      });
      rows = page.rows;
      total = page.total;
      statusTotals = {
        activeTotal: page.activeTotal,
        archivedTotal: page.archivedTotal,
      };
    } else {
      rows = await listContactsForViewerCached(
        user.id,
        user.userRole,
        requestedOrg,
        sort,
      );
    }
    let dealCounts: Map<string, number> | undefined;
    let dealAdderNames: Map<string, string> | undefined;
    if (!lean) {
      const contactIds = rows.map((r) => String(r.id));
      [dealCounts, dealAdderNames] = await Promise.all([
        countDealInvestmentsByContactIdForViewer({
          viewerUserId: user.id,
          jwtUserRole: user.userRole,
          contactIds,
          requestedOrganizationId: requestedOrg,
        }),
        resolveDealAdderNamesByContactIdForViewer({
          viewerUserId: user.id,
          jwtUserRole: user.userRole,
          contactIds,
          requestedOrganizationId: requestedOrg,
        }),
      ]);
    }
    const contacts = await mapContactsToJsonWithNames(
      rows,
      dealCounts,
      dealAdderNames,
      organizationIdFromRequestQuery(req),
      user.id,
    );
    logSocContactDirectoryView({
      actorUserId: user.id,
      resultCount: contacts.length,
    });
    res.status(200).json({
      contacts,
      ...pageEnvelope(pageQuery, total ?? contacts.length),
      ...(statusTotals ?? {}),
    });
  } catch (err) {
    console.error("getContacts:", err);
    res.status(500).json({ message: "Could not load contacts" });
  }
}

/**
 * GET /contacts/matching-ids — ids of every contact matching the current search
 * and filters, so "select all" and CSV export cover the whole result set rather
 * than just the page the table has loaded.
 */
export async function getContactMatchingIds(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const ids = await listContactIdsForViewerFilters({
      viewerUserId: user.id,
      viewerRole: user.userRole,
      requestedOrganizationId: requestedOrganizationIdFromRequest(req),
      search: parsePageQuery(req).search,
      filters: contactListFiltersFromQuery(req),
      includeOptedInSelfRegistered: truthyQuery(
        req.query.includePlatformContacts,
      ),
    });
    res.status(200).json({ ids, total: ids.length });
  } catch (err) {
    console.error("getContactMatchingIds:", err);
    res.status(500).json({ message: "Could not load matching contacts" });
  }
}

/**
 * GET /contacts/platform-contacts — Platform Contacts section: self-registered
 * investors. Opted-in only for company users; all self-signups for platform admins.
 * `?organizationId=` limits the list to one company. The active-org header is ignored
 * so All Contacts / Platform Contacts stay global unless a company is requested.
 */
export async function getPlatformContacts(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const sort = contactListSortFromQuery(req);
    const lean = truthyQuery(req.query.lean);
    const organizationId = organizationIdFromRequestQuery(req);
    const rows = await listPlatformVisibleContactsCached(
      user.id,
      sort,
      user.userRole,
      organizationId,
    );
    const dealAdderNames = lean
      ? undefined
      : await resolveDealAdderNamesByContactIdForViewer({
          viewerUserId: user.id,
          jwtUserRole: user.userRole,
          contactIds: rows.map((r) => String(r.id)),
          requestedOrganizationId: requestedOrganizationIdFromRequest(req),
        });
    const contacts = await mapContactsToJsonWithNames(
      rows,
      undefined,
      dealAdderNames,
      organizationId,
      user.id,
    );
    logSocContactDirectoryView({
      actorUserId: user.id,
      resultCount: contacts.length,
    });
    res.status(200).json({ contacts });
  } catch (err) {
    console.error("getPlatformContacts:", err);
    res.status(500).json({ message: "Could not load platform contacts" });
  }
}

/** GET /contacts/deal-stats?ids= — deal counts / owners for the visible table page. */
export async function getContactDealStats(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const ids = parseIdListQuery(req.query.ids, 100);
    if (ids.length === 0) {
      res.status(200).json({ contacts: [] });
      return;
    }
    const requestedOrg = requestedOrganizationIdFromRequest(req);
    const matched = await listViewerContactsByIds({
      viewerUserId: user.id,
      viewerRole: user.userRole,
      requestedOrganizationId: requestedOrg,
      contactIds: ids,
    });
    const contactIds = matched.map((r) => String(r.id));
    const [dealCounts, dealAdderNames] = await Promise.all([
      countDealInvestmentsByContactIdForViewer({
        viewerUserId: user.id,
        jwtUserRole: user.userRole,
        contactIds,
        requestedOrganizationId: requestedOrg,
      }),
      resolveDealAdderNamesByContactIdForViewer({
        viewerUserId: user.id,
        jwtUserRole: user.userRole,
        contactIds,
        requestedOrganizationId: requestedOrg,
      }),
    ]);
    const contacts = await mapContactsToJsonWithNames(
      matched,
      dealCounts,
      dealAdderNames,
      organizationIdFromRequestQuery(req),
      user.id,
    );
    res.status(200).json({ contacts });
  } catch (err) {
    console.error("getContactDealStats:", err);
    res.status(500).json({ message: "Could not load contact deal stats" });
  }
}

/** GET /contacts/:contactId */
export async function getContact(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  try {
    const requestedOrg = requestedOrganizationIdFromRequest(req);
    const row = await getContactForViewer(
      user.id,
      contactId,
      user.userRole,
      requestedOrg,
    );
    if (!row) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    const [dealCounts, dealAdderNames] = await Promise.all([
      countDealInvestmentsByContactIdForViewer({
        viewerUserId: user.id,
        jwtUserRole: user.userRole,
        contactIds: [String(row.id)],
        requestedOrganizationId: requestedOrg,
      }),
      resolveDealAdderNamesByContactIdForViewer({
        viewerUserId: user.id,
        jwtUserRole: user.userRole,
        contactIds: [String(row.id)],
        requestedOrganizationId: requestedOrg,
      }),
    ]);
    res.status(200).json({
      contact: await mapContactToJsonWithNames(
        row,
        dealCounts,
        dealAdderNames,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("getContact:", err);
    res.status(500).json({ message: "Could not load contact" });
  }
}

/** GET /contacts/:contactId/deals — deal name, contact role, organization, last visit. */
export async function getContactDeals(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  try {
    const requestedOrg = requestedOrganizationIdFromRequest(req);
    const row = await getContactForViewer(
      user.id,
      contactId,
      user.userRole,
      requestedOrg,
    );
    if (!row) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    const deals = await listDealsForContactForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactId: String(row.id),
      requestedOrganizationId: requestedOrg,
    });
    res.status(200).json({ deals });
  } catch (err) {
    console.error("getContactDeals:", err);
    res.status(500).json({ message: "Could not load contact deals" });
  }
}

export async function postContact(req: Request, res: Response): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const firstName = bodyString(b.first_name || b.firstName).trim();
  const lastName = bodyString(b.last_name || b.lastName).trim();
  const email = bodyString(b.email).trim();
  const phone = bodyString(b.phone).trim();
  const note = bodyString(b.note).trim();
  const tags = bodyStringArray(b.tags);
  const lists = bodyStringArray(b.lists);
  const ownersFromClient = bodyStringArray(b.owners);
  const sendInvitationMail = bodyString(
    b.send_invitation_mail ?? b.sendInvitationMail,
  );

  if (!firstName) {
    res.status(400).json({ message: "First name is required" });
    return;
  }
  if (!lastName) {
    res.status(400).json({ message: "Last name is required" });
    return;
  }
  if (!email) {
    res.status(400).json({ message: "Email is required" });
    return;
  }

  try {
    const creatorLabel = (await getUserDisplayNameById(user.id)).trim();
    const fallback =
      user.email?.trim() || creatorLabel || "User";
    const primaryOwner = creatorLabel || fallback;
    const orgId = await resolveOrganizationIdForContactLabels(req, user.id);
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const { sponsors, lockToListed } = await listContactOwnerSponsorsForViewer({
      viewerUserId: user.id,
      viewerRole: actor?.role ?? user.userRole,
      organizationId: orgId,
    });
    const allowed = allowedOwnerNamesFromSponsors(
      sponsors,
      lockToListed ? [] : [primaryOwner],
    );
    const filtered = filterOwnersToAllowedNames(ownersFromClient, allowed);
    const owners = lockToListed
      ? dedupeOwnersPreserveOrder(
          filtered.length > 0
            ? filtered
            : sponsors.map((s) => s.displayName).filter(Boolean),
        )
      : dedupeOwnersPreserveOrder([primaryOwner, ...filtered]);

    const row = await insertContact({
      input: {
        firstName,
        lastName,
        email,
        phone,
        note,
        tags,
        lists,
        owners,
      },
      createdByUserId: user.id,
      organizationId: orgId,
    });
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(row.id)],
    });
    logSocContactWrite({
      operation: "create",
      actorUserId: user.id,
      contactId: String(row.id),
    });
    const invitationResult = await sendContactInvitationEmailIfRequested({
      sendInvitationMail,
      email,
      invitedByUserId: user.id,
      skipBecausePortalUser: row.isPortalUser,
    });
    const saved =
      invitationResult === "sent"
        ? ((await markContactInvitationEmailSent(row.id)) ?? row)
        : row;
    res.status(201).json({
      message:
        invitationResult === "sent"
          ? "Contact created and invitation email sent"
          : invitationResult === "failed"
            ? "Contact created, but the invitation email could not be sent"
            : "Contact created",
      contact: await mapContactToJsonWithNames(
        saved,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
      invitationEmailSent: invitationResult === "sent",
    });
  } catch (err) {
    if (err instanceof ContactInvalidPhoneError) {
      res.status(400).json({ message: err.message });
      return;
    }
    if (err instanceof ContactScopeConflictError) {
      res.status(409).json({ message: err.message });
      return;
    }
    console.error("postContact:", err);
    res.status(500).json({ message: "Could not create contact" });
  }
}

function bodyImportMapping(raw: unknown): ContactImportMapping {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const allowed = new Set([
    "firstName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "note",
    "tags",
    "lists",
  ]);
  const out: ContactImportMapping = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(field)) continue;
    out[field as keyof ContactImportMapping] =
      value == null || String(value).trim() === "" ? null : String(value).trim();
  }
  return out;
}

export async function postContactImportParse(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    res.status(400).json({ message: "Upload a CSV or Excel file." });
    return;
  }

  try {
    const result = await parseContactImportFile({
      userId: user.id,
      fileName: file.originalname || "contacts.csv",
      mimeType: file.mimetype || "",
      buffer: file.buffer,
    });
    res.status(201).json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not parse import file.";
    res.status(400).json({ message });
  }
}

export async function postContactImportPreview(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const batchId = String(req.params.batchId ?? "").trim();
  if (!batchId) {
    res.status(400).json({ message: "Import batch id required" });
    return;
  }

  try {
    const result = await previewContactImport({
      userId: user.id,
      batchId,
      mapping: bodyImportMapping((req.body as Record<string, unknown>)?.mapping),
    });
    res.status(200).json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not preview import.";
    res.status(400).json({ message });
  }
}

export async function postContactImportConfirm(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const batchId = String(req.params.batchId ?? "").trim();
  if (!batchId) {
    res.status(400).json({ message: "Import batch id required" });
    return;
  }

  const rawMode = bodyString(
    (req.body as Record<string, unknown>)?.duplicateMode ??
      (req.body as Record<string, unknown>)?.duplicate_mode,
  )
    .trim()
    .toLowerCase();
  const duplicateMode: ContactImportDuplicateMode =
    rawMode === "update" ? "update" : "skip";

  try {
    const result = await confirmContactImport({
      userId: user.id,
      batchId,
      duplicateMode,
    });
    invalidateContactDirectoryCache();
    res.status(200).json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not import contacts.";
    res.status(400).json({ message });
  }
}

/** POST /contacts/:contactId/send-invitation */
export async function postContactInvitation(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  try {
    const row = await getContactForViewer(
      user.id,
      contactId,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!row) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    const blocked = contactInvitationEmailBlockReason(row);
    if (blocked) {
      res.status(409).json({ message: blocked });
      return;
    }
    const invitationResult = await sendContactInvitationEmailIfRequested({
      sendInvitationMail: "yes",
      email: row.email,
      invitedByUserId: user.id,
      skipBecausePortalUser: row.isPortalUser,
    });
    if (invitationResult !== "sent") {
      res.status(502).json({
        message: "The invitation email could not be sent",
      });
      return;
    }
    const saved = (await markContactInvitationEmailSent(row.id)) ?? {
      ...row,
      invitationEmailSent: true,
    };
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(saved.id)],
      requestedOrganizationId: requestedOrganizationIdFromRequest(req),
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(saved.id),
    });
    res.status(200).json({
      message: "Invitation email sent",
      contact: await mapContactToJsonWithNames(
        saved,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
      invitationEmailSent: true,
    });
  } catch (err) {
    console.error("postContactInvitation:", err);
    res.status(500).json({ message: "Could not send invitation email" });
  }
}

export async function patchContact(req: Request, res: Response): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const editReason = bodyString(b.edit_reason || b.editReason).trim();
  if (!editReason) {
    res.status(400).json({ message: "Edit reason is required" });
    return;
  }

  const firstName = bodyString(b.first_name || b.firstName).trim();
  const lastName = bodyString(b.last_name || b.lastName).trim();
  const email = bodyString(b.email).trim();
  const phone = bodyString(b.phone).trim();
  const note = bodyString(b.note).trim();
  const tags = bodyStringArray(b.tags);
  const lists = bodyStringArray(b.lists);
  const ownersFromClient = bodyStringArray(b.owners);

  if (!firstName) {
    res.status(400).json({ message: "First name is required" });
    return;
  }
  if (!lastName) {
    res.status(400).json({ message: "Last name is required" });
    return;
  }
  if (!email) {
    res.status(400).json({ message: "Email is required" });
    return;
  }

  try {
    const existing = await getContactForViewer(
      user.id,
      contactId,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!existing) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    const orgId = await resolveOrganizationIdForContactLabels(req, user.id);
    const [actor] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const { sponsors, lockToListed } = await listContactOwnerSponsorsForViewer({
      viewerUserId: user.id,
      viewerRole: actor?.role ?? user.userRole,
      organizationId: orgId,
      contactId,
    });
    const allowed = allowedOwnerNamesFromSponsors(
      sponsors,
      lockToListed ? [] : (existing.owners ?? []),
    );
    const filtered = filterOwnersToAllowedNames(ownersFromClient, allowed);
    const owners = dedupeOwnersPreserveOrder(
      lockToListed && filtered.length === 0
        ? sponsors.map((s) => s.displayName).filter(Boolean)
        : filtered,
    );

    const updated = await updateContactFieldsForViewer(
      user.id,
      contactId,
      {
        firstName,
        lastName,
        email,
        phone,
        note,
        tags,
        lists,
        owners,
        lastEditReason: editReason,
      },
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(updated.id),
    });
    res.status(200).json({
      message: "Contact updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    if (err instanceof ContactInvalidPhoneError) {
      res.status(400).json({ message: err.message });
      return;
    }
    if (err instanceof ContactScopeConflictError) {
      res.status(409).json({ message: err.message });
      return;
    }
    console.error("patchContact:", err);
    res.status(500).json({ message: "Could not update contact" });
  }
}

export async function patchContactStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const raw = bodyString(b.status).trim().toLowerCase();
  const status = raw === "suspended" ? "suspended" : "active";

  try {
    const updated = await patchContactStatusForViewer(
      user.id,
      contactId,
      status,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "status_update",
      actorUserId: user.id,
      contactId: String(updated.id),
      status,
    });
    res.status(200).json({
      message: "Contact status updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("patchContactStatus:", err);
    res.status(500).json({ message: "Could not update contact status" });
  }
}

function parseShowOfferingsVisibility(
  raw: unknown,
): ContactOfferingVisibility | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  const s = bodyString(raw).trim();
  if (!s) return null;
  return normalizeContactOfferingVisibility(s);
}

function parseKnownSinceInput(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  const s = bodyString(raw).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return undefined;
  return s;
}

/** PATCH /contacts/:contactId/show-offerings */
export async function patchContactShowOfferings(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const rawShowOfferingsVisibility = Object.prototype.hasOwnProperty.call(
    b,
    "showOfferingsVisibility",
  )
    ? b.showOfferingsVisibility
    : b.show_offerings_visibility;
  const showOfferingsVisibility = parseShowOfferingsVisibility(
    rawShowOfferingsVisibility,
  );
  if (showOfferingsVisibility === undefined) {
    res.status(400).json({
      message:
        "showOfferingsVisibility must be one of: ALL_OFFERINGS, HIDE_OFFERINGS, 506B_ONLY, 506C_ONLY (or empty/null to clear)",
    });
    return;
  }

  try {
    const updated = await patchContactShowOfferingsForViewer(
      user.id,
      contactId,
      showOfferingsVisibility,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(updated.id),
    });
    res.status(200).json({
      message: "Contact offerings visibility updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("patchContactShowOfferings:", err);
    res.status(500).json({
      message: "Could not update contact offerings visibility",
    });
  }
}

/** PATCH /contacts/:contactId/accreditation-status */
export async function patchContactAccreditationStatus(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const raw = b.accreditationStatus ?? b.accreditation_status;
  if (raw === undefined) {
    res.status(400).json({ message: "accreditationStatus is required" });
    return;
  }
  const accreditationStatus =
    raw === null || String(raw).trim() === ""
      ? null
      : String(raw).trim().slice(0, 500);
  try {
    const updated = await patchContactAccreditationStatusForViewer(
      user.id,
      contactId,
      accreditationStatus,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(updated.id),
    });
    res.status(200).json({
      message: "Contact accreditation status updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("patchContactAccreditationStatus:", err);
    res
      .status(500)
      .json({ message: "Could not update accreditation status" });
  }
}

/** PATCH /contacts/:contactId/known-since */
export async function patchContactKnownSince(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const knownSince = parseKnownSinceInput(b.knownSince ?? b.known_since);
  if (knownSince === undefined) {
    res.status(400).json({
      message: "knownSince must be YYYY-MM-DD or null/empty to clear",
    });
    return;
  }
  try {
    const updated = await patchContactKnownSinceForViewer(
      user.id,
      contactId,
      knownSince,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(updated.id),
    });
    res.status(200).json({
      message: "Contact known since updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("patchContactKnownSince:", err);
    res.status(500).json({ message: "Could not update known since" });
  }
}

/** PATCH /contacts/:contactId/relationship-506b */
export async function patchContactRelationship506b(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const contactId = paramStr(req.params.contactId);
  if (!contactId) {
    res.status(400).json({ message: "Contact id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const relationship506b = parseRelationship506bInput(
    b.relationship506b ?? b.relationship_506b,
  );
  if (relationship506b === undefined) {
    res.status(400).json({
      message: "relationship506b must be YES, NO, or empty/null to clear",
    });
    return;
  }
  try {
    const updated = await patchContactRelationship506bForViewer(
      user.id,
      contactId,
      relationship506b,
      user.userRole,
      requestedOrganizationIdFromRequest(req),
    );
    if (!updated) {
      res.status(404).json({ message: "Contact not found or access denied" });
      return;
    }
    invalidateContactDirectoryCache();
    const dealCounts = await countDealInvestmentsByContactIdForViewer({
      viewerUserId: user.id,
      jwtUserRole: user.userRole,
      contactIds: [String(updated.id)],
    });
    logSocContactWrite({
      operation: "update",
      actorUserId: user.id,
      contactId: String(updated.id),
    });
    res.status(200).json({
      message: "Contact relationship updated",
      contact: await mapContactToJsonWithNames(
        updated,
        dealCounts,
        undefined,
        organizationIdFromRequestQuery(req),
        user.id,
      ),
    });
  } catch (err) {
    console.error("patchContactRelationship506b:", err);
    res.status(500).json({ message: "Could not update relationship" });
  }
}

const EMAIL_TEMPLATE_SUBJECT_MAX = 255;
const EMAIL_TEMPLATE_NAME_MAX = 255;
const EMAIL_TEMPLATE_BODY_HTML_MAX = 200_000;
/** Base64 of a 30 MB file is ~40 MB (4/3). */
const EMAIL_TEMPLATE_ATTACHMENT_BASE64_MAX = 42_000_000;

/** GET /contacts/email-templates */
export async function getContactEmailTemplates(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  try {
    const requestedOrg = requestedOrganizationIdFromRequest(req);
    const rows = await listContactEmailTemplatesForViewer(
      user.id,
      user.userRole,
      requestedOrg,
    );
    const templates = await Promise.all(
      rows.map((r) => mapContactEmailTemplateToJsonWithName(r)),
    );
    res.status(200).json({
      templates,
    });
  } catch (err) {
    console.error("getContactEmailTemplates:", err);
    res.status(500).json({ message: "Could not load email templates" });
  }
}

/** POST /contacts/email-templates */
export async function postContactEmailTemplate(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const name = bodyString(b.name).trim().slice(0, EMAIL_TEMPLATE_NAME_MAX);
  const subject = bodyString(b.subject).slice(0, EMAIL_TEMPLATE_SUBJECT_MAX);
  const body = bodyString(b.body).slice(0, EMAIL_TEMPLATE_BODY_HTML_MAX);
  const archived = bodyBoolean(b.archived);
  const attachment = bodyAttachment(b.attachment);

  if (!name) {
    res.status(400).json({ message: "Template name is required" });
    return;
  }
  if (
    attachment &&
    attachment.dataBase64.length > EMAIL_TEMPLATE_ATTACHMENT_BASE64_MAX
  ) {
    res.status(400).json({ message: "Attachment is too large" });
    return;
  }

  try {
    const row = await insertContactEmailTemplate({
      createdByUserId: user.id,
      requestedOrganizationId: requestedOrganizationIdFromRequest(req),
      input: { name, subject, body, attachment, archived },
    });
    res.status(201).json({
      message: "Email template created",
      template: await mapContactEmailTemplateToJsonWithName(row),
    });
  } catch (err) {
    console.error("postContactEmailTemplate:", err);
    res.status(500).json({ message: "Could not create email template" });
  }
}

/** PATCH /contacts/email-templates/:templateId */
export async function patchContactEmailTemplate(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const templateId = paramStr(req.params.templateId);
  if (!templateId) {
    res.status(400).json({ message: "Template id required" });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const name = bodyString(b.name).trim().slice(0, EMAIL_TEMPLATE_NAME_MAX);
  const subject = bodyString(b.subject).slice(0, EMAIL_TEMPLATE_SUBJECT_MAX);
  const body = bodyString(b.body).slice(0, EMAIL_TEMPLATE_BODY_HTML_MAX);
  const archived = bodyBoolean(b.archived);
  const attachment = bodyAttachment(b.attachment);

  if (!name) {
    res.status(400).json({ message: "Template name is required" });
    return;
  }
  if (
    attachment &&
    attachment.dataBase64.length > EMAIL_TEMPLATE_ATTACHMENT_BASE64_MAX
  ) {
    res.status(400).json({ message: "Attachment is too large" });
    return;
  }

  try {
    const updated = await updateContactEmailTemplateForViewer({
      viewerUserId: user.id,
      viewerRole: user.userRole,
      requestedOrganizationId: requestedOrganizationIdFromRequest(req),
      templateId,
      input: { name, subject, body, attachment, archived },
    });
    if (!updated) {
      res
        .status(404)
        .json({ message: "Email template not found or access denied" });
      return;
    }
    res.status(200).json({
      message: "Email template updated",
      template: await mapContactEmailTemplateToJsonWithName(updated),
    });
  } catch (err) {
    console.error("patchContactEmailTemplate:", err);
    res.status(500).json({ message: "Could not update email template" });
  }
}

/** DELETE /contacts/email-templates/:templateId */
export async function deleteContactEmailTemplate(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await getValidJwtUser(req);
  if (!user?.id) {
    res.status(401).json({ message: "Authorization required" });
    return;
  }
  const templateId = paramStr(req.params.templateId);
  if (!templateId) {
    res.status(400).json({ message: "Template id required" });
    return;
  }
  try {
    const ok = await deleteContactEmailTemplateForViewer({
      viewerUserId: user.id,
      viewerRole: user.userRole,
      requestedOrganizationId: requestedOrganizationIdFromRequest(req),
      templateId,
    });
    if (!ok) {
      res
        .status(404)
        .json({ message: "Email template not found or access denied" });
      return;
    }
    res.status(200).json({ message: "Email template deleted" });
  } catch (err) {
    console.error("deleteContactEmailTemplate:", err);
    res.status(500).json({ message: "Could not delete email template" });
  }
}
