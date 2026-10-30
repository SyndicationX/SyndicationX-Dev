import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  channelsFromDocumentScope,
  documentVisibilitySummary,
  scopeFromDocumentChannels,
  type SectionSharedWithScope,
} from "../../utils/offeringPreviewDocSections"

type Props = {
  docName: string
  scope: SectionSharedWithScope
  disabled?: boolean
  onChange: (next: SectionSharedWithScope) => void
}

export function DocumentVisibilityPicker({
  docName,
  scope,
  disabled = false,
  onChange,
}: Props) {
  const reactId = useId()
  const idPrefix = `deal-doc-vis-${reactId.replace(/:/g, "")}`
  const triggerId = `${idPrefix}-trigger`
  const menuId = `${idPrefix}-menu`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [menuBox, setMenuBox] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
  } | null>(null)

  const channels = channelsFromDocumentScope(scope)
  const summary = documentVisibilitySummary(scope)

  const updateMenuBox = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(16 * 16, Math.max(r.width, 12.5 * 16), vw - 2 * margin)
    let left = r.left
    if (left + width > vw - margin) left = vw - margin - width
    if (left < margin) left = margin
    const gap = 4
    const spaceBelow = vh - r.bottom - margin
    const spaceAbove = r.top - margin
    const maxPanel = 16 * 16
    const openDown = spaceBelow >= Math.min(180, spaceAbove)
    const maxHeight = Math.max(
      140,
      Math.min(maxPanel, (openDown ? spaceBelow : spaceAbove) - gap),
    )
    const top = openDown
      ? r.bottom + gap
      : Math.max(margin, r.top - maxHeight - gap)
    setMenuBox((prev) => {
      if (
        prev &&
        prev.top === top &&
        prev.left === left &&
        prev.width === width &&
        prev.maxHeight === maxHeight
      ) {
        return prev
      }
      return { top, left, width, maxHeight }
    })
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuBox(null)
      return
    }
    updateMenuBox()
    function onResize() {
      updateMenuBox()
    }
    function onScroll(e: Event) {
      const t = e.target
      if (t instanceof Node && menuRef.current?.contains(t)) return
      updateMenuBox()
    }
    window.addEventListener("resize", onResize)
    document.addEventListener("scroll", onScroll, true)
    return () => {
      window.removeEventListener("resize", onResize)
      document.removeEventListener("scroll", onScroll, true)
    }
  }, [isOpen, updateMenuBox])

  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false)
    }
    function eventPathContainsMenuOrTrigger(e: Event): boolean {
      const path = typeof e.composedPath === "function" ? e.composedPath() : []
      for (const node of path) {
        if (node === triggerRef.current || node === menuRef.current) return true
      }
      const t = e.target
      if (!(t instanceof Node)) return false
      if (triggerRef.current?.contains(t)) return true
      if (menuRef.current?.contains(t)) return true
      return false
    }
    function onPointerDown(e: PointerEvent) {
      if (eventPathContainsMenuOrTrigger(e)) return
      setIsOpen(false)
    }
    const timer = window.setTimeout(() => {
      document.addEventListener("keydown", onKeyDown)
      document.addEventListener("pointerdown", onPointerDown, true)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [isOpen])

  function commit(next: SectionSharedWithScope) {
    if (next === scope) return
    setIsOpen(false)
    onChange(next)
  }

  function onHiddenChange(checked: boolean) {
    if (!checked) return
    commit("not_visible")
  }

  function onOfferingChange(checked: boolean) {
    commit(
      scopeFromDocumentChannels({
        offeringLink: checked,
        lpPortal: channels.lpPortal,
      }),
    )
  }

  function onLpPortalChange(checked: boolean) {
    commit(
      scopeFromDocumentChannels({
        offeringLink: channels.offeringLink,
        lpPortal: checked,
      }),
    )
  }

  return (
    <div
      className={`deal_docs_shared_with_root${isOpen ? " deal_docs_shared_with_root_open" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        className="deal_docs_shared_with_summary"
        title={summary}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={menuId}
        aria-label={`Visibility for ${docName}. ${summary}. ${isOpen ? "Close" : "Open"} to change.`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (disabled) return
          setIsOpen((open) => !open)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="deal_docs_shared_with_summary_text">{summary}</span>
      </button>
      {isOpen && menuBox
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="deal_docs_shared_with_menu deal_docs_shared_with_menu_portal"
              role="dialog"
              aria-label={`Visibility for ${docName}`}
              style={{
                position: "fixed",
                top: menuBox.top,
                left: menuBox.left,
                width: menuBox.width,
                maxHeight: menuBox.maxHeight,
                zIndex: 13000,
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="deal_docs_shared_with_menu_top">
                <span className="deal_docs_shared_with_menu_top_label">Visibility</span>
              </div>
              <div className="deal_docs_shared_with_menu_scroll">
                <ul className="deal_docs_shared_with_menu_list">
                  <li>
                    <label
                      className="deal_docs_shared_with_menu_row"
                      htmlFor={`${idPrefix}-hidden`}
                    >
                      <input
                        id={`${idPrefix}-hidden`}
                        type="checkbox"
                        checked={channels.hidden}
                        onChange={(e) => onHiddenChange(e.target.checked)}
                      />
                      <span>Hidden by default</span>
                    </label>
                  </li>
                  <li>
                    <label
                      className="deal_docs_shared_with_menu_row"
                      htmlFor={`${idPrefix}-offering`}
                    >
                      <input
                        id={`${idPrefix}-offering`}
                        type="checkbox"
                        checked={channels.offeringLink}
                        onChange={(e) => onOfferingChange(e.target.checked)}
                      />
                      <span>Offering link</span>
                    </label>
                  </li>
                  <li>
                    <label
                      className="deal_docs_shared_with_menu_row"
                      htmlFor={`${idPrefix}-lp`}
                    >
                      <input
                        id={`${idPrefix}-lp`}
                        type="checkbox"
                        checked={channels.lpPortal}
                        onChange={(e) => onLpPortalChange(e.target.checked)}
                      />
                      <span>LP portal</span>
                    </label>
                  </li>
                </ul>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
