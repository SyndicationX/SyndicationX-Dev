import {
  Calendar,
  Banknote,
  Eye,
  FileSignature,
  Info,
  Link2,
  Loader2,
  Mail,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  UserMinus,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { isLeadSponsorRole } from "../../../constants/investor-profile"
import type { DealInvestorRow } from "../../../types/deal-investors.types"

export const LEAD_SPONSOR_REQUIRED_MESSAGE =
  "At least one lead sponsor should be present in the deal"
import {
  investorEsignIsFullyCompletedForRow,
  investorEsignWasSent,
} from "../../../utils/investorEsignStatus"
import { MemberRemoveConfirmModal } from "../../../../usermanagement/MemberRemoveConfirmModal"
import {
  InvestorRemovalConfirmModal,
  type InvestorRemovalAction,
} from "./InvestorRemovalConfirmModal"
import "../../../../usermanagement/user_management.css"
import "../../../components/open-investment-esign-required-modal.css"
import "./deal-member-row-actions.css"

/** Menu-sized variant of the add/edit modal’s “notify the member” hint. */
export const INVITATION_EMAILS_BLOCKED_ACTION_TITLE =
  "Invitation emails are unavailable while the deal is in draft or required deal details are incomplete."

export interface DealMemberRowActionsProps {
  row: DealInvestorRow
  /** Open read-only details (parent may refetch roster first). */
  onView?: (row: DealInvestorRow) => void | Promise<void>
  onEdit: (row: DealInvestorRow) => void
  onCopyLink: (row: DealInvestorRow) => void
  /** Investors tab only: send eSign packet to this row’s email. */
  onSendEsign?: (row: DealInvestorRow) => void | Promise<void>
  /** When true, Send E-sign is shown but not clickable (e.g. no templates uploaded yet). */
  sendEsignDisabled?: boolean
  sendEsignDisabledTitle?: string
  onSendInvite: (row: DealInvestorRow) => void
  /** Return a promise so the confirm dialog can show a loading state until the API finishes. */
  onDelete: (
    row: DealInvestorRow,
    removal?: { action: InvestorRemovalAction; reason: string },
  ) => void | Promise<void>
  /** If true (default), opens the portal confirm dialog before calling `onDelete`. */
  confirmBeforeDelete?: boolean
  /**
   * Who is being removed. Investor and team member use the typed REMOVE dialog.
   * General Partner rows keep the existing member confirmation.
   */
  removalSubject?: "member" | "investor" | "team_member"
  /** General Partners: same confirm dialog as removing an organization member. */
  orgStyleRemoveConfirm?: boolean
  /** Session draft row: first menu item is "Continue editing" (opens add-member flow). */
  draftRow?: boolean
  /** Disable Edit while keeping the rest of the row actions available. */
  editDisabled?: boolean
  editDisabledTitle?: string
  /** When true, the mail action label becomes “Re-send invitation mail”. */
  invitationMailSent?: boolean
  /** True while this row’s invitation email request is in flight. */
  invitationMailSending?: boolean
  /**
   * Deal lifecycle blocks invitation emails (draft stage or incomplete deal details) —
   * same rule the add/edit modal uses to lock its “notify the member” choice to No.
   */
  invitationMailBlocked?: boolean
  /**
   * When false, “Copy offering link” is disabled (e.g. visibility is not “Only visible with link”).
   */
  offeringLinkAvailable?: boolean
  /** Deal lifecycle blocks offering preview link copy (e.g. Draft or Liquidated). */
  offeringLinkBlockedBecauseDraft?: boolean
  /** Investors tab: advance investment to “funding instructions sent” (optional). */
  onApproveFund?: (row: DealInvestorRow) => void | Promise<void>
  /** Investors tab: change the funded date after the fund is approved. */
  onEditFundedDate?: (row: DealInvestorRow) => void
  /** When true, “Approve fund” is disabled (e.g. LP-only roster row or busy). */
  approveFundDisabled?: boolean
  /** True while this row’s approve-fund request is in flight. */
  approveFundBusy?: boolean
  /** Optional tooltip when Approve fund is disabled. */
  approveFundDisabledTitle?: string
  /** Open the row for reading only. Hides edit, invite, eSign, and delete. */
  viewOnly?: boolean
  /** Lead and admin sponsors cannot remove a co-sponsor's investor. */
  removeHidden?: boolean
  /**
   * Lead and admin sponsors may only view a co-sponsor's investor.
   * Other menu items stay visible and disabled.
   */
  actionsLimitedToView?: boolean
  actionsLimitedToViewTitle?: string
}

export function DealMemberRowActions({
  row,
  onView,
  onEdit,
  onCopyLink,
  onSendEsign,
  sendEsignDisabled = false,
  sendEsignDisabledTitle,
  onSendInvite,
  onDelete,
  confirmBeforeDelete = true,
  removalSubject = "member",
  orgStyleRemoveConfirm = false,
  draftRow = false,
  editDisabled = false,
  editDisabledTitle,
  invitationMailSent = false,
  invitationMailSending = false,
  invitationMailBlocked = false,
  offeringLinkAvailable = false,
  offeringLinkBlockedBecauseDraft = false,
  onApproveFund,
  onEditFundedDate,
  approveFundDisabled = false,
  approveFundBusy = false,
  approveFundDisabledTitle,
  viewOnly = false,
  removeHidden = false,
  actionsLimitedToView = false,
  actionsLimitedToViewTitle = "This investor was added by a co-sponsor. Only view is available.",
}: DealMemberRowActionsProps) {
  const esignWasSent = investorEsignWasSent(row)
  const esignCompleted = investorEsignIsFullyCompletedForRow(row)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [leadSponsorBlockedOpen, setLeadSponsorBlockedOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const deleteTitleId = useId()
  const leadSponsorBlockedTitleId = useId()
  const deletingLeadSponsor =
    !draftRow && isLeadSponsorRole(row.investorRole)

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  const memberLabel = row.displayName?.trim() || "member"
  const useInvestorChoiceModal = removalSubject === "investor" && !draftRow
  const isTypedRemoval =
    removalSubject === "team_member" ||
    (removalSubject === "investor" && draftRow)

  useLayoutEffect(() => {
    if (!menuOpen) return

    function syncPosition() {
      const trigger = wrapRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const r = trigger.getBoundingClientRect()
      const mw = menu.offsetWidth || 200
      const mh = menu.offsetHeight || 120
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
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      closeMenu()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeMenu()
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [menuOpen, closeMenu])

  useEffect(() => {
    if (!deleteConfirmOpen && !leadSponsorBlockedOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || deleteBusy) return
      setDeleteConfirmOpen(false)
      setLeadSponsorBlockedOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [deleteConfirmOpen, leadSponsorBlockedOpen, deleteBusy])

  async function runDelete() {
    if (deletingLeadSponsor) {
      setLeadSponsorBlockedOpen(true)
      closeMenu()
      return
    }
    if (confirmBeforeDelete) {
      setDeleteError("")
      setDeleteConfirmOpen(true)
      closeMenu()
      return
    }
    setDeleteBusy(true)
    try {
      await Promise.resolve(onDelete(row))
    } finally {
      setDeleteBusy(false)
    }
    closeMenu()
  }

  async function confirmDelete() {
    setDeleteBusy(true)
    try {
      await Promise.resolve(onDelete(row))
    } finally {
      setDeleteBusy(false)
      setDeleteConfirmOpen(false)
    }
  }

  async function confirmInvestorRemoval(removal: {
    action: InvestorRemovalAction
    reason: string
  }) {
    setDeleteBusy(true)
    setDeleteError("")
    try {
      await Promise.resolve(onDelete(row, removal))
      setDeleteConfirmOpen(false)
    } catch (err) {
      setDeleteError(
        err instanceof Error && err.message
          ? err.message
          : "Could not remove this record.",
      )
    } finally {
      setDeleteBusy(false)
    }
  }

  function runMenuAction(fn: () => void) {
    fn()
    closeMenu()
  }

  async function runView() {
    if (!onView) return
    closeMenu()
    await Promise.resolve(onView(row))
  }

  const leadSponsorBlockedModal =
    leadSponsorBlockedOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="open_inv_esign_modal_overlay portal_modal_z_boost"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setLeadSponsorBlockedOpen(false)
            }}
          >
            <div
              className="open_inv_esign_modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={leadSponsorBlockedTitleId}
              onClick={(e) => e.stopPropagation()}
            >
              <header className="open_inv_esign_modal_head">
                <span
                  className="open_inv_esign_modal_icon open_inv_esign_modal_icon--info"
                  aria-hidden
                >
                  <Info size={22} strokeWidth={2} />
                </span>
                <div className="open_inv_esign_modal_head_text">
                  <h2
                    id={leadSponsorBlockedTitleId}
                    className="open_inv_esign_modal_title"
                  >
                    Cannot remove Lead Sponsor
                  </h2>
                </div>
                <button
                  type="button"
                  className="open_inv_esign_modal_close"
                  onClick={() => setLeadSponsorBlockedOpen(false)}
                  aria-label="Close"
                >
                  <X size={20} strokeWidth={2} aria-hidden />
                </button>
              </header>
              <div className="open_inv_esign_modal_body">
                <p className="open_inv_esign_modal_message">
                  {LEAD_SPONSOR_REQUIRED_MESSAGE}
                </p>
              </div>
              <footer className="open_inv_esign_modal_actions">
                <button
                  type="button"
                  className="open_inv_esign_modal_btn open_inv_esign_modal_btn--primary"
                  onClick={() => setLeadSponsorBlockedOpen(false)}
                >
                  <X size={16} strokeWidth={2} aria-hidden />
                  Close
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )
      : null

  const deleteModal =
    useInvestorChoiceModal && deleteConfirmOpen ? (
      <InvestorRemovalConfirmModal
        investorName={memberLabel}
        busy={deleteBusy}
        error={deleteError}
        onClose={() => {
          if (deleteBusy) return
          setDeleteConfirmOpen(false)
        }}
        onConfirm={(removal) => void confirmInvestorRemoval(removal)}
      />
    ) : (orgStyleRemoveConfirm || isTypedRemoval) && deleteConfirmOpen ? (
      <MemberRemoveConfirmModal
        memberName={memberLabel}
        busy={deleteBusy}
        error=""
        submitLabel="Remove"
        message={
          removalSubject === "team_member" ? (
            <>
              This will remove <strong>{memberLabel}</strong> from the team
              members on this deal. Other roles, investments, and the contact
              record stay in place.
            </>
          ) : removalSubject === "investor" ? (
            <>
              This will remove <strong>{memberLabel}</strong>&apos;s investment.
            </>
          ) : (
            <>
              This will remove <strong>{memberLabel}</strong> from this deal.
              They will leave General Partners.
            </>
          )
        }
        onClose={() => {
          if (deleteBusy) return
          setDeleteConfirmOpen(false)
        }}
        onConfirm={() => void confirmDelete()}
      />
    ) : deleteConfirmOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost deal_member_delete_overlay"
            role="presentation"
          >
            <div
              className="um_modal um_modal_view deals_add_inv_modal_panel deals_suspend_all_modal_panel deal_member_delete_modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={deleteTitleId}
            >
              <div className="um_modal_head">
                <h3 id={deleteTitleId} className="um_modal_title">
                  Remove member from deal?
                </h3>
                <button
                  type="button"
                  className="um_modal_close"
                  onClick={() => !deleteBusy && setDeleteConfirmOpen(false)}
                  disabled={deleteBusy}
                  aria-label="Close"
                >
                  <X size={20} strokeWidth={2} aria-hidden />
                </button>
              </div>
              <div className="deals_suspend_all_modal_body">
                <p className="deals_suspend_all_modal_message">
                  Remove &quot;{memberLabel}&quot; from this deal? This cannot be
                  undone.
                </p>
              </div>
              <div className="um_modal_actions add_contact_modal_actions">
                <button
                  type="button"
                  className="um_btn_secondary"
                  onClick={() => setDeleteConfirmOpen(false)}
                  disabled={deleteBusy}
                >
                  <X size={16} strokeWidth={2} aria-hidden />
                  Close
                </button>
                <button
                  type="button"
                  className="um_btn_primary deal_member_delete_confirm_btn"
                  onClick={() => void confirmDelete()}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? (
                    <>
                      <Loader2
                        size={16}
                        strokeWidth={2}
                        className="deals_deal_view_spinner"
                        aria-hidden
                      />
                      Removing…
                    </>
                  ) : (
                    <>
                      <Trash2 size={16} strokeWidth={2} aria-hidden />
                      Remove member
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <div
      className="deal_member_row_actions"
      role="group"
      aria-label={`Actions for ${memberLabel}`}
      aria-busy={approveFundBusy || undefined}
    >
      {leadSponsorBlockedModal}
      {deleteModal}
      <div className="um_kebab_root" ref={wrapRef}>
        <button
          type="button"
          className="um_kebab_trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={approveFundBusy ? "Approving fund…" : "Actions"}
          aria-label={
            approveFundBusy
              ? `Approving fund for ${memberLabel}`
              : `Actions for ${memberLabel}`
          }
          disabled={approveFundBusy}
          onClick={() => {
            if (approveFundBusy) return
            setMenuOpen((v) => !v)
          }}
        >
          {approveFundBusy ? (
            <Loader2
              className="deal_inv_mail_status_spin"
              size={18}
              strokeWidth={2}
              aria-hidden
            />
          ) : (
            <MoreHorizontal size={18} strokeWidth={2} aria-hidden />
          )}
        </button>
        {menuOpen && typeof document !== "undefined"
          ? createPortal(
              <ul
                ref={menuRef}
                className="deal_member_row_actions_menu um_kebab_menu um_kebab_menu--portal"
                role="menu"
              >
                {onApproveFund && !viewOnly ? (
                  <li role="none">
                    <button
                      type="button"
                      className={`um_kebab_menuitem${
                        draftRow || approveFundDisabled || actionsLimitedToView
                          ? " um_kebab_menuitem_disabled"
                          : ""
                      }`}
                      role="menuitem"
                      disabled={draftRow || approveFundDisabled || actionsLimitedToView}
                      title={
                        actionsLimitedToView
                          ? actionsLimitedToViewTitle
                          : approveFundDisabledTitle
                      }
                      onClick={() => {
                        if (draftRow || approveFundDisabled || actionsLimitedToView) return
                        runMenuAction(() => void onApproveFund(row))
                      }}
                    >
                      <Banknote
                        className="um_kebab_menuitem_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                      Approve fund
                    </button>
                  </li>
                ) : null}
                {onEditFundedDate && !viewOnly ? (
                  <li role="none">
                    <button
                      type="button"
                      className={`um_kebab_menuitem${
                        draftRow || actionsLimitedToView
                          ? " um_kebab_menuitem_disabled"
                          : ""
                      }`}
                      role="menuitem"
                      disabled={draftRow || actionsLimitedToView}
                      title={
                        actionsLimitedToView
                          ? actionsLimitedToViewTitle
                          : draftRow
                            ? "Available after the investor is saved"
                            : "Change the funded date"
                      }
                      onClick={() => {
                        if (draftRow || actionsLimitedToView) return
                        runMenuAction(() => onEditFundedDate(row))
                      }}
                    >
                      <Calendar
                        className="um_kebab_menuitem_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                      Edit funded date
                    </button>
                  </li>
                ) : null}
                {onView ? (
                  <li role="none">
                    <button
                      type="button"
                      className="um_kebab_menuitem"
                      role="menuitem"
                      onClick={() => void runView()}
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
                ) : null}
                {viewOnly ? null : (
                <>
                <li role="none">
                  <button
                    type="button"
                    className={`um_kebab_menuitem${
                      editDisabled || actionsLimitedToView
                        ? " um_kebab_menuitem_disabled"
                        : ""
                    }`}
                    role="menuitem"
                    disabled={editDisabled || actionsLimitedToView}
                    title={
                      actionsLimitedToView
                        ? actionsLimitedToViewTitle
                        : editDisabledTitle
                    }
                    onClick={() => {
                      if (editDisabled || actionsLimitedToView) return
                      runMenuAction(() => onEdit(row))
                    }}
                  >
                    <Pencil
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    {draftRow ? "Continue editing" : "Edit"}
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    className={`um_kebab_menuitem${
                      draftRow || !offeringLinkAvailable || actionsLimitedToView
                        ? " um_kebab_menuitem_disabled"
                        : ""
                    }`}
                    role="menuitem"
                    disabled={draftRow || !offeringLinkAvailable || actionsLimitedToView}
                    title={
                      actionsLimitedToView
                        ? actionsLimitedToViewTitle
                        : offeringLinkBlockedBecauseDraft
                        ? "Change the deal stage before copying an offering preview link."
                        : !offeringLinkAvailable
                          ? 'Set visibility to “Only visible with link” in Offering Details to enable this link.'
                          : undefined
                    }
                    onClick={() => {
                      if (draftRow || !offeringLinkAvailable || actionsLimitedToView) return
                      runMenuAction(() => onCopyLink(row))
                    }}
                  >
                    <Link2
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Copy offering link
                  </button>
                </li>
                {onSendEsign && !esignCompleted ? (
                  <li role="none">
                    <button
                      type="button"
                      className={`um_kebab_menuitem${
                        draftRow || sendEsignDisabled || actionsLimitedToView
                          ? " um_kebab_menuitem_disabled"
                          : ""
                      }`}
                      role="menuitem"
                      disabled={draftRow || sendEsignDisabled || actionsLimitedToView}
                      title={
                        actionsLimitedToView
                          ? actionsLimitedToViewTitle
                          : draftRow
                          ? "Available after the investor is saved"
                          : sendEsignDisabled
                            ? sendEsignDisabledTitle
                            : esignWasSent
                              ? "Re-send eSign documents to this investor"
                              : "Send eSign documents to this investor"
                      }
                      onClick={() => {
                        if (draftRow || sendEsignDisabled || actionsLimitedToView) return
                        runMenuAction(() => void onSendEsign(row))
                      }}
                    >
                      <FileSignature
                        className="um_kebab_menuitem_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                      {esignWasSent ? "Re-send E-sign" : "Send E-sign"}
                    </button>
                  </li>
                ) : null}
                <li role="none">
                  <button
                    type="button"
                    className={`um_kebab_menuitem${
                      draftRow ||
                      invitationMailSending ||
                      invitationMailBlocked ||
                      actionsLimitedToView
                        ? " um_kebab_menuitem_disabled"
                        : ""
                    }`}
                    role="menuitem"
                    disabled={
                      draftRow ||
                      invitationMailSending ||
                      invitationMailBlocked ||
                      actionsLimitedToView
                    }
                    title={
                      actionsLimitedToView
                        ? actionsLimitedToViewTitle
                        : draftRow
                        ? "Available after the member is saved"
                        : invitationMailSending
                          ? "Sending invitation email"
                        : invitationMailBlocked
                          ? INVITATION_EMAILS_BLOCKED_ACTION_TITLE
                        : invitationMailSent
                          ? "Send another invitation email"
                          : undefined
                    }
                    onClick={() => {
                      if (
                        draftRow ||
                        invitationMailSending ||
                        invitationMailBlocked ||
                        actionsLimitedToView
                      )
                        return
                      runMenuAction(() => onSendInvite(row))
                    }}
                  >
                    {invitationMailSending ? (
                      <Loader2
                        className="um_kebab_menuitem_icon deal_inv_mail_status_spin"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                    ) : draftRow || !invitationMailSent ? (
                      <Mail
                        className="um_kebab_menuitem_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                    ) : (
                      <Send
                        className="um_kebab_menuitem_icon"
                        size={16}
                        strokeWidth={2}
                        aria-hidden
                      />
                    )}
                    {draftRow
                      ? "Send invitation email"
                      : invitationMailSending
                        ? "Sending…"
                      : invitationMailSent
                        ? "Re-send invitation email"
                        : "Send invitation email"}
                  </button>
                </li>
                {removeHidden && !actionsLimitedToView ? null : (
                <li role="none">
                  <button
                    type="button"
                    className={`um_kebab_menuitem deals_kebab_menuitem_danger${
                      actionsLimitedToView ? " um_kebab_menuitem_disabled" : ""
                    }`}
                    role="menuitem"
                    disabled={actionsLimitedToView}
                    title={actionsLimitedToView ? actionsLimitedToViewTitle : undefined}
                    onClick={() => {
                      if (actionsLimitedToView) return
                      void runDelete()
                    }}
                  >
                    <UserMinus
                      className="um_kebab_menuitem_icon"
                      size={16}
                      strokeWidth={2}
                      aria-hidden
                    />
                    Remove
                  </button>
                </li>
                )}
                </>
                )}
              </ul>,
              document.body,
            )
          : null}
      </div>
    </div>
  )
}
