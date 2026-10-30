import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Eye, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import {
  DataTable,
  type DataTableColumn,
} from "@/common/components/data-table/DataTable"
import { EntityAvatarNameCell } from "@/common/components/entity-avatar/EntityAvatarNameCell"
import type { InvestorSharedConnectBank } from "@/modules/Investing/api/stripeInvestorPaymentsApi"
import "@/modules/Syndication/Deals/tabs/deal_members/components/deal-member-row-actions.css"
import "@/modules/Syndication/usermanagement/user_management.css"
import type { InvestorProfileListRow } from "./investor-profiles.types"
import { InvestingProfilesTableToolbar } from "./InvestingProfilesTableToolbar"

export const PROFILE_BANK_RECORD_PREFIX = "profile-bank:"

export function isSavedProfileBankId(accountId: string): boolean {
  return accountId.startsWith(PROFILE_BANK_RECORD_PREFIX)
}

export type BankAccountTableRow = InvestorSharedConnectBank & {
  id: string
  serialNo: number
  bankLabel: string
  accountLabel: string
  routingLabel: string
  accountTypeLabel: string
  holderLabel: string
  statusLabel: string
  profilesLabel: string
}

function bankStatusLabel(bank: InvestorSharedConnectBank): string {
  if (bank.payoutsEnabled) return "Ready"
  const slug = bank.status.trim().toLowerCase()
  if (!slug || slug === "not_started") {
    return bank.bankAccount ? "Linked" : "Not set up"
  }
  if (slug === "onboarding" || slug === "pending" || slug === "linked") {
    return bank.payoutsEnabled ? "Ready" : "Setup pending"
  }
  if (slug === "restricted") return "Restricted"
  return bank.status
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatSharedBankOptionLabel(
  bank: InvestorSharedConnectBank,
): string {
  const parts = [
    bank.bankAccount?.bankName?.trim() || null,
    bank.bankAccount?.last4 ? `···· ${bank.bankAccount.last4}` : null,
  ].filter(Boolean)
  if (parts.length) return parts.join(" ")
  if (bank.payoutsEnabled) return "Ready bank account"
  return "Bank account on file"
}

function bankDigits(value: string): string {
  return value.replace(/\D/g, "")
}

function maskAccountLast4(value: string): string {
  const digits = bankDigits(value)
  if (!digits) return "—"
  return `···· ${digits.slice(-4)}`
}

function accountTypeLabel(value: string): string {
  const raw = value.trim()
  if (!raw) return "—"
  const slug = raw.toLowerCase()
  if (slug === "checking") return "Checking"
  if (slug === "savings") return "Savings"
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Banks saved on investor profiles (name, routing, and account). */
export function savedProfileBankTableRows(
  profiles: InvestorProfileListRow[],
): BankAccountTableRow[] {
  const groups = new Map<
    string,
      {
      bankName: string
      routing: string
      account: string
      accountType: string
      profileIds: string[]
      names: string[]
    }
  >()
  for (const profile of profiles) {
    if (profile.archived || profile.isDraft) continue
    const bank = profile.distributionBank
    if (!bank) continue
    const routing = bankDigits(bank.achRoutingNumber)
    const account = bankDigits(bank.achAccountNumber)
    const bankName = bank.achBankName.trim()
    const accountType = bank.achBankAccountType.trim()
    if (!((bankName && (routing || account)) || (routing && account))) continue
    const fingerprint = `${routing}|${account}|${bankName.toLowerCase()}`
    const existing = groups.get(fingerprint)
    const name = profile.profileName.trim() || "Profile"
    if (existing) {
      existing.profileIds.push(profile.id)
      existing.names.push(name)
    } else {
      groups.set(fingerprint, {
        bankName,
        routing: bank.achRoutingNumber.trim(),
        account: bank.achAccountNumber.trim(),
        accountType,
        profileIds: [profile.id],
        names: [name],
      })
    }
  }
  return [...groups.values()].map((group, index) => {
    const accountId = `${PROFILE_BANK_RECORD_PREFIX}${group.profileIds[0]}`
    const bankName = group.bankName || "Bank account"
    return {
      accountId,
      status: "on_file",
      payoutsEnabled: false,
      bankAccount: {
        bankName,
        last4: bankDigits(group.account).slice(-4) || null,
        routingNumber: group.routing || null,
        accountHolderName: null,
        currency: null,
        status: null,
      },
      profileIds: group.profileIds,
      id: accountId,
      serialNo: index + 1,
      bankLabel: bankName,
      accountLabel: maskAccountLast4(group.account),
      routingLabel: group.routing || "—",
      accountTypeLabel: accountTypeLabel(group.accountType),
      holderLabel: "—",
      statusLabel: "On file",
      profilesLabel: group.names.join(", "),
    }
  })
}

export function buildBankAccountTableRows(
  banks: InvestorSharedConnectBank[],
  profileNameById: ReadonlyMap<string, string>,
): BankAccountTableRow[] {
  return banks.map((bank) => {
    const names = bank.profileIds
      .map((id) => profileNameById.get(id)?.trim() || null)
      .filter(Boolean) as string[]
    const bankName = bank.bankAccount?.bankName?.trim() || ""
    return {
      ...bank,
      id: bank.accountId,
      serialNo: 0,
      bankLabel: bankName || (bank.accountId ? "Bank account" : "—"),
      accountLabel: bank.bankAccount?.last4
        ? `···· ${bank.bankAccount.last4}`
        : "—",
      routingLabel: bank.bankAccount?.routingNumber?.trim() || "—",
      accountTypeLabel: "—",
      holderLabel: bank.bankAccount?.accountHolderName?.trim() || "—",
      statusLabel: bankStatusLabel(bank),
      profilesLabel:
        names.length > 0 ? names.join(", ") : "Not linked to a profile yet",
    }
  })
}

/** Shared ACH bank inventory. Profiles pick a bank on My Profiles. */
export function bankAccountDetailRows(row: BankAccountTableRow): {
  label: string
  value: string
}[] {
  return [
    { label: "Bank", value: row.bankLabel },
    { label: "Account", value: row.accountLabel },
    { label: "Routing", value: row.routingLabel },
    { label: "Account type", value: row.accountTypeLabel },
    { label: "Status", value: row.statusLabel },
  ]
}

function BankAccountRowActions({
  row,
  setupBusy,
  onView,
  onEdit,
  onDelete,
}: {
  row: BankAccountTableRow
  setupBusy?: boolean
  onView: (row: BankAccountTableRow) => void
  onEdit: (row: BankAccountTableRow) => void
  onDelete: (row: BankAccountTableRow) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const label = row.bankLabel.trim() || "Bank account"

  useLayoutEffect(() => {
    if (!open) return
    function syncPosition() {
      const trigger = wrapRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const rect = trigger.getBoundingClientRect()
      const menuWidth = menu.offsetWidth || 180
      const menuHeight = menu.offsetHeight || 140
      const gap = 6
      let top = rect.bottom + gap
      if (top + menuHeight > window.innerHeight - gap) {
        top = Math.max(gap, rect.top - menuHeight - gap)
      }
      let left = rect.right - menuWidth
      left = Math.min(Math.max(gap, left), window.innerWidth - menuWidth - gap)
      menu.style.position = "fixed"
      menu.style.top = `${top}px`
      menu.style.left = `${left}px`
      menu.style.right = "auto"
      menu.style.zIndex = "11000"
    }
    syncPosition()
    const frame = requestAnimationFrame(syncPosition)
    window.addEventListener("scroll", syncPosition, true)
    window.addEventListener("resize", syncPosition)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", syncPosition, true)
      window.removeEventListener("resize", syncPosition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(event: MouseEvent) {
      const target = event.target as Node
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close()
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [close, open])

  function run(action: () => void) {
    close()
    action()
  }

  return (
    <div
      className="um_kebab_root"
      ref={wrapRef}
      role="group"
      aria-label={`Actions for ${label}`}
    >
      <button
        type="button"
        className="um_kebab_trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        aria-label={`Actions for ${label}`}
        disabled={setupBusy}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <MoreHorizontal size={18} strokeWidth={2} aria-hidden />
      </button>
      {open
        ? createPortal(
            <ul
              ref={menuRef}
              className="um_kebab_menu um_kebab_menu--portal"
              role="menu"
            >
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() => run(() => onView(row))}
                >
                  <Eye className="um_kebab_menuitem_icon" size={16} strokeWidth={2} aria-hidden />
                  View
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() => run(() => onEdit(row))}
                >
                  <Pencil className="um_kebab_menuitem_icon" size={16} strokeWidth={2} aria-hidden />
                  Edit
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem deals_kebab_menuitem_danger"
                  role="menuitem"
                  onClick={() => run(() => onDelete(row))}
                >
                  <Trash2 className="um_kebab_menuitem_icon" size={16} strokeWidth={2} aria-hidden />
                  Delete
                </button>
              </li>
            </ul>,
            document.body,
          )
        : null}
    </div>
  )
}

export function bankAccountDetailsColumns(handlers: {
  setupBusy?: boolean
  onView: (row: BankAccountTableRow) => void
  onEdit: (row: BankAccountTableRow) => void
  onDelete: (row: BankAccountTableRow) => void
}): DataTableColumn<BankAccountTableRow>[] {
  return [
    {
      id: "sno",
      header: "S.No",
      align: "center",
      colWidth: "3.25rem",
      thClassName: "um_th_serial",
      tdClassName: "um_td_serial",
      sortValue: (r) => r.serialNo,
      cell: (r) => (r.serialNo > 0 ? r.serialNo : "—"),
    },
    {
      id: "bank",
      header: "Bank",
      colWidth: "14rem",
      thClassName: "investing_profiles_col_name",
      tdClassName: "um_td_user investing_profiles_td_name",
      sortValue: (r) => r.bankLabel.toLowerCase(),
      cell: (r) => (
        <EntityAvatarNameCell
          displayName={r.bankLabel}
          onClick={() => handlers.onView(r)}
          linkClassName="deals_table_name_link investing_profiles_name_text um_user_meta_username"
          cellClassName="investing_profiles_name_cell"
        />
      ),
    },
    {
      id: "account",
      header: "Account",
      colWidth: "8rem",
      sortValue: (r) => r.accountLabel,
      cell: (r) => <span className="investing_bank_mono">{r.accountLabel}</span>,
    },
    {
      id: "routing",
      header: "Routing",
      colWidth: "8.5rem",
      sortValue: (r) => r.routingLabel.toLowerCase(),
      cell: (r) => <span className="investing_bank_mono">{r.routingLabel}</span>,
    },
    {
      id: "accountType",
      header: "Account type",
      colWidth: "8.5rem",
      sortValue: (r) => r.accountTypeLabel.toLowerCase(),
      cell: (r) => r.accountTypeLabel,
    },
    /* Status column hidden — restore with the block below.
    {
      id: "status",
      header: "Status",
      colWidth: "7.5rem",
      sortValue: (r) => r.statusLabel.toLowerCase(),
      cell: (r) => (
        <span
          className={`investing_bank_status investing_bank_status--${
            r.status === "on_file"
              ? "onfile"
              : r.payoutsEnabled
                ? "ready"
                : r.status === "restricted"
                  ? "danger"
                  : r.accountId
                    ? "pending"
                    : "neutral"
          }`}
        >
          {r.statusLabel}
        </span>
      ),
    },
    */
    {
      id: "actions",
      header: "Actions",
      align: "center",
      colWidth: "4.75rem",
      thClassName: "um_th_actions",
      tdClassName: "um_td_actions",
      cell: (r) => (
        <BankAccountRowActions
          row={r}
          setupBusy={handlers.setupBusy}
          onView={handlers.onView}
          onEdit={handlers.onEdit}
          onDelete={handlers.onDelete}
        />
      ),
    },
  ]
}

export function InvestingBankAccountsTab({
  rows,
  loading,
  setupBusy,
  onAddBank,
  onViewBank,
  onEditBank,
  onDeleteBank,
}: {
  rows: BankAccountTableRow[]
  loading?: boolean
  setupBusy?: boolean
  onAddBank: () => void
  onViewBank: (row: BankAccountTableRow) => void
  onEditBank: (row: BankAccountTableRow) => void
  onDeleteBank: (row: BankAccountTableRow) => void
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [
        r.bankLabel,
        r.accountLabel,
        r.routingLabel,
        r.accountTypeLabel,
        r.statusLabel,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
  }, [rows, query])

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: filtered.length,
      onPageChange: setPage,
      onPageSizeChange: (n: number) => {
        setPageSize(n)
        setPage(1)
      },
      ariaLabel: "Bank accounts table pagination",
    }),
    [page, pageSize, filtered.length],
  )

  const columns: DataTableColumn<BankAccountTableRow>[] = useMemo(
    () =>
      bankAccountDetailsColumns({
        setupBusy,
        onView: onViewBank,
        onEdit: onEditBank,
        onDelete: onDeleteBank,
      }),
    [onDeleteBank, onEditBank, onViewBank, setupBusy],
  )

  return (
    <>
      <div className="um_members_header_block contacts_inner_header">
        <div className="contacts_toolbar_filters_row">
          <p className="investing_bank_tab_lead">
            Bank accounts saved on your investor profiles. Account numbers show
            the last four digits only.
          </p>
          <button
            type="button"
            className="um_btn_primary contacts_toolbar_add_btn"
            disabled={loading || setupBusy}
            onClick={onAddBank}
          >
            <Plus size={18} strokeWidth={2} aria-hidden />
            Add bank account
          </button>
        </div>
      </div>

      <div
        id="profiles-panel-bank-accounts"
        role="tabpanel"
        aria-labelledby="profiles-tab-bank-accounts"
        className="contacts_main_tab_panel_wrap"
      >
        <div className="um_members_tab_content contacts_main_tab_content_flush">
          <div className="um_panel um_members_tab_panel deals_list_table_panel deals_list_card_surface deal_inv_table_panel investing_profiles_table_panel">
            <InvestingProfilesTableToolbar
              searchValue={query}
              onSearchChange={(v) => {
                setQuery(v)
                setPage(1)
              }}
              searchPlaceholder="Search bank accounts…"
              searchAriaLabel="Search bank accounts"
              searchDisabled={loading}
            />
            <DataTable<BankAccountTableRow>
              visualVariant="members"
              membersTableClassName="um_table_members deal_inv_table"
              stickyFirstColumn={false}
              columns={columns}
              rows={filtered}
              isLoading={Boolean(loading && rows.length === 0)}
              getRowKey={(row) => row.id}
              emptyLabel={
                loading && rows.length === 0
                  ? "Loading bank accounts…"
                  : query.trim()
                    ? "No bank accounts match your search."
                    : "You have not added a bank account yet. Use Add bank account to get started."
              }
              initialSort={{ columnId: "sno", direction: "asc" }}
              pagination={filtered.length > 0 ? pagination : undefined}
            />
          </div>
        </div>
      </div>
    </>
  )
}

export function ProfileBankAccountDetailsSection({
  rows,
  setupBusy,
  onView,
  onEdit,
  onDelete,
}: {
  rows: BankAccountTableRow[]
  setupBusy?: boolean
  onView: (row: BankAccountTableRow) => void
  onEdit: (row: BankAccountTableRow) => void
  onDelete: (row: BankAccountTableRow) => void
}) {
  const columns = useMemo(
    () =>
      bankAccountDetailsColumns({
        setupBusy,
        onView,
        onEdit,
        onDelete,
      }),
    [onDelete, onEdit, onView, setupBusy],
  )
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
    if (page > totalPages) setPage(totalPages)
  }, [rows.length, pageSize, page])
  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: rows.length,
      onPageChange: setPage,
      onPageSizeChange: (n: number) => {
        setPageSize(n)
        setPage(1)
      },
      ariaLabel: "Profile bank accounts table pagination",
    }),
    [page, pageSize, rows.length],
  )
  return (
    <section
      className="investing_profile_view_card investing_profile_bank_section"
      aria-label="Bank Account Details"
    >
      <h3 className="investing_profile_view_card_title">Bank Account Details</h3>
      <p className="investing_profile_bank_note">
        Bank account saved on this profile. On file means the details are saved.
        It does not mean the account is verified.
      </p>
      {rows.length === 0 ? (
        <p className="investing_profile_bank_empty">
          No bank account is on file for this profile.
        </p>
      ) : (
        <DataTable<BankAccountTableRow>
          visualVariant="members"
          membersTableClassName="um_table_members deal_inv_table"
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          emptyLabel="No bank account is on file for this profile."
          initialSort={{ columnId: "sno", direction: "asc" }}
          stickyFirstColumn={false}
          pagination={rows.length > 0 ? pagination : undefined}
        />
      )}
    </section>
  )
}
