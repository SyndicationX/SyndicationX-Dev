import {
  Archive,
  ArchiveRestore,
  Download,
  Eye,
  Landmark,
  MoreHorizontal,
  Pencil,
  Play,
} from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "@/common/components/Toast"
import "@/modules/Syndication/usermanagement/user_management.css"

type RowEntityKind = "profile" | "beneficiary" | "address"

function labels(kind: RowEntityKind) {
  const noun =
    kind === "profile" ? "profile" : kind === "beneficiary" ? "beneficiary" : "address"
  return {
    viewTitle: `View ${noun}` as const,
    editTitle: `Edit ${noun}` as const,
    archiveTitle: `Archive ${noun}` as const,
    exportTitle: `Export ${noun}` as const,
  }
}

/**
 * Kebab (⋯) for Investing profiles tables: View, Edit, Archive, Export.
 * Pass `onView` / `onEdit` / `onExport` to run real actions; otherwise archive-only uses `onSetArchived`.
 */
export function InvestingProfilesRowActions({
  displayName,
  kind,
  archived: archivedProp = false,
  incompleteDraft = false,
  onSetArchived,
  onView,
  onEdit,
  onExport,
  onSetupPayouts,
}: {
  displayName: string
  kind: RowEntityKind
  archived?: boolean
  /** Incomplete add-profile or session draft — show Resume instead of Edit. */
  incompleteDraft?: boolean
  onSetArchived?: (archived: boolean) => void
  onView?: () => void
  onEdit?: () => void
  onExport?: () => void
  /** Opens Stripe-hosted bank onboarding for ACH distributions. */
  onSetupPayouts?: () => void
}) {
  const { viewTitle, editTitle, archiveTitle, exportTitle } = labels(kind)
  const resumeLabel = incompleteDraft ? "Resume" : editTitle
  const archived = Boolean(archivedProp)
  const canToggleArchive = Boolean(onSetArchived)
  const nameFallback =
    kind === "profile" ? "Profile" : kind === "beneficiary" ? "Beneficiary" : "Address"
  const nameForMsg = (displayName?.trim() || nameFallback).replace(/"/g, "”")
  const a11yLabel = nameForMsg
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const close = useCallback(() => setOpen(false), [])

  const apiHint = (action: string) =>
    `“${nameForMsg}” — connect API to ${action}.`

  const run = useCallback(
    (fn: () => void) => {
      close()
      fn()
    },
    [close],
  )

  useLayoutEffect(() => {
    if (!open) return

    function syncPosition() {
      const trigger = wrapRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const r = trigger.getBoundingClientRect()
      const mw = menu.offsetWidth || 200
      const mh = menu.offsetHeight || 200
      const gap = 6
      const vh = window.innerHeight
      const vw = window.innerWidth
      let top = r.bottom + gap
      if (top + mh > vh - gap) top = Math.max(gap, r.top - mh - gap)
      let left = r.right - mw
      left = Math.min(Math.max(gap, left), vw - mw - gap)
      menu.style.position = "fixed"
      menu.style.top = `${top}px`
      menu.style.left = `${left}px`
      menu.style.right = "auto"
      menu.style.zIndex = "11000"
    }

    syncPosition()
    const raf = requestAnimationFrame(syncPosition)
    const ro = new ResizeObserver(syncPosition)
    if (menuRef.current) ro.observe(menuRef.current)
    window.addEventListener("scroll", syncPosition, true)
    window.addEventListener("resize", syncPosition)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener("scroll", syncPosition, true)
      window.removeEventListener("resize", syncPosition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  return (
    <div
      className="um_kebab_root"
      ref={wrapRef}
      role="group"
      aria-label={`Actions for ${a11yLabel}`}
    >
      <button
        type="button"
        className="um_kebab_trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        aria-label={`Actions for ${a11yLabel}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal size={18} strokeWidth={2} aria-hidden />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <ul
              ref={menuRef}
              className="um_kebab_menu um_kebab_menu--portal"
              role="menu"
            >
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() =>
                    run(() => {
                      if (onView) onView()
                      else toast.success(viewTitle, apiHint("open details"))
                    })
                  }
                >
                  <Eye
                    className="um_kebab_menuitem_icon"
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                  />
                  View
                </button>
              </li>
              {kind === "profile" && onSetupPayouts ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem"
                    role="menuitem"
                    onClick={() => run(onSetupPayouts)}
                  >
                    <Landmark
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Set up ACH distributions
                  </button>
                </li>
              ) : null}
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() =>
                    run(() => {
                      if (onEdit) onEdit()
                      else toast.success(resumeLabel, apiHint("edit"))
                    })
                  }
                >
                  {incompleteDraft ? (
                    <Play
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                  ) : (
                    <Pencil
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                  )}
                  {resumeLabel}
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() =>
                    run(() => {
                      if (canToggleArchive && onSetArchived) {
                        const next = !archived
                        onSetArchived(next)
                        if (next) {
                          toast.success(archiveTitle, `“${nameForMsg}” is archived.`)
                        } else {
                          toast.success(
                            "Restored",
                            `“${nameForMsg}” is back in the active list.`,
                          )
                        }
                        return
                      }
                      toast.success(archiveTitle, apiHint("archive"))
                    })
                  }
                >
                  {archived && canToggleArchive ? (
                    <ArchiveRestore
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                  ) : (
                    <Archive
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                  )}
                  {archived && canToggleArchive ? "Restore" : "Archive"}
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  className="um_kebab_menuitem"
                  role="menuitem"
                  onClick={() =>
                    run(() => {
                      if (onExport) onExport()
                      else toast.success(exportTitle, apiHint("export"))
                    })
                  }
                >
                  <Download
                    className="um_kebab_menuitem_icon"
                    size={16}
                    strokeWidth={2}
                    aria-hidden
                  />
                  Export
                </button>
              </li>
            </ul>,
            document.body,
          )
        : null}
    </div>
  )
}
