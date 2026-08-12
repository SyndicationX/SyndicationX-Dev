import { parseMoneyDigits } from "../../utils/offeringMoneyFormat"
import type {
  DistributionFeeClassSplit,
  DistributionFeeConfig,
  DistributionSetupClass,
} from "../types/distribution-setup.types"
import { allocateCentsByWeight, roundMoney } from "../engine/helpers/rounding"
import {
  getPeriodWindow,
  periodFromFactor,
} from "./distributionPeriod"

/** Built-in fee type presets — empty so sponsors type/create their own. */
export const DEFAULT_DISTRIBUTION_FEE_TYPE_OPTIONS = [] as const

/** Legacy presets removed from the Type dropdown (still allowed if already selected). */
const REMOVED_DISTRIBUTION_FEE_TYPE_PRESETS = new Set([
  "acquisition fee",
  "asset management fee",
  "disposition fee",
  "property management fee",
])

export function mergeFeeTypeOptions(params: {
  options?: string[] | null
  extra?: string[] | null
}): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const extras = new Set(
    (params.extra ?? [])
      .map((raw) =>
        String(raw ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase(),
      )
      .filter(Boolean),
  )
  for (const raw of [
    ...(params.options ?? []),
    ...DEFAULT_DISTRIBUTION_FEE_TYPE_OPTIONS,
    ...(params.extra ?? []),
  ]) {
    const t = String(raw ?? "")
      .trim()
      .replace(/\s+/g, " ")
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    if (
      REMOVED_DISTRIBUTION_FEE_TYPE_PRESETS.has(key) &&
      !extras.has(key)
    )
      continue
    seen.add(key)
    out.push(t)
  }
  return out
}

export function emptyDistributionFeeConfig(
  classes: DistributionSetupClass[] = [],
): DistributionFeeConfig {
  const asOf = new Date().toISOString().slice(0, 10)
  const window = getPeriodWindow(asOf, "quarterly")
  return {
    name: "",
    type: "",
    typeOptions: [...DEFAULT_DISTRIBUTION_FEE_TYPE_OPTIONS],
    cashAvailable: "$0.00",
    periodFactor: "0.25",
    periodStart: window.start,
    periodEnd: window.end,
    classSplits: defaultClassSplits(classes),
  }
}

export function defaultClassSplits(
  classes: DistributionSetupClass[],
): DistributionFeeClassSplit[] {
  return classes.map((c) => ({
    classId: c.id,
    percent: "0",
  }))
}

/** Keep splits aligned with current Class Setup; preserve typed percents. */
export function syncFeeClassSplits(params: {
  classes: DistributionSetupClass[]
  splits: DistributionFeeClassSplit[]
}): DistributionFeeClassSplit[] {
  const byId = new Map(
    params.splits.map((s) => [s.classId, s.percent] as const),
  )
  return params.classes.map((c) => ({
    classId: c.id,
    percent: byId.get(c.id) ?? "0",
  }))
}

export function parseFeePercent(raw: string): number {
  const t = String(raw ?? "")
    .trim()
    .replace(/%/g, "")
    .replace(/,/g, "")
  if (!t) return NaN
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

export function feeClassSplitTotal(splits: DistributionFeeClassSplit[]): number {
  return roundMoney(
    splits.reduce((sum, s) => {
      const n = parseFeePercent(s.percent)
      return sum + (Number.isFinite(n) ? n : 0)
    }, 0),
  )
}

export function validateDistributionFee(params: {
  fee: DistributionFeeConfig
  requireComplete?: boolean
}): { ok: boolean; message: string } {
  const name = params.fee.name.trim()
  const requireComplete = params.requireComplete === true || name.length > 0

  if (!requireComplete) return { ok: true, message: "" }

  if (!name)
    return {
      ok: false,
      message: "Acquisition fee name is required.",
    }

  const feeType = params.fee.type.trim()
  if (!feeType)
    return {
      ok: false,
      message: "Acquisition fee type is required.",
    }

  if (params.fee.classSplits.length === 0)
    return {
      ok: false,
      message: "Add investor classes in Class Setup before configuring a fee.",
    }

  for (const s of params.fee.classSplits) {
    const n = parseFeePercent(s.percent)
    if (!Number.isFinite(n) || n < 0 || n > 100)
      return {
        ok: false,
        message: "Each class percentage must be between 0% and 100%.",
      }
  }

  const total = feeClassSplitTotal(params.fee.classSplits)
  if (Math.abs(total - 100) > 0.005)
    return {
      ok: false,
      message: `Class allocation must equal 100% (currently ${total.toFixed(2)}%).`,
    }

  const start = params.fee.periodStart?.trim() ?? ""
  const end = params.fee.periodEnd?.trim() ?? ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return {
      ok: false,
      message: "Period start date and period end date are required.",
    }
  if (end < start)
    return {
      ok: false,
      message: "Period end date must be on or after the period start date.",
    }

  return { ok: true, message: "" }
}

/** When period cadence changes, snap the fee window to that calendar period. */
export function feeWindowForPeriodFactor(params: {
  periodFactor: string
  asOfIso?: string
}): { periodStart: string; periodEnd: string } {
  const period = periodFromFactor(Number(params.periodFactor) || 0.25)
  const asOf =
    params.asOfIso && /^\d{4}-\d{2}-\d{2}$/.test(params.asOfIso)
      ? params.asOfIso
      : new Date().toISOString().slice(0, 10)
  const window = getPeriodWindow(asOf, period)
  return { periodStart: window.start, periodEnd: window.end }
}

/** Allocate fee cash across classes by percentage (cents-accurate). */
export function allocateFeeCashByClass(params: {
  cashAvailable: string
  splits: DistributionFeeClassSplit[]
}): Record<string, number> {
  const cash = Math.max(0, parseMoneyDigits(params.cashAvailable))
  const weights = params.splits.map((s) => {
    const n = parseFeePercent(s.percent)
    return Number.isFinite(n) && n > 0 ? n : 0
  })
  const cents = allocateCentsByWeight({
    totalCents: Math.round(cash * 100),
    weights,
  })
  const out: Record<string, number> = {}
  params.splits.forEach((s, i) => {
    out[s.classId] = (cents[i] ?? 0) / 100
  })
  return out
}
