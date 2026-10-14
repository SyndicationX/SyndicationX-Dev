/** Display helpers for the Deals list table only */

import { SEC_TYPE_OPTIONS } from "./constants/sec-type-options"
import {
  DEAL_FORM_TYPE_OPTIONS,
  DEAL_TYPE_LABELS,
  type DealTypeOption,
} from "./types/deals.types"

export {
  formatDateDdMmmYyyy as formatDealListDateDisplay,
  dateSortValue,
} from "../../../common/utils/formatDateDisplay"

/** Strip “(most common)” suffix from option labels shown in the UI. */
export function stripMostCommonFromLabel(label: string): string {
  return label.replace(/\s*\(most common\)\s*/gi, "").trim() || label
}

/** Human-readable deal type for tables (wizard codes + legacy option keys). */
export function dealTypeDisplayLabel(code: string): string {
  if (!code || code === "—") return "—"
  const fromForm = DEAL_FORM_TYPE_OPTIONS.find((o) => o.value === code)
  if (fromForm) return stripMostCommonFromLabel(fromForm.label)
  const k = code as DealTypeOption
  const mapped = DEAL_TYPE_LABELS[k]
  return mapped ? stripMostCommonFromLabel(mapped) : code
}

/** SEC type dropdown value → label (deals list / dashboard cards). */
export function secTypeDisplayLabel(code: string): string {
  const t = String(code ?? "").trim()
  if (!t || t === "—") return "—"
  const hit = SEC_TYPE_OPTIONS.find((o) => o.value === t)
  const label = hit?.label ?? t
  return stripMostCommonFromLabel(label)
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function fieldMatchesDealSearch(value: string | null | undefined, query: string, compactQuery: string): boolean {
  const text = String(value ?? "").trim()
  if (!text || text === "—") return false
  if (text.toLowerCase().includes(query)) return true
  return compactQuery.length >= 3 && compactSearchText(text).includes(compactQuery)
}

/**
 * Dashboard and deals-page search. Matches the deal name, deal type, and SEC
 * type, so "506(c)" matches a stored `506_c` offering.
 */
export function dealFieldsMatchSearch(
  fields: {
    name?: string | null
    dealType?: string | null
    secType?: string | null
    location?: string | null
  },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const compactQuery = compactSearchText(q)
  const dealType = String(fields.dealType ?? "")
  const secType = String(fields.secType ?? "")
  return [
    fields.name,
    fields.location,
    dealType,
    dealTypeDisplayLabel(dealType),
    secType,
    secTypeDisplayLabel(secType),
  ].some((value) => fieldMatchesDealSearch(value, q, compactQuery))
}

const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Deals list amount cells: USD with `$`. */
export function formatCommittedCurrency(raw: string): string {
  if (raw == null) return "—"
  const s = String(raw).trim()
  if (s === "" || s === "—") return "—"
  const n = Number.parseFloat(s.replace(/[^0-9.-]/g, ""))
  if (!Number.isFinite(n)) return s
  return moneyFmt.format(n)
}

export function committedSortValue(raw: string): number {
  const n = Number.parseFloat(String(raw ?? "").replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : 0
}

export function parseInvestorCountFromCell(raw: string): number {
  const n = Number.parseInt(String(raw ?? "").replace(/\D/g, ""), 10)
  return Number.isFinite(n) ? n : 0
}

export function formatInvestorCountDisplay(raw: string): string {
  const s = String(raw ?? "").trim()
  if (s === "" || s === "—") return "—"
  return String(parseInvestorCountFromCell(raw))
}
