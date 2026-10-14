import { Download, Flag, Search, X } from "lucide-react"
import { DropdownSelect } from "@/common/components/dropdown-select/DropdownSelect"
import { ExportModalFooter } from "@/common/components/modal/ExportModalFooter"
import { toast } from "@/common/components/Toast"
import { buildTableExportFilename } from "@/common/utils/tableExportFilename"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "../Syndication/Deals/components/export-deals-modal.css"
import "./feedback.css"
import {
  buildFeedbackCsv,
  downloadFeedbackCsv,
  feedbackExportLabel,
} from "./feedbackCsv"
import {
  FEEDBACK_PRIORITY_OPTIONS,
  feedbackPriorityLabel,
  feedbackUserRoleLabel,
  type FeedbackItem,
  type FeedbackPriority,
  type FeedbackStatus,
} from "./types"

type PriorityFilter = "all" | FeedbackPriority | "unset"

const PRIORITY_FILTER_OPTIONS: { value: PriorityFilter; label: string }[] = [
  { value: "all", label: "All priorities" },
  ...FEEDBACK_PRIORITY_OPTIONS,
  { value: "unset", label: "No priority" },
]

function matchesPriorityFilter(
  row: FeedbackItem,
  filter: PriorityFilter,
): boolean {
  if (filter === "all") return true
  if (filter === "unset") return !row.priority
  return row.priority === filter
}

interface ExportFeedbackModalProps {
  open: boolean
  onClose: () => void
  items: FeedbackItem[]
  listKind?: FeedbackStatus | "all"
  /** Platform admin can triage by P0–P3; hide for submitters. */
  showPriorityFilter?: boolean
}

export function ExportFeedbackModal({
  open,
  onClose,
  items,
  listKind = "all",
  showPriorityFilter = false,
}: ExportFeedbackModalProps) {
  const [modalQuery, setModalQuery] = useState("")
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setModalQuery("")
    setPriorityFilter("all")
    setSelectedIds(new Set(items.map((r) => r.id)))
  }, [open, items, listKind])

  const scopedItems = useMemo(
    () => items.filter((r) => matchesPriorityFilter(r, priorityFilter)),
    [items, priorityFilter],
  )

  const visibleItems = useMemo(() => {
    const q = modalQuery.trim().toLowerCase()
    let list = [...scopedItems]
    if (q) {
      list = list.filter((r) => {
        const blob = [
          r.username,
          r.userEmail,
          r.userRole ?? "",
          feedbackUserRoleLabel(r.userRole),
          r.pageLabel,
          r.subPageLabel,
          r.description,
          r.status,
          r.priority ?? "",
          feedbackPriorityLabel(r.priority),
          r.feedbackType ?? "",
          r.adminResponse ?? "",
          r.reviewedByName ?? "",
        ]
          .join(" ")
          .toLowerCase()
        return blob.includes(q)
      })
    }
    list.sort((a, b) => feedbackExportLabel(a).localeCompare(feedbackExportLabel(b)))
    return list
  }, [scopedItems, modalQuery])

  const visibleIds = useMemo(
    () => visibleItems.map((r) => r.id),
    [visibleItems],
  )

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id))

  useEffect(() => {
    const el = selectAllRef.current
    if (!el) return
    el.indeterminate = someVisibleSelected && !allVisibleSelected
  }, [someVisibleSelected, allVisibleSelected])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLInputElement>("input[type='search']")
        ?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected)
        for (const id of visibleIds) next.delete(id)
      else for (const id of visibleIds) next.add(id)
      return next
    })
  }, [allVisibleSelected, visibleIds])

  function applyPriorityFilter(next: PriorityFilter) {
    setPriorityFilter(next)
    const nextPool = items.filter((r) => matchesPriorityFilter(r, next))
    setSelectedIds(new Set(nextPool.map((r) => r.id)))
  }

  function handleExportExcel() {
    const chosen = scopedItems.filter((r) => selectedIds.has(r.id))
    if (chosen.length === 0) return
    const csv = buildFeedbackCsv(chosen)
    const statusSlug =
      listKind === "Pending"
        ? "feedback-pending"
        : listKind === "Reviewed"
          ? "feedback-reviewed"
          : listKind === "Resolved"
            ? "feedback-resolved"
            : "feedback"
    const prioritySlug =
      priorityFilter === "all"
        ? ""
        : priorityFilter === "unset"
          ? "-unprioritized"
          : `-${priorityFilter.toLowerCase()}`
    const filename = buildTableExportFilename({
      tableSlug: `${statusSlug}${prioritySlug}`,
      includeDateStamp: true,
    })
    downloadFeedbackCsv(csv, filename)
    toast.success("Feedback exported", `Saved as ${filename}`)
    onClose()
  }

  if (!open) return null

  const title =
    listKind === "Pending"
      ? "Export pending feedback"
      : listKind === "Reviewed"
        ? "Export reviewed feedback"
        : listKind === "Resolved"
          ? "Export resolved feedback"
          : "Export feedback"

  return (
    <div className="deals_export_modal_overlay" role="presentation">
      <div
        ref={panelRef}
        className="deals_export_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-export-modal-title"
      >
        <header className="deals_export_modal_head">
          <h2
            id="feedback-export-modal-title"
            className="deals_export_modal_title"
          >
            {title}
          </h2>
          <button
            type="button"
            className="deals_export_modal_close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <p className="deals_export_modal_hint">
          {showPriorityFilter
            ? "Filter by priority, search and select feedback, then export to Excel (CSV format)."
            : "Search and select feedback, then export to Excel (CSV format)."}
        </p>

        {showPriorityFilter ? (
          <div
            className="deals_export_modal_filters"
            role="group"
            aria-label="Feedback export filters"
          >
            <div className="deals_export_modal_filter_field">
              <label
                className="deals_export_modal_filter_label"
                htmlFor="feedback-export-priority-filter"
              >
                <Flag size={14} strokeWidth={2} aria-hidden />
                Priority
              </label>
              <DropdownSelect
                id="feedback-export-priority-filter"
                className="deals_export_modal_filter_dropdown"
                triggerClassName="deals_export_modal_filter_select"
                ariaLabel="Filter export by priority"
                value={priorityFilter}
                onChange={(next) => applyPriorityFilter(next as PriorityFilter)}
                useFixedPanel
                options={PRIORITY_FILTER_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                }))}
              />
            </div>
          </div>
        ) : null}

        <div className="deals_export_modal_search">
          <input
            type="search"
            className="deals_export_modal_search_input"
            placeholder="Search feedback…"
            value={modalQuery}
            onChange={(e) => setModalQuery(e.target.value)}
            aria-label="Search feedback in export list"
          />
          <Search
            className="deals_export_modal_search_icon"
            size={18}
            strokeWidth={2}
            aria-hidden
          />
        </div>

        <label className="deals_export_modal_select_all">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleSelectAllVisible}
            aria-label={`Select all ${visibleItems.length} feedback item${visibleItems.length === 1 ? "" : "s"} shown`}
          />
          <span>
            Select all
            {visibleItems.length !== scopedItems.length ||
            scopedItems.length !== items.length ? (
              <span className="deals_export_modal_select_all_meta">
                {" "}
                ({visibleItems.length} shown)
              </span>
            ) : null}
          </span>
        </label>

        <ul className="deals_export_modal_list" aria-label="Feedback to export">
          {visibleItems.length === 0 ? (
            <li className="deals_export_modal_empty">
              {priorityFilter !== "all" && scopedItems.length === 0
                ? "No feedback matches this priority."
                : "No feedback matches your search."}
            </li>
          ) : (
            visibleItems.map((row) => (
              <li key={row.id} className="deals_export_modal_row">
                <label className="deals_export_modal_row_label">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleId(row.id)}
                    aria-label={`Select ${feedbackExportLabel(row)}`}
                  />
                  <span className="deals_export_modal_row_name">
                    {feedbackExportLabel(row)}
                  </span>
                  <span className="deals_export_modal_row_meta feedback_export_row_meta">
                    {row.priority ? (
                      <span
                        className={`feedback_priority feedback_priority_${row.priority.toLowerCase()}`}
                      >
                        {feedbackPriorityLabel(row.priority)}
                      </span>
                    ) : null}
                    {row.feedbackType ? <span>{row.feedbackType}</span> : null}
                    <span>{row.status}</span>
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>

        <ExportModalFooter onClose={onClose}>
          <button
            type="button"
            className="um_btn_primary"
            onClick={handleExportExcel}
            disabled={
              scopedItems.filter((r) => selectedIds.has(r.id)).length === 0
            }
          >
            <Download size={16} strokeWidth={2} aria-hidden />
            Export to Excel
          </button>
        </ExportModalFooter>
      </div>
    </div>
  )
}
