import {
  CheckCircle2,
  ClipboardList,
  Download,
  Eye,
  Flag,
  MessageSquareText,
  Pencil,
  Plus,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  canEditOwnPendingFeedback,
  isPlatformAdmin,
} from "@/common/auth/roleUtils"
import {
  DataTable,
  type DataTableColumn,
} from "@/common/components/data-table/DataTable"
import { TabsScrollStrip } from "@/common/components/tabs-scroll-strip/TabsScrollStrip"
import { toast } from "@/common/components/Toast"
import { TABLE_PAGE_SIZE_ID } from "@/common/hooks/usePersistedTablePageSize"
import {
  useServerPagedTable,
  type PagedRequest,
  type PagedResult,
} from "@/common/hooks/useServerPagedTable"
import { formatDateDdMmmYyyy } from "@/common/utils/formatDateDisplay"
import { formatCount } from "@/common/utils/formatCount"
import { ExportFeedbackModal } from "./ExportFeedbackModal"
import { FeedbackDetailsModal } from "./FeedbackDetailsModal"
import { FeedbackFormModal } from "./FeedbackFormModal"
import { FeedbackPriorityModal } from "./FeedbackPriorityModal"
import { FeedbackTypeModal } from "./FeedbackTypeModal"
import {
  fetchFeedbackItem,
  fetchFeedbackList,
  fetchFeedbackPage,
  fetchMyFeedback,
  notifyFeedbackPendingChanged,
  reviewFeedback,
  setFeedbackPriority,
  setFeedbackType,
} from "./api/feedbackApi"
import type {
  FeedbackItem,
  FeedbackPriority,
  FeedbackReviewAction,
  FeedbackStatus,
  FeedbackType,
} from "./types"
import { feedbackPriorityLabel, feedbackUserRoleLabel } from "./types"
import "../Syndication/usermanagement/user_management.css"
import "../Syndication/Deals/deals-list.css"
import "./feedback.css"

function formatDateTime(raw: string | null | undefined): string {
  if (!raw?.trim()) return "—"
  const date = formatDateDdMmmYyyy(raw)
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return date
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })
  return `${date} ${time}`
}

function StatusCell({ status }: { status: FeedbackStatus }) {
  const tone =
    status === "Resolved"
      ? "um_status_dot_active"
      : status === "Reviewed"
        ? "um_status_dot_invited"
        : "um_status_dot_invited"
  return (
    <span className="um_status_cell">
      <span className={`um_status_dot ${tone}`} />
      <span className="um_status_label">{status}</span>
    </span>
  )
}

function NotesCell({ text }: { text: string | null }) {
  if (!text?.trim()) return <span>—</span>
  return (
    <span className="feedback_desc" title={text}>
      {text}
    </span>
  )
}

export default function FeedbackPage() {
  const admin = isPlatformAdmin()
  const [searchParams, setSearchParams] = useSearchParams()
  const viewId = searchParams.get("view")?.trim() || ""
  const [formOpen, setFormOpen] = useState(!admin && !viewId)
  const [editItem, setEditItem] = useState<FeedbackItem | null>(null)
  const sponsorCanEditPending = canEditOwnPendingFeedback()
  const [tab, setTab] = useState<FeedbackStatus>("Pending")
  const [activeItem, setActiveItem] = useState<FeedbackItem | null>(null)
  const [modalMode, setModalMode] = useState<"review" | "view">("view")
  const [priorityItem, setPriorityItem] = useState<FeedbackItem | null>(null)
  const [prioritySaving, setPrioritySaving] = useState(false)
  const [typeItem, setTypeItem] = useState<FeedbackItem | null>(null)
  const [typeSaving, setTypeSaving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  /** Tab badges come from the API so they count every match, not just this page. */
  const [statusCounts, setStatusCounts] = useState<Record<FeedbackStatus, number>>({
    Pending: 0,
    Reviewed: 0,
    Resolved: 0,
  })
  const suppressViewOpenRef = useRef(false)

  const fetchPage = useCallback<
    (req: PagedRequest) => Promise<PagedResult<FeedbackItem>>
  >(
    async ({ page, pageSize, search, sort, signal }) => {
      const result = await fetchFeedbackPage({
        admin,
        status: tab,
        page,
        pageSize,
        search,
        sort,
        signal,
      })
      if (result.counts) setStatusCounts(result.counts)
      return { rows: result.rows, total: result.total }
    },
    [admin, tab],
  )

  const table = useServerPagedTable<FeedbackItem>({
    tableId: TABLE_PAGE_SIZE_ID.feedback,
    fetchPage,
    deps: [admin, tab],
    initialSort: { columnId: "submitted", direction: "desc" },
  })

  const { rows: items, isLoading: loading, refresh } = table
  const error = table.error

  const load = useCallback(async () => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!viewId) {
      suppressViewOpenRef.current = false
      return
    }
    if (suppressViewOpenRef.current) return
    const existing = items.find((row) => row.id === viewId)
    if (existing) {
      setActiveItem(existing)
      setModalMode(admin && existing.status !== "Resolved" ? "review" : "view")
      return
    }
    let cancelled = false
    void (async () => {
      const result = await fetchFeedbackItem(viewId)
      if (cancelled || !result.ok) return
      setActiveItem(result.feedback)
      setModalMode(
        admin && result.feedback.status !== "Resolved" ? "review" : "view",
      )
    })()
    return () => {
      cancelled = true
    }
  }, [viewId, items, admin])

  /** The API already narrowed to the active tab. */
  const visible = items

  const pagination = useMemo(
    () => ({
      ...table.pagination,
      serverSide: true,
      ariaLabel: admin
        ? `${tab} feedback table pagination`
        : "Feedback table pagination",
    }),
    [table.pagination, admin, tab],
  )

  function openReview(row: FeedbackItem) {
    setActiveItem(row)
    setModalMode(row.status === "Resolved" ? "view" : "review")
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("view", row.id)
        return next
      },
      { replace: true },
    )
  }

  function openEdit(row: FeedbackItem) {
    if (row.status !== "Pending") {
      toast.error(
        "This feedback can no longer be edited",
        "A platform admin has already reviewed or resolved it.",
      )
      return
    }
    setEditItem(row)
    setFormOpen(true)
  }

  function openView(row: FeedbackItem) {
    setActiveItem(row)
    setModalMode("view")
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("view", row.id)
        return next
      },
      { replace: true },
    )
  }

  function closeDetails() {
    suppressViewOpenRef.current = true
    setActiveItem(null)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("view")
        return next
      },
      { replace: true },
    )
  }

  async function handleAction(action: FeedbackReviewAction, adminResponse: string) {
    if (!activeItem) return
    const row = activeItem
    closeDetails()
    const result = await reviewFeedback(row.id, { action, adminResponse })
    if (!result.ok) {
      toast.error("Could not update feedback", result.message)
      setActiveItem(row)
      setModalMode("review")
      return
    }
    /** The row moves to another tab, so reload rather than patching in place. */
    refresh()
    toast.success(
      action === "resolved" ? "Feedback resolved" : "Feedback reviewed",
      `${row.username} will be notified.`,
    )
    notifyFeedbackPendingChanged()
    if (action === "resolved") setTab("Resolved")
    else setTab("Reviewed")
  }

  async function handlePrioritySave(priority: FeedbackPriority) {
    if (!priorityItem) return
    setPrioritySaving(true)
    const result = await setFeedbackPriority(priorityItem.id, priority)
    setPrioritySaving(false)
    if (!result.ok) {
      toast.error("Could not update priority", result.message)
      return
    }
    setPriorityItem(null)
    setActiveItem((prev) =>
      prev && prev.id === result.feedback.id ? result.feedback : prev,
    )
    refresh()
    toast.success("Priority updated", feedbackPriorityLabel(priority))
  }

  async function handleTypeSave(feedbackType: FeedbackType) {
    if (!typeItem) return
    setTypeSaving(true)
    const result = await setFeedbackType(typeItem.id, feedbackType)
    setTypeSaving(false)
    if (!result.ok) {
      toast.error("Could not update feedback type", result.message)
      return
    }
    setTypeItem(null)
    setActiveItem((prev) =>
      prev && prev.id === result.feedback.id ? result.feedback : prev,
    )
    refresh()
    toast.success("Feedback type updated", feedbackType)
  }

  const serialNoColumn = useMemo<DataTableColumn<FeedbackItem>>(
    () => ({
      id: "sno",
      header: "S.No",
      align: "center",
      colWidth: "3.75rem",
      thClassName: "feedback_sno_col",
      tdClassName: "feedback_sno_col um_td_numeric",
      sortValue: (row) => row.feedbackNo,
      cell: (row) => (row.feedbackNo > 0 ? row.feedbackNo : "—"),
    }),
    [],
  )

  const sharedIdentityCols = useMemo<DataTableColumn<FeedbackItem>[]>(
    () => [
      serialNoColumn,
      {
        id: "username",
        header: "Username",
        sortValue: (row) => row.username.toLowerCase(),
        cell: (row) => row.username || "—",
      },
      {
        id: "email",
        header: "User Email",
        sortValue: (row) => row.userEmail.toLowerCase(),
        cell: (row) => row.userEmail || "—",
      },
      {
        id: "role",
        header: "Role",
        sortValue: (row) => feedbackUserRoleLabel(row.userRole).toLowerCase(),
        cell: (row) => feedbackUserRoleLabel(row.userRole),
      },
      {
        id: "page",
        header: "Page",
        sortValue: (row) => row.pageLabel.toLowerCase(),
        cell: (row) => row.pageLabel || "—",
      },
      {
        id: "subPage",
        header: "Sub Page / Tab",
        sortValue: (row) => row.subPageLabel.toLowerCase(),
        cell: (row) => row.subPageLabel || "—",
      },
      {
        id: "priority",
        header: "Priority",
        sortValue: (row) => row.priority ?? "P9",
        cell: (row) => (
          <button
            type="button"
            className={`feedback_priority_btn${
              row.priority
                ? ` feedback_priority feedback_priority_${row.priority.toLowerCase()}`
                : ""
            }`}
            onClick={() => setPriorityItem(row)}
            title={row.priority ? "Change priority" : "Set priority"}
          >
            <Flag size={13} strokeWidth={2} aria-hidden />
            {row.priority ? feedbackPriorityLabel(row.priority) : "Set"}
          </button>
        ),
      },
      {
        id: "feedbackType",
        header: "Feedback Type",
        sortValue: (row) => row.feedbackType ?? "zzz",
        cell: (row) => (
          <button
            type="button"
            className={`feedback_priority_btn${
              row.feedbackType ? " feedback_type_value" : ""
            }`}
            onClick={() => setTypeItem(row)}
            title={row.feedbackType ? "Change feedback type" : "Set feedback type"}
          >
            <ClipboardList size={13} strokeWidth={2} aria-hidden />
            {row.feedbackType ?? "Set"}
          </button>
        ),
      },
      {
        id: "description",
        header: "Description",
        sortValue: (row) => row.description.toLowerCase(),
        tdClassName: "feedback_desc_cell",
        cell: (row) => (
          <span className="feedback_desc" title={row.description}>
            {row.description || "—"}
          </span>
        ),
      },
      {
        id: "submitted",
        header: "Submitted Date",
        sortValue: (row) => Date.parse(row.createdAt) || 0,
        cell: (row) => formatDateTime(row.createdAt),
      },
    ],
    [serialNoColumn],
  )

  const pendingColumns = useMemo<DataTableColumn<FeedbackItem>[]>(
    () => [
      ...sharedIdentityCols,
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status,
        cell: (row) => <StatusCell status={row.status} />,
      },
      {
        id: "review",
        header: "Review",
        cell: (row) => (
          <button
            type="button"
            className="um_btn_primary feedback_review_btn"
            onClick={() => openReview(row)}
          >
            Review
          </button>
        ),
      },
    ],
    [sharedIdentityCols],
  )

  const reviewedColumns = useMemo<DataTableColumn<FeedbackItem>[]>(
    () => [
      ...sharedIdentityCols,
      {
        id: "response",
        header: "Review Comments",
        sortValue: (row) => (row.adminResponse ?? "").toLowerCase(),
        tdClassName: "feedback_desc_cell",
        cell: (row) => <NotesCell text={row.adminResponse} />,
      },
      {
        id: "reviewed",
        header: "Reviewed Date",
        sortValue: (row) => Date.parse(row.reviewedAt ?? "") || 0,
        cell: (row) => formatDateTime(row.reviewedAt),
      },
      {
        id: "reviewedBy",
        header: "Reviewed By",
        sortValue: (row) => (row.reviewedByName ?? "").toLowerCase(),
        cell: (row) => row.reviewedByName || "—",
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status,
        cell: (row) => <StatusCell status={row.status} />,
      },
      {
        id: "review",
        header: "Action",
        cell: (row) => (
          <button
            type="button"
            className="um_btn_primary feedback_review_btn"
            onClick={() => openReview(row)}
          >
            Resolve
          </button>
        ),
      },
    ],
    [sharedIdentityCols],
  )

  const resolvedColumns = useMemo<DataTableColumn<FeedbackItem>[]>(
    () => [
      ...sharedIdentityCols,
      {
        id: "response",
        header: "Review Comments",
        sortValue: (row) => (row.adminResponse ?? "").toLowerCase(),
        tdClassName: "feedback_desc_cell",
        cell: (row) => <NotesCell text={row.adminResponse} />,
      },
      {
        id: "reviewed",
        header: "Reviewed Date",
        sortValue: (row) => Date.parse(row.reviewedAt ?? "") || 0,
        cell: (row) => formatDateTime(row.reviewedAt),
      },
      {
        id: "reviewedBy",
        header: "Reviewed By",
        sortValue: (row) => (row.reviewedByName ?? "").toLowerCase(),
        cell: (row) => row.reviewedByName || "—",
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status,
        cell: (row) => <StatusCell status={row.status} />,
      },
      {
        id: "view",
        header: "View",
        cell: (row) => (
          <button
            type="button"
            className="um_btn_secondary feedback_review_btn"
            onClick={() => openView(row)}
          >
            <Eye size={14} aria-hidden />
            View
          </button>
        ),
      },
    ],
    [sharedIdentityCols],
  )

  const myColumns = useMemo<DataTableColumn<FeedbackItem>[]>(
    () => [
      serialNoColumn,
      {
        id: "page",
        header: "Page",
        sortValue: (row) => row.pageLabel.toLowerCase(),
        cell: (row) => row.pageLabel || "—",
      },
      {
        id: "subPage",
        header: "Sub Page / Tab",
        sortValue: (row) => row.subPageLabel.toLowerCase(),
        cell: (row) => row.subPageLabel || "—",
      },
      {
        id: "description",
        header: "Description",
        sortValue: (row) => row.description.toLowerCase(),
        tdClassName: "feedback_desc_cell",
        cell: (row) => (
          <span className="feedback_desc" title={row.description}>
            {row.description || "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        sortValue: (row) => row.status,
        cell: (row) => <StatusCell status={row.status} />,
      },
      {
        id: "submitted",
        header: "Submitted Date",
        sortValue: (row) => Date.parse(row.createdAt) || 0,
        cell: (row) => formatDateTime(row.createdAt),
      },
      {
        id: "response",
        header: "Review Comments",
        sortValue: (row) => (row.adminResponse ?? "").toLowerCase(),
        tdClassName: "feedback_desc_cell",
        cell: (row) => <NotesCell text={row.adminResponse} />,
      },
      {
        id: "actions",
        header: "Action",
        cell: (row) => {
          const canEdit =
            sponsorCanEditPending && row.status === "Pending"
          return (
            <div className="feedback_row_actions">
              {canEdit ? (
                <button
                  type="button"
                  className="um_btn_primary feedback_review_btn"
                  onClick={() => openEdit(row)}
                >
                  <Pencil size={14} aria-hidden />
                  Edit
                </button>
              ) : null}
              <button
                type="button"
                className="um_btn_secondary feedback_review_btn"
                onClick={() => openView(row)}
              >
                <Eye size={14} aria-hidden />
                View
              </button>
            </div>
          )
        },
      },
    ],
    [serialNoColumn, sponsorCanEditPending],
  )

  const pendingCount = statusCounts.Pending
  const reviewedCount = statusCounts.Reviewed
  const resolvedCount = statusCounts.Resolved

  /**
   * Export covers every submission, not just the loaded page, so it uses the
   * unpaginated form of the same endpoints.
   */
  const [exportList, setExportList] = useState<FeedbackItem[]>([])
  useEffect(() => {
    if (!exportOpen) return
    let cancelled = false
    void (async () => {
      const result = admin ? await fetchFeedbackList(tab) : await fetchMyFeedback()
      if (!cancelled && result.ok) setExportList(result.items)
    })()
    return () => {
      cancelled = true
    }
  }, [exportOpen, admin, tab])
  const exportDisabled = loading || table.total === 0

  const actions = (
    <div className="um_members_top_row_actions">
      <button
        type="button"
        className="um_toolbar_export_btn"
        onClick={() => setExportOpen(true)}
        disabled={exportDisabled}
      >
        <Download size={16} strokeWidth={2} aria-hidden />
        <span>Export All</span>
      </button>
      <button
        type="button"
        className="um_btn_primary"
        onClick={() => {
          setEditItem(null)
          setFormOpen(true)
        }}
      >
        <Plus size={16} aria-hidden />
        Submit Feedback
      </button>
    </div>
  )

  const adminColumns =
    tab === "Pending"
      ? pendingColumns
      : tab === "Reviewed"
        ? reviewedColumns
        : resolvedColumns

  return (
    <section className="um_page feedback_page" aria-label="Feedback">
      <div className="um_header_row">
        <h1 className="um_title um_title_with_icon">
          <MessageSquareText className="um_title_icon" size={22} aria-hidden />
          {admin ? "Feedback Management" : "Feedback"}
        </h1>
        {!admin ? actions : null}
      </div>

      {admin ? (
        <>
          <div className="um_members_top_row">
            <div className="um_members_tabs_outer deals_tabs_outer um_segmented_tabs_outer">
              <TabsScrollStrip scrollClassName="deals_tabs_scroll um_segmented_tabs_scroll">
                <div
                  className="um_members_tabs_row deals_tabs_row um_segmented_tabs_row"
                  role="tablist"
                  aria-label="Feedback status"
                >
                  <button
                    type="button"
                    id="feedback-tab-pending"
                    role="tab"
                    aria-selected={tab === "Pending"}
                    className={`um_members_tab deals_tabs_tab um_segmented_tab${
                      tab === "Pending" ? " um_members_tab_active" : ""
                    }`}
                    onClick={() => setTab("Pending")}
                  >
                    <ClipboardList
                      className="deals_tabs_icon um_segmented_tab_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span className="deals_tabs_label um_segmented_tab_label">
                      Pending
                    </span>
                    <span className="feedback_tab_count">{formatCount(pendingCount)}</span>
                  </button>
                  <button
                    type="button"
                    id="feedback-tab-reviewed"
                    role="tab"
                    aria-selected={tab === "Reviewed"}
                    className={`um_members_tab deals_tabs_tab um_segmented_tab${
                      tab === "Reviewed" ? " um_members_tab_active" : ""
                    }`}
                    onClick={() => setTab("Reviewed")}
                  >
                    <ClipboardList
                      className="deals_tabs_icon um_segmented_tab_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span className="deals_tabs_label um_segmented_tab_label">
                      Reviewed
                    </span>
                    <span className="feedback_tab_count">{formatCount(reviewedCount)}</span>
                  </button>
                  <button
                    type="button"
                    id="feedback-tab-resolved"
                    role="tab"
                    aria-selected={tab === "Resolved"}
                    className={`um_members_tab deals_tabs_tab um_segmented_tab${
                      tab === "Resolved" ? " um_members_tab_active" : ""
                    }`}
                    onClick={() => setTab("Resolved")}
                  >
                    <CheckCircle2
                      className="deals_tabs_icon um_segmented_tab_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span className="deals_tabs_label um_segmented_tab_label">
                      Resolved
                    </span>
                    <span className="feedback_tab_count">{formatCount(resolvedCount)}</span>
                  </button>
                </div>
              </TabsScrollStrip>
            </div>
            {actions}
          </div>
          <div className="um_members_tab_content" role="tabpanel">
            {error ? <p className="feedback_form_error">{error}</p> : null}
            <DataTable
              columns={adminColumns}
              rows={visible}
              getRowKey={(row) => row.id}
              emptyLabel={
                tab === "Pending"
                  ? "No pending feedback."
                  : tab === "Reviewed"
                    ? "No reviewed feedback yet."
                    : "No resolved feedback yet."
              }
              isLoading={loading}
              visualVariant="members"
              membersShell="plain"
              stripedRows
              controlledSort={{ value: table.sort, onChange: table.setSort }}
              pagination={table.total > 0 ? pagination : undefined}
            />
          </div>
        </>
      ) : (
        <>
          <p className="feedback_user_lead">
            Tell us about a page or tab that needs attention. You can edit a
            submission until a platform admin reviews or resolves it.
          </p>
          {error ? <p className="feedback_form_error">{error}</p> : null}
          <DataTable
            columns={myColumns}
            rows={visible}
            getRowKey={(row) => row.id}
            emptyLabel="You have not submitted feedback yet."
            isLoading={loading}
            visualVariant="members"
            membersShell="plain"
            stripedRows
            controlledSort={{ value: table.sort, onChange: table.setSort }}
            pagination={table.total > 0 ? pagination : undefined}
          />
        </>
      )}

      <FeedbackFormModal
        open={formOpen}
        initial={editItem}
        onClose={() => {
          setFormOpen(false)
          setEditItem(null)
        }}
        onSubmitted={() => {
          void load()
          notifyFeedbackPendingChanged()
        }}
      />
      <FeedbackDetailsModal
        open={activeItem != null}
        item={activeItem}
        mode={modalMode}
        onClose={closeDetails}
        onAction={(action, notes) => void handleAction(action, notes)}
      />
      <FeedbackPriorityModal
        open={priorityItem != null}
        item={priorityItem}
        submitting={prioritySaving}
        onClose={() => {
          if (prioritySaving) return
          setPriorityItem(null)
        }}
        onSave={(priority) => void handlePrioritySave(priority)}
      />
      <FeedbackTypeModal
        open={typeItem != null}
        item={typeItem}
        submitting={typeSaving}
        onClose={() => {
          if (typeSaving) return
          setTypeItem(null)
        }}
        onSave={(feedbackType) => void handleTypeSave(feedbackType)}
      />
      <ExportFeedbackModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        items={exportList}
        listKind={admin ? tab : "all"}
        showPriorityFilter={admin}
      />
    </section>
  )
}
