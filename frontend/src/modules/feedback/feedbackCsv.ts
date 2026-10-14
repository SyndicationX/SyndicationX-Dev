import { formatDateDdMmmYyyy } from "@/common/utils/formatDateDisplay"
import { downloadTableExportCsv } from "@/common/utils/tableExportFilename"
import type { FeedbackItem } from "./types"
import { feedbackPriorityLabel, feedbackUserRoleLabel } from "./types"

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function formatDateTime(raw: string | null | undefined): string {
  if (!raw?.trim()) return ""
  const date = formatDateDdMmmYyyy(raw)
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return date === "—" ? "" : date
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  return `${date} ${time}`
}

export function feedbackExportLabel(row: FeedbackItem): string {
  const who = row.username.trim() || row.userEmail.trim()
  const page = [row.pageLabel, row.subPageLabel].filter(Boolean).join(" / ")
  if (who && page) return `${who} — ${page}`
  return who || page || "Feedback"
}

export function buildFeedbackCsv(rows: FeedbackItem[]): string {
  const headers = [
    "S.No",
    "Username",
    "User Email",
    "Role",
    "Page",
    "Sub Page / Tab",
    "Priority",
    "Feedback Type",
    "Description",
    "Status",
    "Submitted Date",
    "Review Comments",
    "Reviewed Date",
    "Reviewed By",
    "Resolved Date",
  ]
  const lines = [headers.map(escapeCsvCell).join(",")]
  for (const row of rows) {
    const roleLabel = feedbackUserRoleLabel(row.userRole)
    lines.push(
      [
        row.feedbackNo > 0 ? String(row.feedbackNo) : "",
        row.username,
        row.userEmail,
        roleLabel === "—" ? "" : roleLabel,
        row.pageLabel,
        row.subPageLabel,
        row.priority ? feedbackPriorityLabel(row.priority) : "",
        row.feedbackType ?? "",
        row.description,
        row.status,
        formatDateTime(row.createdAt),
        row.adminResponse ?? "",
        formatDateTime(row.reviewedAt),
        row.reviewedByName ?? "",
        formatDateTime(row.resolvedAt),
      ]
        .map((c) => escapeCsvCell(String(c)))
        .join(","),
    )
  }
  return `\uFEFF${lines.join("\r\n")}`
}

export function downloadFeedbackCsv(content: string, filename: string): void {
  downloadTableExportCsv(content, filename)
}
