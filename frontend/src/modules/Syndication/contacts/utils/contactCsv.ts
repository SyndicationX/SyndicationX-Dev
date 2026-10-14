import { formatDateDdMmmYyyy } from "@/common/utils/formatDateDisplay"
import type { ContactRow } from "../types/contact.types"
import { CONTACT_RELATIONSHIP_506B_OPTIONS } from "../types/contact.types"

/** Table / UI / CSV: **DD-MMM-YYYY** (application standard). */
export function formatContactSinceLabel(iso: string | undefined): string {
  return formatDateDdMmmYyyy(iso)
}

function sinceForCsv(row: ContactRow): string {
  const v = formatContactSinceLabel(row.createdAt)
  return v === "—" ? "" : v
}

export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value))
    return `"${value.replace(/"/g, '""')}"`
  return value
}

export function joinMulti(values: string[]): string {
  return values.filter(Boolean).join("; ")
}

/** One line per exported row for the audit email (name + email). */
export function exportAuditLinesForContacts(rows: ContactRow[]): string[] {
  return rows.map((r) => {
    const n = [r.firstName, r.lastName].filter(Boolean).join(" ").trim()
    const label = n || r.email || "—"
    const em = r.email?.trim()
    return em ? `${label} (${em})` : String(label)
  })
}

export function buildPlatformContactsCsv(
  rows: ContactRow[],
  opts?: { includeVisibility?: boolean },
): string {
  const includeVisibility = opts?.includeVisibility === true
  const headers = [
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Accreditation Status",
    // "Invited by",
    ...(includeVisibility ? ["Visible on platform"] : []),
    "Joined",
  ]
  const lines = [headers.map(escapeCsvCell).join(",")]
  for (const row of rows) {
    const status = (row.accreditationStatus ?? "").trim()
    const cells = [
      row.firstName,
      row.lastName,
      row.email,
      row.phone,
      status || "N/A",
      // row.invitedByDisplayName?.trim() ?? "",
      ...(includeVisibility
        ? [row.visibleToUsers === true ? "Yes" : "No"]
        : []),
      sinceForCsv(row),
    ]
    lines.push(cells.map((c) => escapeCsvCell(String(c))).join(","))
  }
  return `\uFEFF${lines.join("\r\n")}`
}

export function buildContactsCsv(
  rows: ContactRow[],
  opts?: { includeVisibility?: boolean; includeOrganization?: boolean },
): string {
  const includeVisibility = opts?.includeVisibility === true
  const includeOrganization = opts?.includeOrganization === true
  const headers = [
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Deals",
    "Relationship",
    "Note",
    "Contact tags",
    "Lists",
    "Owners",
    ...(includeOrganization ? ["Organization"] : []),
    "Invited by",
    ...(includeVisibility ? ["Visible on platform"] : []),
    "Added by",
    "Since",
  ]
  const lines = [headers.map(escapeCsvCell).join(",")]
  for (const row of rows) {
    lines.push(
      [
        row.firstName,
        row.lastName,
        row.email,
        row.phone,
        String(row.dealCount ?? 0),
        CONTACT_RELATIONSHIP_506B_OPTIONS.find(
          (o) => o.value === (row.relationship506b === "YES" ? "YES" : "NO"),
        )?.label ?? "506(b) No",
        row.note,
        joinMulti(row.tags),
        joinMulti(row.lists),
        joinMulti(row.owners),
        ...(includeOrganization ? [row.organizationName?.trim() ?? ""] : []),
        row.invitedByDisplayName?.trim() ?? "",
        ...(includeVisibility
          ? [row.visibleToUsers === true ? "Yes" : "No"]
          : []),
        row.createdByDisplayName ?? "",
        sinceForCsv(row),
      ]
        .map((c) => escapeCsvCell(String(c)))
        .join(","),
    )
  }
  return `\uFEFF${lines.join("\r\n")}`
}

export function downloadContactsCsv(content: string, filename: string): void {
  const blob = new Blob([content], {
    type: "text/csv;charset=utf-8;",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
