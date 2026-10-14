import {
  buildTableExportFilename,
  downloadTableExportBytes,
  TABLE_EXPORT_XLSX_MIME,
} from "../../../../../../common/utils/tableExportFilename"
import { buildXlsxWorkbook, type XlsxCell } from "../../../../../../common/utils/xlsxWorkbook"
import type { DealInvestorRow } from "../../../types/deal-investors.types"
import type {
  DistributionSetupClass,
  PriorDistributionRecord,
} from "../../../distribution-setup/types/distribution-setup.types"
import { formatAmountNumberExport } from "../../../utils/offeringMoneyFormat"
import {
  classTableRowsForDistribution,
  computeDistributionListMetrics,
  deductsFromDisplayLabel,
  distributionDisplayName,
  formatPaymentDateLabel,
  formatPeriodCalendarLabel,
  formatPeriodDatesLabel,
  investorRowsForDistributionClass,
  sourceDisplayLabel,
  typeDisplayLabel,
} from "./distributionListDisplay"

function moneyCell(n: number): number | "" {
  if (!Number.isFinite(n)) return ""
  return Number(formatAmountNumberExport(n) || "0")
}

function pctCell(n: number): number | "" {
  if (!Number.isFinite(n)) return ""
  return Math.round(n * 100) / 100
}

function distributionSheetRows(
  row: PriorDistributionRecord,
  setupClasses: DistributionSetupClass[],
  investors: DealInvestorRow[],
): XlsxCell[][] {
  const metrics = computeDistributionListMetrics({
    row,
    investors,
    classes: setupClasses,
  })
  const classRows = classTableRowsForDistribution({
    row,
    setupClasses,
    investors,
  })
  const out: XlsxCell[][] = [
    ["Distribution"],
    [
      "Distribution name",
      "Source",
      "Type",
      "Deducts from",
      "Amount",
      "Paid",
      "Unpaid",
      "Paid % of pref",
      "Period",
      "Payment date",
    ],
    [
      distributionDisplayName(row),
      sourceDisplayLabel(row.source),
      typeDisplayLabel(row),
      deductsFromDisplayLabel(row),
      moneyCell(metrics.paid),
      moneyCell(metrics.paid),
      moneyCell(metrics.unpaid),
      metrics.paidPctOfRequired > 100.5 ? "" : pctCell(metrics.paidPctOfRequired),
      formatPeriodCalendarLabel(
        metrics.periodStart,
        metrics.periodEnd,
        row.period,
      ) ||
        formatPeriodDatesLabel(metrics.periodStart, metrics.periodEnd),
      formatPaymentDateLabel(metrics.paymentDate),
    ],
    [],
    ["Classes"],
    [
      "Class",
      "Type",
      "Investors",
      "Capital",
      "Accumulated Pref",
      "Payment",
      "Share %",
      "Unpaid",
    ],
  ]

  if (classRows.length === 0) {
    out.push(["No class allocations for this distribution."])
  } else {
    for (const cls of classRows) {
      out.push([
        cls.name,
        cls.typeLabel,
        cls.investorCount,
        moneyCell(cls.capital),
        moneyCell(cls.required),
        moneyCell(cls.payment),
        pctCell(cls.sharePct),
        moneyCell(cls.unpaid),
      ])
    }
  }

  out.push([])
  out.push(["Investors"])
  out.push([
    "Class",
    "Investor",
    "Email",
    "Capital",
    "% of class",
    "% of deal",
    "Accumulated Pref",
    "Payment",
    "Unpaid",
  ])

  let investorCount = 0
  for (const cls of classRows) {
    const investorRows = investorRowsForDistributionClass({
      row,
      classId: cls.id,
      className: cls.name,
      setupClasses,
      investors,
    })
    for (const inv of investorRows) {
      investorCount += 1
      out.push([
        cls.name,
        inv.name,
        inv.email,
        moneyCell(inv.capital),
        pctCell(inv.percentOfClass),
        pctCell(inv.percentOfDeal),
        moneyCell(inv.required),
        moneyCell(inv.payment),
        moneyCell(inv.unpaid),
      ])
    }
  }
  if (investorCount === 0) {
    out.push(["No investor allocations for this distribution."])
  }

  return out
}

export function downloadDistributionsExportCsv(params: {
  rows: PriorDistributionRecord[]
  dealName?: string | null
  setupClasses: DistributionSetupClass[]
  investors: DealInvestorRow[]
}): void {
  const sheets = params.rows.map((row) => ({
    name: distributionDisplayName(row),
    rows: distributionSheetRows(row, params.setupClasses, params.investors),
  }))
  const bytes = buildXlsxWorkbook(
    sheets.length > 0
      ? sheets
      : [{ name: "Distributions", rows: [["No distributions selected."]] }],
  )
  const filename = buildTableExportFilename({
    dealName: params.dealName,
    tableSlug: "distribution",
    extension: "xlsx",
  })
  downloadTableExportBytes(bytes, filename, TABLE_EXPORT_XLSX_MIME)
}
