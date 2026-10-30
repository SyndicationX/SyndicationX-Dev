import { portalAuthHeaders } from "@/common/auth/portalAuthHeaders"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"

export const INVESTMENT_DETAIL_REFETCH_EVENT = "sx-investment-detail-refetch"

export type MyInvestorParticipationState = {
  archivedDealIds: string[]
  removedDealIds: string[]
}

type MutationResult =
  | { ok: true; sponsorNotified: boolean }
  | { ok: false; message: string }

export async function fetchMyInvestorParticipation(): Promise<MyInvestorParticipationState> {
  const base = getApiV1Base()
  if (!base) return { archivedDealIds: [], removedDealIds: [] }
  const res = await fetch(`${base}/deals/my-participation`, {
    headers: { ...portalAuthHeaders() },
    credentials: "include",
  })
  if (!res.ok) return { archivedDealIds: [], removedDealIds: [] }
  const data = (await res.json().catch(() => ({}))) as Partial<MyInvestorParticipationState>
  const archivedDealIds = Array.isArray(data.archivedDealIds)
    ? data.archivedDealIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : []
  const removedDealIds = Array.isArray(data.removedDealIds)
    ? data.removedDealIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : []
  return { archivedDealIds, removedDealIds }
}

async function sendParticipation(
  path: string,
  method: "PATCH" | "DELETE",
  body: Record<string, unknown>,
  fallback: string,
): Promise<MutationResult> {
  const base = getApiV1Base()
  if (!base) return { ok: false, message: "VITE_BASE_URL is not configured." }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...portalAuthHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    message?: string
    sponsorNotified?: boolean
  }
  if (!res.ok) return { ok: false, message: data.message?.trim() || fallback }
  return { ok: true, sponsorNotified: data.sponsorNotified === true }
}

export function patchMyInvestorDealParticipation(
  dealId: string,
  archived: boolean,
  reason?: string,
): Promise<MutationResult> {
  return sendParticipation(
    `/deals/${encodeURIComponent(dealId)}/my-participation`,
    "PATCH",
    { archived, reason: reason ?? "" },
    archived ? "Could not archive this deal." : "Could not restore this deal.",
  )
}

export function deleteMyInvestorDealParticipation(
  dealId: string,
  reason?: string,
): Promise<MutationResult> {
  return sendParticipation(
    `/deals/${encodeURIComponent(dealId)}/my-participation`,
    "DELETE",
    { reason: reason ?? "" },
    "Could not remove this soft commitment.",
  )
}

export function patchMyInvestorProfileParticipation(
  dealId: string,
  investmentId: string,
  archived: boolean,
  reason?: string,
): Promise<MutationResult> {
  return sendParticipation(
    `/deals/${encodeURIComponent(dealId)}/my-participation/${encodeURIComponent(investmentId)}`,
    "PATCH",
    { archived, reason: reason ?? "" },
    archived ? "Could not archive this profile." : "Could not restore this profile.",
  )
}

export function deleteMyInvestorProfileParticipation(
  dealId: string,
  investmentId: string,
  reason?: string,
): Promise<MutationResult> {
  return sendParticipation(
    `/deals/${encodeURIComponent(dealId)}/my-participation/${encodeURIComponent(investmentId)}`,
    "DELETE",
    { reason: reason ?? "" },
    "Could not remove this profile.",
  )
}

export function participationSavedDescription(sponsorNotified: boolean): string {
  return sponsorNotified
    ? "The sponsor on this deal was notified."
    : "Saved. The sponsor could not be emailed."
}
