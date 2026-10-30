import { Archive, ArchiveRestore, MoreHorizontal, Plus, Trash2, TrendingUp } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ConfirmDeleteModal } from "@/common/components/ConfirmDeleteModal"
import { toast } from "@/common/components/Toast"
import { MemberRemoveConfirmModal } from "@/modules/Syndication/usermanagement/MemberRemoveConfirmModal"
import "@/modules/Syndication/usermanagement/user_management.css"

type InvestmentProfileBreakdownRowActionsProps = {
  profileLabel: string
  /** When false, kebab stays visible but cannot open. */
  disabled?: boolean
  /** Shown on hover when the action cannot be used. */
  disabledReason?: string
  archived?: boolean
  onAddInvestment?: () => void
  onResumeInvesting?: () => void
  /** Soft-committed and invested profiles. Notifies the sponsor. */
  onArchive?: () => Promise<void>
  onRestore?: () => Promise<void>
  /** Soft-committed profiles only. Notifies the sponsor. */
  onDeleteProfile?: () => Promise<void>
}

/**
 * Kebab (⋯) for Profile and investment breakdown rows.
 * Add investment opens Invest now with this row’s profile selected.
 * Resume investing appears when that profile has an in-progress draft.
 */
export function InvestmentProfileBreakdownRowActions({
  profileLabel,
  disabled = false,
  disabledReason,
  archived = false,
  onAddInvestment,
  onResumeInvesting,
  onArchive,
  onRestore,
  onDeleteProfile,
}: InvestmentProfileBreakdownRowActionsProps) {
  const a11yLabel = (profileLabel?.trim() || "Profile").replace(/"/g, "”")
  const [open, setOpen] = useState(false)
  const [confirmKind, setConfirmKind] = useState<null | "archive" | "delete">(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useLayoutEffect(() => {
    if (
      !open ||
      disabled ||
      (!onResumeInvesting && !onAddInvestment && !onArchive && !onRestore && !onDeleteProfile)
    ) {
      return
    }

    function syncPosition() {
      const trigger = wrapRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const r = trigger.getBoundingClientRect()
      const mw = menu.offsetWidth || 200
      const mh = menu.offsetHeight || 80
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
  }, [open, disabled, onAddInvestment, onResumeInvesting, onArchive, onRestore, onDeleteProfile])

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

  const hasMenu = Boolean(
    onAddInvestment || onResumeInvesting || onArchive || onRestore || onDeleteProfile,
  )

  const runConfirmed = useCallback(async () => {
    const action = confirmKind === "delete" ? onDeleteProfile : onArchive
    if (!action) return
    setConfirmBusy(true)
    setDeleteError("")
    try {
      await action()
      setDeleteError("")
      setConfirmKind(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong."
      if (confirmKind === "delete") setDeleteError(message)
      toast.error(
        confirmKind === "delete" ? "Could not remove profile" : "Could not archive profile",
        message,
      )
    } finally {
      setConfirmBusy(false)
    }
  }, [confirmKind, onArchive, onDeleteProfile])
  const hoverReason = disabledReason?.trim() || ""
  const triggerTitle = hoverReason || "Actions"

  return (
    <div
      className="um_kebab_root"
      ref={wrapRef}
      role="group"
      aria-label={`Actions for ${a11yLabel}`}
    >
      <span
        className="um_kebab_trigger_hover"
        title={triggerTitle}
        style={disabled ? { display: "inline-flex" } : undefined}
      >
      <button
        type="button"
        className="um_kebab_trigger"
        aria-haspopup={disabled ? undefined : "menu"}
        aria-expanded={disabled ? undefined : open}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        title={triggerTitle}
        style={disabled ? { pointerEvents: "none" } : undefined}
        aria-label={
          hoverReason
            ? `${hoverReason} Actions for ${a11yLabel}`
            : `Actions for ${a11yLabel}`
        }
        onClick={(e) => {
          e.stopPropagation()
          if (disabled) return
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal size={18} strokeWidth={2} aria-hidden />
      </button>
      </span>
      {open && !disabled && hasMenu && typeof document !== "undefined"
        ? createPortal(
            <ul
              ref={menuRef}
              className="um_kebab_menu um_kebab_menu--portal"
              role="menu"
            >
              {onAddInvestment ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem"
                    role="menuitem"
                    onClick={() => {
                      close()
                      onAddInvestment()
                    }}
                  >
                    <Plus
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Add investment
                  </button>
                </li>
              ) : null}
              {onResumeInvesting ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem"
                    role="menuitem"
                    onClick={() => {
                      close()
                      onResumeInvesting()
                    }}
                  >
                    <TrendingUp
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Resume investing
                  </button>
                </li>
              ) : null}
              {archived && onRestore ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem"
                    role="menuitem"
                    onClick={() => {
                      close()
                      void onRestore().catch((err: unknown) => {
                        toast.error(
                          "Could not restore profile",
                          err instanceof Error ? err.message : "Something went wrong.",
                        )
                      })
                    }}
                  >
                    <ArchiveRestore
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Restore profile
                  </button>
                </li>
              ) : null}
              {!archived && onArchive ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem"
                    role="menuitem"
                    onClick={() => {
                      close()
                      setConfirmKind("archive")
                    }}
                  >
                    <Archive
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Archive profile
                  </button>
                </li>
              ) : null}
              {onDeleteProfile ? (
                <li role="none">
                  <button
                    type="button"
                    className="um_kebab_menuitem deals_kebab_menuitem_danger"
                    role="menuitem"
                    onClick={() => {
                      close()
                      setConfirmKind("delete")
                    }}
                  >
                    <Trash2
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Remove
                  </button>
                </li>
              ) : null}
            </ul>,
            document.body,
          )
        : null}
      <ConfirmDeleteModal
        open={confirmKind === "archive"}
        title="Archive this profile?"
        message={`Archive “${a11yLabel}” on this deal? The commitment comes off the deal until you restore the profile. The sponsor is notified.`}
        confirmLabel="Archive"
        busyLabel="Archiving…"
        busy={confirmBusy}
        onCancel={() => {
          if (!confirmBusy) setConfirmKind(null)
        }}
        onConfirm={() => void runConfirmed()}
      />
      {confirmKind === "delete" ? (
        <MemberRemoveConfirmModal
          memberName={a11yLabel}
          busy={confirmBusy}
          error={deleteError}
          submitLabel="Remove"
          busyLabel="Removing…"
          message={
            <>
              This will remove the soft commitment for <strong>{a11yLabel}</strong>.
              It is removed from the deal and the sponsor is notified.
            </>
          }
          onClose={() => {
            if (confirmBusy) return
            setDeleteError("")
            setConfirmKind(null)
          }}
          onConfirm={() => void runConfirmed()}
        />
      ) : null}
    </div>
  )
}
