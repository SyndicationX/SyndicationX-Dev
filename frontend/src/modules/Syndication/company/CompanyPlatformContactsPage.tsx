import { Download, RefreshCw, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate, useOutletContext, useParams } from "react-router-dom"
import {
  DataTable,
  type DataTableColumn,
} from "../../../common/components/data-table/DataTable"
import {
  TABLE_PAGE_SIZE_ID,
  usePersistedTablePageSize,
} from "@/common/hooks/usePersistedTablePageSize"
import { displayEmail } from "../../../common/utils/displayEmail"
import { formatUsPhoneStoredForUi } from "../../../common/phone/usPhoneNumber"
import { fetchPlatformContactsResult } from "../contacts/api/contactsApi"
import { ExportContactsModal } from "../contacts/components/ExportContactsModal"
import type { ContactRow } from "../contacts/types/contact.types"
import type { CustomerCompanyOutletContext } from "./CustomerCompanyLayout"
import "../Deals/deal-investors-tab.css"
import "../Deals/deals-list.css"
import "../usermanagement/user_management.css"
import "./company_page.css"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function contactDisplayName(row: ContactRow): string {
  const name = [row.firstName, row.lastName]
    .map((part) => String(part ?? "").trim())
    .filter((part) => part && part !== "—")
    .join(" ")
  return name || displayEmail(row.email) || "—"
}

function contactStatusLabel(row: ContactRow): string {
  return row.status === "suspended" ? "Archived" : "Active"
}

export default function CompanyPlatformContactsPage() {
  const { companyId = "" } = useParams<{ companyId: string }>()
  const navigate = useNavigate()
  const { companyDisplayName } = useOutletContext<CustomerCompanyOutletContext>()

  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePersistedTablePageSize(
    TABLE_PAGE_SIZE_ID.customerPlatformContacts,
  )
  const [query, setQuery] = useState("")
  const [exportOpen, setExportOpen] = useState(false)

  const load = useCallback(async () => {
    const id = companyId.trim()
    if (!UUID_RE.test(id)) {
      setContacts([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError("")
    try {
      const result = await fetchPlatformContactsResult({
        organizationId: id,
        sort: "name",
        lean: true,
        force: true,
      })
      if (!result.ok) {
        setError(result.error)
        setContacts([])
        return
      }
      setContacts(result.contacts)
    } catch {
      setError("Unable to load platform contacts.")
      setContacts([])
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => {
    if (!UUID_RE.test(companyId.trim())) {
      navigate("/customers", { replace: true })
      return
    }
    void load()
  }, [companyId, navigate, load])

  const titleCompany = companyDisplayName?.trim() || "Company"

  const filteredContacts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((row) => {
      const owners = (row.owners ?? []).join(" ")
      return (
        contactDisplayName(row).toLowerCase().includes(q) ||
        displayEmail(row.email).toLowerCase().includes(q) ||
        formatUsPhoneStoredForUi(row.phone).toLowerCase().includes(q) ||
        owners.toLowerCase().includes(q) ||
        (row.invitedByDisplayName ?? "").toLowerCase().includes(q) ||
        (row.visibleToUsers === true ? "yes" : "no").includes(q) ||
        contactStatusLabel(row).toLowerCase().includes(q)
      )
    })
  }, [contacts, query])

  useEffect(() => {
    setPage(1)
  }, [query, companyId])

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredContacts.length / pageSize))
    if (page > totalPages) setPage(totalPages)
  }, [filteredContacts.length, page, pageSize])

  const pagination = useMemo(
    () => ({
      page,
      pageSize,
      totalItems: filteredContacts.length,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
      ariaLabel: `Platform contacts for ${titleCompany} table pagination`,
    }),
    [page, pageSize, filteredContacts.length, titleCompany],
  )

  const columns: DataTableColumn<ContactRow>[] = useMemo(
    () => [
      {
        id: "name",
        header: "Name",
        colWidth: "16rem",
        sortValue: (row) => contactDisplayName(row).toLowerCase(),
        cell: (row) => contactDisplayName(row),
      },
      {
        id: "email",
        header: "Email",
        colWidth: "16rem",
        sortValue: (row) => displayEmail(row.email).toLowerCase(),
        tdClassName: "cp_company_deal_meta_td",
        cell: (row) => (
          <span className="cp_company_cell_muted">
            {displayEmail(row.email) || "—"}
          </span>
        ),
      },
      {
        id: "phone",
        header: "Phone",
        colWidth: "9rem",
        sortValue: (row) => formatUsPhoneStoredForUi(row.phone),
        cell: (row) => formatUsPhoneStoredForUi(row.phone) || "—",
      },
      {
        id: "owner",
        header: "Owner",
        colWidth: "12rem",
        sortValue: (row) => (row.owners ?? []).join(", ").toLowerCase(),
        tdClassName: "cp_company_deal_meta_td",
        cell: (row) => {
          const owners = (row.owners ?? [])
            .map((name) => name.trim())
            .filter(Boolean)
          return (
            <span className="cp_company_cell_muted">
              {owners.length > 0 ? owners.join(", ") : "—"}
            </span>
          )
        },
      },
      /* Hidden: Invited by on Platform Contacts for every role (restore by uncommenting)
      {
        id: "invitedBy",
        header: "Invited by",
        colWidth: "12rem",
        sortValue: (row) => (row.invitedByDisplayName ?? "").toLowerCase(),
        tdClassName: "cp_company_deal_meta_td",
        cell: (row) => (
          <span className="cp_company_cell_muted">
            {row.invitedByDisplayName?.trim() || "—"}
          </span>
        ),
      },
      */
      {
        id: "visibleToUsers",
        header: "Visible on platform",
        colWidth: "9rem",
        align: "center",
        sortValue: (row) => (row.visibleToUsers === true ? 1 : 0),
        cell: (row) => (row.visibleToUsers === true ? "Yes" : "No"),
      },
      {
        id: "status",
        header: "Status",
        colWidth: "7rem",
        sortValue: (row) => contactStatusLabel(row).toLowerCase(),
        cell: (row) => contactStatusLabel(row),
      },
    ],
    [],
  )

  return (
    <div
      className={`um_panel um_members_tab_panel deals_list_table_panel deals_list_card_surface deal_inv_table_panel${
        loading ? " deals_list_table_panel_loading" : ""
      }`}
      id="cp-company-panel-platform-contacts"
      role="tabpanel"
      aria-labelledby="cp-company-tab-platform-contacts"
      aria-busy={loading}
    >
      <div className="cp_company_tab_panel_inner">
        <div className="um_toolbar cp_company_tab_toolbar deal_inv_table_um_toolbar um_toolbar_export_then_search">
          <p className="cp_company_tab_toolbar_hint">
            Platform contacts for{" "}
            <strong className="cp_company_tab_toolbar_strong">
              {titleCompany}
            </strong>
            . Self-signups invited by this company, and contacts who chose to
            be visible on the platform.
          </p>
          <div className="um_toolbar_actions">
            <button
              type="button"
              className="um_toolbar_export_btn"
              disabled={loading || contacts.length === 0}
              onClick={() => setExportOpen(true)}
            >
              <Download size={18} strokeWidth={2} aria-hidden />
              <span>Export All</span>
            </button>
            <button
              type="button"
              className="um_btn_toolbar"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={18} strokeWidth={2} aria-hidden />
              Refresh
            </button>
          </div>
          <div className="um_search_wrap">
            <Search className="um_search_icon" size={18} aria-hidden />
            <input
              type="search"
              className="um_search_input"
              placeholder="Search platform contacts…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={`Search platform contacts for ${titleCompany}`}
              disabled={loading}
            />
          </div>
        </div>

        {error ? (
          <p className="um_msg_error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="cp_company_tab_table_wrap">
          <DataTable
            visualVariant="members"
            stickyFirstColumn={false}
            membersTableClassName="um_table_members deal_inv_table cp_company_deals_table"
            initialSort={{ columnId: "name", direction: "asc" }}
            columns={columns}
            rows={loading ? [] : filteredContacts}
            getRowKey={(row, i) => row.id || `platform-contact-${i}`}
            isLoading={loading}
            emptyLabel={
              contacts.length === 0
                ? "No platform contacts for this company."
                : query.trim()
                  ? "No platform contacts match your search."
                  : "No rows."
            }
            emptyStateRole={loading ? "status" : undefined}
            pagination={
              !loading && filteredContacts.length > 0 ? pagination : undefined
            }
          />
        </div>
      </div>
      <ExportContactsModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        contacts={contacts}
        listKind="platform"
        includePlatformVisibility
      />
    </div>
  )
}
