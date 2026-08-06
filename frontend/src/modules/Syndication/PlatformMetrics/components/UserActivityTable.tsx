import { Users } from "lucide-react"
import {
  formatActivityDateTime,
  type UserActivityRow,
} from "../platformMetricsApi"

type Props = {
  rows: UserActivityRow[]
  loading: boolean
  error: string | null
}

export function UserActivityTable({ rows, loading, error }: Props) {
  return (
    <article className="pm_panel pm_user_activity_panel">
      <div className="pm_panel_head">
        <div className="pm_panel_title_row">
          <span className="pm_panel_icon pm_panel_icon_info" aria-hidden>
            <Users size={18} />
          </span>
          <h3 className="pm_panel_title">User activity</h3>
        </div>
        <span className="pm_panel_badge">
          Logged in: <strong>{loading ? "…" : rows.length}</strong>
        </span>
      </div>

      {error ? (
        <p className="pm_empty_state" role="alert">
          {error}
        </p>
      ) : null}

      <div className="um_table_wrap pm_user_activity_table_wrap">
        <table className="um_table pm_user_activity_table">
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Email</th>
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
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="pm_user_activity_empty">
                  No users are currently logged in.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.userId}>
                  <td className="pm_ua_name">{row.userName}</td>
                  <td className="pm_ua_email">{row.email}</td>
                  <td>{formatActivityDateTime(row.loginAt)}</td>
                  <td>
                    {row.isActive ? (
                      <span className="pm_ua_active">Active session</span>
                    ) : (
                      formatActivityDateTime(row.logoutAt)
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
                            <span className="pm_ua_page_count">{p.count}</span>
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
      </div>
      {/* <p className="pm_panel_note">
        Only users with an active session are listed. Page counts reflect navigations
        during the current login (updates as users move through the app).
      </p> */}
    </article>
  )
}
