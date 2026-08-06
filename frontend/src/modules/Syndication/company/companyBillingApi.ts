import { portalAuthHeaders } from "../../../common/auth/portalAuthHeaders"
import { getApiV1Base } from "../../../common/utils/apiBaseUrl"

export type StripeBillingPlanId = "starter" | "running" | "growth"
export type StripeBillingSeatBand = "5" | "10" | "10plus"

export type CompanyBillingStatus = {
  configured: boolean
  testMode: boolean
  webhookConfigured?: boolean
  companyId: string
  planId: string | null
  billingCycle: string | null
  subscriptionStatus: string
  priceId: string | null
  currentPeriodEnd: string | null
  hasCustomer: boolean
  hasSubscription: boolean
  lastPaymentError?: string | null
  lastPaymentFailedAt?: string | null
  paymentHealthy?: boolean
  plansConfigured: Array<{
    id: StripeBillingPlanId | string
    monthlyReady: boolean
    annualReady: boolean
    monthlyEnv?: string
    annualEnv?: string
    seats?: Array<{
      seatBand: StripeBillingSeatBand | string
      monthlyReady: boolean
      annualReady: boolean
      monthlyEnv?: string
      annualEnv?: string
    }>
  }>
}

export type CompanyBillingInvoice = {
  id: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  status: string
  amount: string
  hostedInvoiceUrl: string | null
  invoicePdf: string | null
  paymentFailureMessage?: string | null
  paymentFailedAt?: string | null
}

export type CompanyBillingPaymentMethod = {
  id: string
  stripePaymentMethodId: string
  stripeCustomerId: string | null
  type: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  funding: string | null
  country: string | null
  fingerprint: string | null
  billingName: string | null
  billingEmail: string | null
  billingPhone: string | null
  billingAddress: unknown
  isDefault: boolean
  livemode: boolean
  stripeCreatedAt: string | null
  stripePayload: unknown
  detachedAt: string | null
  createdAt: string
  updatedAt: string
}

function authHeaders(): Record<string, string> {
  return portalAuthHeaders() as Record<string, string>
}

function messageFromBody(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const m = (data as { message?: unknown }).message
    if (typeof m === "string" && m.trim()) return m.trim()
  }
  return fallback
}

export async function fetchCompanyBillingStatus(
  companyId: string,
): Promise<
  | { ok: true; status: CompanyBillingStatus }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing`,
      { headers: authHeaders(), credentials: "include" },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not load billing (${res.status}).`),
        statusCode: res.status,
      }
    }
    return { ok: true, status: data as CompanyBillingStatus }
  } catch {
    return {
      ok: false,
      message: "Network error loading billing status.",
      statusCode: 0,
    }
  }
}

export async function startCompanyBillingCheckout(
  companyId: string,
  planId: string,
  billingCycle: "monthly" | "annually",
  seatBand: StripeBillingSeatBand = "5",
): Promise<
  | { ok: true; url: string }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/checkout`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          planId,
          seatBand,
          billingCycle: billingCycle === "annually" ? "yearly" : "monthly",
        }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Checkout failed (${res.status}).`),
        statusCode: res.status,
      }
    }
    const url =
      data && typeof data === "object"
        ? String((data as { url?: unknown }).url ?? "").trim()
        : ""
    if (!url) {
      return {
        ok: false,
        message: "Checkout did not return a Stripe URL.",
        statusCode: res.status,
      }
    }
    return { ok: true, url }
  } catch {
    return {
      ok: false,
      message: "Network error starting checkout.",
      statusCode: 0,
    }
  }
}

export async function openCompanyBillingPortal(
  companyId: string,
): Promise<
  | { ok: true; url: string }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/portal`,
      {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Billing portal failed (${res.status}).`),
        statusCode: res.status,
      }
    }
    const url =
      data && typeof data === "object"
        ? String((data as { url?: unknown }).url ?? "").trim()
        : ""
    if (!url) {
      return {
        ok: false,
        message: "Portal did not return a Stripe URL.",
        statusCode: res.status,
      }
    }
    return { ok: true, url }
  } catch {
    return {
      ok: false,
      message: "Network error opening billing portal.",
      statusCode: 0,
    }
  }
}

export async function syncCompanyBillingCheckout(
  companyId: string,
  sessionId: string,
): Promise<
  | { ok: true; status: CompanyBillingStatus }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/sync-checkout`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not sync checkout (${res.status}).`),
        statusCode: res.status,
      }
    }
    return { ok: true, status: data as CompanyBillingStatus }
  } catch {
    return {
      ok: false,
      message: "Network error syncing checkout.",
      statusCode: 0,
    }
  }
}

export async function fetchCompanyBillingInvoices(
  companyId: string,
): Promise<
  | { ok: true; invoices: CompanyBillingInvoice[] }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/invoices`,
      { headers: authHeaders(), credentials: "include" },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not load invoices (${res.status}).`),
        statusCode: res.status,
      }
    }
    const list =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { invoices?: unknown }).invoices)
        ? (data as { invoices: CompanyBillingInvoice[] }).invoices
        : []
    return { ok: true, invoices: list }
  } catch {
    return {
      ok: false,
      message: "Network error loading invoices.",
      statusCode: 0,
    }
  }
}

export async function fetchCompanyBillingPaymentMethods(
  companyId: string,
): Promise<
  | { ok: true; paymentMethods: CompanyBillingPaymentMethod[] }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/payment-methods`,
      { headers: authHeaders(), credentials: "include" },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(
          data,
          `Could not load payment methods (${res.status}).`,
        ),
        statusCode: res.status,
      }
    }
    const list =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { paymentMethods?: unknown }).paymentMethods)
        ? (data as { paymentMethods: CompanyBillingPaymentMethod[] }).paymentMethods
        : []
    return { ok: true, paymentMethods: list }
  } catch {
    return {
      ok: false,
      message: "Network error loading payment methods.",
      statusCode: 0,
    }
  }
}

export async function syncCompanyBillingPaymentMethods(
  companyId: string,
): Promise<
  | { ok: true; paymentMethods: CompanyBillingPaymentMethod[] }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/sync-payment-methods`,
      {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(
          data,
          `Could not sync payment methods (${res.status}).`,
        ),
        statusCode: res.status,
      }
    }
    const list =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { paymentMethods?: unknown }).paymentMethods)
        ? (data as { paymentMethods: CompanyBillingPaymentMethod[] }).paymentMethods
        : []
    return { ok: true, paymentMethods: list }
  } catch {
    return {
      ok: false,
      message: "Network error syncing payment methods.",
      statusCode: 0,
    }
  }
}

export type BillingPaymentElementSession = {
  clientSecret: string
  subscriptionId: string
  customerId: string
  publishableKey: string | null
  paymentIntentId: string | null
  invoiceId: string | null
  planId: string
  seatBand: string
  billingCycle: string
  priceId: string
}

export type BillingSetupIntentSession = {
  clientSecret: string
  setupIntentId: string
  customerId: string
  publishableKey: string | null
}

export type StripeBillingPublicConfig = {
  configured: boolean
  testMode: boolean
  webhookConfigured: boolean
  publishableKey: string | null
  paymentElementReady: boolean
}

export async function fetchStripeBillingConfig(): Promise<
  | { ok: true; config: StripeBillingPublicConfig }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(`${base}/billing/config`, {
      headers: authHeaders(),
      credentials: "include",
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not load Stripe config (${res.status}).`),
        statusCode: res.status,
      }
    }
    const cfg = data as Partial<StripeBillingPublicConfig>
    return {
      ok: true,
      config: {
        configured: Boolean(cfg.configured),
        testMode: Boolean(cfg.testMode),
        webhookConfigured: Boolean(cfg.webhookConfigured),
        publishableKey:
          typeof cfg.publishableKey === "string" ? cfg.publishableKey : null,
        paymentElementReady: Boolean(cfg.paymentElementReady),
      },
    }
  } catch {
    return {
      ok: false,
      message: "Network error loading Stripe config.",
      statusCode: 0,
    }
  }
}

/** Resolve publishable key: Vite env first, then backend /billing/config. */
export async function resolveStripePublishableKey(
  fromSession?: string | null,
): Promise<string | null> {
  const fromEnv = String(
    import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "",
  ).trim()
  if (fromEnv.startsWith("pk_")) return fromEnv
  const fromApi = String(fromSession ?? "").trim()
  if (fromApi.startsWith("pk_")) return fromApi
  const cfg = await fetchStripeBillingConfig()
  if (cfg.ok && cfg.config.publishableKey?.startsWith("pk_")) {
    return cfg.config.publishableKey
  }
  return null
}

/**
 * Option 2 — in-app Payment Element (card + ACH).
 * POST /companies/:id/billing/payment-element
 */
export async function startCompanyBillingPaymentElement(
  companyId: string,
  planId: string,
  billingCycle: "monthly" | "annually",
  seatBand: StripeBillingSeatBand = "5",
): Promise<
  | { ok: true; session: BillingPaymentElementSession }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/payment-element`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          planId,
          seatBand,
          billingCycle: billingCycle === "annually" ? "yearly" : "monthly",
        }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(
          data,
          `Could not start payment (${res.status}).`,
        ),
        statusCode: res.status,
      }
    }
    const clientSecret =
      data && typeof data === "object"
        ? String((data as { clientSecret?: unknown }).clientSecret ?? "").trim()
        : ""
    const subscriptionId =
      data && typeof data === "object"
        ? String(
            (data as { subscriptionId?: unknown }).subscriptionId ?? "",
          ).trim()
        : ""
    if (!clientSecret || !subscriptionId) {
      return {
        ok: false,
        message: "Payment Element session was incomplete.",
        statusCode: res.status,
      }
    }
    const row = data as Record<string, unknown>
    return {
      ok: true,
      session: {
        clientSecret,
        subscriptionId,
        customerId: String(row.customerId ?? "").trim(),
        publishableKey:
          typeof row.publishableKey === "string" ? row.publishableKey : null,
        paymentIntentId:
          typeof row.paymentIntentId === "string" ? row.paymentIntentId : null,
        invoiceId: typeof row.invoiceId === "string" ? row.invoiceId : null,
        planId: String(row.planId ?? planId),
        seatBand: String(row.seatBand ?? seatBand),
        billingCycle: String(row.billingCycle ?? billingCycle),
        priceId: String(row.priceId ?? ""),
      },
    }
  } catch {
    return {
      ok: false,
      message: "Network error starting Payment Element.",
      statusCode: 0,
    }
  }
}

export async function startCompanyBillingSetupIntent(
  companyId: string,
): Promise<
  | { ok: true; session: BillingSetupIntentSession }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/setup-intent`,
      {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(
          data,
          `Could not start SetupIntent (${res.status}).`,
        ),
        statusCode: res.status,
      }
    }
    const clientSecret =
      data && typeof data === "object"
        ? String((data as { clientSecret?: unknown }).clientSecret ?? "").trim()
        : ""
    const setupIntentId =
      data && typeof data === "object"
        ? String((data as { setupIntentId?: unknown }).setupIntentId ?? "").trim()
        : ""
    if (!clientSecret || !setupIntentId) {
      return {
        ok: false,
        message: "SetupIntent session was incomplete.",
        statusCode: res.status,
      }
    }
    const row = data as Record<string, unknown>
    return {
      ok: true,
      session: {
        clientSecret,
        setupIntentId,
        customerId: String(row.customerId ?? "").trim(),
        publishableKey:
          typeof row.publishableKey === "string" ? row.publishableKey : null,
      },
    }
  } catch {
    return {
      ok: false,
      message: "Network error starting SetupIntent.",
      statusCode: 0,
    }
  }
}

export async function syncCompanyBillingPayment(
  companyId: string,
  opts?: { subscriptionId?: string; paymentIntentId?: string },
): Promise<
  | { ok: true; status: CompanyBillingStatus }
  | { ok: false; message: string; statusCode: number }
> {
  const base = getApiV1Base()
  if (!base) {
    return {
      ok: false,
      message: "API is not configured (VITE_BASE_URL).",
      statusCode: 0,
    }
  }
  try {
    const res = await fetch(
      `${base}/companies/${encodeURIComponent(companyId)}/billing/sync-payment`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          subscriptionId: opts?.subscriptionId,
          paymentIntentId: opts?.paymentIntentId,
        }),
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(
          data,
          `Could not sync payment (${res.status}).`,
        ),
        statusCode: res.status,
      }
    }
    return { ok: true, status: data as CompanyBillingStatus }
  } catch {
    return {
      ok: false,
      message: "Network error syncing payment.",
      statusCode: 0,
    }
  }
}
