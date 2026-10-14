/**
 * Keep in sync with backend/src/services/billing/saasBillingStartDate.ts
 * (month is 1–12). Default complimentary window; a deal can have its own
 * saasBillingStartsAt from platform admin.
 */
export const PLATFORM_SAAS_BILLING_START_YEAR = 2026
export const PLATFORM_SAAS_BILLING_START_MONTH = 10 // October
export const PLATFORM_SAAS_BILLING_START_DAY = 1

export const PLATFORM_SAAS_BILLING_STARTS_AT_MS = Date.UTC(
  PLATFORM_SAAS_BILLING_START_YEAR,
  PLATFORM_SAAS_BILLING_START_MONTH - 1,
  PLATFORM_SAAS_BILLING_START_DAY,
  0,
  0,
  0,
  0,
)

export function platformSaasBillingHasStarted(nowMs = Date.now()): boolean {
  return PLATFORM_SAAS_BILLING_STARTS_AT_MS < nowMs
}

export function platformSaasBillingStartDisplay(): string {
  return new Date(PLATFORM_SAAS_BILLING_STARTS_AT_MS).toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" },
  )
}

export function dealSaasBillingHasStarted(
  iso: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const raw = String(iso ?? "").trim()
  if (raw) {
    const t = Date.parse(raw)
    if (Number.isFinite(t)) return t < nowMs
  }
  return platformSaasBillingHasStarted(nowMs)
}

export function formatSaasBillingStartIsoDisplay(
  iso: string | null | undefined,
): string {
  const raw = String(iso ?? "").trim()
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return platformSaasBillingStartDisplay()
  return new Date(t).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}
