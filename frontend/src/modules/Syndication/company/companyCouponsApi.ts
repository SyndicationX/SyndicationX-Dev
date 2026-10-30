import { portalAuthHeaders } from "../../../common/auth/portalAuthHeaders"
import { getApiV1Base } from "../../../common/utils/apiBaseUrl"

export type PlatformCouponCode = {
  id: string
  code: string
  active: boolean
  timesRedeemed: number
  maxRedemptions: number | null
  expiresAt: string | null
}

export type PlatformCouponRow = {
  id: string
  name: string | null
  percentOff: number | null
  amountOffCents: number | null
  currency: string | null
  duration: string
  durationInMonths: number | null
  maxRedemptions: number | null
  timesRedeemed: number
  redeemBy: string | null
  valid: boolean
  createdAt: string | null
  promotionCodes: PlatformCouponCode[]
}

export type CreatePlatformCouponInput = {
  name: string
  code: string
  discountType: "percent" | "amount"
  percentOff?: number
  amountOff?: number
  duration: "once" | "repeating" | "forever"
  durationInMonths?: number
  maxRedemptions?: number
  redeemBy?: string
}

type ApiErr = { ok: false; message: string }

function messageFromBody(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const m = (data as { message?: unknown }).message
    if (typeof m === "string" && m.trim()) return m.trim()
  }
  return fallback
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null
}

function mapCode(raw: unknown): PlatformCouponCode | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const code = str(r.code)
  if (!id || !code) return null
  return {
    id,
    code,
    active: r.active === true,
    timesRedeemed: num(r.timesRedeemed) ?? 0,
    maxRedemptions: num(r.maxRedemptions),
    expiresAt: str(r.expiresAt),
  }
}

function mapCoupon(raw: unknown): PlatformCouponRow | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const codes = Array.isArray(r.promotionCodes)
    ? r.promotionCodes
        .map(mapCode)
        .filter((c): c is PlatformCouponCode => c != null)
    : []
  return {
    id,
    name: str(r.name),
    percentOff: num(r.percentOff),
    amountOffCents: num(r.amountOffCents),
    currency: str(r.currency),
    duration: str(r.duration) ?? "once",
    durationInMonths: num(r.durationInMonths),
    maxRedemptions: num(r.maxRedemptions),
    timesRedeemed: num(r.timesRedeemed) ?? 0,
    redeemBy: str(r.redeemBy),
    valid: r.valid === true,
    createdAt: str(r.createdAt),
    promotionCodes: codes,
  }
}

export async function fetchPlatformCoupons(): Promise<
  { ok: true; coupons: PlatformCouponRow[] } | ApiErr
> {
  const base = getApiV1Base()
  if (!base) return { ok: false, message: "API is not configured (VITE_BASE_URL)." }
  try {
    const res = await fetch(`${base}/billing/coupons`, {
      headers: portalAuthHeaders(),
      credentials: "include",
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not load coupons (${res.status}).`),
      }
    }
    const raw =
      data && typeof data === "object" && Array.isArray((data as { coupons?: unknown }).coupons)
        ? (data as { coupons: unknown[] }).coupons
        : []
    return {
      ok: true,
      coupons: raw.map(mapCoupon).filter((c): c is PlatformCouponRow => c != null),
    }
  } catch {
    return { ok: false, message: "Could not reach the server." }
  }
}

export async function createPlatformCoupon(
  input: CreatePlatformCouponInput,
): Promise<{ ok: true; coupon: PlatformCouponRow } | ApiErr> {
  const base = getApiV1Base()
  if (!base) return { ok: false, message: "API is not configured (VITE_BASE_URL)." }
  try {
    const res = await fetch(`${base}/billing/coupons`, {
      method: "POST",
      headers: {
        ...portalAuthHeaders(),
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(input),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not create the coupon (${res.status}).`),
      }
    }
    const coupon = mapCoupon(
      data && typeof data === "object" ? (data as { coupon?: unknown }).coupon : null,
    )
    if (!coupon) return { ok: false, message: "Coupon was created but the response was incomplete." }
    return { ok: true, coupon }
  } catch {
    return { ok: false, message: "Could not reach the server." }
  }
}

export type OrgCouponUse = {
  couponId: string
  code: string
  name: string | null
  percentOff: number | null
  amountOffCents: number | null
  currency: string | null
  redemptions: number
  savedCents: number
  lastUsedAt: string | null
}

export type OrgCouponUsage = {
  id: string
  name: string
  redemptions: number
  savedCents: number
  coupons: OrgCouponUse[]
}

function mapUse(raw: unknown): OrgCouponUse | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const code = str(r.code)
  if (!code) return null
  return {
    couponId: str(r.couponId) ?? "",
    code,
    name: str(r.name),
    percentOff: num(r.percentOff),
    amountOffCents: num(r.amountOffCents),
    currency: str(r.currency),
    redemptions: num(r.redemptions) ?? 0,
    savedCents: num(r.savedCents) ?? 0,
    lastUsedAt: str(r.lastUsedAt),
  }
}

function mapOrg(raw: unknown): OrgCouponUsage | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const coupons = Array.isArray(r.coupons)
    ? r.coupons.map(mapUse).filter((row): row is OrgCouponUse => row != null)
    : []
  return {
    id,
    name: str(r.name) ?? "Organization",
    redemptions: num(r.redemptions) ?? coupons.reduce((sum, row) => sum + row.redemptions, 0),
    savedCents: num(r.savedCents) ?? coupons.reduce((sum, row) => sum + row.savedCents, 0),
    coupons,
  }
}

export async function fetchPlatformCouponUsage(): Promise<
  { ok: true; organizations: OrgCouponUsage[]; truncated: boolean } | ApiErr
> {
  const base = getApiV1Base()
  if (!base) return { ok: false, message: "API is not configured (VITE_BASE_URL)." }
  try {
    const res = await fetch(`${base}/billing/coupons/usage`, {
      headers: portalAuthHeaders(),
      credentials: "include",
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not load coupon usage (${res.status}).`),
      }
    }
    const raw =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { organizations?: unknown }).organizations)
        ? (data as { organizations: unknown[] }).organizations
        : []
    return {
      ok: true,
      organizations: raw.map(mapOrg).filter((row): row is OrgCouponUsage => row != null),
      truncated:
        Boolean(data && typeof data === "object" && (data as { truncated?: unknown }).truncated),
    }
  } catch {
    return { ok: false, message: "Could not reach the server." }
  }
}

export async function deactivatePlatformCoupon(
  couponId: string,
): Promise<{ ok: true } | ApiErr> {
  const base = getApiV1Base()
  if (!base) return { ok: false, message: "API is not configured (VITE_BASE_URL)." }
  try {
    const res = await fetch(
      `${base}/billing/coupons/${encodeURIComponent(couponId)}/deactivate`,
      {
        method: "POST",
        headers: portalAuthHeaders(),
        credentials: "include",
      },
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        message: messageFromBody(data, `Could not deactivate the coupon (${res.status}).`),
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: "Could not reach the server." }
  }
}
