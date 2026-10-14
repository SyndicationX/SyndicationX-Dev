import "@/common/components/data-table/data-table.css"

export interface MyAccountPanelLoaderProps {
  label?: string
}

/** Fills the account tab panel while the profile is fetched, so fields never flash stale session values. */
export function MyAccountPanelLoader({
  label = "Loading your account…",
}: MyAccountPanelLoaderProps) {
  return (
    <div
      className="myaccount_panel_loading"
      role="status"
      aria-live="polite"
      aria-busy
    >
      <div className="data_table_loader_spinner" aria-hidden />
      <span className="myaccount_panel_loading_text">{label}</span>
    </div>
  )
}
