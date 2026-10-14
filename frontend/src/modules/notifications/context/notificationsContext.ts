import { createContext } from "react"
import type { PortalNotification } from "../types/notification.types"

export interface NotificationsContextValue {
  notifications: PortalNotification[]
  unreadCount: number
  isLoading: boolean
  loadError: string | null
  /** Forces a rebuild — use for explicit user retry, not for opening the panel. */
  refresh: () => Promise<void>
  /** Reuses a recent result when one exists; rebuilds only once it has gone stale. */
  refreshIfStale: () => Promise<void>
  markRead: (id: string) => void
  markAllRead: () => void
}

export const NotificationsContext = createContext<
  NotificationsContextValue | undefined
>(undefined)
