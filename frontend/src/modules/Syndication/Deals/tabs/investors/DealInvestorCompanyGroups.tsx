import { Building2, ChevronDown } from "lucide-react"
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { DataTable, type DataTableColumn } from "../../../../../common/components/data-table/DataTable"
import { formatCount } from "@/common/utils/formatCount"
import {
  formatCurrencyTableDisplay,
  investorRowCommittedAmountNumeric,
  parseMoneyDigits,
} from "../../utils/offeringMoneyFormat"
import type { DealInvestorRow } from "../../types/deal-investors.types"

const NO_COMPANY_LABEL = "No company"

export type InvestorCompanyGroup = {
  key: string
  name: string
  /** First-created company admin, when the roster row includes one. */
  adminName?: string
  rows: DealInvestorRow[]
}

export function groupInvestorsByCompany(
  rows: DealInvestorRow[],
): InvestorCompanyGroup[] {
  const buckets = new Map<string, InvestorCompanyGroup>()
  for (const row of rows) {
    const rawNames = String(row.addedByCompanyName ?? "")
      .split("||")
      .map((part) => part.trim())
    const rawAdmins = String(row.companyAdminName ?? "")
      .split("||")
      .map((part) => part.trim())
    const labeled = rawNames
      .map((name, index) => ({
        name,
        adminName: rawAdmins[index] ?? "",
      }))
      .filter((part) => part.name && part.name !== "—")
    const labels =
      labeled.length > 0
        ? labeled
        : [{ name: NO_COMPANY_LABEL, adminName: "" }]
    const seen = new Set<string>()
    for (const label of labels) {
      const key = label.name.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const existing = buckets.get(key)
      if (existing) {
        existing.rows.push(row)
        if (!existing.adminName && label.adminName) {
          existing.adminName = label.adminName
        }
      } else {
        buckets.set(key, {
          key,
          name: label.name,
          ...(label.adminName ? { adminName: label.adminName } : {}),
          rows: [row],
        })
      }
    }
  }
  return [...buckets.values()].sort((a, b) => {
    if (a.name === NO_COMPANY_LABEL) return 1
    if (b.name === NO_COMPANY_LABEL) return -1
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

export type CompanyGroupCountNoun = "investor" | "sponsor" | "member"

function countNounPlural(noun: CompanyGroupCountNoun): string {
  if (noun === "member") return "team members"
  return `${noun}s`
}

function investorCountLabel(
  count: number,
  noun: CompanyGroupCountNoun = "investor",
): string {
  const word =
    count === 1 ? (noun === "member" ? "team member" : noun) : countNounPlural(noun)
  return `${count === 1 ? "1" : formatCount(count)} ${word}`
}

function companyCommittedTotal(rows: DealInvestorRow[]): string {
  const sum = rows.reduce(
    (acc, row) => acc + investorRowCommittedAmountNumeric(row),
    0,
  )
  return formatCurrencyTableDisplay(String(sum))
}

function sponsorCountText(count: number): string {
  return count === 1 ? "1" : formatCount(count)
}

/** Sum of Investors committed on general-partner rows in this company. */
function investorsCommittedTotal(rows: DealInvestorRow[]): string {
  const sum = rows.reduce((acc, row) => {
    const n = parseMoneyDigits(String(row.addedInvestorsCommitted ?? ""))
    return acc + (Number.isFinite(n) ? n : 0)
  }, 0)
  return formatCurrencyTableDisplay(String(sum))
}

function DealInvestorCompanyGroup({
  group,
  open,
  onToggle,
  columns,
  dealId,
  pageSize,
  onPageSizeChange,
  selectedInvestorIds,
  onToggleSelectGroup,
  getRowClassName,
  countNoun = "investor",
  emptyLabel = "No LP investors match your filters.",
}: {
  group: InvestorCompanyGroup
  open: boolean
  onToggle: () => void
  columns: DataTableColumn<DealInvestorRow>[]
  dealId: string
  pageSize: number
  onPageSizeChange: (nextSize: number) => void
  selectedInvestorIds: Set<string>
  onToggleSelectGroup: (rows: DealInvestorRow[]) => void
  getRowClassName: (row: DealInvestorRow) => string | undefined
  countNoun?: CompanyGroupCountNoun
  emptyLabel?: string
}) {
  const [page, setPage] = useState(1)
  const selectAllRef = useRef<HTMLInputElement | null>(null)
  const panelId = `deal-inv-company-${dealId}-${group.key.replace(/[^a-z0-9]+/gi, "-")}`
  const rowSig = group.rows.map((row) => row.id).join("\0")

  const committedTotal = useMemo(
    () =>
      countNoun === "member"
        ? investorsCommittedTotal(group.rows)
        : companyCommittedTotal(group.rows),
    [countNoun, group.rows],
  )
  const investorsTotal = useMemo(
    () => investorsCommittedTotal(group.rows),
    [group.rows],
  )
  const sponsorMetrics = countNoun === "sponsor"
  const allSelected =
    group.rows.length > 0 &&
    group.rows.every((row) => selectedInvestorIds.has(row.id))
  const someSelected =
    group.rows.some((row) => selectedInvestorIds.has(row.id)) && !allSelected

  useLayoutEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected, allSelected, open])

  useEffect(() => {
    setPage(1)
  }, [rowSig])

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(group.rows.length / pageSize))
    if (page > totalPages) setPage(totalPages)
  }, [group.rows.length, pageSize, page])

  const groupColumns = useMemo(
    () =>
      columns.map((column) => {
        if (column.id !== "select") return column
        return {
          ...column,
          header: (
            <input
              ref={selectAllRef}
              type="checkbox"
              className="um_table_header_select_cb"
              checked={allSelected}
              onChange={() => onToggleSelectGroup(group.rows)}
              disabled={group.rows.length === 0}
              aria-label={`Select all ${countNounPlural(countNoun)} in ${group.name}`}
            />
          ),
        }
      }),
    [allSelected, columns, countNoun, group.name, group.rows, onToggleSelectGroup],
  )

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: group.rows.length,
      onPageChange: setPage,
      onPageSizeChange,
      ariaLabel: `${group.name} ${countNounPlural(countNoun)} pagination`,
    }),
    [group.name, group.rows.length, countNoun, onPageSizeChange, page, pageSize],
  )

  return (
    <section className={`deal_inv_company_group${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="deal_inv_company_group_toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden
          className={`deal_inv_company_group_chevron${open ? " is-open" : ""}`}
        />
        <span className="deal_inv_company_group_mark" aria-hidden>
          <Building2 size={15} strokeWidth={2} />
        </span>
        <span className="deal_inv_company_group_identity">
          <span className="deal_inv_company_group_name">{group.name}</span>
          {group.adminName ? (
            <span className="deal_inv_company_group_admin">{group.adminName}</span>
          ) : null}
        </span>
        <span
          className={`deal_inv_company_group_aside${
            sponsorMetrics ? " deal_inv_company_group_aside_sponsor" : ""
          }`}
        >
          {sponsorMetrics ? (
            <>
              <span className="deal_inv_company_group_metric deal_inv_company_group_metric_count">
                <span className="deal_inv_company_group_committed_label">
                  Total sponsors
                </span>
                <span className="deal_inv_company_group_count_value">
                  {sponsorCountText(group.rows.length)}
                </span>
              </span>
              <span className="deal_inv_company_group_metric deal_inv_company_group_metric_sponsor">
                <span className="deal_inv_company_group_committed_label">
                  Sponsor committed
                </span>
                <span className="deal_inv_company_group_committed_value">
                  {committedTotal}
                </span>
              </span>
              <span className="deal_inv_company_group_metric deal_inv_company_group_metric_investors">
                <span className="deal_inv_company_group_committed_label">
                  Investors committed
                </span>
                <span className="deal_inv_company_group_committed_value">
                  {investorsTotal}
                </span>
              </span>
            </>
          ) : (
            <>
              <span className="deal_inv_company_group_count">
                {investorCountLabel(group.rows.length, countNoun)}
              </span>
              <span className="deal_inv_company_group_committed">
                <span className="deal_inv_company_group_committed_label">
                  Committed
                </span>
                <span className="deal_inv_company_group_committed_value">
                  {committedTotal}
                </span>
              </span>
            </>
          )}
        </span>
      </button>
      {open ? (
        <div className="deal_inv_company_group_body" id={panelId}>
          <DataTable
            visualVariant="members"
            membersTableClassName="um_table_members deal_inv_table"
            stickyColumnCount={2}
            forceHorizontalScroll
            columns={groupColumns}
            rows={group.rows}
            getRowKey={(row, i) =>
              row.id?.trim() ? row.id : `inv-${dealId}-${group.key}-${i}`
            }
            getRowClassName={(row) => getRowClassName(row)}
            emptyLabel={emptyLabel}
            pagination={pagination}
          />
        </div>
      ) : null}
    </section>
  )
}

export function DealInvestorCompanyGroups({
  groups,
  columns,
  dealId,
  pageSize,
  onPageSizeChange,
  selectedInvestorIds,
  onToggleSelectGroup,
  getRowClassName,
  searchActive,
  countNoun = "investor",
  emptyLabel = "No LP investors match your filters.",
}: {
  groups: InvestorCompanyGroup[]
  columns: DataTableColumn<DealInvestorRow>[]
  dealId: string
  pageSize: number
  onPageSizeChange: (nextSize: number) => void
  selectedInvestorIds: Set<string>
  onToggleSelectGroup: (rows: DealInvestorRow[]) => void
  getRowClassName: (row: DealInvestorRow) => string | undefined
  searchActive: boolean
  countNoun?: CompanyGroupCountNoun
  emptyLabel?: string
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
  const groupKeySig = groups.map((group) => group.key).join("\0")

  useEffect(() => {
    const keys = groupKeySig ? groupKeySig.split("\0") : []
    setOpenKeys((prev) => {
      if (searchActive) return new Set(keys)
      const next = new Set([...prev].filter((key) => keys.includes(key)))
      if (next.size === 0 && keys[0]) next.add(keys[0])
      return next
    })
  }, [groupKeySig, searchActive])

  const allOpen = groups.length > 0 && groups.every((group) => openKeys.has(group.key))

  const headerColumns = useMemo(() => {
    if (countNoun === "sponsor") {
      let countChars = sponsorCountText(1).length
      let sponsorChars = companyCommittedTotal([]).length
      let investorChars = investorsCommittedTotal([]).length
      for (const group of groups) {
        countChars = Math.max(countChars, sponsorCountText(group.rows.length).length)
        sponsorChars = Math.max(
          sponsorChars,
          companyCommittedTotal(group.rows).length,
        )
        investorChars = Math.max(
          investorChars,
          investorsCommittedTotal(group.rows).length,
        )
      }
      return {
        "--deal-inv-company-count-w": `calc(${countChars}ch + 0.35rem)`,
        "--deal-inv-company-sponsor-w": `calc(${sponsorChars}ch + 0.35rem)`,
        "--deal-inv-company-investor-w": `calc(${investorChars}ch + 0.35rem)`,
      } as CSSProperties
    }
    let countChars = investorCountLabel(1, countNoun).length
    let amountChars = (
      countNoun === "member" ? investorsCommittedTotal([]) : companyCommittedTotal([])
    ).length
    for (const group of groups) {
      countChars = Math.max(
        countChars,
        investorCountLabel(group.rows.length, countNoun).length,
      )
      amountChars = Math.max(
        amountChars,
        (countNoun === "member"
          ? investorsCommittedTotal(group.rows)
          : companyCommittedTotal(group.rows)
        ).length,
      )
    }
    return {
      "--deal-inv-company-count-w": `calc(${countChars}ch + 1.45rem)`,
      "--deal-inv-company-committed-w": `calc(${amountChars}ch + 0.35rem)`,
    } as CSSProperties
  }, [countNoun, groups])

  return (
    <div className="deal_inv_company_groups" style={headerColumns}>
      {groups.length > 1 && !searchActive ? (
        <div className="deal_inv_company_groups_bar">
          <button
            type="button"
            className="deal_inv_company_groups_toggle_all"
            onClick={() =>
              setOpenKeys(
                allOpen ? new Set() : new Set(groups.map((group) => group.key)),
              )
            }
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
        </div>
      ) : null}
      {groups.map((group) => (
        <DealInvestorCompanyGroup
          key={group.key}
          group={group}
          open={openKeys.has(group.key)}
          onToggle={() =>
            setOpenKeys((prev) => {
              const next = new Set(prev)
              if (next.has(group.key)) next.delete(group.key)
              else next.add(group.key)
              return next
            })
          }
          columns={columns}
          dealId={dealId}
          pageSize={pageSize}
          onPageSizeChange={onPageSizeChange}
          selectedInvestorIds={selectedInvestorIds}
          onToggleSelectGroup={onToggleSelectGroup}
          getRowClassName={getRowClassName}
          countNoun={countNoun}
          emptyLabel={emptyLabel}
        />
      ))}
    </div>
  )
}
