import { toast } from "../components/Toast/toastStore"
import { performPortalLogout } from "./portalLogout"
import { getSessionUserId } from "./sessionUserId"

/** localStorage: the account that most recently signed in in this browser profile. */
export const ACTIVE_BROWSER_USER_STORAGE_KEY = "portalActiveBrowserUserId"

/** sessionStorage flag read on the sign-in page after this tab was signed out. */
export const EXCLUSIVE_BROWSER_LOGOUT_NOTICE_KEY = "exclusiveBrowserLogoutNotice"

let exclusiveGuardInstalled = false
let displacedLogoutStarted = false

function readActiveBrowserUserId(): string {
  if (typeof localStorage === "undefined") return ""
  try {
    return localStorage.getItem(ACTIVE_BROWSER_USER_STORAGE_KEY)?.trim() ?? ""
  } catch {
    return ""
  }
}

/**
 * Record this tab's signed-in user as the only active account in this browser
 * window. Other tabs signed in as a different user hear the storage event and
 * sign out. Incognito storage is separate, so a private window is not affected.
 */
export function publishActiveBrowserUserFromSession(): void {
  const userId = getSessionUserId()
  if (!userId || typeof localStorage === "undefined") return
  try {
    localStorage.setItem(ACTIVE_BROWSER_USER_STORAGE_KEY, userId)
  } catch {
    /* private mode / blocked storage */
  }
}

function markExclusiveBrowserLogoutNotice(): void {
  if (typeof sessionStorage === "undefined") return
  try {
    sessionStorage.setItem(EXCLUSIVE_BROWSER_LOGOUT_NOTICE_KEY, "1")
  } catch {
    /* ignore */
  }
}

/** Toast once after this tab was closed because another account signed in. */
export function showExclusiveBrowserLogoutToastIfNeeded(): boolean {
  if (typeof sessionStorage === "undefined") return false
  if (sessionStorage.getItem(EXCLUSIVE_BROWSER_LOGOUT_NOTICE_KEY) !== "1") {
    return false
  }
  sessionStorage.removeItem(EXCLUSIVE_BROWSER_LOGOUT_NOTICE_KEY)
  toast.warning(
    "Signed out",
    "Another account signed in on this browser, so this session was closed.",
    8000,
  )
  return true
}

async function logoutDisplacedBrowserSession(): Promise<void> {
  if (displacedLogoutStarted) return
  displacedLogoutStarted = true
  markExclusiveBrowserLogoutNotice()
  try {
    await performPortalLogout()
  } catch {
    /* still leave this tab */
  }
  const returnPath = `${window.location.pathname}${window.location.search}`
  const next =
    returnPath && returnPath !== "/" && !returnPath.includes("/signin")
      ? `?next=${encodeURIComponent(returnPath)}`
      : ""
  window.location.assign(`/signin${next}`)
}

/**
 * If this tab is signed in as someone other than the browser's active account,
 * sign it out. When no account has claimed the browser yet, this tab claims it.
 */
function enforceExclusiveBrowserUser(): void {
  const mine = getSessionUserId()
  if (!mine) return
  const active = readActiveBrowserUserId()
  if (!active) {
    publishActiveBrowserUserFromSession()
    return
  }
  if (active === mine) return
  void logoutDisplacedBrowserSession()
}

/** Keep a single signed-in account across tabs in this browser window. */
export function installExclusiveBrowserSessionGuard(): void {
  if (typeof window === "undefined" || exclusiveGuardInstalled) return
  exclusiveGuardInstalled = true

  enforceExclusiveBrowserUser()

  window.addEventListener("storage", (event) => {
    if (event.key !== ACTIVE_BROWSER_USER_STORAGE_KEY) return
    enforceExclusiveBrowserUser()
  })

  window.addEventListener("focus", () => {
    enforceExclusiveBrowserUser()
  })

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") enforceExclusiveBrowserUser()
  })
}
