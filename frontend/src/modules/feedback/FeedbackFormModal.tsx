import {
  FileText,
  LayoutGrid,
  List,
  Loader2,
  MessageSquareText,
  Pencil,
  Send,
  X,
} from "lucide-react"
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import { createPortal } from "react-dom"
import { DropdownSelect } from "@/common/components/dropdown-select/DropdownSelect"
import { toast } from "@/common/components/Toast"
import {
  fetchFeedbackCatalog,
  notifyFeedbackPendingChanged,
  submitFeedback,
  updateFeedback,
} from "./api/feedbackApi"
import {
  type FeedbackItem,
  type FeedbackPageOption,
} from "./types"
import "./feedback.css"

const OTHER_SUB_PAGE_KEY = "other"
const OTHER_LABEL_PREFIX = "Other — "

function otherSubPageFromItem(item: FeedbackItem | null | undefined): string {
  if (!item || item.subPageKey !== OTHER_SUB_PAGE_KEY) return ""
  const label = item.subPageLabel.trim()
  if (label.startsWith(OTHER_LABEL_PREFIX)) {
    return label.slice(OTHER_LABEL_PREFIX.length).trim()
  }
  return ""
}

export function FeedbackFormModal({
  open,
  onClose,
  onSubmitted,
  initial = null,
}: {
  open: boolean
  onClose: () => void
  onSubmitted?: () => void
  initial?: FeedbackItem | null
}) {
  const titleId = useId()
  const [pages, setPages] = useState<FeedbackPageOption[]>([])
  const [pageKey, setPageKey] = useState("")
  const [subPageKey, setSubPageKey] = useState("")
  const [subPageOther, setSubPageOther] = useState("")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      const result = await fetchFeedbackCatalog()
      if (cancelled) return
      if (result.ok) {
        setPages(result.pages)
        setPageKey((prev) => prev || result.pages[0]?.pageKey || "")
      } else {
        setError(result.message)
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setPageKey("")
      setSubPageKey("")
      setSubPageOther("")
      setDescription("")
      setError(null)
      setSubmitting(false)
      return
    }
    if (initial) {
      setPageKey(initial.pageKey)
      setSubPageKey(initial.subPageKey)
      setSubPageOther(otherSubPageFromItem(initial))
      setDescription(initial.description)
    }
  }, [open, initial])

  const selectedPage = useMemo(
    () => pages.find((p) => p.pageKey === pageKey) ?? null,
    [pages, pageKey],
  )

  useEffect(() => {
    if (!selectedPage) return
    setSubPageKey((prev) =>
      prev === OTHER_SUB_PAGE_KEY ||
      selectedPage.subPages.some((s) => s.key === prev)
        ? prev
        : selectedPage.subPages[0]?.key ?? OTHER_SUB_PAGE_KEY,
    )
  }, [selectedPage])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !submitting) onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, submitting, onClose])

  if (!open || typeof document === "undefined") return null

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!pageKey) {
      setError("Select a page.")
      return
    }
    if (!subPageKey) {
      setError("Select a sub page / tab.")
      return
    }
    if (subPageKey === OTHER_SUB_PAGE_KEY && !subPageOther.trim()) {
      setError("Enter the sub page / tab name.")
      return
    }
    if (!description.trim()) {
      setError("Enter a description.")
      return
    }
    setSubmitting(true)
    setError(null)
    const payload = {
      pageKey,
      subPageKey,
      subPageOther:
        subPageKey === OTHER_SUB_PAGE_KEY ? subPageOther.trim() : undefined,
      description: description.trim(),
    }
    const editingId = initial?.id?.trim() ?? ""
    const result = editingId
      ? await updateFeedback(editingId, payload)
      : await submitFeedback(payload)
    setSubmitting(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    toast.success(
      editingId ? "Feedback updated" : "Feedback submitted",
      editingId
        ? "Your changes were saved."
        : "Thank you — we will review it shortly.",
    )
    notifyFeedbackPendingChanged()
    onSubmitted?.()
    onClose()
  }

  return createPortal(
    <div
      className="um_modal_overlay contacts_suspend_overlay portal_modal_z_boost"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose()
      }}
    >
      <div
        className="um_modal feedback_form_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="um_modal_head add_contact_modal_head">
          <div className="add_contact_modal_head_main">
            <h3 id={titleId} className="um_modal_title um_title_with_icon">
              <MessageSquareText size={20} aria-hidden />
              {initial ? "Edit feedback" : "Submit feedback"}
            </h3>
          </div>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <form className="feedback_form" onSubmit={(e) => void handleSubmit(e)}>
          {error ? <p className="feedback_form_error">{error}</p> : null}
          <label className="feedback_field">
            <span className="feedback_field_label">
              <LayoutGrid
                className="um_field_label_icon"
                size={17}
                strokeWidth={2}
                aria-hidden
              />
              <span>Page</span>
            </span>
            <DropdownSelect
              ariaLabel="Page"
              value={pageKey}
              onChange={setPageKey}
              disabled={loading || submitting || pages.length === 0}
              placeholder={loading ? "Loading pages…" : "Select a page"}
              useFixedPanel
              options={pages.map((p) => ({
                value: p.pageKey,
                label: p.pageLabel,
              }))}
            />
          </label>
          <label className="feedback_field">
            <span className="feedback_field_label">
              <List
                className="um_field_label_icon"
                size={17}
                strokeWidth={2}
                aria-hidden
              />
              <span>Sub Page / Tab</span>
            </span>
            <DropdownSelect
              ariaLabel="Sub Page / Tab"
              value={subPageKey}
              useFixedPanel
              onChange={setSubPageKey}
              disabled={loading || submitting || !selectedPage}
              placeholder="Select a sub page / tab"
              options={[
                ...(selectedPage?.subPages ?? [])
                  .filter((s) => s.key !== OTHER_SUB_PAGE_KEY)
                  .map((s) => ({
                    value: s.key,
                    label: s.label,
                  })),
                { value: OTHER_SUB_PAGE_KEY, label: "Other" },
              ]}
            />
          </label>
          {subPageKey === OTHER_SUB_PAGE_KEY ? (
            <label className="feedback_field">
              <span className="feedback_field_label">
                <Pencil
                  className="um_field_label_icon"
                  size={17}
                  strokeWidth={2}
                  aria-hidden
                />
                <span>Other sub page / tab</span>
              </span>
              <input
                className="feedback_other_input"
                type="text"
                value={subPageOther}
                onChange={(e) => setSubPageOther(e.target.value)}
                maxLength={200}
                disabled={submitting}
                placeholder="Type the page or tab that is not listed"
              />
            </label>
          ) : null}
          <label className="feedback_field">
            <span className="feedback_field_label">
              <FileText
                className="um_field_label_icon"
                size={17}
                strokeWidth={2}
                aria-hidden
              />
              <span>Description</span>
            </span>
            <textarea
              className="feedback_textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              maxLength={8000}
              disabled={submitting}
              placeholder="Describe the issue, idea, or improvement…"
            />
          </label>
          <div className="um_modal_actions add_contact_modal_actions">
            <button
              type="button"
              className="um_btn_secondary"
              onClick={onClose}
              disabled={submitting}
            >
              <X size={16} aria-hidden />
              Cancel
            </button>
            <div className="add_contact_modal_actions_trailing">
              <button
                type="submit"
                className="um_btn_primary"
                disabled={submitting || loading}
              >
                {submitting ? (
                  <Loader2 size={16} className="feedback_spin" aria-hidden />
                ) : (
                  <Send size={16} aria-hidden />
                )}
                {submitting
                  ? initial
                    ? "Saving…"
                    : "Submitting…"
                  : initial
                    ? "Save changes"
                    : "Submit Feedback"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
