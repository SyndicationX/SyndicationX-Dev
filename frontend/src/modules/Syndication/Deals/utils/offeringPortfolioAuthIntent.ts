import {
  enablePortfolioRecentlyViewedForUser,
  INVESTING_DASHBOARD_OPPORTUNITIES_URL,
  migratePendingRecentlyViewedDeal,
  recordRecentlyViewedDeal,
} from "@/modules/Investing/pages/dashboard/recentlyViewedDeals"
import { getStoredAccessToken } from "@/common/auth/authTokensApi"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"

const STORAGE_KEY = "ip_offering_portfolio_auth_intent:v1"
const MAX_AGE_MS = 60 * 60 * 1000

export type OfferingPortfolioAuthIntent = {
  dealId: string
  previewToken?: string
  sponsorRef?: string
  createdAt: number
}

export function dealOfferingPortfolioPath(dealId: string): string {
  const id = String(dealId ?? "").trim()
  if (!id) return "/dashboard"
  return `/deals/${encodeURIComponent(id)}/offering-portfolio`
}

export function writeOfferingPortfolioAuthIntent(
  dealId: string,
  previewToken?: string | null,
  sponsorRef?: string | null,
): void {
  const id = String(dealId ?? "").trim()
  if (!id || typeof sessionStorage === "undefined") return
  const preview = String(previewToken ?? "").trim()
  const ref = String(sponsorRef ?? "").trim()
  const payload: OfferingPortfolioAuthIntent = {
    dealId: id,
    ...(preview ? { previewToken: preview } : {}),
    ...(ref ? { sponsorRef: ref } : {}),
    createdAt: Date.now(),
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* quota / private mode */
  }
}

/** Preview token and sponsor ref carried on `/offering_portfolio?preview=&ref=`. */
export function offeringPreviewParamsFromReturnPath(
  path: string | null | undefined,
): { previewToken?: string; sponsorRef?: string } {
  const raw = String(path ?? "").trim()
  if (!raw || !isPublicOfferingPortfolioReturnPath(raw)) return {}
  try {
    const url = new URL(raw, "http://localhost")
    const previewToken = url.searchParams.get("preview")?.trim() ?? ""
    const sponsorRef = url.searchParams.get("ref")?.trim() ?? ""
    return {
      ...(previewToken ? { previewToken } : {}),
      ...(sponsorRef ? { sponsorRef } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Claim target after sign-in or signup. Session intent wins; the return URL
 * still supplies the preview token when the visitor opened the share link
 * and then signed in.
 */
export function resolveOfferingPortfolioClaimIntent(
  returnPath?: string | null,
): OfferingPortfolioAuthIntent | null {
  const stored = readOfferingPortfolioAuthIntent()
  const fromUrl = offeringPreviewParamsFromReturnPath(returnPath)
  const previewToken = stored?.previewToken || fromUrl.previewToken || ""
  const sponsorRef = stored?.sponsorRef || fromUrl.sponsorRef || ""
  const dealId = stored?.dealId || ""
  if (!previewToken && !dealId) return null
  return {
    dealId: dealId || "preview",
    ...(previewToken ? { previewToken } : {}),
    ...(sponsorRef ? { sponsorRef } : {}),
    createdAt: stored?.createdAt ?? Date.now(),
  }
}

export function readOfferingPortfolioAuthIntent(): OfferingPortfolioAuthIntent | null {
  if (typeof sessionStorage === "undefined") return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw?.trim()) return null
    const parsed = JSON.parse(raw) as OfferingPortfolioAuthIntent
    const dealId = String(parsed?.dealId ?? "").trim()
    const createdAt = Number(parsed?.createdAt)
    if (!dealId || !Number.isFinite(createdAt)) return null
    if (Date.now() - createdAt > MAX_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    const previewToken = String(parsed?.previewToken ?? "").trim()
    const sponsorRef = String(parsed?.sponsorRef ?? "").trim()
    return {
      dealId,
      ...(previewToken ? { previewToken } : {}),
      ...(sponsorRef ? { sponsorRef } : {}),
      createdAt,
    }
  } catch {
    return null
  }
}

export function clearOfferingPortfolioAuthIntent(): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function consumeOfferingPortfolioAuthIntent(): OfferingPortfolioAuthIntent | null {
  const intent = readOfferingPortfolioAuthIntent()
  if (intent) clearOfferingPortfolioAuthIntent()
  return intent
}

export async function claimOfferingPortfolioAccess(
  intent: OfferingPortfolioAuthIntent,
): Promise<{ dealId: string; userDetails?: unknown } | null> {
  const previewToken = String(intent.previewToken ?? "").trim()
  if (!previewToken) return null
  const base = getApiV1Base()
  const accessToken = getStoredAccessToken()
  if (!base || !accessToken) {
    throw new Error("Could not authenticate the offering access request.")
  }
  const response = await fetch(`${base}/auth/offering-preview/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      previewToken,
      ...(intent.sponsorRef?.trim()
        ? { sponsorRef: intent.sponsorRef.trim() }
        : {}),
    }),
  })
  const data = (await response.json().catch(() => ({}))) as {
    dealId?: string
    userDetails?: unknown
    message?: string
  }
  if (!response.ok) {
    throw new Error(
      data.message?.trim() || "Could not add this offering to your account.",
    )
  }
  const rawDetails = data.userDetails
  const userDetails = Array.isArray(rawDetails)
    ? rawDetails
    : rawDetails && typeof rawDetails === "object"
      ? [rawDetails]
      : undefined
  return {
    dealId: String(data.dealId ?? intent.dealId).trim(),
    userDetails,
  }
}

export function applyOfferingPortfolioPostAuth(dealId: string): {
  redirectTo: string
  postAuthState: { returnTo: string }
} {
  const id = String(dealId ?? "").trim()
  enablePortfolioRecentlyViewedForUser()
  migratePendingRecentlyViewedDeal()
  recordRecentlyViewedDeal(id)
  return {
    redirectTo: dealOfferingPortfolioPath(id),
    postAuthState: { returnTo: INVESTING_DASHBOARD_OPPORTUNITIES_URL },
  }
}

/** Public share URL should not override the authenticated offering after login. */
export function isPublicOfferingPortfolioReturnPath(
  path: string | null | undefined,
): boolean {
  const p = String(path ?? "").trim()
  if (!p.startsWith("/")) return false
  return /\/offering_portfolio(?:\/|$|\?)/.test(p)
}
