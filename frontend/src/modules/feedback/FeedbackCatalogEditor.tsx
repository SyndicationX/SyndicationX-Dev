import { Loader2, Plus, Save, Trash2, X } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "@/common/components/Toast"
import { fetchFeedbackCatalog, saveFeedbackCatalog } from "./api/feedbackApi"
import type { FeedbackPageOption, FeedbackSubPageOption } from "./types"
import "./feedback.css"

function emptyPage(): FeedbackPageOption {
  return {
    pageKey: "",
    pageLabel: "",
    sortOrder: String(Date.now()),
    subPages: [{ key: "", label: "Overview" }],
  }
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
}

export function FeedbackCatalogEditor({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}) {
  const titleId = useId()
  const [pages, setPages] = useState<FeedbackPageOption[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      const result = await fetchFeedbackCatalog()
      if (cancelled) return
      if (result.ok) setPages(result.pages)
      else setError(result.message)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  if (!open || typeof document === "undefined") return null

  function updatePage(index: number, patch: Partial<FeedbackPageOption>) {
    setPages((prev) =>
      prev.map((page, i) => (i === index ? { ...page, ...patch } : page)),
    )
  }

  function updateTab(
    pageIndex: number,
    tabIndex: number,
    patch: Partial<FeedbackSubPageOption>,
  ) {
    setPages((prev) =>
      prev.map((page, i) => {
        if (i !== pageIndex) return page
        return {
          ...page,
          subPages: page.subPages.map((tab, j) =>
            j === tabIndex ? { ...tab, ...patch } : tab,
          ),
        }
      }),
    )
  }

  async function handleSave() {
    const cleaned = pages
      .map((page) => ({
        ...page,
        pageLabel: page.pageLabel.trim(),
        pageKey: page.pageKey.trim() || slug(page.pageLabel),
        subPages: page.subPages
          .map((tab) => ({
            key: tab.key.trim() || slug(tab.label),
            label: tab.label.trim(),
          }))
          .filter((tab) => tab.label),
      }))
      .filter((page) => page.pageLabel)
    if (cleaned.length === 0) {
      setError("Add at least one page.")
      return
    }
    if (cleaned.some((page) => page.subPages.length === 0)) {
      setError("Each page needs at least one sub page / tab.")
      return
    }
    setSaving(true)
    setError(null)
    const result = await saveFeedbackCatalog(cleaned)
    setSaving(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPages(result.pages)
    toast.success("Page options saved")
    onSaved?.()
    onClose()
  }

  return createPortal(
    <div
      className="um_modal_overlay contacts_suspend_overlay portal_modal_z_boost"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div
        className="um_modal feedback_catalog_modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="um_modal_head add_contact_modal_head">
          <div className="add_contact_modal_head_main">
            <h3 id={titleId} className="um_modal_title">
              Page / tab options
            </h3>
            <p className="feedback_catalog_lead">
              These options appear in the feedback form. Add or rename pages and
              sub pages without a code change.
            </p>
          </div>
          <button
            type="button"
            className="um_modal_close"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {error ? <p className="feedback_form_error">{error}</p> : null}
        {loading ? (
          <p className="feedback_empty">Loading page options…</p>
        ) : (
          <div className="feedback_catalog_list">
            {pages.map((page, pageIndex) => (
              <section key={`${page.pageKey}-${pageIndex}`} className="feedback_catalog_page">
                <div className="feedback_catalog_page_head">
                  <input
                    className="feedback_catalog_input"
                    value={page.pageLabel}
                    onChange={(e) =>
                      updatePage(pageIndex, { pageLabel: e.target.value })
                    }
                    placeholder="Page name"
                    aria-label={`Page ${pageIndex + 1} name`}
                  />
                  <button
                    type="button"
                    className="um_btn_secondary feedback_icon_btn"
                    onClick={() =>
                      setPages((prev) => prev.filter((_, i) => i !== pageIndex))
                    }
                    aria-label={`Remove ${page.pageLabel || "page"}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <ul className="feedback_catalog_tabs">
                  {page.subPages.map((tab, tabIndex) => (
                    <li key={`${tab.key}-${tabIndex}`}>
                      <input
                        className="feedback_catalog_input"
                        value={tab.label}
                        onChange={(e) =>
                          updateTab(pageIndex, tabIndex, {
                            label: e.target.value,
                          })
                        }
                        placeholder="Sub page / tab"
                        aria-label={`Sub page ${tabIndex + 1} for ${page.pageLabel || "page"}`}
                      />
                      <button
                        type="button"
                        className="um_btn_secondary feedback_icon_btn"
                        onClick={() =>
                          updatePage(pageIndex, {
                            subPages: page.subPages.filter((_, i) => i !== tabIndex),
                          })
                        }
                        aria-label="Remove tab"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="um_btn_secondary"
                  onClick={() =>
                    updatePage(pageIndex, {
                      subPages: [...page.subPages, { key: "", label: "" }],
                    })
                  }
                >
                  <Plus size={16} />
                  Add tab
                </button>
              </section>
            ))}
            <button
              type="button"
              className="um_btn_secondary"
              onClick={() => setPages((prev) => [...prev, emptyPage()])}
            >
              <Plus size={16} />
              Add page
            </button>
          </div>
        )}
        <div className="um_modal_actions add_contact_modal_actions">
          <button
            type="button"
            className="um_btn_secondary"
            onClick={onClose}
            disabled={saving}
          >
            <X size={16} />
            Cancel
          </button>
          <div className="add_contact_modal_actions_trailing">
            <button
              type="button"
              className="um_btn_primary"
              onClick={() => void handleSave()}
              disabled={saving || loading}
            >
              {saving ? (
                <Loader2 size={16} className="feedback_spin" />
              ) : (
                <Save size={16} />
              )}
              {saving ? "Saving…" : "Save options"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
