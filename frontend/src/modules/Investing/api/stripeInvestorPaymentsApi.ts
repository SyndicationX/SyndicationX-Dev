import { portalAuthHeaders } from "@/common/auth/portalAuthHeaders"
import { getApiV1Base } from "@/common/utils/apiBaseUrl"

function baseOrThrow(): string {
  const base = getApiV1Base()
  if (!base) throw new Error("API is not configured (VITE_BASE_URL).")
  return base
}

async function jsonOrError(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(
      typeof data.message === "string"
        ? data.message
        : `Payment request failed (${res.status}).`,
    )
  }
  return data
}

export async function startInvestorInvestmentCheckout(
  dealId: string,
  investmentId: string,
): Promise<{ url: string; sessionId: string; paymentStatus: string }> {
  const base = baseOrThrow()
  const res = await fetch(
    `${base}/deals/${encodeURIComponent(dealId)}/investments/${encodeURIComponent(investmentId)}/checkout`,
    {
      method: "POST",
      headers: portalAuthHeaders({ omitActiveOrganization: true }),
      credentials: "include",
    },
  )
  const data = await jsonOrError(res)
  const url = String(data.url ?? "").trim()
  if (!url) throw new Error("Stripe Checkout did not return a redirect URL.")
  return {
    url,
    sessionId: String(data.sessionId ?? "").trim(),
    paymentStatus: String(data.paymentStatus ?? "created").trim(),
  }
}

export async function syncInvestorInvestmentCheckout(
  sessionId: string,
): Promise<{ paymentStatus: string }> {
  const base = baseOrThrow()
  const res = await fetch(
    `${base}/investing/investment-payments/sync-checkout`,
    {
      method: "POST",
      headers: {
        ...portalAuthHeaders({ omitActiveOrganization: true }),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ sessionId }),
    },
  )
  const data = await jsonOrError(res)
  return { paymentStatus: String(data.paymentStatus ?? "").trim() }
}

export type StripeConnectRecipientStatus = {
  accountId: string | null
  status: string
  detailsSubmitted: boolean
  payoutsEnabled: boolean
}

export async function fetchStripeConnectRecipientStatus(
  profileId: string,
): Promise<StripeConnectRecipientStatus> {
  const base = baseOrThrow()
  const res = await fetch(
    `${base}/investing/profiles/${encodeURIComponent(profileId)}/stripe-connect/status`,
    {
      headers: portalAuthHeaders({ omitActiveOrganization: true }),
      credentials: "include",
    },
  )
  const data = await jsonOrError(res)
  return {
    accountId:
      typeof data.accountId === "string" && data.accountId.trim()
        ? data.accountId.trim()
        : null,
    status: String(data.status ?? "not_started").trim(),
    detailsSubmitted: Boolean(data.detailsSubmitted),
    payoutsEnabled: Boolean(data.payoutsEnabled),
  }
}

export async function startStripeConnectRecipientOnboarding(
  profileId: string,
): Promise<{ url: string; status: string; payoutsEnabled: boolean }> {
  const base = baseOrThrow()
  const res = await fetch(
    `${base}/investing/profiles/${encodeURIComponent(profileId)}/stripe-connect/onboarding`,
    {
      method: "POST",
      headers: portalAuthHeaders({ omitActiveOrganization: true }),
      credentials: "include",
    },
  )
  const data = await jsonOrError(res)
  const url = String(data.url ?? "").trim()
  if (!url) throw new Error("Stripe Connect did not return an onboarding URL.")
  return {
    url,
    status: String(data.status ?? "onboarding").trim(),
    payoutsEnabled: Boolean(data.payoutsEnabled),
  }
}

export type DistributionPayout = {
  id: string
  investmentId: string
  amountCents: number
  currency: string
  status: string
  failureCode: string | null
  failureMessage: string | null
  initiatedAt: string | null
  paidAt: string | null
  updatedAt: string
}

export async function fetchDistributionPayouts(
  dealId: string,
  distributionId: string,
): Promise<DistributionPayout[]> {
  const base = baseOrThrow()
  const res = await fetch(
    `${base}/deals/${encodeURIComponent(dealId)}/distributions/${encodeURIComponent(distributionId)}/payouts`,
    { headers: portalAuthHeaders(), credentials: "include" },
  )
  const data = await jsonOrError(res)
  return Array.isArray(data.payouts)
    ? (data.payouts as DistributionPayout[])
    : []
}

export async function executeDistributionAchPayouts(
  dealId: string,
  distributionId: string,
  opts?: { investmentId?: string; investmentIds?: string[] },
): Promise<{
  initiated: number
  skipped: number
  failed: number
  results: Array<{
    investmentId: string
    investorName: string
    amountCents: number
    status: string
    message?: string
  }>
}> {
  const base = baseOrThrow()
  const investmentIds = [
    ...(opts?.investmentId?.trim() ? [opts.investmentId.trim()] : []),
    ...(opts?.investmentIds ?? []).map((id) => id.trim()).filter(Boolean),
  ]
  const res = await fetch(
    `${base}/deals/${encodeURIComponent(dealId)}/distributions/${encodeURIComponent(distributionId)}/payouts`,
    {
      method: "POST",
      headers: {
        ...portalAuthHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(
        investmentIds.length === 1
          ? { investmentId: investmentIds[0] }
          : investmentIds.length > 1
            ? { investmentIds }
            : {},
      ),
    },
  )
  const data = await jsonOrError(res)
  return {
    initiated: Number(data.initiated) || 0,
    skipped: Number(data.skipped) || 0,
    failed: Number(data.failed) || 0,
    results: Array.isArray(data.results)
      ? (data.results as Array<{
          investmentId: string
          investorName: string
          amountCents: number
          status: string
          message?: string
        }>)
      : [],
  }
}
