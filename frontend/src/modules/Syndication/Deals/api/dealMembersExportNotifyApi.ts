import { SESSION_BEARER_KEY } from "@/common/auth/sessionKeys"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"

function authHeaders(): HeadersInit {
  const token =
    typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(SESSION_BEARER_KEY)
      : null
  const h: HeadersInit = {}
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** Same audit/email pattern as members export. Best-effort; failures are ignored by callers. */
export async function notifyDealMembersExportAudit(
  dealId: string,
  params: {
    rowCount: number
    exportedLines?: string[]
    rosterLabel?: string
  },
): Promise<void> {
  const base = getApiV1Base()
  if (!base || !dealId.trim()) return
  try {
    await fetch(
      `${base}/deals/${encodeURIComponent(dealId.trim())}/members/export-notify`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          rowCount: params.rowCount,
          format: "xlsx",
          exportedLines: params.exportedLines,
          rosterLabel: params.rosterLabel,
        }),
      },
    )
  } catch {
    /* non-blocking */
  }
}
