export type FeedbackStatus = "Pending" | "Reviewed" | "Resolved"

export type FeedbackReviewAction = "reviewed" | "resolved"

export type FeedbackPriority = "P0" | "P1" | "P2" | "P3"

export type FeedbackType = "Feature Request" | "Bug Report" | "Change Request"

export const FEEDBACK_PRIORITY_OPTIONS: {
  value: FeedbackPriority
  label: string
}[] = [
  { value: "P0", label: "Critical" },
  { value: "P1", label: "High" },
  { value: "P2", label: "Medium" },
  { value: "P3", label: "Low" },
]

export const FEEDBACK_TYPE_OPTIONS: {
  value: FeedbackType
  label: string
}[] = [
  { value: "Feature Request", label: "Feature Request" },
  { value: "Bug Report", label: "Bug Report" },
  { value: "Change Request", label: "Change Request" },
]

export function parseFeedbackPriority(raw: unknown): FeedbackPriority | null {
  const s = String(raw ?? "").trim().toUpperCase()
  if (s === "P0" || s === "P1" || s === "P2" || s === "P3") return s
  return null
}

export function parseFeedbackType(raw: unknown): FeedbackType | null {
  const s = String(raw ?? "").trim().toLowerCase()
  if (s === "feature request") return "Feature Request"
  if (s === "bug report") return "Bug Report"
  if (s === "change request") return "Change Request"
  return null
}

export function feedbackPriorityLabel(
  priority: FeedbackPriority | null | undefined,
): string {
  if (!priority) return "—"
  return (
    FEEDBACK_PRIORITY_OPTIONS.find((o) => o.value === priority)?.label ??
    priority
  )
}

export function feedbackUserRoleLabel(
  role: string | null | undefined,
): string {
  const r = String(role ?? "").trim().toLowerCase()
  if (!r) return "—"
  const byCode: Record<string, string> = {
    platform_admin: "Platform Admin",
    platform_user: "Platform user",
    user: "Platform user",
    company_admin: "Company Admin",
    company_user: "Company Member",
    deal_participant: "Deal Participant",
    investor: "Investor",
  }
  if (byCode[r]) return byCode[r]
  const raw = String(role ?? "").trim()
  return (
    raw
      .split(/[\s_-]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ") || "—"
  )
}

export type FeedbackAlertKind =
  | "submitter_reviewed"
  | "submitter_resolved"
  | "admin_new"
  | "admin_updated"

export type FeedbackSubPageOption = {
  key: string
  label: string
}

export type FeedbackPageOption = {
  pageKey: string
  pageLabel: string
  sortOrder: string
  subPages: FeedbackSubPageOption[]
}

export type FeedbackItem = {
  id: string
  /** Permanent entry order. The first submitted feedback is 1. */
  feedbackNo: number
  userId: string
  username: string
  userEmail: string
  userRole: string | null
  pageKey: string
  pageLabel: string
  subPageKey: string
  subPageLabel: string
  description: string
  priority: FeedbackPriority | null
  feedbackType: FeedbackType | null
  status: FeedbackStatus
  adminResponse: string | null
  createdAt: string
  reviewedAt: string | null
  reviewedByUserId: string | null
  reviewedByName: string | null
  resolvedAt: string | null
  viewerIsSubmitter?: boolean
  viewerIsReviewer?: boolean
  alertKinds?: FeedbackAlertKind[]
}
