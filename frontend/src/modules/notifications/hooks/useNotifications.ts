import { useContext } from "react"
import {
  NotificationsContext,
  type NotificationsContextValue,
} from "../context/notificationsContext"

const EMPTY_NOTIFICATIONS: NotificationsContextValue = {
  notifications: [],
  unreadCount: 0,
  isLoading: false,
  loadError: null,
  refresh: async () => {},
  refreshIfStale: async () => {},
  markRead: () => {},
  markAllRead: () => {},
}

export function useNotifications() {
  return useContext(NotificationsContext) ?? EMPTY_NOTIFICATIONS
}
