import { useEffect, useState } from "react"
import { Navigate } from "react-router-dom"
import { fetchMyProfile } from "./accountApi"
import { myAccountDefaultTabPath } from "./myAccountIndividual"
import { MyAccountPanelLoader } from "./MyAccountPanelLoader"
import { mergeSessionUserDetails, readSessionUser } from "./sessionUser"

/**
 * `/account` → first tab. Session may predate the individual-account fields, so
 * refresh the profile before redirecting.
 */
export function MyAccountIndexRedirect() {
  const [user, setUser] = useState<Record<string, unknown> | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchMyProfile().then((profile) => {
      if (cancelled) return
      if (profile) mergeSessionUserDetails(profile)
      setUser(readSessionUser())
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) return <MyAccountPanelLoader />
  return <Navigate to={myAccountDefaultTabPath(user)} replace />
}
