import {
  portalAuthHeaders,
  organizationIdQueryParam,
  PORTAL_OMIT_ACTIVE_ORG_HEADER,
} from "@/common/auth/portalAuthHeaders"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"
import type {
  ContactDealRow,
  ContactOfferingVisibility,
  ContactOwnerSponsorOption,
  ContactRelationship506b,
  ContactRow,
  ContactStatus,
} from "../types/contact.types"
import type {
  ContactImportConfirmResult,
  ContactImportDuplicateMode,
  ContactImportMapping,
  ContactImportParseResult,
  ContactImportPreviewResult,
} from "../types/contactImport.types"

function authHeaders(options?: { omitActiveOrganization?: boolean }): HeadersInit {
  const headers = portalAuthHeaders({
    omitActiveOrganization: options?.omitActiveOrganization,
  })
  if (!options?.omitActiveOrganization) return headers
  return {
    ...(headers as Record<string, string>),
    [PORTAL_OMIT_ACTIVE_ORG_HEADER]: "1",
  }
}

function normalizeStatus(raw: unknown): ContactRow["status"] {
  const s = String(raw ?? "active").trim().toLowerCase()
  return s === "suspended" ? "suspended" : "active"
}

function normalizeOfferingVisibility(
  raw: unknown,
): ContactOfferingVisibility | null {
  if (raw == null || String(raw).trim() === "") return null
  const s = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s()-]+/g, "_")
  if (
    s === "ALL_OFFERINGS" ||
    s === "ALL" ||
    s === "SHOW" ||
    s === "SHOW_OFFERINGS"
  )
    return "ALL_OFFERINGS"
  if (s === "HIDE_OFFERINGS" || s === "HIDE" || s === "HIDDEN")
    return "HIDE_OFFERINGS"
  if (
    s === "506B_ONLY" ||
    s === "506B" ||
    s === "506_B" ||
    s === "506_B_ONLY" ||
    s === "506B_OFFERINGS_ONLY"
  )
    return "506B_ONLY"
  if (
    s === "506C_ONLY" ||
    s === "506C" ||
    s === "506_C" ||
    s === "506_C_ONLY" ||
    s === "506C_OFFERINGS_ONLY"
  )
    return "506C_ONLY"
  return null
}

function normalizeKnownSince(raw: unknown): string | null {
  if (raw == null || raw === "") return null
  const s = String(raw).trim()
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1]! : null
}

function normalizeRelationship506b(
  raw: unknown,
): ContactRelationship506b | null {
  if (raw == null || String(raw).trim() === "") return null
  const s = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s()-]+/g, "_")
  if (
    s === "YES" ||
    s === "506B_YES" ||
    s === "506B" ||
    s === "TRUE" ||
    s === "1"
  )
    return "YES"
  if (s === "NO" || s === "FALSE" || s === "0") return "NO"
  return null
}

function parseContactFlag(raw: unknown): boolean {
  if (raw === true || raw === 1) return true
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
  return s === "true" || s === "yes" || s === "1"
}

function normalizeContact(raw: Record<string, unknown>): ContactRow {
  const tags = raw.tags
  const lists = raw.lists
  const owners = raw.owners
  const showOfferingsVisibility = normalizeOfferingVisibility(
    raw.showOfferingsVisibility ?? raw.show_offerings_visibility,
  )
  const accreditationRaw =
    raw.accreditationStatus ?? raw.accreditation_status
  const accreditationStatus =
    accreditationRaw == null || String(accreditationRaw).trim() === ""
      ? null
      : String(accreditationRaw).trim()
  const knownSince = normalizeKnownSince(raw.knownSince ?? raw.known_since)
  const relationship506b =
    normalizeRelationship506b(
      raw.relationship506b ?? raw.relationship_506b,
    ) ?? "NO"
  return {
    id: String(raw.id ?? ""),
    firstName: String(raw.firstName ?? raw.first_name ?? ""),
    lastName: String(raw.lastName ?? raw.last_name ?? ""),
    email: String(raw.email ?? ""),
    phone: String(raw.phone ?? ""),
    note: String(raw.note ?? ""),
    tags: Array.isArray(tags) ? tags.map((x) => String(x)) : [],
    lists: Array.isArray(lists) ? lists.map((x) => String(x)) : [],
    owners: Array.isArray(owners) ? owners.map((x) => String(x)) : [],
    status: normalizeStatus(raw.status),
    showOfferingsVisibility,
    accreditationStatus,
    knownSince,
    relationship506b,
    lastEditReason:
      raw.lastEditReason != null || raw.last_edit_reason != null
        ? String(raw.lastEditReason ?? raw.last_edit_reason).trim() ||
          undefined
        : undefined,
    createdByDisplayName:
      raw.createdByDisplayName != null || raw.created_by_display_name != null
        ? String(raw.createdByDisplayName ?? raw.created_by_display_name)
        : undefined,
    invitedByDisplayName:
      raw.invitedByDisplayName != null || raw.invited_by_display_name != null
        ? String(
            raw.invitedByDisplayName ?? raw.invited_by_display_name,
          ).trim() || undefined
        : undefined,
    invitedByUserId:
      raw.invitedByUserId != null || raw.invited_by_user_id != null
        ? String(raw.invitedByUserId ?? raw.invited_by_user_id).trim() ||
          undefined
        : undefined,
    createdByUserId:
      raw.createdByUserId != null || raw.created_by_user_id != null
        ? String(raw.createdByUserId ?? raw.created_by_user_id).trim() ||
          undefined
        : undefined,
    organizationId:
      raw.organizationId != null || raw.organization_id != null
        ? String(raw.organizationId ?? raw.organization_id).trim() || undefined
        : undefined,
    organizationName:
      raw.organizationName != null || raw.organization_name != null
        ? String(raw.organizationName ?? raw.organization_name).trim() ||
          undefined
        : undefined,
    addedByCompanyName:
      raw.addedByCompanyName != null || raw.added_by_company_name != null
        ? String(raw.addedByCompanyName ?? raw.added_by_company_name).trim() ||
          undefined
        : undefined,
    createdAt:
      raw.createdAt != null || raw.created_at != null
        ? String(raw.createdAt ?? raw.created_at).trim() || undefined
        : undefined,
    visibleToUsers: parseContactFlag(
      raw.visibleToUsers ?? raw.visible_to_users,
    ),
    platformAdminOnly: parseContactFlag(
      raw.platformAdminOnly ?? raw.platform_admin_only,
    ),
    isPortalUser: parseContactFlag(
      raw.isPortalUser ?? raw.is_portal_user,
    ),
    invitationEmailSent: parseContactFlag(
      raw.invitationEmailSent ?? raw.invitation_email_sent,
    ),
    importSource:
      raw.importSource != null || raw.import_source != null
        ? (String(raw.importSource ?? raw.import_source).trim() as ContactRow["importSource"])
        : undefined,
    canSendInvitationEmail:
      raw.canSendInvitationEmail != null ||
      raw.can_send_invitation_email != null
        ? parseContactFlag(
            raw.canSendInvitationEmail ?? raw.can_send_invitation_email,
          )
        : undefined,
    dealCount: (() => {
      const v = raw.dealCount ?? raw.deal_count
      if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.floor(v))
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v)
        if (Number.isFinite(n)) return Math.max(0, Math.floor(n))
      }
      return 0
    })(),
  }
}

export type ContactsFetchResult =
  | { ok: true; contacts: ContactRow[] }
  | { ok: false; error: string }

const CONTACTS_LIST_TTL_MS = 20_000
const contactsListCache = new Map<
  string,
  { at: number; result: ContactsFetchResult }
>()

export function invalidateContactsListCache(): void {
  contactsListCache.clear()
}

function contactsListCacheKey(options?: {
  sort?: "name" | "createdAt"
  lean?: boolean
  platform?: boolean
  organizationId?: string
  allOrganizations?: boolean
}): string {
  return [
    options?.allOrganizations
      ? "all-organizations"
      : options?.organizationId?.trim() || organizationIdQueryParam() || "",
    options?.sort ?? "createdAt",
    options?.lean ? "lean" : "full",
    options?.platform ? "platform" : "org",
  ].join("|")
}

/**
 * Contacts with the failure kept, so a screen can tell "no contacts" apart from
 * "the request failed" instead of rendering an empty directory either way.
 */
export async function fetchContactsResult(options?: {
  sort?: "name" | "createdAt"
  lean?: boolean
  force?: boolean
  /** Platform admin: CRM for this company, not the active workspace. */
  organizationId?: string
  /** Platform admin All Contacts: every company, ignoring the workspace. */
  allOrganizations?: boolean
}): Promise<ContactsFetchResult> {
  const base = getApiV1Base()
  if (!base) return { ok: false, error: "API base URL is not configured." }
  const cacheKey = contactsListCacheKey(options)
  const cached = contactsListCache.get(cacheKey)
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.at < CONTACTS_LIST_TTL_MS
  ) {
    return cached.result
  }
  try {
    const params = new URLSearchParams()
    const allOrganizations = options?.allOrganizations === true
    const oid = allOrganizations
      ? ""
      : options?.organizationId?.trim() || organizationIdQueryParam() || ""
    if (oid) params.set("organizationId", oid)
    if (options?.sort === "name") params.set("sort", "name")
    if (options?.lean) params.set("lean", "1")
    const q = params.toString()
    const res = await fetch(`${base}/contacts${q ? `?${q}` : ""}`, {
      headers: {
        ...authHeaders(
          allOrganizations ? { omitActiveOrganization: true } : undefined,
        ),
      },
      credentials: "include",
    })
    const data = (await res.json().catch(() => ({}))) as {
      contacts?: unknown
      message?: unknown
    }
    if (!res.ok) {
      const message =
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : `Could not load contacts (${res.status}).`
      return { ok: false, error: message }
    }
    const list = data.contacts
    if (!Array.isArray(list)) {
      return { ok: false, error: "Contacts response was not in the expected format." }
    }
    const result: ContactsFetchResult = {
      ok: true,
      contacts: list
        .filter(
          (x): x is Record<string, unknown> => x != null && typeof x === "object",
        )
        .map(normalizeContact),
    }
    contactsListCache.set(cacheKey, { at: Date.now(), result })
    return result
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not load contacts.",
    }
  }
}

/** Signups that used a company member's invite link (Customers member dropdown). */
export async function fetchMemberInviteeContacts(
  organizationId: string,
): Promise<ContactsFetchResult> {
  const base = getApiV1Base()
  if (!base) return { ok: false, error: "API base URL is not configured." }
  const orgId = organizationId.trim()
  if (!orgId) return { ok: false, error: "Organization id is required." }
  try {
    const params = new URLSearchParams()
    params.set("organizationId", orgId)
    const res = await fetch(
      `${base}/contacts/member-invitees?${params.toString()}`,
      {
        headers: { ...authHeaders() },
        credentials: "include",
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      contacts?: unknown
      message?: unknown
    }
    if (!res.ok) {
      const message =
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : `Could not load invited contacts (${res.status}).`
      return { ok: false, error: message }
    }
    const list = data.contacts
    if (!Array.isArray(list)) {
      return { ok: false, error: "Invited contacts response was not in the expected format." }
    }
    return {
      ok: true,
      contacts: list
        .filter(
          (x): x is Record<string, unknown> => x != null && typeof x === "object",
        )
        .map(normalizeContact),
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not load invited contacts.",
    }
  }
}

export async function fetchContacts(options?: {
  sort?: "name" | "createdAt"
  lean?: boolean
  force?: boolean
}): Promise<ContactRow[]> {
  const result = await fetchContactsResult(options)
  return result.ok ? result.contacts : []
}

/** Server-side equivalents of the Contacts toolbar dropdowns. */
export type ContactsPageFilters = {
  status?: "active" | "archived"
  tag?: string | null
  owner?: string
  accreditation?: string
  offeringVisibility?: string
}

function contactsListQuery(
  search: string,
  filters: ContactsPageFilters,
): URLSearchParams {
  const query = new URLSearchParams()
  const oid = organizationIdQueryParam()
  if (oid) query.set("organizationId", oid)
  if (search) query.set("search", search)
  if (filters.status) query.set("status", filters.status)
  if (filters.tag) query.set("tag", filters.tag)
  if (filters.owner && filters.owner !== "all") query.set("owner", filters.owner)
  if (filters.accreditation && filters.accreditation !== "all") {
    query.set("accreditation", filters.accreditation)
  }
  if (filters.offeringVisibility && filters.offeringVisibility !== "all") {
    query.set("offeringVisibility", filters.offeringVisibility)
  }
  /** Opted-in self-signups belong in the same directory listing. */
  query.set("includePlatformContacts", "1")
  return query
}

export type ContactsPageResult = {
  rows: ContactRow[]
  total: number
  activeTotal: number
  archivedTotal: number
}

/**
 * One page of contacts, searched, filtered and counted by the API.
 *
 * Deliberately uncached: `useServerPagedTable` already caches and prefetches
 * pages, and a second TTL cache here would serve stale rows after an edit.
 */
export async function fetchContactsPage(params: {
  page: number
  pageSize: number
  search: string
  sort?: "name" | "createdAt"
  filters?: ContactsPageFilters
  lean?: boolean
  signal?: AbortSignal
}): Promise<ContactsPageResult> {
  const base = getApiV1Base()
  if (!base) throw new Error("API base URL is not configured.")
  const query = contactsListQuery(params.search, params.filters ?? {})
  query.set("page", String(params.page))
  query.set("pageSize", String(params.pageSize))
  if (params.sort === "name") query.set("sort", "name")
  if (params.lean) query.set("lean", "1")

  const res = await fetch(`${base}/contacts?${query.toString()}`, {
    headers: { ...authHeaders() },
    credentials: "include",
    signal: params.signal,
  })
  const data = (await res.json().catch(() => ({}))) as {
    contacts?: unknown
    total?: unknown
    activeTotal?: unknown
    archivedTotal?: unknown
    message?: unknown
  }
  if (!res.ok) {
    throw new Error(
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : `Could not load contacts (${res.status}).`,
    )
  }
  if (!Array.isArray(data.contacts)) {
    throw new Error("Contacts response was not in the expected format.")
  }
  const rows = data.contacts
    .filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
    .map(normalizeContact)
  const count = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    rows,
    total: count(data.total, rows.length),
    activeTotal: count(data.activeTotal, 0),
    archivedTotal: count(data.archivedTotal, 0),
  }
}

/**
 * Ids of every contact matching the current search and filters, so "select all"
 * and CSV export still cover the whole directory once only one page is loaded.
 */
export async function fetchContactMatchingIds(params: {
  search: string
  filters?: ContactsPageFilters
  signal?: AbortSignal
}): Promise<string[]> {
  const base = getApiV1Base()
  if (!base) throw new Error("API base URL is not configured.")
  const query = contactsListQuery(params.search, params.filters ?? {})
  const res = await fetch(`${base}/contacts/matching-ids?${query.toString()}`, {
    headers: { ...authHeaders() },
    credentials: "include",
    signal: params.signal,
  })
  const data = (await res.json().catch(() => ({}))) as {
    ids?: unknown
    message?: unknown
  }
  if (!res.ok) {
    throw new Error(
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : `Could not load matching contacts (${res.status}).`,
    )
  }
  return Array.isArray(data.ids) ? data.ids.map((x) => String(x)) : []
}

/** Deal counts and owners for the visible contacts page (max 100 ids). */
export async function fetchContactDealStats(
  ids: string[],
  options?: { organizationId?: string; allOrganizations?: boolean },
): Promise<Map<string, ContactRow>> {
  const byId = new Map<string, ContactRow>()
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  if (unique.length === 0) return byId
  const base = getApiV1Base()
  if (!base) return byId
  try {
    const params = new URLSearchParams()
    const allOrganizations = options?.allOrganizations === true
    const oid = allOrganizations
      ? ""
      : options?.organizationId?.trim() || organizationIdQueryParam() || ""
    if (oid) params.set("organizationId", oid)
    params.set("ids", unique.slice(0, 100).join(","))
    const res = await fetch(`${base}/contacts/deal-stats?${params.toString()}`, {
      headers: {
        ...authHeaders(
          allOrganizations ? { omitActiveOrganization: true } : undefined,
        ),
      },
      credentials: "include",
    })
    const data = (await res.json().catch(() => ({}))) as { contacts?: unknown }
    if (!res.ok || !Array.isArray(data.contacts)) return byId
    for (const item of data.contacts) {
      if (item == null || typeof item !== "object") continue
      const row = normalizeContact(item as Record<string, unknown>)
      if (row.id) byId.set(row.id, row)
    }
  } catch {
    /* keep empty — table still shows the directory without deal counts */
  }
  return byId
}

export async function hydrateContactDealStatsInChunks(
  ids: string[],
  options?: { organizationId?: string; allOrganizations?: boolean },
): Promise<Map<string, ContactRow>> {
  const byId = new Map<string, ContactRow>()
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = await fetchContactDealStats(unique.slice(i, i + 100), options)
    for (const [id, row] of chunk) byId.set(id, row)
  }
  return byId
}

export type PlatformContactsFetchOptions = {
  sort?: "name" | "createdAt"
  lean?: boolean
  force?: boolean
  /** One company (Customers → organization). Omit for the global Platform Contacts tab. */
  organizationId?: string
}

/**
 * Platform Contacts: opted-in self-signups, or all self-signups for platform admins.
 * The global list is cached apart from a single company's list.
 */
export async function fetchPlatformContactsResult(
  options?: PlatformContactsFetchOptions,
): Promise<ContactsFetchResult> {
  const base = getApiV1Base()
  if (!base) return { ok: false, error: "API base URL is not configured." }
  const organizationId = options?.organizationId?.trim() ?? ""
  const cacheKey = contactsListCacheKey({
    sort: options?.sort,
    lean: options?.lean,
    platform: true,
    organizationId,
    allOrganizations: organizationId.length === 0,
  })
  const cached = contactsListCache.get(cacheKey)
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.at < CONTACTS_LIST_TTL_MS
  ) {
    return cached.result
  }
  try {
    const params = new URLSearchParams()
    if (organizationId) params.set("organizationId", organizationId)
    if (options?.sort === "name") params.set("sort", "name")
    if (options?.lean) params.set("lean", "1")
    const q = params.toString()
    const res = await fetch(
      `${base}/contacts/platform-contacts${q ? `?${q}` : ""}`,
      {
        headers: { ...authHeaders() },
        credentials: "include",
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      contacts?: unknown
      message?: unknown
    }
    if (!res.ok) {
      const message =
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : `Could not load platform contacts (${res.status}).`
      return { ok: false, error: message }
    }
    const list = data.contacts
    if (!Array.isArray(list)) {
      return {
        ok: false,
        error: "Platform contacts response was not in the expected format.",
      }
    }
    const result: ContactsFetchResult = {
      ok: true,
      contacts: list
        .filter(
          (x): x is Record<string, unknown> => x != null && typeof x === "object",
        )
        .map(normalizeContact),
    }
    contactsListCache.set(cacheKey, { at: Date.now(), result })
    return result
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Could not load platform contacts.",
    }
  }
}

/** Platform Contacts list. Failures become an empty list for pickers that only need rows. */
export async function fetchPlatformContacts(
  options?: PlatformContactsFetchOptions,
): Promise<ContactRow[]> {
  const result = await fetchPlatformContactsResult(options)
  return result.ok ? result.contacts : []
}

function contactEmailKey(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Self-registered investors who did not opt in cannot be added to deals.
 */
export function contactEligibleForDealRoster(row: ContactRow): boolean {
  if (row.platformAdminOnly === true) return row.visibleToUsers === true
  return true
}

/** Drop platform rows already present in the viewer’s CRM (same id or email). */
export function platformContactsNotAlreadyInList(
  orgContacts: ContactRow[],
  platformContacts: ContactRow[],
): ContactRow[] {
  const ids = new Set(orgContacts.map((c) => c.id))
  const emails = new Set(
    orgContacts
      .map((c) => contactEmailKey(c.email))
      .filter((e) => e.includes("@")),
  )
  return platformContacts.filter((p) => {
    if (ids.has(p.id)) return false
    const em = contactEmailKey(p.email)
    if (em.includes("@") && emails.has(em)) return false
    return true
  })
}

/**
 * CRM contacts plus Platform Contacts for Add Investor / Add Member pickers.
 * Hidden self-signups (visibility No) are omitted even for platform admins.
 */
export async function fetchDealContactPickerLists(options?: {
  sort?: "name" | "createdAt"
}): Promise<{ contacts: ContactRow[]; platformContacts: ContactRow[] }> {
  const [contacts, platform] = await Promise.all([
    fetchContacts({ ...options, lean: true }),
    fetchPlatformContacts({ ...options, lean: true }),
  ])
  const dealEligibleContacts = contacts.filter(contactEligibleForDealRoster)
  const dealEligiblePlatform = platform.filter(contactEligibleForDealRoster)
  return {
    contacts: dealEligibleContacts,
    platformContacts: platformContactsNotAlreadyInList(
      dealEligibleContacts,
      dealEligiblePlatform,
    ),
  }
}

function parseContactDealLastWent(value: unknown): string | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export async function fetchContactDeals(
  id: string,
): Promise<ContactDealRow[]> {
  const base = getApiV1Base()
  if (!base || !id.trim()) return []
  const params = new URLSearchParams()
  const oid = organizationIdQueryParam()
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/deals${q ? `?${q}` : ""}`,
    {
      headers: { ...authHeaders() },
      credentials: "include",
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    deals?: unknown
    message?: unknown
  }
  if (!res.ok) {
    throw new Error(
      typeof data.message === "string" && data.message.trim()
        ? data.message
        : "Could not load deals",
    )
  }
  if (!Array.isArray(data.deals)) return []
  return data.deals
    .map((row) => {
      if (!row || typeof row !== "object") return null
      const r = row as Record<string, unknown>
      const dealId = String(r.dealId ?? r.deal_id ?? "").trim()
      if (!dealId) return null
      return {
        dealId,
        dealName: String(r.dealName ?? r.deal_name ?? "").trim(),
        contactRole: String(r.contactRole ?? r.contact_role ?? "").trim(),
        dealOrganization: String(
          r.dealOrganization ?? r.deal_organization ?? "",
        ).trim(),
        lastWentAt: parseContactDealLastWent(
          r.lastWentAt ?? r.last_went_at,
        ),
      } satisfies ContactDealRow
    })
    .filter((row): row is ContactDealRow => row != null)
}

export async function fetchContact(id: string): Promise<ContactRow | null> {
  const base = getApiV1Base()
  if (!base || !id.trim()) return null
  try {
    const params = new URLSearchParams()
    const oid = organizationIdQueryParam()
    if (oid) params.set("organizationId", oid)
    const q = params.toString()
    const res = await fetch(
      `${base}/contacts/${encodeURIComponent(id)}${q ? `?${q}` : ""}`,
      {
        headers: { ...authHeaders() },
        credentials: "include",
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      contact?: Record<string, unknown>
    }
    if (!res.ok) return null
    const c = data.contact
    if (!c || typeof c !== "object") return null
    return normalizeContact(c)
  } catch {
    return null
  }
}

function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const msg = (data as { message?: unknown }).message
    if (typeof msg === "string" && msg.trim()) return msg
  }
  return fallback
}

export async function parseContactImportFile(
  file: File,
): Promise<ContactImportParseResult> {
  const base = getApiV1Base()
  if (!base) throw new Error("API is not configured (VITE_BASE_URL).")
  const form = new FormData()
  form.set("file", file)
  const res = await fetch(`${base}/contacts/import/parse`, {
    method: "POST",
    headers: { ...authHeaders() },
    credentials: "include",
    body: form,
  })
  const data = (await res.json().catch(() => ({}))) as ContactImportParseResult & {
    message?: string
  }
  if (!res.ok) {
    throw new Error(apiErrorMessage(data, `Could not parse file (${res.status}).`))
  }
  return data
}

export async function previewContactImport(params: {
  batchId: string
  mapping: ContactImportMapping
}): Promise<ContactImportPreviewResult> {
  const base = getApiV1Base()
  if (!base) throw new Error("API is not configured (VITE_BASE_URL).")
  const res = await fetch(
    `${base}/contacts/import/${encodeURIComponent(params.batchId)}/preview`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ mapping: params.mapping }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as ContactImportPreviewResult & {
    message?: string
  }
  if (!res.ok) {
    throw new Error(apiErrorMessage(data, `Could not preview import (${res.status}).`))
  }
  return data
}

export async function confirmContactImport(params: {
  batchId: string
  duplicateMode: ContactImportDuplicateMode
}): Promise<ContactImportConfirmResult> {
  const base = getApiV1Base()
  if (!base) throw new Error("API is not configured (VITE_BASE_URL).")
  const res = await fetch(
    `${base}/contacts/import/${encodeURIComponent(params.batchId)}/confirm`,
    {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ duplicateMode: params.duplicateMode }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as ContactImportConfirmResult & {
    message?: string
  }
  if (!res.ok) {
    throw new Error(apiErrorMessage(data, `Could not import contacts (${res.status}).`))
  }
  invalidateContactsListCache()
  return data
}

export async function createContact(
  payload: Omit<ContactRow, "id" | "createdByDisplayName"> & {
    sendInvitationMail?: "yes" | "no"
  },
  options?: { organizationId?: string },
): Promise<ContactRow & { invitationEmailSent?: boolean }> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const params = new URLSearchParams()
  const oid = options?.organizationId?.trim() || ""
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const res = await fetch(`${base}/contacts${q ? `?${q}` : ""}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      first_name: payload.firstName,
      last_name: payload.lastName,
      email: payload.email,
      phone: payload.phone,
      note: payload.note,
      tags: payload.tags,
      lists: payload.lists,
      owners: payload.owners,
      send_invitation_mail: payload.sendInvitationMail ?? "no",
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
    invitationEmailSent?: unknown
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return {
    ...normalizeContact(c as Record<string, unknown>),
    invitationEmailSent:
      data.invitationEmailSent === true ||
      parseContactFlag(
        (c as Record<string, unknown>).invitationEmailSent ??
          (c as Record<string, unknown>).invitation_email_sent,
      ),
  }
}

export async function sendContactInvitation(
  id: string,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const params = new URLSearchParams()
  const oid = organizationIdQueryParam()
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/send-invitation${q ? `?${q}` : ""}`,
    {
      method: "POST",
      headers: { ...authHeaders() },
      credentials: "include",
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c)
}

/** This user's own investor signup link; signups through it become their contacts. */
export async function fetchInvestorInviteLink(): Promise<string> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  const params = new URLSearchParams()
  const oid = organizationIdQueryParam()
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const res = await fetch(
    `${base}/contacts/investor-invite-link${q ? `?${q}` : ""}`,
    {
      headers: { ...authHeaders() },
      credentials: "include",
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    inviteUrl?: unknown
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const url = String(data.inviteUrl ?? "").trim()
  if (!url) throw new Error("Invalid response")
  return url
}

export async function updateContact(
  id: string,
  payload: Omit<ContactRow, "id" | "createdByDisplayName">,
  editReason: string,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(`${base}/contacts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      first_name: payload.firstName,
      last_name: payload.lastName,
      email: payload.email,
      phone: payload.phone,
      note: payload.note,
      tags: payload.tags,
      lists: payload.lists,
      owners: payload.owners,
      edit_reason: editReason.trim(),
    }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

export async function patchContactStatus(
  id: string,
  status: ContactStatus,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/status`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ status }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

export async function patchContactShowOfferings(
  id: string,
  showOfferingsVisibility: ContactOfferingVisibility | null,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/show-offerings`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ showOfferingsVisibility }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

export async function patchContactAccreditationStatus(
  id: string,
  accreditationStatus: string | null,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/accreditation-status`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ accreditationStatus }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

export async function patchContactKnownSince(
  id: string,
  knownSince: string | null,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/known-since`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ knownSince }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

export async function patchContactRelationship506b(
  id: string,
  relationship506b: ContactRelationship506b | null,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  invalidateContactsListCache()
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/relationship-506b`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ relationship506b }),
    },
  )
  const data = (await res.json().catch(() => ({}))) as {
    message?: unknown
    contact?: Record<string, unknown>
  }
  if (!res.ok) {
    const msg =
      data?.message != null ? String(data.message) : `Error ${res.status}`
    throw new Error(msg)
  }
  const c = data.contact
  if (!c || typeof c !== "object") throw new Error("Invalid response")
  return normalizeContact(c as Record<string, unknown>)
}

/** Notify configured inbox that contacts were exported (Excel/CSV). Best-effort; failures are ignored by callers. */
export async function notifyContactsExportAudit(params: {
  rowCount: number
  exportedContactLines?: string[]
}): Promise<void> {
  const base = getApiV1Base()
  if (!base) return
  try {
    await fetch(`${base}/contacts/export-notify`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        rowCount: params.rowCount,
        format: "excel_csv",
        exportedContactLines: params.exportedContactLines,
      }),
    })
  } catch {
    /* non-blocking */
  }
}

/** Distinct tag names from `organization_contact_tag` (CRM catalog / autocomplete). */
export async function fetchOrganizationContactTags(options?: {
  organizationId?: string
}): Promise<string[]> {
  const base = getApiV1Base()
  if (!base) return []
  const params = new URLSearchParams()
  const oid = options?.organizationId?.trim() ?? organizationIdQueryParam()
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const url = `${base}/contacts/organization-tags${q ? `?${q}` : ""}`
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders() },
      credentials: "include",
    })
    const data = (await res.json().catch(() => ({}))) as { tags?: unknown }
    if (!res.ok) return []
    const raw = data.tags
    return Array.isArray(raw)
      ? raw.map((x) => String(x).trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

/** Distinct list names from `organization_contact_list` (CRM catalog / autocomplete). */
export async function fetchOrganizationContactLists(options?: {
  organizationId?: string
}): Promise<string[]> {
  const base = getApiV1Base()
  if (!base) return []
  const params = new URLSearchParams()
  const oid = options?.organizationId?.trim() ?? organizationIdQueryParam()
  if (oid) params.set("organizationId", oid)
  const q = params.toString()
  const url = `${base}/contacts/organization-lists${q ? `?${q}` : ""}`
  try {
    const res = await fetch(url, {
      headers: { ...authHeaders() },
      credentials: "include",
    })
    const data = (await res.json().catch(() => ({}))) as { lists?: unknown }
    if (!res.ok) return []
    const raw = data.lists
    return Array.isArray(raw)
      ? raw.map((x) => String(x).trim()).filter(Boolean)
      : []
  } catch {
    return []
  }
}

function normalizeOwnerSponsor(
  raw: Record<string, unknown>,
): ContactOwnerSponsorOption | null {
  const displayName = String(raw.displayName ?? raw.display_name ?? "").trim()
  const userId = String(raw.userId ?? raw.user_id ?? "").trim()
  if (!displayName) return null
  return {
    userId,
    displayName,
    email: String(raw.email ?? "").trim(),
  }
}

/** Org / role-scoped sponsors for the contact Owners dropdown. */
export async function fetchContactOwnerSponsors(options?: {
  contactId?: string
  organizationId?: string
}): Promise<{
  sponsors: ContactOwnerSponsorOption[]
  lockToListed: boolean
}> {
  const empty = { sponsors: [] as ContactOwnerSponsorOption[], lockToListed: false }
  const base = getApiV1Base()
  if (!base) return empty
  try {
    const params = new URLSearchParams()
    const oid =
      options?.organizationId?.trim() || organizationIdQueryParam() || ""
    if (oid) params.set("organizationId", oid)
    const contactId = options?.contactId?.trim()
    if (contactId) params.set("contactId", contactId)
    const q = params.toString()
    const res = await fetch(
      `${base}/contacts/owner-sponsors${q ? `?${q}` : ""}`,
      {
        headers: { ...authHeaders() },
        credentials: "include",
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      sponsors?: unknown
      lockToListed?: unknown
    }
    if (!res.ok) return empty
    const list = data.sponsors
    if (!Array.isArray(list)) return empty
    return {
      sponsors: list
        .filter(
          (x): x is Record<string, unknown> =>
            x != null && typeof x === "object" && !Array.isArray(x),
        )
        .map(normalizeOwnerSponsor)
        .filter((x): x is ContactOwnerSponsorOption => x != null),
      lockToListed: data.lockToListed === true,
    }
  } catch {
    return empty
  }
}
