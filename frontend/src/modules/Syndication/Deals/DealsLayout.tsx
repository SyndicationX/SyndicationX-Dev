import { useEffect, useState } from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"
import { usePortalMode } from "@/modules/Investing/context/PortalModeContext"
import { CoSponsorCompanyRequiredAlert } from "@/common/auth/CoSponsorCompanyRequiredAlert"
import { loadCoSponsorNeedsCompany } from "@/common/auth/coSponsorCompanyGate"
import { DealsPageCenteredLoader } from "./components/DealsPageCenteredLoader"

/**
 * Investing LP deal routes under `/deals/*` (not syndication list/create/tools):
 * `/deals/:dealId`, `/deals/:dealId/offering-portfolio`, `/deals/:dealId/invest`.
 */
const INVESTING_DEAL_WORKSPACE_PATH =
  /^\/deals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/(offering-portfolio|invest))?$/i

const OPEN_DEAL_PATH =
  /^\/deals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i

/** Syndication-only shell for `/deals/*` */
export default function DealsLayout() {
  const { mode } = usePortalMode()
  const location = useLocation()
  const path = (location.pathname || "/").replace(/\/+$/, "") || "/"
  const openingDeal = OPEN_DEAL_PATH.test(path)
  const [companyBlocked, setCompanyBlocked] = useState<boolean | null>(null)

  useEffect(() => {
    if (!openingDeal) {
      setCompanyBlocked(false)
      return
    }
    let cancelled = false
    setCompanyBlocked(null)
    void loadCoSponsorNeedsCompany().then((needsCompany) => {
      if (!cancelled) setCompanyBlocked(needsCompany)
    })
    return () => {
      cancelled = true
    }
  }, [openingDeal, path])

  if (mode === "investing") {
    if (!INVESTING_DEAL_WORKSPACE_PATH.test(path)) {
      return <Navigate to="/dashboard" replace />
    }
  }

  if (openingDeal && companyBlocked === null) {
    return <DealsPageCenteredLoader label="Loading deal…" />
  }

  if (openingDeal && companyBlocked) {
    return (
      <div className="deals_list_page deals_detail_page">
        <CoSponsorCompanyRequiredAlert />
      </div>
    )
  }

  return <Outlet />
}
