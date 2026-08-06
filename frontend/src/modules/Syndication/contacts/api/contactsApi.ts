import { portalAuthHeaders, organizationIdQueryParam } from "@/common/auth/portalAuthHeaders"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"
import type {
  ContactRow,
  ContactShowOfferings,
  ContactStatus,
} from "../types/contact.types"

function authHeaders(): HeadersInit {
  return portalAuthHeaders()
}

function normalizeStatus(raw: unknown): ContactRow["status"] {
  const s = String(raw ?? "active").trim().toLowerCase()
  return s === "suspended" ? "suspended" : "active"
}

function normalizeShowOfferings(raw: unknown): ContactShowOfferings {
  const s = String(raw ?? "show").trim().toLowerCase()
  if (s === "506c" || s === "hide") return s
  return "show"
}

function normalizeContact(raw: Record<string, unknown>): ContactRow {
  const tags = raw.tags
  const lists = raw.lists
  const owners = raw.owners
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
    showOfferings: normalizeShowOfferings(
      raw.showOfferings ?? raw.show_offerings,
    ),
    lastEditReason:
      raw.lastEditReason != null || raw.last_edit_reason != null
        ? String(raw.lastEditReason ?? raw.last_edit_reason).trim() ||
          undefined
        : undefined,
    createdByDisplayName:
      raw.createdByDisplayName != null || raw.created_by_display_name != null
        ? String(raw.createdByDisplayName ?? raw.created_by_display_name)
        : undefined,
    createdAt:
      raw.createdAt != null || raw.created_at != null
        ? String(raw.createdAt ?? raw.created_at).trim() || undefined
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

export async function fetchContacts(): Promise<ContactRow[]> {
  const base = getApiV1Base()
  if (!base) return []
  try {
    const params = new URLSearchParams()
    const oid = organizationIdQueryParam()
    if (oid) params.set("organizationId", oid)
    const q = params.toString()
    const res = await fetch(`${base}/contacts${q ? `?${q}` : ""}`, {
      headers: { ...authHeaders() },
      credentials: "include",
    })
    const data = (await res.json().catch(() => ({}))) as {
      contacts?: unknown
    }
    if (!res.ok) return []
    const list = data.contacts
    if (!Array.isArray(list)) return []
    return list
      .filter((x): x is Record<string, unknown> => x != null && typeof x === "object")
      .map(normalizeContact)
  } catch {
    return []
  }
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

export async function createContact(
  payload: Omit<ContactRow, "id" | "createdByDisplayName">,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  const res = await fetch(`${base}/contacts`, {
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

export async function updateContact(
  id: string,
  payload: Omit<ContactRow, "id" | "createdByDisplayName">,
  editReason: string,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
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
  showOfferings: ContactShowOfferings,
): Promise<ContactRow> {
  const base = getApiV1Base()
  if (!base) {
    throw new Error("API is not configured (VITE_BASE_URL).")
  }
  const res = await fetch(
    `${base}/contacts/${encodeURIComponent(id)}/show-offerings`,
    {
      method: "PATCH",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ showOfferings }),
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
