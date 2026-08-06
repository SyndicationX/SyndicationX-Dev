import { ArrowLeft, Landmark, Loader2, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../common/components/data-table/DataTable"
import { TableCompactAmountCell } from "../../../../../common/components/card-compact-amount/CardCompactAmount"
import { toast } from "../../../../../common/components/Toast"
import { setAppDocumentTitle } from "../../../../../common/utils/appDocumentTitle"
import { fetchDealInvestorClasses, fetchDealInvestors } from "../../api/dealsApi"
import {
  executeDistributionAchPayouts,
  fetchDistributionPayouts,
  type DistributionPayout,
} from "@/modules/Investing/api/stripeInvestorPaymentsApi"
import {
  fetchDistributionSetup,
  patchDistributionInvestorPercent,
} from "../../distribution-setup/api/distributionSetupApi"
import type {
  DistributionSetupBundle,
  PriorDistributionRecord,
} from "../../distribution-setup/types/distribution-setup.types"
import {
  factorFromPeriod,
  investedCapitalFromClasses,
  runDistributionSim,
} from "../../distribution-setup/utils/distributionSim"
import {
  buildCashFlows,
  type HurdleCashFlow,
} from "../../distribution-setup/utils/hurdleCalculations"
import type { DealInvestorClass } from "../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import {
  formatCurrencyUsdTypeInput,
  formatPercentTypeInput,
  moneyAmountOnBlur,
  parseMoneyDigits,
  sanitizePercentTypingInput,
} from "../../utils/offeringMoneyFormat"
import { buildDealDetailReturnSearch } from "../../utils/offeringDetailsSectionNav"
import {
  allocateInvestorDistributionLines,
  applyPaymentEdit,
  applyPercentOfClassEdit,
  parseStoredClassPercent,
  type InvestorDistributionLine,
} from "./utils/investorDistributionAllocation"
import {
  allocateInvestorsByPreferredDue,
  type InvestorPreferredLine,
} from "./utils/investorPreferredAllocation"
import {
  resolvePeriodWindow,
} from "./utils/distributionListDisplay"
import { InvestorClassPillsDisplay } from "../investors/InvestorClassPillsDisplay"
import { DealInvestorIdentityCell } from "../investors/DealInvestorIdentityCell"
import {
  DealInvestorViewModal,
  type DealInvestorViewDistributionContext,
} from "../investors/DealInvestorViewModal"
import { FormTooltip } from "../../../../../common/components/form-tooltip/FormTooltip"
import { isPlatformAdmin } from "../../../../../common/auth/roleUtils"
import "../../../usermanagement/user_management.css"
import "../../deals-list.css"
import "../../deal-investors-tab.css"
import "../../distribution-setup/distribution-setup.css"
import "../investors/investor-class-pills.css"
import "./distributions-tab.css"
import "./distribution-details.css"

function formatDistributionDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso || "—"
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function sourceLabel(source: string | undefined): string {
  const s = (source ?? "").trim().toLowerCase()
  if (s === "capital" || s === "capital_event") return "Capital event"
  if (s === "operating") return "Operating"
  if (s === "fee" || s === "distribution_fee") return "GP Payment"
  return "—"
}

function achStatusSlug(status: string): string {
  const raw = status.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
  return raw || "not-sent"
}

function achStatusLabel(status: string): string {
  const slug = achStatusSlug(status)
  const labels: Record<string, string> = {
    "not-sent": "Not sent",
    pending: "Pending",
    processing: "Processing",
    paid: "Paid",
    transferred: "Transferred",
    failed: "Failed",
    canceled: "Canceled",
    cancelled: "Canceled",
    reversed: "Reversed",
  }
  if (labels[slug]) return labels[slug]
  return status
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function achStatusTone(status: string): string {
  const slug = achStatusSlug(status)
  if (slug === "paid" || slug === "transferred") return "success"
  if (slug === "processing" || slug === "pending") return "info"
  if (slug === "failed" || slug === "canceled" || slug === "cancelled" || slug === "reversed")
    return "danger"
  return "neutral"
}

function priorRecordsToCashFlows(
  records: PriorDistributionRecord[],
): Array<{ amount: number; date: Date }> {
  const out: Array<{ amount: number; date: Date }> = []
  for (const row of records) {
    const amount = parseMoneyDigits(row.amount)
    if (!Number.isFinite(amount) || amount === 0) continue
    const date = new Date(`${row.date}T00:00:00`)
    if (Number.isNaN(date.getTime())) continue
    out.push({ amount, date })
  }
  return out
}

function blurFormatPercentClamped(raw: string): string {
  const t = sanitizePercentTypingInput(raw)
  if (!t) return ""
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return ""
  return `${Math.max(0, Math.min(100, n)).toFixed(2)}%`
}

function linesFromStoredPayments(
  distribution: PriorDistributionRecord,
  investors: DealInvestorRow[] = [],
): InvestorDistributionLine[] | null {
  const stored = distribution.investorPayments
  if (!stored?.length) return null

  const pctByInvestorId = new Map<string, number>()
  const pctByContact = new Map<string, number>()
  for (const inv of investors) {
    const storedPct = parseStoredClassPercent(inv.percentOfClassDistributions)
    if (storedPct == null) continue
    const id = String(inv.id ?? "")
      .trim()
      .toLowerCase()
    if (id) pctByInvestorId.set(id, storedPct)
    const contact = String(inv.contactId ?? "")
      .trim()
      .toLowerCase()
    if (contact) pctByContact.set(contact, storedPct)
  }

  return stored.map((p) => {
    const investorId = String(p.investorId ?? "")
      .trim()
      .toLowerCase()
    const contactId = String(p.contactId ?? "")
      .trim()
      .toLowerCase()
    const fromDb =
      (investorId ? pctByInvestorId.get(investorId) : undefined) ??
      (contactId ? pctByContact.get(contactId) : undefined)
    const fromStored =
      Number(String(p.percentOfClass).replace(/[^0-9.-]/g, "")) || 0
    return {
      investorId: p.investorId,
      ...(p.contactId?.trim() ? { contactId: p.contactId.trim() } : {}),
      ...(p.userEmail?.trim()
        ? { userEmail: p.userEmail.trim().toLowerCase() }
        : {}),
      investorName: p.investorName || "—",
      classId: p.classId,
      className: p.className || "—",
      capital: parseMoneyDigits(p.capital) || 0,
      percentOfClass: fromDb ?? fromStored,
      payment: parseMoneyDigits(p.payment) || 0,
    }
  })
}

export function DistributionDetailsPage() {
  const { dealId: dealIdParam, distributionId: distIdParam } = useParams()
  const navigate = useNavigate()
  const dealId = (dealIdParam ?? "").trim()
  const distributionId = (distIdParam ?? "").trim()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<DistributionSetupBundle | null>(null)
  const [investors, setInvestors] = useState<DealInvestorRow[]>([])
  const [investorClasses, setInvestorClasses] = useState<DealInvestorClass[]>(
    [],
  )
  const [viewInvestorRow, setViewInvestorRow] = useState<DealInvestorRow | null>(
    null,
  )
  const [viewDistributionLine, setViewDistributionLine] =
    useState<InvestorPreferredLine | null>(null)
  const [distribution, setDistribution] =
    useState<PriorDistributionRecord | null>(null)
  const [lines, setLines] = useState<InvestorPreferredLine[]>([])
  const [pctDrafts, setPctDrafts] = useState<Record<string, string>>({})
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, string>>(
    {},
  )
  const [savingInvestorId, setSavingInvestorId] = useState<string | null>(null)
  const [payouts, setPayouts] = useState<DistributionPayout[]>([])
  const [executingPayouts, setExecutingPayouts] = useState(false)
  const [sendingInvestorId, setSendingInvestorId] = useState<string | null>(
    null,
  )
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [query, setQuery] = useState("")

  const backHref = `/deals/${encodeURIComponent(dealId)}${buildDealDetailReturnSearch(
    { tab: "distributions" },
  )}`
  const distributionSetupHref = `/deals/${encodeURIComponent(dealId)}/distribution-setup?editDistributionId=${encodeURIComponent(distributionId)}`
  const classSetupHref = `/deals/${encodeURIComponent(dealId)}/class-setup`

  const load = useCallback(async () => {
    if (!dealId || !distributionId) return
    setLoading(true)
    setError(null)
    try {
      const [setup, invPack, payoutRows, classes] = await Promise.all([
        fetchDistributionSetup(dealId),
        fetchDealInvestors(dealId),
        fetchDistributionPayouts(dealId, distributionId).catch(() => []),
        fetchDealInvestorClasses(dealId).catch(() => []),
      ])
      const found =
        (setup.priorDistributions ?? []).find((p) => p.id === distributionId) ??
        null
      setBundle(setup)
      setInvestors(invPack.investors ?? [])
      setInvestorClasses(classes)
      setDistribution(found)
      setPayouts(payoutRows)
      if (!found) {
        setError("That distribution was not found for this deal.")
      }
    } catch (err) {
      setBundle(null)
      setInvestors([])
      setInvestorClasses([])
      setDistribution(null)
      setPayouts([])
      setError(
        err instanceof Error ? err.message : "Could not load distribution.",
      )
    } finally {
      setLoading(false)
    }
  }, [dealId, distributionId])

  const dealAllClassNamesLine = useMemo(
    () =>
      investorClasses
        .map((c) => String(c.name ?? "").trim())
        .filter(Boolean)
        .join(", "),
    [investorClasses],
  )

  const openInvestorView = useCallback(
    (line: InvestorPreferredLine) => {
      const dealRow =
        investors.find((inv) => inv.id === line.investorId) ??
        investors.find(
          (inv) =>
            line.contactId &&
            String(inv.contactId ?? "").trim().toLowerCase() ===
              String(line.contactId).trim().toLowerCase(),
        ) ??
        null
      if (!dealRow) {
        toast.error(
          "Investor details unavailable",
          "Could not match this payment line to an investor on the deal.",
        )
        return
      }
      setViewDistributionLine(line)
      setViewInvestorRow(dealRow)
    },
    [investors],
  )

  const viewDistributionContext =
    useMemo((): DealInvestorViewDistributionContext | null => {
      if (!distribution || !viewDistributionLine) return null
      const payout = payouts.find(
        (p) => p.investmentId === viewDistributionLine.investorId,
      )
      return {
        distributionName:
          String(distribution.name ?? "").trim() ||
          formatDistributionDate(distribution.date),
        distributionDate: distribution.date,
        distributionAmount: distribution.amount,
        waterfallSource: sourceLabel(distribution.source),
        className: viewDistributionLine.className,
        capital: viewDistributionLine.capital,
        percentOfClass: viewDistributionLine.percentOfClass,
        payment: viewDistributionLine.payment,
        required: viewDistributionLine.required,
        unpaid: viewDistributionLine.unpaid,
        annualRatePct: viewDistributionLine.annualRatePct,
        days: viewDistributionLine.days,
        achStatus: payout?.status ?? "not sent",
        achInitiatedAt: payout?.initiatedAt ?? null,
        achPaidAt: payout?.paidAt ?? null,
        achFailureMessage: payout?.failureMessage ?? null,
      }
    }, [distribution, viewDistributionLine, payouts])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setAppDocumentTitle("Distribution details")
  }, [])

  const classPaymentByClassId = useMemo(() => {
    if (!bundle || !distribution) return {} as Record<string, number>
    const cash = parseMoneyDigits(distribution.amount)
    if (!Number.isFinite(cash) || cash <= 0) return {}

    const source =
      (distribution.source ?? "").trim().toLowerCase() === "capital" ||
      (distribution.source ?? "").trim().toLowerCase() === "capital_event"
        ? "capital"
        : "operating"
    const rows =
      source === "capital"
        ? bundle.waterfalls.capital
        : bundle.waterfalls.operating

    const period =
      distribution.period === "monthly" ||
      distribution.period === "quarterly" ||
      distribution.period === "annual"
        ? distribution.period
        : "quarterly"
    const periodFactor = factorFromPeriod(period)

    const priorsBefore = (bundle.priorDistributions ?? []).filter(
      (p) =>
        p.id !== distribution.id &&
        (p.date < distribution.date ||
          (p.date === distribution.date && p.id < distribution.id)),
    )
    const prior = priorRecordsToCashFlows(priorsBefore)
    const invested = investedCapitalFromClasses(bundle.classes)
    const distDate = new Date(`${distribution.date}T00:00:00`)
    const cashFlows: HurdleCashFlow[] =
      invested > 0
        ? buildCashFlows({
            investmentAmount: invested,
            investmentDate: new Date(
              distDate.getFullYear() - 1,
              distDate.getMonth(),
              distDate.getDate(),
            ),
            distributions: [...prior, { amount: cash, date: distDate }],
          })
        : []
    const cumulativeDistributions =
      prior.reduce((s, d) => s + d.amount, 0) + cash

    const sim = runDistributionSim({
      cash,
      periodFactor,
      rows,
      classes: bundle.classes,
      promote: bundle.promote,
      stageMetOverrides: {},
      dueOverrides: {},
      cashFlows,
      cumulativeDistributions,
      asOfDate: distribution.date,
      priorDistributions: bundle.priorDistributions,
      excludePriorId: distribution.id,
      dayCountMode: "period_window",
    })
    return sim.perClass
  }, [bundle, distribution])

  const computedLines = useMemo((): InvestorPreferredLine[] => {
    if (!bundle || !distribution) return []
    const cash = parseMoneyDigits(distribution.amount)
    const window = resolvePeriodWindow(distribution)

    // Prefer saved investor payments (including manual edits) so Payment stays editable/persistent.
    // Overlay DB percentOfClassDistributions when present so % matches the LP roster.
    const fromStored = linesFromStoredPayments(distribution, investors)
    if (fromStored?.length) {
      return fromStored.map((line) => ({
        ...line,
        required: line.payment,
        unpaid: 0,
        annualRatePct: 0,
        days: 0,
      }))
    }

    // Initial view when no payments have been stored yet: preferred due (capital × rate × days).
    const prefLines = allocateInvestorsByPreferredDue({
      distributionAmount: Number.isFinite(cash) ? cash : 0,
      periodStartIso: window.start,
      periodEndIso: window.end,
      dayCountMode: "period_window",
      investors,
      classes: bundle.classes,
      perClassPaid: classPaymentByClassId,
    })
    if (prefLines.length > 0) return prefLines

    const base = allocateInvestorDistributionLines({
      investors,
      classes: bundle.classes,
      perClass: classPaymentByClassId,
    })
    return base.map((line) => ({
      ...line,
      required: line.payment,
      unpaid: 0,
      annualRatePct: 0,
      days: 0,
    }))
  }, [bundle, distribution, investors, classPaymentByClassId])

  useEffect(() => {
    setLines(computedLines)
    const pctNext: Record<string, string> = {}
    const payNext: Record<string, string> = {}
    for (const row of computedLines) {
      pctNext[row.investorId] = Number.isFinite(row.percentOfClass)
        ? `${(Math.round(row.percentOfClass * 100) / 100).toFixed(2)}%`
        : ""
      payNext[row.investorId] = Number.isFinite(row.payment)
        ? moneyAmountOnBlur(String(Math.round(row.payment * 100) / 100))
        : ""
    }
    setPctDrafts(pctNext)
    setPaymentDrafts(payNext)
  }, [computedLines])

  useEffect(() => {
    setPage(1)
  }, [lines.length, query])

  const filteredLines = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((row) => {
      const hay = [
        row.investorName,
        row.className,
        row.classId,
        String(row.capital),
        String(row.percentOfClass),
        String(row.payment),
        row.userEmail ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
  }, [lines, query])

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: filteredLines.length,
      onPageChange: setPage,
      onPageSizeChange: (n: number) => {
        setPageSize(n)
        setPage(1)
      },
      ariaLabel: "Distribution investors pagination",
    }),
    [page, pageSize, filteredLines.length],
  )

  const totalPayment = useMemo(
    () => filteredLines.reduce((s, r) => s + r.payment, 0),
    [filteredLines],
  )

  const allLinesPaymentTotal = useMemo(
    () => lines.reduce((s, r) => s + r.payment, 0),
    [lines],
  )

  const payoutByInvestmentId = useMemo(
    () => new Map(payouts.map((p) => [p.investmentId, p])),
    [payouts],
  )

  const sendAchPayouts = useCallback(async () => {
    if (!dealId || !distributionId || executingPayouts || sendingInvestorId)
      return
    const confirmed = window.confirm(
      `Send ${lines.length} ACH distribution payout${lines.length === 1 ? "" : "s"} totaling $${allLinesPaymentTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}? Stripe transfers cannot be edited after they are submitted.`,
    )
    if (!confirmed) return
    setExecutingPayouts(true)
    try {
      const result = await executeDistributionAchPayouts(
        dealId,
        distributionId,
      )
      const refreshed = await fetchDistributionPayouts(dealId, distributionId)
      setPayouts(refreshed)
      if (result.failed > 0 || result.skipped > 0) {
        toast.error(
          "Some payouts need attention",
          `${result.initiated} submitted, ${result.skipped} skipped, ${result.failed} failed. Skipped investors must complete Stripe Connect bank setup.`,
        )
      } else {
        toast.success(
          "ACH payouts submitted",
          `${result.initiated} payout${result.initiated === 1 ? "" : "s"} sent to Stripe for processing.`,
        )
      }
    } catch (err) {
      toast.error(
        "Could not send payouts",
        err instanceof Error ? err.message : "Please try again.",
      )
    } finally {
      setExecutingPayouts(false)
    }
  }, [
    dealId,
    distributionId,
    executingPayouts,
    sendingInvestorId,
    lines.length,
    allLinesPaymentTotal,
  ])

  const canSendInvestorPayout = useCallback(
    (investorId: string, payment: number) => {
      if (!(payment > 0)) return false
      const payout = payoutByInvestmentId.get(investorId)
      if (!payout) return true
      const status = payout.status.trim().toLowerCase()
      return (
        status === "failed" ||
        status === "canceled" ||
        status === "reversed" ||
        status === "pending"
      )
    },
    [payoutByInvestmentId],
  )

  const isInvestorPayoutLocked = useCallback(
    (investorId: string) => {
      const payout = payoutByInvestmentId.get(investorId)
      if (!payout) return false
      const status = payout.status.trim().toLowerCase()
      return (
        status === "processing" ||
        status === "paid" ||
        status === "transferred"
      )
    },
    [payoutByInvestmentId],
  )

  const sendInvestorAchPayout = useCallback(
    async (row: InvestorPreferredLine) => {
      if (
        !dealId ||
        !distributionId ||
        executingPayouts ||
        sendingInvestorId ||
        !canSendInvestorPayout(row.investorId, row.payment)
      ) {
        return
      }
      const amountLabel = row.payment.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      const confirmed = window.confirm(
        `Send ACH payment of $${amountLabel} to ${row.investorName}? Stripe transfers cannot be edited after they are submitted.`,
      )
      if (!confirmed) return
      setSendingInvestorId(row.investorId)
      try {
        const result = await executeDistributionAchPayouts(
          dealId,
          distributionId,
          { investmentId: row.investorId },
        )
        const refreshed = await fetchDistributionPayouts(dealId, distributionId)
        setPayouts(refreshed)
        const lineResult = result.results[0]
        if (result.failed > 0 || lineResult?.status === "failed") {
          toast.error(
            "Payment failed",
            lineResult?.message ||
              "Stripe could not send this investor payout.",
          )
        } else if (result.skipped > 0 || lineResult?.status === "skipped") {
          toast.error(
            "Cannot send payment",
            lineResult?.message ||
              "This investor must complete Stripe Connect bank setup first.",
          )
        } else {
          toast.success(
            "ACH payment submitted",
            `$${amountLabel} is processing for ${row.investorName}.`,
          )
        }
      } catch (err) {
        toast.error(
          "Could not send payment",
          err instanceof Error ? err.message : "Please try again.",
        )
      } finally {
        setSendingInvestorId(null)
      }
    },
    [
      dealId,
      distributionId,
      executingPayouts,
      sendingInvestorId,
      canSendInvestorPayout,
    ],
  )

  const syncInvestorPct = useCallback(
    (investorId: string, nextPct: number) => {
      setInvestors((prev) =>
        prev.map((inv) => {
          const line = lines.find((l) => l.investorId === investorId)
          const match =
            inv.id === investorId ||
            (line?.contactId &&
              inv.contactId?.trim().toLowerCase() ===
                line.contactId.trim().toLowerCase())
          if (!match) return inv
          return {
            ...inv,
            percentOfClassDistributions: `${(Math.round(nextPct * 100) / 100).toFixed(2)}%`,
          }
        }),
      )
    },
    [lines],
  )

  const persistShare = useCallback(
    async (
      investorId: string,
      payload: { percentOfClass?: number; payment?: number },
      localLines: InvestorDistributionLine[],
    ) => {
      if (!dealId || !distributionId) return
      setSavingInvestorId(investorId)
      try {
        const saved = await patchDistributionInvestorPercent(
          dealId,
          distributionId,
          { investorId, ...payload },
        )
        setBundle(saved)
        const found =
          (saved.priorDistributions ?? []).find(
            (p) => p.id === distributionId,
          ) ?? null
        setDistribution(found)
        const updated = localLines.find((l) => l.investorId === investorId)
        if (updated) syncInvestorPct(investorId, updated.percentOfClass)
        toast.success(
          "Payment updated",
          "Saved payment and % of class. Change is logged.",
        )
      } catch (err) {
        toast.error(
          "Could not save",
          err instanceof Error ? err.message : "Try again.",
        )
        void load()
      } finally {
        setSavingInvestorId(null)
      }
    },
    [dealId, distributionId, syncInvestorPct, load],
  )

  const savePercent = useCallback(
    async (investorId: string, raw: string) => {
      const t = sanitizePercentTypingInput(raw)
      const n = t ? parseFloat(t) : NaN
      if (!Number.isFinite(n)) {
        toast.error("Invalid percent", "Enter a number between 0 and 100.")
        return
      }
      const nextPct = Math.max(0, Math.min(100, n))
      const nextLines = applyPercentOfClassEdit({
        lines,
        investorId,
        nextPercent: nextPct,
        classPaymentByClassId,
      }).map((l) => {
        const prev = lines.find((x) => x.investorId === l.investorId)
        return {
          ...l,
          required: prev?.required ?? l.payment,
          unpaid: Math.max(0, (prev?.required ?? l.payment) - l.payment),
          annualRatePct: prev?.annualRatePct ?? 0,
          days: prev?.days ?? 0,
        }
      })
      setLines(nextLines)
      const updated = nextLines.find((l) => l.investorId === investorId)
      setPctDrafts((prev) => ({
        ...prev,
        [investorId]: `${(Math.round(nextPct * 100) / 100).toFixed(2)}%`,
      }))
      if (updated) {
        setPaymentDrafts((prev) => ({
          ...prev,
          [investorId]: moneyAmountOnBlur(
            String(Math.round(updated.payment * 100) / 100),
          ),
        }))
      }
      await persistShare(investorId, { percentOfClass: nextPct }, nextLines)
    },
    [lines, classPaymentByClassId, persistShare],
  )

  const savePayment = useCallback(
    async (investorId: string, raw: string) => {
      const amount = parseMoneyDigits(raw)
      if (!Number.isFinite(amount) || amount < 0) {
        toast.error("Invalid payment", "Enter a valid dollar amount.")
        return
      }
      const nextLines = applyPaymentEdit({
        lines,
        investorId,
        nextPayment: amount,
        classPaymentByClassId,
      }).map((l) => {
        const prev = lines.find((x) => x.investorId === l.investorId)
        return {
          ...l,
          required: prev?.required ?? l.payment,
          unpaid: Math.max(0, (prev?.required ?? l.payment) - l.payment),
          annualRatePct: prev?.annualRatePct ?? 0,
          days: prev?.days ?? 0,
        }
      })
      setLines(nextLines)
      const updated = nextLines.find((l) => l.investorId === investorId)
      if (updated) {
        setPctDrafts((prev) => ({
          ...prev,
          [investorId]: `${(Math.round(updated.percentOfClass * 100) / 100).toFixed(2)}%`,
        }))
        setPaymentDrafts((prev) => ({
          ...prev,
          [investorId]: moneyAmountOnBlur(
            String(Math.round(updated.payment * 100) / 100),
          ),
        }))
      }
      await persistShare(investorId, { payment: amount }, nextLines)
    },
    [lines, classPaymentByClassId, persistShare],
  )

  const showFormulaTips = isPlatformAdmin()

  const columns: DataTableColumn<InvestorPreferredLine>[] = useMemo(
    () => [
      {
        id: "investor",
        header: "Investor",
        colWidth: "16rem",
        thClassName: "deal_dist_th_investor",
        tdClassName: "deal_dist_td_investor",
        sortValue: (row) =>
          `${row.investorName} ${row.userEmail ?? ""}`.toLowerCase(),
        cell: (row) => {
          const dealRow =
            investors.find((inv) => inv.id === row.investorId) ?? null
          if (dealRow) {
            return (
              <DealInvestorIdentityCell
                row={dealRow}
                onNameClick={() => openInvestorView(row)}
              />
            )
          }
          const name = (row.investorName ?? "").trim() || "—"
          const email = (row.userEmail ?? "").trim()
          return (
            <div className="deal_dist_details_investor_cell">
              <button
                type="button"
                className="deal_dist_details_investor_name deal_inv_identity_name_btn"
                title={name !== "—" ? `View details for ${name}` : undefined}
                aria-label={
                  name !== "—" ? `View details for ${name}` : undefined
                }
                disabled={name === "—"}
                onClick={() => openInvestorView(row)}
              >
                {name}
              </button>
              {email ? (
                <span className="deal_dist_details_investor_email" title={email}>
                  {email}
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "class",
        header: "Class",
        colWidth: "11rem",
        thClassName: "deal_dist_th_class",
        tdClassName: "deal_dist_td_class deal_dist_td_class_pill",
        sortValue: (row) => row.className.toLowerCase(),
        cell: (row) => {
          const name = (row.className ?? "").trim()
          if (!name || name === "—")
            return <span className="deal_inv_class_pill_muted">—</span>
          return (
            <InvestorClassPillsDisplay
              pillSource={name}
              titleForTooltip={name}
            />
          )
        },
      },
      {
        id: "capital",
        header: "Capital",
        align: "right",
        colWidth: "9.5rem",
        thClassName: "deals_th_align_right deal_dist_th_capital",
        tdClassName: "um_td_numeric deals_td_align_right deal_dist_td_capital",
        sortValue: (row) => row.capital,
        cell: (row) => <TableCompactAmountCell amount={row.capital} />,
      },
      {
        id: "pct",
        header: showFormulaTips ? (
          <span className="deal_dist_th_with_help deal_dist_th_pct_head">
            <span>% of class</span>
            <FormTooltip
              label="How % of class is calculated"
              content={
                <div className="deal_dist_formula_tooltip">
                  <p>
                    Share of this investor’s capital within their class:
                  </p>
                  <p className="deal_dist_formula_tooltip_eq">
                    (Investor capital ÷ Class capital) × 100
                  </p>
                  <p>
                    Example: $50,000 ÷ $817,000 × 100 ≈ 6.12%. Payment uses this
                    share of the class distribution.
                  </p>
                </div>
              }
              placement="bottom"
              panelAlign="end"
              openOnHover
              nativeButtonTrigger={false}
            />
          </span>
        ) : (
          "% of class"
        ),
        align: "right",
        colWidth: "8.5rem",
        thClassName: "deals_th_align_right deal_dist_th_pct",
        tdClassName: "um_td_numeric deals_td_align_right deal_dist_td_pct",
        sortValue: (row) => row.percentOfClass,
        cell: (row) => (
          <input
            type="text"
            className="deal_dist_details_pct_input"
            inputMode="decimal"
            aria-label={`Percent of class for ${row.investorName}`}
            value={pctDrafts[row.investorId] ?? ""}
            disabled={
              savingInvestorId === row.investorId ||
              isInvestorPayoutLocked(row.investorId)
            }
            placeholder="0.00%"
            onChange={(e) => {
              const next = formatPercentTypeInput(e.target.value, 100)
              setPctDrafts((prev) => ({
                ...prev,
                [row.investorId]: next,
              }))
            }}
            onBlur={(e) => {
              const formatted = blurFormatPercentClamped(e.target.value)
              setPctDrafts((prev) => ({
                ...prev,
                [row.investorId]: formatted,
              }))
              const prevN = row.percentOfClass
              const nextN = formatted
                ? parseFloat(sanitizePercentTypingInput(formatted))
                : NaN
              if (
                !Number.isFinite(nextN) ||
                Math.abs(nextN - prevN) < 0.0005
              ) {
                return
              }
              void savePercent(row.investorId, formatted)
            }}
          />
        ),
      },
      {
        id: "payment",
        header: showFormulaTips ? (
          <span className="deal_dist_th_with_help deal_dist_th_pct_head">
            <span>Payment</span>
            <FormTooltip
              label="How payment is calculated"
              content={
                <div className="deal_dist_formula_tooltip">
                  <p>
                    Investor payment is preferred due, scaled by available cash:
                  </p>
                  <p className="deal_dist_formula_tooltip_eq">
                    Required = Capital × Rate × Days ÷ 365
                  </p>
                  <p className="deal_dist_formula_tooltip_eq">
                    Payment = Required × (Cash available ÷ Σ Required)
                  </p>
                </div>
              }
              placement="bottom"
              panelAlign="end"
              openOnHover
              nativeButtonTrigger={false}
            />
          </span>
        ) : (
          "Payment"
        ),
        align: "right",
        colWidth: "9.5rem",
        thClassName: "deals_th_align_right deal_dist_th_payment",
        tdClassName: "um_td_numeric deals_td_align_right deal_dist_td_payment",
        sortValue: (row) => row.payment,
        cell: (row) => (
          <input
            type="text"
            className="deal_dist_details_pct_input deal_dist_details_pay_input"
            inputMode="decimal"
            aria-label={`Payment for ${row.investorName}`}
            value={paymentDrafts[row.investorId] ?? ""}
            disabled={
              savingInvestorId === row.investorId ||
              isInvestorPayoutLocked(row.investorId)
            }
            placeholder="$0.00"
            onChange={(e) => {
              setPaymentDrafts((prev) => ({
                ...prev,
                [row.investorId]: formatCurrencyUsdTypeInput(e.target.value),
              }))
            }}
            onBlur={(e) => {
              const formatted = moneyAmountOnBlur(e.target.value)
              setPaymentDrafts((prev) => ({
                ...prev,
                [row.investorId]: formatted,
              }))
              const nextN = parseMoneyDigits(formatted)
              if (
                !Number.isFinite(nextN) ||
                Math.abs(nextN - row.payment) < 0.005
              ) {
                return
              }
              void savePayment(row.investorId, formatted)
            }}
          />
        ),
      },
      {
        id: "payoutStatus",
        header: "ACH status",
        colWidth: "9rem",
        sortValue: (row) =>
          payoutByInvestmentId.get(row.investorId)?.status ?? "not sent",
        cell: (row) => {
          const payout = payoutByInvestmentId.get(row.investorId)
          const status = payout?.status ?? "not sent"
          const slug = achStatusSlug(status)
          const tone = achStatusTone(status)
          return (
            <span
              className={`deal_dist_ach_badge deal_dist_ach_badge--${tone} is-${slug}`}
              title={payout?.failureMessage ?? undefined}
            >
              {achStatusLabel(status)}
            </span>
          )
        },
      },
      {
        id: "actions",
        header: "Actions",
        align: "right",
        colWidth: "8.5rem",
        thClassName: "um_th_actions deal_dist_th_actions",
        tdClassName: "um_td_actions deal_dist_td_actions",
        cell: (row) => {
          const sending = sendingInvestorId === row.investorId
          const canSend = canSendInvestorPayout(row.investorId, row.payment)
          const payout = payoutByInvestmentId.get(row.investorId)
          const label =
            payout &&
            ["failed", "canceled", "reversed"].includes(
              payout.status.trim().toLowerCase(),
            )
              ? "Retry payment"
              : "Send payment"
          return (
            <button
              type="button"
              className="um_btn_secondary deal_dist_details_send_btn"
              disabled={
                !canSend ||
                executingPayouts ||
                sendingInvestorId != null ||
                savingInvestorId === row.investorId
              }
              title={
                canSend
                  ? `Send ACH payment to ${row.investorName}`
                  : payout
                    ? `ACH already ${payout.status}`
                    : "Payment amount must be greater than zero"
              }
              aria-label={`${label} for ${row.investorName}`}
              onClick={() => void sendInvestorAchPayout(row)}
            >
              {sending ? (
                <Loader2
                  size={14}
                  className="deals_create_loading_icon"
                  aria-hidden
                />
              ) : (
                <Landmark size={14} aria-hidden />
              )}
              {sending ? "Sending…" : label}
            </button>
          )
        },
      },
    ],
    [
      showFormulaTips,
      pctDrafts,
      paymentDrafts,
      savingInvestorId,
      sendingInvestorId,
      executingPayouts,
      payoutByInvestmentId,
      canSendInvestorPayout,
      isInvestorPayoutLocked,
      sendInvestorAchPayout,
      savePercent,
      savePayment,
      investors,
      openInvestorView,
    ],
  )

  if (!dealId || !distributionId) {
    return (
      <div className="deals_list_page deals_detail_page deals_dist_setup_page">
        <p className="deals_list_not_found">Missing deal or distribution.</p>
        <Link to="/deals" className="deals_list_inline_back">
          Back to deals
        </Link>
      </div>
    )
  }

  const title =
    distribution?.name?.trim() ||
    (distribution
      ? `Distribution · ${formatDistributionDate(distribution.date)}`
      : "Distribution details")

  return (
    <div className="deals_list_page deals_detail_page deals_dist_setup_page deal_dist_details_page">
      <header className="deals_list_head ds_page_header">
        <div className="deals_list_title_row">
          <button
            type="button"
            className="deals_list_back_circle"
            onClick={() => navigate(backHref)}
            aria-label="Back to distributions"
          >
            <ArrowLeft size={20} strokeWidth={2} aria-hidden />
          </button>
          <div className="ds_page_header_text">
            <h1 className="deals_list_title">Distribution details</h1>
            <p className="ds_page_subtitle">
              {bundle?.dealName ? `${bundle.dealName} · ` : ""}
              {title} · Investor payments for this run
            </p>
          </div>
        </div>
        <div className="ds_page_header_actions">
          <button
            type="button"
            className="um_btn_primary"
            disabled={
              loading ||
              executingPayouts ||
              sendingInvestorId != null ||
              !distribution ||
              lines.length === 0 ||
              allLinesPaymentTotal <= 0
            }
            onClick={() => void sendAchPayouts()}
          >
            {executingPayouts ? (
              <Loader2
                size={16}
                className="deals_create_loading_icon"
                aria-hidden
              />
            ) : (
              <Landmark size={16} aria-hidden />
            )}
            {executingPayouts ? "Submitting…" : "Send ACH distributions"}
          </button>
          <Link to={backHref} className="um_toolbar_export_btn">
            Back to Distributions
          </Link>
          <Link to={classSetupHref} className="um_toolbar_export_btn">
            Class Setup
          </Link>
          <Link
            to={distributionSetupHref}
            className="um_toolbar_export_btn deals_list_add_link"
          >
            Edit Distribution
          </Link>
        </div>
      </header>

      {loading ? (
        <p className="deal_dist_details_loading">Loading distribution…</p>
      ) : error && !distribution ? (
        <div className="um_panel deal_dist_details_error_panel">
          <p>{error}</p>
          <Link to={backHref} className="deals_list_inline_back">
            Back to Distributions
          </Link>
        </div>
      ) : distribution ? (
        <div className="ds_page_body deal_dist_details_body">
          <div
            className="deal_dist_summary deal_dist_details_summary"
            aria-live="polite"
          >
            <div className="deal_dist_summary_item">
              <span className="deal_dist_summary_label">Date</span>
              <span className="deal_dist_summary_value">
                {formatDistributionDate(distribution.date)}
              </span>
            </div>
            <div className="deal_dist_summary_item">
              <span className="deal_dist_summary_label">Cash distributed</span>
              <span className="deal_dist_summary_value deal_dist_summary_value_money">
                <TableCompactAmountCell amount={distribution.amount} />
              </span>
            </div>
            <div className="deal_dist_summary_item">
              <span className="deal_dist_summary_label">Waterfall</span>
              <span className="deal_dist_summary_value">
                <span className="deal_dist_wf_badge">
                  {sourceLabel(distribution.source)}
                </span>
              </span>
            </div>
            <div className="deal_dist_summary_item">
              <span className="deal_dist_summary_label">Investor payments</span>
              <span className="deal_dist_summary_value deal_dist_summary_value_money">
                <TableCompactAmountCell
                  amount={Math.round(totalPayment * 100) / 100}
                />
              </span>
            </div>
          </div>

          <div className="um_panel um_members_tab_panel deals_list_table_panel deals_list_card_surface deal_inv_table_panel deal_dist_panel">
            <div
              className="um_toolbar um_toolbar_export_then_search deal_dist_details_toolbar"
              role="toolbar"
              aria-label="Investor payments"
            >
              <div className="deal_dist_details_table_intro">
                <h2 className="deal_dist_heading">Investors</h2>
              </div>
              <div className="um_search_wrap deal_dist_search">
                <Search className="um_search_icon" size={18} aria-hidden />
                <input
                  type="search"
                  className="um_search_input"
                  placeholder="Search investors…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search investors"
                />
              </div>
            </div>
            <DataTable
              visualVariant="members"
              membersTableClassName="um_table_members deal_inv_table deal_dist_table deal_dist_details_table"
              stickyColumnCount={1}
              forceHorizontalScroll
              columns={columns}
              rows={filteredLines}
              getRowKey={(row) => row.investorId}
              emptyLabel={
                query.trim()
                  ? "No investors match your search."
                  : "No funded investors matched to classes for this distribution."
              }
              initialSort={{ columnId: "payment", direction: "desc" }}
              pagination={pagination}
            />
          </div>
        </div>
      ) : null}

      <DealInvestorViewModal
        row={viewInvestorRow}
        onClose={() => {
          setViewInvestorRow(null)
          setViewDistributionLine(null)
        }}
        investorClasses={investorClasses}
        dealAllClassNamesLine={dealAllClassNamesLine}
        distributionContext={viewDistributionContext}
        initialSectionTab="distribution"
      />
    </div>
  )
}
