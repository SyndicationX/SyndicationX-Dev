import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { FEEDBACK_PENDING_CHANGED_EVENT } from "@/modules/feedback/api/feedbackApi"
import { fetchPortalNotifications } from "../api/fetchPortalNotifications"
import type { PortalNotification } from "../types/notification.types"
import {
  getReadNotificationIds,
  persistAllNotificationsRead,
  persistNotificationRead,
} from "../utils/notificationReadStorage"
import { NotificationsContext } from "./notificationsContext"

export { NotificationsContext } from "./notificationsContext"
export type { NotificationsContextValue } from "./notificationsContext"

function applyReadState(
  items: Omit<PortalNotification, "read">[],
  readIds: Set<string>,
): PortalNotification[] {
  return items.map((n) => ({ ...n, read: readIds.has(n.id) }))
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<PortalNotification[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const hasLoadedRef = useRef(false)

  /**
   * `force` rebuilds; otherwise a cached set is reused (see fetchPortalNotifications).
   * Only the first load shows the spinner — background refreshes keep the list on screen.
   */
  const load = useCallback(async (options?: { force?: boolean }) => {
    if (!hasLoadedRef.current) setIsLoading(true)
    try {
      const fetched = await fetchPortalNotifications({ force: options?.force })
      const readIds = getReadNotificationIds()
      setNotifications(applyReadState(fetched, readIds))
      setLoadError(null)
      hasLoadedRef.current = true
    } catch {
      setNotifications([])
      setLoadError("Could not load notifications. Try again in a moment.")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    await load({ force: true })
  }, [load])

  const refreshIfStale = useCallback(async () => {
    await load()
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    function onFocus() {
      void load()
    }
    function onFeedbackChanged() {
      void load({ force: true })
    }
    window.addEventListener("focus", onFocus)
    window.addEventListener(FEEDBACK_PENDING_CHANGED_EVENT, onFeedbackChanged)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.removeEventListener(
        FEEDBACK_PENDING_CHANGED_EVENT,
        onFeedbackChanged,
      )
    }
  }, [load])

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  )

  const markRead = useCallback((id: string) => {
    const trimmed = id.trim()
    if (!trimmed) return
    persistNotificationRead(trimmed)
    setNotifications((prev) =>
      prev.map((n) => (n.id === trimmed ? { ...n, read: true } : n)),
    )
  }, [])

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const ids = prev.map((n) => n.id)
      persistAllNotificationsRead(ids)
      return prev.map((n) => ({ ...n, read: true }))
    })
  }, [])

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      isLoading,
      loadError,
      refresh,
      refreshIfStale,
      markRead,
      markAllRead,
    }),
    [
      notifications,
      unreadCount,
      isLoading,
      loadError,
      refresh,
      refreshIfStale,
      markRead,
      markAllRead,
    ],
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  )
}
