import { Loader2, Mail, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { toast } from "../../../../../common/components/Toast"
import { postDealDocumentSharedNotification } from "../../api/dealsApi"
import type { DealInvestorClass } from "../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../types/deal-investors.types"
import {
  lpInvestorsAddedBySponsorUserId,
  SPONSOR_USER_INVESTORS_MENU_LABEL,
  type SponsorPickerOption,
} from "../../utils/offeringPreviewDocumentAudience"

type SharedNotificationRecipient = {
  to_email: string
  member_display_name?: string
}

export function toggleIdInList(list: string[], id: string, on: boolean): string[] {
  if (on) return list.includes(id) ? list : [...list, id]
  return list.filter((x) => x !== id)
}

function formatDocumentSharedWithSummary(args: {
  classIds: string[]
  investorIds: string[]
  sponsorUserIds: string[]
  allInvestors: boolean
  classes: DealInvestorClass[]
  investors: DealInvestorRow[]
  sponsorUserOptions: SponsorPickerOption[]
}): string {
  const {
    classIds,
    investorIds,
    sponsorUserIds,
    allInvestors,
    classes,
    investors,
    sponsorUserOptions,
  } = args
  const bits: string[] = []
  for (const id of classIds) {
    const c = classes.find((x) => x.id === id)
    bits.push(c?.name?.trim() || id)
  }
  for (const uid of sponsorUserIds) {
    const o = sponsorUserOptions.find((x) => x.id === uid)
    bits.push(
      o
        ? `${SPONSOR_USER_INVESTORS_MENU_LABEL}: ${o.label}`
        : `${SPONSOR_USER_INVESTORS_MENU_LABEL}: ${uid}`,
    )
  }
  if (allInvestors) bits.push("All Investors")
  else {
    for (const id of investorIds) {
      const r = investors.find((x) => x.id === id)
      const email =
        r?.userEmail && r.userEmail !== "—" ? r.userEmail.trim() : ""
      const name = r?.displayName?.trim() || id
      bits.push(email ? `${name} (${email})` : name)
    }
  }
  if (bits.length === 0) return "All viewers (default)"
  const joined = bits.join(", ")
  if (joined.length > 72) return `${bits.length} selected`
  return joined
}

function investorRowMatchesDealClass(
  row: DealInvestorRow,
  classId: string,
  dealClasses: DealInvestorClass[],
): boolean {
  const rowClass = row.investorClass?.trim()
  if (!rowClass || rowClass === "—") return false
  if (rowClass === classId) return true
  const cls = dealClasses.find((c) => c.id === classId)
  const className = cls?.name?.trim()
  return Boolean(className && rowClass === className)
}

function resolveSharedWithRecipients(args: {
  allInvestors: boolean
  investorIds: string[]
  sponsorUserIds: string[]
  classIds: string[]
  investors: DealInvestorRow[]
  dealClasses: DealInvestorClass[]
}): SharedNotificationRecipient[] {
  const {
    allInvestors,
    investorIds,
    sponsorUserIds,
    classIds,
    investors,
    dealClasses,
  } = args
  const byEmail = new Map<string, SharedNotificationRecipient>()

  function addRow(row: DealInvestorRow) {
    const email = row.userEmail?.trim()
    if (!email || email === "—" || !email.includes("@")) return
    const key = email.toLowerCase()
    if (byEmail.has(key)) return
    const name = row.displayName?.trim()
    byEmail.set(key, {
      to_email: email,
      member_display_name: name && name !== "—" ? name : undefined,
    })
  }

  if (allInvestors) {
    for (const row of investors) addRow(row)
  } else {
    for (const id of investorIds) {
      const row = investors.find((x) => x.id === id)
      if (row) addRow(row)
    }
    for (const classId of classIds) {
      for (const row of investors) {
        if (investorRowMatchesDealClass(row, classId, dealClasses)) addRow(row)
      }
    }
    for (const sponsorUid of sponsorUserIds) {
      for (const row of lpInvestorsAddedBySponsorUserId(sponsorUid, investors)) {
        addRow(row)
      }
    }
  }

  return [...byEmail.values()]
}

export function sharedAudienceSearchBlob(
  sharedDealClassIds: string[],
  sharedInvestorIds: string[],
  sharedWithAllInvestors: boolean,
  classes: DealInvestorClass[],
  investors: DealInvestorRow[],
): string {
  const parts: string[] = []
  for (const id of sharedDealClassIds) {
    const c = classes.find((x) => x.id === id)
    if (c?.name) parts.push(c.name)
  }
  if (sharedWithAllInvestors) {
    parts.push("All Investors", "investors")
  } else {
    for (const id of sharedInvestorIds) {
      const r = investors.find((x) => x.id === id)
      if (r) {
        parts.push(r.displayName, r.userEmail)
      }
    }
  }
  return parts.join(" ")
}

export function DocumentSharedWithPicker(args: {
  dealId: string
  idPrefix: string
  classIds: string[]
  investorIds: string[]
  sponsorUserIds: string[]
  allInvestors: boolean
  dealClasses: DealInvestorClass[]
  /** Investors on this deal (Investors tab / LP rows only). */
  investors: DealInvestorRow[]
  /** Sponsor users (deal roster); selecting one shares with all LPs they added. */
  sponsorUserOptions: SponsorPickerOption[]
  docName: string
  onClassChange: (classId: string, checked: boolean) => void
  onAllInvestorsChange: (checked: boolean) => void
  onInvestorChange: (investorRowId: string, checked: boolean) => void
  onSponsorUserChange: (sponsorUserId: string, checked: boolean) => void
}) {
  const {
    dealId,
    idPrefix,
    classIds,
    investorIds,
    sponsorUserIds,
    allInvestors,
    dealClasses,
    investors,
    sponsorUserOptions,
    docName,
    onClassChange,
    onAllInvestorsChange,
    onInvestorChange,
    onSponsorUserChange,
  } = args
  const triggerId = useId()
  const confirmModalTitleId = useId()
  const menuId = `${idPrefix}-shared-menu`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [sendBusy, setSendBusy] = useState(false)
  const [menuBox, setMenuBox] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
  } | null>(null)

  const summary = formatDocumentSharedWithSummary({
    classIds,
    investorIds,
    sponsorUserIds,
    allInvestors,
    classes: dealClasses,
    investors,
    sponsorUserOptions,
  })

  const hasAudienceSelection =
    allInvestors ||
    investorIds.length > 0 ||
    classIds.length > 0 ||
    sponsorUserIds.length > 0

  const notifyRecipients = useMemo(
    () =>
      resolveSharedWithRecipients({
        allInvestors,
        investorIds,
        sponsorUserIds,
        classIds,
        investors,
        dealClasses,
      }),
    [allInvestors, investorIds, sponsorUserIds, classIds, investors, dealClasses],
  )

  const openNotifyConfirm = useCallback(() => {
    if (!hasAudienceSelection) {
      toast.error(
        "No one selected",
        "Select at least one deal class, sponsor user investors, or investor in Shared With first.",
      )
      return
    }
    if (notifyRecipients.length === 0) {
      toast.error(
        "No email addresses",
        "Selected investors do not have a valid email on file.",
      )
      return
    }
    setIsOpen(false)
    setConfirmOpen(true)
  }, [hasAudienceSelection, notifyRecipients.length])

  const handleConfirmSendNotification = useCallback(() => {
    const idTrim = dealId?.trim() ?? ""
    if (!idTrim) {
      toast.error("Save the deal", "Save the deal before sending notifications.")
      return
    }
    void (async () => {
      setSendBusy(true)
      try {
        const result = await postDealDocumentSharedNotification(idTrim, {
          recipients: notifyRecipients,
          document_names: [docName.trim() || "Document"],
        })
        if (!result.ok) {
          toast.error("Could not send email", result.message)
          return
        }
        if (result.failures.length > 0) {
          toast.success(
            "Email partially sent",
            `Sent ${result.sent} of ${notifyRecipients.length}. Some addresses failed.`,
          )
        } else {
          toast.success(
            "Email sent",
            `Notified ${result.sent} recipient${result.sent === 1 ? "" : "s"} that this document was shared.`,
          )
        }
        setConfirmOpen(false)
      } finally {
        setSendBusy(false)
      }
    })()
  }, [dealId, docName, notifyRecipients])

  const updateMenuBox = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 10
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minW = Math.min(18 * 16, vw - 2 * margin)
    const maxW = Math.min(22 * 16, vw - 2 * margin)
    const width = Math.min(maxW, Math.max(minW, r.width))
    let left = r.left
    if (left + width > vw - margin) left = vw - margin - width
    if (left < margin) left = margin

    const gap = 4
    const spaceBelow = vh - r.bottom - margin
    const spaceAbove = r.top - margin
    const maxPanel = 16 * 16
    const openDown = spaceBelow >= Math.min(200, spaceAbove)

    if (openDown) {
      const maxHeight = Math.max(140, Math.min(maxPanel, spaceBelow - gap))
      setMenuBox({ top: r.bottom + gap, left, width, maxHeight })
      return
    }
    const maxHeight = Math.max(140, Math.min(maxPanel, spaceAbove - gap))
    const top = Math.max(margin, r.top - maxHeight - gap)
    setMenuBox({ top, left, width, maxHeight })
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuBox(null)
      return
    }
    updateMenuBox()
    function onScrollOrResize() {
      updateMenuBox()
    }
    window.addEventListener("resize", onScrollOrResize)
    document.addEventListener("scroll", onScrollOrResize, true)
    return () => {
      window.removeEventListener("resize", onScrollOrResize)
      document.removeEventListener("scroll", onScrollOrResize, true)
    }
  }, [isOpen, updateMenuBox])

  useEffect(() => {
    if (!isOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (confirmOpen) return
        setIsOpen(false)
      }
    }
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node
      if (confirmOpen) return
      if (triggerRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setIsOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("mousedown", onPointerDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("mousedown", onPointerDown)
    }
  }, [isOpen, confirmOpen])

  useEffect(() => {
    if (!confirmOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !sendBusy) setConfirmOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [confirmOpen, sendBusy])

  const menuBody = (
    <>
      <div className="deal_docs_shared_with_menu_section">
        <p className="deal_docs_shared_with_menu_heading">Deal classes</p>
        {dealClasses.length === 0 ? (
          <p className="deal_docs_shared_with_menu_empty">No deal classes yet.</p>
        ) : (
          <ul className="deal_docs_shared_with_menu_list">
            {dealClasses
              .filter((c) => c.id.trim())
              .map((c) => {
                const cid = c.id.trim()
                const checked = classIds.includes(cid)
                const oid = `${idPrefix}-class-${cid}`
                return (
                  <li key={cid}>
                    <label className="deal_docs_shared_with_menu_row" htmlFor={oid}>
                      <input
                        id={oid}
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onClassChange(cid, e.target.checked)}
                      />
                      <span>{c.name.trim() || cid}</span>
                    </label>
                  </li>
                )
              })}
          </ul>
        )}
      </div>
      <div className="deal_docs_shared_with_menu_section">
        <p className="deal_docs_shared_with_menu_heading">
          {SPONSOR_USER_INVESTORS_MENU_LABEL}
        </p>
        {/* <p className="deal_docs_shared_with_menu_sub">
          Choose a sponsor on this deal. Every investor they added can view this
          file (and receives notification email when you use the mail icon).
        </p> */}
        {sponsorUserOptions.length === 0 ? (
          <p className="deal_docs_shared_with_menu_empty">
            No sponsor users on this deal yet.
          </p>
        ) : (
          <ul className="deal_docs_shared_with_menu_list">
            {sponsorUserOptions.map((s) => {
              const sid = s.id.trim()
              const checked = sponsorUserIds.includes(sid)
              const oid = `${idPrefix}-sponsor-user-${sid}`
              const lpCount = lpInvestorsAddedBySponsorUserId(sid, investors).length
              return (
                <li key={sid}>
                  <label className="deal_docs_shared_with_menu_row" htmlFor={oid}>
                    <input
                      id={oid}
                      type="checkbox"
                      checked={checked}
                      disabled={allInvestors}
                      onChange={(e) => onSponsorUserChange(sid, e.target.checked)}
                    />
                    <span className="deal_docs_shared_with_menu_inv_label">
                      <span className="deal_docs_shared_with_menu_inv_name">
                        {s.label}
                      </span>
                      {lpCount > 0 ? (
                        <span className="deal_docs_shared_with_menu_inv_email">
                          {lpCount} investor{lpCount === 1 ? "" : "s"} on this deal
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="deal_docs_shared_with_menu_section">
        <p className="deal_docs_shared_with_menu_heading">Investors</p>
        <p className="deal_docs_shared_with_menu_sub">
          Individual LPs on this deal (Investors tab only).
        </p>
        <ul className="deal_docs_shared_with_menu_list">
          <li key={`${idPrefix}-all-investors`}>
            <label
              className="deal_docs_shared_with_menu_row"
              htmlFor={`${idPrefix}-all-investors-cb`}
            >
              <input
                id={`${idPrefix}-all-investors-cb`}
                type="checkbox"
                checked={allInvestors}
                onChange={(e) => onAllInvestorsChange(e.target.checked)}
              />
              <span>All Investors</span>
            </label>
          </li>
          {investors.length === 0 ? (
            <li className="deal_docs_shared_with_menu_empty_li">
              <p className="deal_docs_shared_with_menu_empty">
                No investor rows on this deal yet.
              </p>
            </li>
          ) : (
            investors
              .filter((r) => r.id.trim())
              .map((r) => {
                const iid = r.id.trim()
                const checked = !allInvestors && investorIds.includes(iid)
                const oid = `${idPrefix}-inv-${iid}`
                const email =
                  r.userEmail && r.userEmail !== "—" ? r.userEmail.trim() : ""
                const nm = r.displayName.trim() || "—"
                return (
                  <li key={iid}>
                    <label className="deal_docs_shared_with_menu_row" htmlFor={oid}>
                      <input
                        id={oid}
                        type="checkbox"
                        checked={checked}
                        disabled={allInvestors}
                        onChange={(e) => onInvestorChange(iid, e.target.checked)}
                      />
                      <span className="deal_docs_shared_with_menu_inv_label">
                        <span className="deal_docs_shared_with_menu_inv_name">
                          {nm}
                        </span>
                        {email ? (
                          <span className="deal_docs_shared_with_menu_inv_email">
                            {email}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                )
              })
          )}
        </ul>
      </div>
    </>
  )

  return (
    <div
      className={`deal_docs_shared_with_root${isOpen && !confirmOpen ? " deal_docs_shared_with_root_open" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        className="deal_docs_shared_with_summary"
        title={summary}
        aria-expanded={isOpen && !confirmOpen}
        aria-haspopup="dialog"
        aria-controls={menuId}
        aria-label={`Shared with for ${docName}. ${summary}. ${isOpen ? "Close" : "Open"} to change.`}
        onClick={() => {
          setIsOpen((o) => !o)
        }}
      >
        <span className="deal_docs_shared_with_summary_text">{summary}</span>
      </button>
      {isOpen && !confirmOpen && menuBox
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="deal_docs_shared_with_menu deal_docs_shared_with_menu_portal"
              role="dialog"
              aria-label={`Choose deal classes or investors for ${docName}`}
              aria-labelledby={triggerId}
              style={{
                position: "fixed",
                top: menuBox.top,
                left: menuBox.left,
                width: menuBox.width,
                maxHeight: menuBox.maxHeight,
                zIndex: 13000,
              }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="deal_docs_shared_with_menu_top">
                <span className="deal_docs_shared_with_menu_top_label">Shared with</span>
                {hasAudienceSelection ? (
                  <button
                    type="button"
                    className="deal_docs_shared_with_mail_btn"
                    title="Send email notification"
                    aria-label={`Send email that ${docName} was shared`}
                    disabled={sendBusy}
                    onClick={(e) => {
                      e.stopPropagation()
                      openNotifyConfirm()
                    }}
                  >
                    <Mail size={16} strokeWidth={2} aria-hidden />
                  </button>
                ) : null}
              </div>
              {menuBody}
            </div>,
            document.body,
          )
        : null}
      {confirmOpen
        ? createPortal(
            <div
              className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost deal_docs_shared_notify_overlay"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget && !sendBusy) setConfirmOpen(false)
              }}
            >
              <div
                className="um_modal deals_add_inv_modal_panel add_contact_panel deal_docs_shared_notify_modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={confirmModalTitleId}
              >
                <div className="um_modal_head add_contact_modal_head">
                  <h3
                    id={confirmModalTitleId}
                    className="um_modal_title add_contact_modal_title"
                  >
                    Send shared document email?
                  </h3>
                  <button
                    type="button"
                    className="um_modal_close"
                    aria-label="Close"
                    disabled={sendBusy}
                    onClick={() => setConfirmOpen(false)}
                  >
                    <X size={20} strokeWidth={2} aria-hidden />
                  </button>
                </div>
                <div className="deals_add_inv_modal_scroll">
                  <p className="deal_offering_muted">
                    The following {notifyRecipients.length === 1 ? "person" : "people"}{" "}
                    will receive an email that{" "}
                    <strong>{docName}</strong> was shared with them on this deal:
                  </p>
                  <ul className="deal_docs_shared_notify_recipient_list">
                    {notifyRecipients.map((r) => (
                      <li key={r.to_email}>
                        {r.member_display_name ? (
                          <>
                            <strong>{r.member_display_name}</strong>
                            <span className="deal_docs_shared_notify_recipient_email">
                              {" "}
                              ({r.to_email})
                            </span>
                          </>
                        ) : (
                          r.to_email
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="um_modal_actions add_contact_modal_actions">
                  <button
                    type="button"
                    className="um_btn_secondary"
                    disabled={sendBusy}
                    onClick={() => setConfirmOpen(false)}
                  >
                    <X size={16} strokeWidth={2} aria-hidden />
                    No
                  </button>
                  <button
                    type="button"
                    className="um_btn_primary"
                    disabled={sendBusy}
                    onClick={handleConfirmSendNotification}
                  >
                    {sendBusy ? (
                      <>
                        <Loader2
                          size={16}
                          strokeWidth={2}
                          className="deals_deal_view_spinner"
                          aria-hidden
                        />
                        Sending…
                      </>
                    ) : (
                      <>
                        <Mail size={16} strokeWidth={2} aria-hidden />
                        Yes, send email
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
