/**
 * Display helpers for Deal → Distributions list (portal-style columns).
 * Period / preferred totals follow Woodland Ridge export math (actual/365).
 */

import { formatDateDdMmmYyyy } from "../../../../../../common/utils/formatDateDisplay"
import type {
  DistributionSetupClass,
  PriorDistributionRecord,
} from "../../../distribution-setup/types/distribution-setup.types"
import {
  getPeriodWindow,
  type DistributionPeriod,
} from "../../../distribution-setup/utils/distributionPeriod"
import type { DealInvestorRow } from "../../../types/deal-investors.types"
import { parseMoneyDigits } from "../../../utils/offeringMoneyFormat"
import { allocateInvestorsByPreferredDue } from "./investorPreferredAllocation"

export type DistributionListMetrics = {
  paid: number
  required: number
  unpaid: number
  /** paid ÷ required × 100 (0 when required is 0) */
  paidPctOfRequired: number
  periodStart: string
  periodEnd: string
  paymentDate: string
}

export function formatPeriodDatesLabel(startIso: string, endIso: string): string {
  return `${formatDateDdMmmYyyy(startIso)} - ${formatDateDdMmmYyyy(endIso)}`
}

/** Payment / calendar dates: DD-MMM-YYYY (e.g. 12-Jan-2026). */
export function formatPaymentDateLabel(iso: string): string {
  return formatDateDdMmmYyyy(iso)
}

export function sourceDisplayLabel(source: string | undefined): string {
  const s = (source ?? "").trim().toLowerCase()
  if (s === "capital" || s === "capital_event") return "Capital event"
  if (s === "operating") return "Operating income"
  if (s === "fee" || s === "distribution_fee") return "GP Payment"
  return "—"
}

export function typeDisplayLabel(row: PriorDistributionRecord): string {
  const src = (row.source ?? "").trim().toLowerCase()
  if (src === "fee" || src === "distribution_fee") {
    const feeType =
      row.distributionType?.trim() || row.name?.trim() || "Acquisition fee"
    return feeType
  }
  const t = (row.distributionType ?? "").trim().toLowerCase()
  if (t === "preferred_return" || t === "preferred" || t === "pref")
    return "Preferred return"
  if (t === "return_of_capital" || t === "roc") return "Return of capital"
  if (t === "promote") return "Promote"
  // Default for operating preferred waterfalls (Woodland / Wildflower).
  return "Preferred return"
}

export function deductsFromDisplayLabel(row: PriorDistributionRecord): string {
  const src = (row.source ?? "").trim().toLowerCase()
  if (src === "fee" || src === "distribution_fee") return "Acquisition fee"
  const d = (row.deductsFrom ?? "").trim().toLowerCase()
  if (d === "accrued_pref" || d === "accrued" || !d)
    return "Deducts from accrued pref"
  if (d === "current_pref" || d === "current") return "Deducts from current pref"
  if (d === "capital") return "Deducts from capital"
  if (d === "fee") return "Acquisition fee"
  return "Deducts from accrued pref"
}

export function distributionDisplayName(row: PriorDistributionRecord): string {
  const n = row.name?.trim()
  if (n) return n
  const period = row.period ?? "quarterly"
  const window = resolvePeriodWindow(row)
  if (period === "quarterly") {
    const m = /^(\d{4})-(\d{2})/.exec(window.start)
    if (m) {
      const q = Math.floor((Number(m[2]) - 1) / 3) + 1
      return `${m[1]} Q${q} Distribution`
    }
  }
  return `${sourceDisplayLabel(row.source)} · ${formatPaymentDateLabel(row.date)}`
}

/** Parse "2026 Q1 Distribution" / "Q1 2026" style names into a calendar quarter. */
function periodFromName(
  name: string | undefined,
): { start: string; end: string } | null {
  const n = (name ?? "").trim()
  if (!n) return null
  const m1 = /(\d{4})\s*Q([1-4])/i.exec(n)
  const m2 = /Q([1-4])\s*(\d{4})/i.exec(n)
  const year = m1 ? Number(m1[1]) : m2 ? Number(m2[2]) : NaN
  const q = m1 ? Number(m1[2]) : m2 ? Number(m2[1]) : NaN
  if (!Number.isFinite(year) || !Number.isFinite(q) || q < 1 || q > 4)
    return null
  const startM = (q - 1) * 3
  const endM = startM + 2
  const endD = new Date(year, endM + 1, 0).getDate()
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x))
  return {
    start: `${year}-${pad(startM + 1)}-01`,
    end: `${year}-${pad(endM + 1)}-${pad(endD)}`,
  }
}

export function resolvePeriodWindow(row: PriorDistributionRecord): {
  start: string
  end: string
} {
  const storedStart = row.periodStart?.trim().slice(0, 10)
  const storedEnd = row.periodEnd?.trim().slice(0, 10)
  if (
    storedStart &&
    storedEnd &&
    /^\d{4}-\d{2}-\d{2}$/.test(storedStart) &&
    /^\d{4}-\d{2}-\d{2}$/.test(storedEnd)
  ) {
    return { start: storedStart, end: storedEnd }
  }
  const fromName = periodFromName(row.name)
  if (fromName) return fromName
  const period: DistributionPeriod =
    row.period === "monthly" ||
    row.period === "annual" ||
    row.period === "quarterly"
      ? row.period
      : "quarterly"
  // Payment date is often after the accrual window (e.g. 04/15 for Q1).
  // If payment falls in the first 20 days of a quarter, treat as prior quarter.
  const paymentIso = (row.paymentDate || row.date || "").slice(0, 10)
  const win = getPeriodWindow(paymentIso || row.date, period)
  if (period !== "quarterly" || !/^\d{4}-\d{2}-\d{2}$/.test(paymentIso))
    return { start: win.start, end: win.end }
  const day = Number(paymentIso.slice(8, 10))
  if (day <= 20 && paymentIso.slice(0, 7) === win.start.slice(0, 7)) {
    const prevAsOf = shiftIsoMonths(win.start, -1)
    const prev = getPeriodWindow(prevAsOf, period)
    return { start: prev.start, end: prev.end }
  }
  return { start: win.start, end: win.end }
}

function shiftIsoMonths(iso: string, deltaMonths: number): string {
  const y = Number(iso.slice(0, 4))
  const m0 = Number(iso.slice(5, 7)) - 1
  const d = Number(iso.slice(8, 10))
  const dt = new Date(y, m0 + deltaMonths, Math.min(d, 28))
  const pad = (x: number) => (x < 10 ? `0${x}` : String(x))
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

export function computeDistributionListMetrics(params: {
  row: PriorDistributionRecord
  investors: DealInvestorRow[]
  classes: DistributionSetupClass[]
}): DistributionListMetrics {
  const { row, investors, classes } = params
  const paid = parseMoneyDigits(row.amount)
  const paidSafe = Number.isFinite(paid) ? Math.max(0, paid) : 0
  const window = resolvePeriodWindow(row)
  const paymentDate = (row.paymentDate || row.date || "").slice(0, 10)

  let required = 0
  if (investors.length > 0 && classes.length > 0) {
    const lines = allocateInvestorsByPreferredDue({
      distributionAmount: paidSafe,
      periodStartIso: window.start,
      periodEndIso: window.end,
      dayCountMode: "period_window",
      investors,
      classes,
    })
    required = lines.reduce((s, l) => s + l.required, 0)
  }
  if (!(required > 0) && row.investorPayments?.length) {
    // Fallback: if only payments stored, treat paid as required (unpaid 0).
    required = paidSafe
  }

  const unpaid = Math.max(0, required - paidSafe)
  const paidPctOfRequired =
    required > 0 ? Math.round((paidSafe / required) * 10000) / 100 : 0

  return {
    paid: paidSafe,
    required,
    unpaid,
    paidPctOfRequired,
    periodStart: window.start,
    periodEnd: window.end,
    paymentDate,
  }
}
