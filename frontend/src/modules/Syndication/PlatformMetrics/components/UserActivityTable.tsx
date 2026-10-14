import { Search, Users } from "lucide-react"
import { useMemo, useState } from "react"
import { DataTablePagination } from "../../../../common/components/DataTablePagination/DataTablePagination"
import { TableHScrollShell } from "../../../../common/components/data-table/TableHScrollShell"
import {
  TABLE_PAGE_SIZE_ID,
  usePersistedTablePageSize,
} from "../../../../common/hooks/usePersistedTablePageSize"
import { formatCount } from "@/common/utils/formatCount"
import {
  formatActivityDateTime,
  // formatRoleLabel,
  type UserActivityRow,
} from "../platformMetricsApi"

type Props = {
  rows: UserActivityRow[]
  loading: boolean
  error: string | null
}

function matchesActivityQuery(row: UserActivityRow, query: string): boolean {
  const name = row.userName.trim().toLowerCase()
  const email = row.email.trim().toLowerCase()
  return name.includes(query) || email.includes(query)
}

export function UserActivityTable({ rows, loading, error }: Props) {
  const [searchQuery, setSearchQuery] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePersistedTablePageSize(
    TABLE_PAGE_SIZE_ID.userActivity,
  )
  const normalizedQuery = searchQuery.trim().toLowerCase()

  const visibleRows = useMemo(() => {
    if (!normalizedQuery) return rows
    return rows.filter((row) => matchesActivityQuery(row, normalizedQuery))
  }, [rows, normalizedQuery])

  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize))
  const safePage = Math.min(page, totalPages)

  const pagedRows = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return visibleRows.slice(start, start + pageSize)
  }, [visibleRows, safePage, pageSize])

  const activeCount = visibleRows.filter((row) => row.isActive).length
  const searching = normalizedQuery.length > 0

  return (
    <article className="pm_panel pm_user_activity_panel">
      <div className="pm_panel_head">
        <div className="pm_panel_title_row">
          <span className="pm_panel_icon pm_panel_icon_info" aria-hidden>
            <Users size={18} />
          </span>
          <h3 className="pm_panel_title">User activity</h3>
        </div>
        <div className="pm_user_activity_head_actions">
          <div className="um_search_wrap pm_user_activity_search">
            <Search className="um_search_icon" size={18} aria-hidden />
            <input
              type="search"
              className="um_search_input"
              placeholder="Search by name or email"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                setPage(1)
              }}
              disabled={loading}
              aria-label="Search user activity by name or email"
            />
          </div>
          <span className="pm_panel_badge">
            Users: <strong>{loading ? "…" : formatCount(visibleRows.length)}</strong>
            {searching && !loading ? (
              <span className="pm_ua_muted"> of {formatCount(rows.length)}</span>
            ) : null}
            {" · "}
            Active: <strong>{loading ? "…" : formatCount(activeCount)}</strong>
          </span>
        </div>
      </div>

      {error ? (
        <p className="pm_empty_state" role="alert">
          {error}
        </p>
      ) : null}

      <div className="um_table_wrap pm_user_activity_table_wrap">
        <TableHScrollShell
          active={!loading && pagedRows.length > 0}
          ariaLabel="User activity columns"
        >
        <table className="um_table pm_user_activity_table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Email</th>
              {/* <th scope="col">Role</th>
              <th scope="col">Company</th> */}
              <th scope="col">Login</th>
              <th scope="col">Logout</th>
              <th scope="col">Page navigations</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="pm_user_activity_loading">
                  Loading user activity…
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="pm_user_activity_empty">
                  {searching
                    ? "No users match that name or email."
                    : "No users on the platform yet."}
                </td>
              </tr>
            ) : (
              pagedRows.map((row) => (
                <tr key={row.userId}>
                  <td className="pm_ua_name">{row.userName}</td>
                  <td className="pm_ua_email">{row.email}</td>
                  {/*
                  <td>Role</td>
                  <td>Company</td>
                  */}
                  <td>
                    {row.loginAt
                      ? formatActivityDateTime(row.loginAt)
                      : <span className="pm_ua_muted">Never signed in</span>}
                  </td>
                  <td>
                    {row.isActive ? (
                      <span className="pm_ua_active">Active session</span>
                    ) : row.loginAt ? (
                      formatActivityDateTime(row.logoutAt)
                    ) : (
                      <span className="pm_ua_muted">—</span>
                    )}
                  </td>
                  <td>
                    {row.pageNavigations.length === 0 ? (
                      <span className="pm_ua_muted">—</span>
                    ) : (
                      <ul className="pm_ua_pages">
                        {row.pageNavigations.map((p) => (
                          <li key={`${row.userId}-${p.pagePath}`}>
                            <span className="pm_ua_page_label">{p.pageLabel}</span>
                            <span className="pm_ua_page_count">{formatCount(p.count)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        </TableHScrollShell>
        {!loading && visibleRows.length > 0 ? (
          <DataTablePagination
            page={safePage}
            pageSize={pageSize}
            totalItems={visibleRows.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            ariaLabel="User activity pagination"
          />
        ) : null}
      </div>
      {/* <p className="pm_panel_note">
        Only users with an active session are listed. Page counts reflect navigations
        during the current login (updates as users move through the app).
      </p> */}
    </article>
  )
}
