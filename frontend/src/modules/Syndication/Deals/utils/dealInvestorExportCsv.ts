import { isPlatformAdmin } from "../../../../common/auth/roleUtils"
import { formatMemberUsername } from "../../usermanagement/memberAdminShared"
import {
  dealInvestorProfileDisplayName,
  investorRoleLabel,
} from "../constants/investor-profile"
import type { DealInvestorRow } from "../types/deal-investors.types"
import {
  displayAddedInvestorsCommittedAmountExport,
  displayInvestorCommittedAmountExport,
  formatAmountNumberExport,
} from "../utils/offeringMoneyFormat"
import {
  dealInvestorStatusForTable,
  investorFundedColumnLabel,
} from "./dealInvestorTableDisplay"

import {
  buildTableExportFilename,
  downloadTableExportBytes,
  downloadTableExportCsv,
  TABLE_EXPORT_XLSX_MIME,
} from "../../../../common/utils/tableExportFilename"
import { buildXlsxWorkbook } from "../../../../common/utils/xlsxWorkbook"

export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function dealInvestorRowExportKey(row: DealInvestorRow): string {
  const id = row.id?.trim()
  if (id) return id
  const e = String(row.userEmail ?? "").trim()
  const n = String(row.displayName ?? "").trim()
  return `k:${n}|${e}`
}

export function exportAuditLinesForDealInvestorRows(
  rows: DealInvestorRow[],
): string[] {
  return rows.map((row) => {
    const name = String(row.displayName ?? "").trim()
    const em = String(row.userEmail ?? "").trim()
    if (name && name !== "—" && em && em !== "—") return `${name} (${em})`
    if (em && em !== "—") return em
    return name && name !== "—" ? name : "—"
  })
}

/** One completed distribution run for an investor, used only by the Investors tab export. */
export type DealInvestorExportHistoryLine = {
  memo: string
  type: string
  paymentDate: string
  payment: number
}

export type BuildDealInvestorsExportCsvOptions = {
  /** When true, append ownership / allocation / total / history columns. */
  includeDistributionDetails?: boolean
  /** Person name column. Defaults to platform admin only. */
  includeSponsor?: boolean
  historyByRowKey?: Map<string, DealInvestorExportHistoryLine[]>
}

function dashOrText(value: string | undefined | null): string {
  const t = String(value ?? "").trim()
  return t && t !== "—" ? t : "—"
}

function formatDistributionHistory(
  history: DealInvestorExportHistoryLine[],
): string {
  if (history.length === 0) return "—"
  return history
    .map((line) =>
      [
        line.memo.trim() || "—",
        line.type.trim() || "—",
        line.paymentDate.trim() || "—",
        formatAmountNumberExport(line.payment) || "0.00",
      ].join(" | "),
    )
    .join("; ")
}

function matrixToCsv(matrix: string[][]): string {
  return `\uFEFF${matrix
    .map((row) => row.map((c) => escapeCsvCell(String(c ?? ""))).join(","))
    .join("\r\n")}`
}

export function buildDealInvestorsExportMatrix(
  rows: DealInvestorRow[],
  dealAllClassNamesLine: string,
  options?: BuildDealInvestorsExportCsvOptions,
): string[][] {
  const includeDist = options?.includeDistributionDetails === true
  const includeSponsor = options?.includeSponsor ?? isPlatformAdmin()
  const matrix: string[][] = [
    [
      "Member name",
      "Profile",
      "Role",
      "Investor class",
      "Status",
      "Sponsor name",
      ...(includeSponsor ? ["Sponsor"] : []),
      "Committed",
      "Signed",
      "Funded",
      ...(includeDist
        ? [
            "Ownership %",
            "Percent of class (distributions)",
            "Distribution allocation %",
            "Total distributed",
            "Distribution details",
          ]
        : []),
      "Self accredited",
      "Verified accreditation",
      "Username",
      "Email",
      "Phone",
    ],
  ]
  for (const row of rows) {
    const invClass =
      (row.investorClass ?? "").trim() ||
      dealAllClassNamesLine.trim() ||
      "—"
    const roleForCsv = investorRoleLabel(row.investorRole ?? "")
    const history =
      options?.historyByRowKey?.get(dealInvestorRowExportKey(row)) ?? []
    const totalDistributed = history.reduce(
      (sum, line) =>
        sum + (Number.isFinite(line.payment) ? line.payment : 0),
      0,
    )
    const ownershipPct =
      dashOrText(row.percentOfClassDistributions) !== "—"
        ? dashOrText(row.percentOfClassDistributions)
        : dashOrText(row.percentOfClassOwnership)
    matrix.push([
      String(row.displayName ?? ""),
      dealInvestorProfileDisplayName(row),
      roleForCsv,
      invClass,
      dealInvestorStatusForTable(row),
      String(row.addedByCompanyName ?? "")
        .split("||")
        .map((part) => part.trim())
        .filter((part) => part && part !== "—")
        .join(", ") || "—",
      ...(includeSponsor
        ? [String(row.addedByDisplayName ?? "").trim() || "—"]
        : []),
      displayInvestorCommittedAmountExport(row),
      String(row.signedDate ?? ""),
      investorFundedColumnLabel(row),
      ...(includeDist
        ? [
            ownershipPct,
            dashOrText(row.percentOfClassDistributions),
            dashOrText(row.distributionAllocationPercent),
            formatAmountNumberExport(totalDistributed) || "0.00",
            formatDistributionHistory(history),
          ]
        : []),
      String(row.selfAccredited ?? ""),
      String(row.verifiedAccLabel ?? ""),
      String(row.userDisplayName ?? ""),
      String(row.userEmail ?? ""),
      String(row.userPhone ?? ""),
    ])
  }
  return matrix
}

export function buildDealInvestorsExportCsv(
  rows: DealInvestorRow[],
  dealAllClassNamesLine: string,
  options?: BuildDealInvestorsExportCsvOptions,
): string {
  return matrixToCsv(
    buildDealInvestorsExportMatrix(rows, dealAllClassNamesLine, options),
  )
}

export function buildDealMembersTableExportMatrix(
  rows: DealInvestorRow[],
): string[][] {
  const matrix: string[][] = [
    [
      "User",
      "Role",
      "Class",
      "Sponsor committed",
      "Investors committed",
      "Total",
      "Status",
      "Added by",
      "Username",
      "Email",
    ],
  ]
  for (const row of rows) {
    const sponsorCommitted = displayInvestorCommittedAmountExport(row)
    const investorCommitted = displayAddedInvestorsCommittedAmountExport(row)
    const sponsorN = Number(sponsorCommitted)
    const investorN = Number(investorCommitted)
    const total =
      (Number.isFinite(sponsorN) ? sponsorN : 0) +
      (Number.isFinite(investorN) ? investorN : 0)
    matrix.push([
      String(row.displayName ?? ""),
      investorRoleLabel(row.investorRole ?? ""),
      String(row.investorClass ?? ""),
      sponsorCommitted,
      investorCommitted,
      sponsorCommitted === "" && investorCommitted === ""
        ? ""
        : formatAmountNumberExport(total),
      dealInvestorStatusForTable(row),
      String(row.addedByDisplayName ?? ""),
      formatMemberUsername(row.userDisplayName),
      String(row.userEmail ?? ""),
    ])
  }
  return matrix
}

export function buildDealMembersTableExportCsv(rows: DealInvestorRow[]): string {
  return matrixToCsv(buildDealMembersTableExportMatrix(rows))
}

export function downloadDealRosterExportXlsx(params: {
  sheetName: string
  matrix: string[][]
  dealName?: string | null
  tableSlug: string
}): string {
  const filename = buildTableExportFilename({
    dealName: params.dealName,
    tableSlug: params.tableSlug,
    extension: "xlsx",
  })
  const bytes = buildXlsxWorkbook([
    { name: params.sheetName, rows: params.matrix },
  ])
  downloadTableExportBytes(bytes, filename, TABLE_EXPORT_XLSX_MIME)
  return filename
}

export function downloadDealExportCsv(content: string, filename: string): void {
  downloadTableExportCsv(content, filename)
}
