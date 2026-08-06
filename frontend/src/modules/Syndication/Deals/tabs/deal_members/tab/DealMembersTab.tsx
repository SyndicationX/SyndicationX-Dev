import {
  Download,
  Eye,
  Info,
  Mail,
  Pencil,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { toast } from "../../../../../../common/components/Toast"
import { FormTooltip } from "../../../../../../common/components/form-tooltip/FormTooltip"
import {
  DataTable,
  type DataTableColumn,
} from "../../../../../../common/components/data-table/DataTable"
import {
  ADD_MEMBER_DRAFT_UPDATED_EVENT,
  clearAddMemberDraft,
  isAddMemberSessionDraftRedundantWithApiRows,
} from "../add-investment/addMemberFormDraftStorage"
import {
  ADD_MEMBER_DRAFT_ROW_ID,
  buildAddMemberDraftInvestorRow,
  investorRowShowsDraftBadge,
} from "../add-investment/addMemberDraftInvestorRow"
import { fetchDealInvestorClasses, fetchDealMembers } from "../../../api/dealsApi"
import { notifyDealMembersExportAudit } from "../../../api/dealMembersExportNotifyApi"
import { formatMemberUsername } from "../../../../usermanagement/memberAdminShared"
import { DealMemberUserCell } from "../../investors/DealMemberUserCell"
import { ExportDealInvestorRowsModal } from "../../investors/ExportDealInvestorRowsModal"
import {
  investorRoleLabel,
  isDealMembersTabRole,
} from "../../../constants/investor-profile"
import type { DealInvestorClass } from "../../../types/deal-investor-class.types"
import type { DealInvestorRow } from "../../../types/deal-investors.types"
import {
  buildDealMembersTableExportCsv,
  downloadDealExportCsv,
  exportAuditLinesForDealInvestorRows,
} from "../../../utils/dealInvestorExportCsv"
import { buildTableExportFilename } from "../../../../../../common/utils/tableExportFilename"
import { dealInvestorStatusDisplayLabel } from "../../../utils/dealInvestorTableDisplay"
import { applyInvitationMailSentMarks } from "../../../utils/dealInvitationMailStatus"
import {
  displayAddedInvestorsCommittedAmount,
  displayInvestorCommittedAmount,
  displayInvestorCommittedAmountExport,
  parseMoneyDigits,
} from "../../../utils/offeringMoneyFormat"
import { TableCompactAmountCell } from "../../../../../../common/components/card-compact-amount/CardCompactAmount"
import { DealInvestorCommittedAmountCell } from "../../investors/DealInvestorCommittedAmountCell"
import { InviteMailStatusBadge } from "../../investors/InviteMailStatusBadge"
import { DealInvestorRoleCell } from "../../investors/DealInvestorRoleBadge"
// import { InvestorClassPillsDisplay } from "../../investors/InvestorClassPillsDisplay"
import { DealMemberRowActions } from "../components/DealMemberRowActions"
import {
  loadEmailTemplates,
  type EmailTemplateRow,
} from "../../../../contacts/emailTemplatesStorage"
import {
  SendMailEmailPreviewModal,
  type SendMailEmailPreviewPayload,
} from "../../../../contacts/components/SendMailEmailPreviewModal"
import {
  getCurrentSessionUserEmail,
  openSendMailDraft,
  parseEmailInput,
} from "../../../../../../common/features/send-mail"
import { useNavigate } from "react-router-dom"
import "../../../deal-investors-tab.css"
import "../../../deals-list.css"
import "../../../../usermanagement/user_management.css"
import "../../../../contacts/contacts.css"
import "./deal-members.css"
import "../../../../../../common/components/data-table/data-table.css"

function includeInDealMembersTable(r: DealInvestorRow): boolean {
  if (r.id === ADD_MEMBER_DRAFT_ROW_ID) {
    const role = String(r.investorRole ?? "").trim()
    if (!role || role === "—") return true
    return isDealMembersTabRole(role)
  }
  return isDealMembersTabRole(r.investorRole)
}

interface DealMembersTabProps {
  dealId: string
  dealName: string
  /**
   * When true, “Copy offering link” is enabled (Offering Details → visibility “Only visible with link”).
   */
  offeringLinkAvailable: boolean
  offeringLinkBlockedBecauseDraft?: boolean
  /** When false, session add-member draft (if any) is merged into the table below. */
  addInvestmentOpen: boolean
  /** From DealInvestorsTab: true while Add or Edit modal is open — suppresses duplicate session draft row. */
  sharedInvestmentModalOpen?: boolean
  onAddMember: () => void
  onEditMember: (row: DealInvestorRow) => void
  onCopyMemberOfferingLink: (row: DealInvestorRow) => void
  onSendMemberInvitationMail: (row: DealInvestorRow) => void
  onDeleteMember: (row: DealInvestorRow) => void
  /** Opens read-only details (e.g. after refetching roster). */
  onViewMember: (row: DealInvestorRow) => void
  /** Increment to refetch rows after add/edit from the shared investor modal. */
  investorsRefreshKey?: number
  /**
   * After send-invitation succeeds, rows marked here show Mail sent / Re-send
   * until the members API includes invitation mail status.
   */
  invitationMailStatusByRowId?: Record<string, true>
}

export function DealMembersTab({
  dealId,
  dealName,
  offeringLinkAvailable,
  offeringLinkBlockedBecauseDraft = false,
  addInvestmentOpen,
  sharedInvestmentModalOpen = false,
  onAddMember,
  onEditMember,
  onCopyMemberOfferingLink,
  onSendMemberInvitationMail,
  onDeleteMember,
  onViewMember,
  investorsRefreshKey = 0,
  invitationMailStatusByRowId,
}: DealMembersTabProps) {
  const navigate = useNavigate()
  const [rows, setRows] = useState<DealInvestorRow[]>([])
  const rowsRef = useRef<DealInvestorRow[]>([])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  const [investorClasses, setInvestorClasses] = useState<DealInvestorClass[]>(
    [],
  )
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [addMemberDraftTick, setAddMemberDraftTick] = useState(0)
  const [query, setQuery] = useState("")
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [sendMailModalOpen, setSendMailModalOpen] = useState(false)
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateRow[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [sendMailCc, setSendMailCc] = useState("")
  const [sendMailEmailPreview, setSendMailEmailPreview] =
    useState<SendMailEmailPreviewPayload | null>(null)
  const memberSelectAllRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    const showFullPageLoading = rowsRef.current.length === 0
    if (showFullPageLoading) setLoading(true)
    try {
      const { members } = await fetchDealMembers(dealId)
      setRows(members)
    } finally {
      setLoading(false)
    }
  }, [dealId])

  const handleViewMember = useCallback(
    async (row: DealInvestorRow) => {
      if (row.id === ADD_MEMBER_DRAFT_ROW_ID) {
        onViewMember(row)
        return
      }
      try {
        const { members: list } = await fetchDealMembers(dealId)
        const fresh = list.find((r) => r.id === row.id)
        onViewMember(fresh ?? row)
      } catch {
        toast.error("Could not load member details.")
      }
    },
    [dealId, onViewMember],
  )

  useEffect(() => {
    void load()
  }, [load, investorsRefreshKey])

  /** Drop stale add-member session draft when API already lists that contact (avoids duplicate row + stuck storage). */
  useEffect(() => {
    if (addInvestmentOpen || sharedInvestmentModalOpen) return
    if (rows.length === 0) return
    if (!isAddMemberSessionDraftRedundantWithApiRows(dealId, rows)) return
    clearAddMemberDraft(dealId)
  }, [
    dealId,
    rows,
    addInvestmentOpen,
    sharedInvestmentModalOpen,
    investorsRefreshKey,
  ])

  useEffect(() => {
    let cancelled = false
    void fetchDealInvestorClasses(dealId).then((list) => {
      if (!cancelled) setInvestorClasses(list)
    })
    return () => {
      cancelled = true
    }
  }, [dealId])

  useEffect(() => {
    function onDraftUpdated() {
      setAddMemberDraftTick((t) => t + 1)
    }
    window.addEventListener(ADD_MEMBER_DRAFT_UPDATED_EVENT, onDraftUpdated)
    return () =>
      window.removeEventListener(ADD_MEMBER_DRAFT_UPDATED_EVENT, onDraftUpdated)
  }, [])

  const sessionDraftRow = useMemo((): DealInvestorRow | null => {
    void addMemberDraftTick
    return buildAddMemberDraftInvestorRow(dealId, investorClasses)
  }, [dealId, investorClasses, addMemberDraftTick])

  const displayRows = useMemo(() => {
    const filtered = rows.filter(includeInDealMembersTable)
    const draft =
      sessionDraftRow && includeInDealMembersTable(sessionDraftRow)
        ? sessionDraftRow
        : null
    const hideSessionDraftRow =
      addInvestmentOpen || sharedInvestmentModalOpen
    /** Autosave row is already in `filtered` — do not duplicate with session draft. */
    const draftRedundantWithApi = isAddMemberSessionDraftRedundantWithApiRows(
      dealId,
      filtered,
    )
    if (draft && !hideSessionDraftRow && !draftRedundantWithApi)
      return [...filtered, draft]
    return filtered
  }, [
    rows,
    sessionDraftRow,
    addInvestmentOpen,
    sharedInvestmentModalOpen,
    dealId,
    addMemberDraftTick,
  ])

  // const dealAllClassNamesLine = useMemo(
  //   () =>
  //     investorClasses
  //       .map((c) => String(c.name ?? "").trim())
  //       .filter(Boolean)
  //       .join(", "),
  //   [investorClasses],
  // )

  const displayRowsWithMail = useMemo(
    () => applyInvitationMailSentMarks(displayRows, invitationMailStatusByRowId),
    [displayRows, invitationMailStatusByRowId],
  )

  useEffect(() => {
    if (!invitationMailStatusByRowId) return
    if (Object.keys(invitationMailStatusByRowId).length === 0) return
    setRows((prev) =>
      applyInvitationMailSentMarks(prev, invitationMailStatusByRowId),
    )
  }, [invitationMailStatusByRowId])

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return displayRowsWithMail
    return displayRowsWithMail.filter((r) => {
      const mailLabel =
        r.invitationMailSent === true
          ? "email sent"
          : "not sent"
      const hay = [
        r.displayName,
        r.userDisplayName,
        r.userEmail,
        r.investorRole,
        r.investorClass,
        r.status,
        r.addedByDisplayName,
        investorRoleLabel(r.investorRole ?? ""),
        displayInvestorCommittedAmountExport(r),
        displayAddedInvestorsCommittedAmount(r),
        mailLabel,
      ]
        .map((x) => String(x ?? "").toLowerCase())
        .join(" ")
      return hay.includes(q)
    })
  }, [displayRowsWithMail, query])

  const allFilteredMembersSelected = useMemo(
    () =>
      filteredRows.length > 0 &&
      filteredRows.every((r) => selectedMemberIds.has(r.id)),
    [filteredRows, selectedMemberIds],
  )

  const someFilteredMembersSelected = useMemo(
    () =>
      filteredRows.some((r) => selectedMemberIds.has(r.id)) &&
      !allFilteredMembersSelected,
    [filteredRows, selectedMemberIds, allFilteredMembersSelected],
  )

  useLayoutEffect(() => {
    const el = memberSelectAllRef.current
    if (el) el.indeterminate = someFilteredMembersSelected
  }, [someFilteredMembersSelected, allFilteredMembersSelected, filteredRows.length])

  useEffect(() => {
    setSelectedMemberIds((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(filteredRows.map((r) => r.id))
      const next = new Set<string>()
      for (const id of prev) {
        if (valid.has(id)) next.add(id)
      }
      if (next.size === prev.size) return prev
      return next
    })
  }, [filteredRows])

  const toggleSelectMember = useCallback((id: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectAllFilteredMembers = useCallback(() => {
    if (filteredRows.length === 0) return
    if (allFilteredMembersSelected) {
      setSelectedMemberIds((prev) => {
        const next = new Set(prev)
        for (const r of filteredRows) next.delete(r.id)
        return next
      })
      return
    }
    setSelectedMemberIds((prev) => {
      const next = new Set(prev)
      for (const r of filteredRows) next.add(r.id)
      return next
    })
  }, [filteredRows, allFilteredMembersSelected])

  const selectedMemberRows = useMemo(
    () => filteredRows.filter((r) => selectedMemberIds.has(r.id)),
    [filteredRows, selectedMemberIds],
  )
  const senderEmail = useMemo(() => getCurrentSessionUserEmail(), [])
  const selectedTemplate = useMemo(
    () => emailTemplates.find((t) => t.id === selectedTemplateId) ?? null,
    [emailTemplates, selectedTemplateId],
  )
  const openSendMailModal = useCallback(() => {
    void (async () => {
      const templates = (await loadEmailTemplates()).filter((t) => !t.archived)
      setEmailTemplates(templates)
      setSelectedTemplateId((prev) =>
        prev && templates.some((t) => t.id === prev)
          ? prev
          : (templates[0]?.id ?? ""),
      )
      setSendMailCc("")
      setSendMailModalOpen(true)
    })()
  }, [])

  const closeSendMailModal = useCallback(() => {
    setSendMailModalOpen(false)
    setSendMailEmailPreview(null)
  }, [])

  const goNewTemplateFromSendMail = useCallback(() => {
    navigate("/contacts/email-templates/new")
  }, [navigate])

  const openSendMailEmailPreview = useCallback(
    (mode: "view" | "edit") => {
      const template = emailTemplates.find((t) => t.id === selectedTemplateId)
      if (!template) {
        toast.error("Template required", "Choose an email template first.")
        return
      }
      const emails = [
        ...new Set(
          selectedMemberRows
            .map((r) => String(r.userEmail ?? "").trim())
            .filter((e) => e.includes("@")),
        ),
      ]
      if (emails.length === 0) {
        toast.error("No email recipients", "Selected deal members have no valid email.")
        return
      }
      setSendMailEmailPreview({
        templateId: template.id,
        templateName: template.name,
        templateArchived: Boolean(template.archived),
        createdBy: template.createdBy,
        createdAt: template.createdAt,
        subject: template.subject,
        bodyHtml: template.body,
        toEmails: emails,
        ccEmails: parseEmailInput(sendMailCc),
        attachment: template.attachment,
        startInEditMode: mode === "edit",
      })
    },
    [emailTemplates, selectedMemberRows, selectedTemplateId, sendMailCc],
  )

  const handleSendMailPreviewSaved = useCallback(
    (patch: { subject: string; bodyHtml: string }) => {
      setSendMailEmailPreview((p) =>
        p ? { ...p, ...patch, startInEditMode: false } : null,
      )
      void loadEmailTemplates().then((rows) => {
        setEmailTemplates(rows.filter((t) => !t.archived))
      })
    },
    [],
  )

  useEffect(() => {
    setPage(1)
  }, [query])

  const exportModalRows = useMemo(
    () => displayRows.filter((r) => r.id !== ADD_MEMBER_DRAFT_ROW_ID),
    [displayRows],
  )

  const columns = useMemo((): DataTableColumn<DealInvestorRow>[] => {
    return [
      {
        id: "select",
        header: (
          <input
            ref={memberSelectAllRef}
            type="checkbox"
            className="um_table_header_select_cb"
            checked={allFilteredMembersSelected}
            onChange={toggleSelectAllFilteredMembers}
            disabled={filteredRows.length === 0}
            aria-label="Select all deal members in this list"
          />
        ),
        align: "center",
        thClassName: "um_th_checkbox",
        tdClassName: "um_td_checkbox",
        cell: (r) => (
          <input
            type="checkbox"
            className="um_table_row_select_cb"
            checked={selectedMemberIds.has(r.id)}
            onChange={() => toggleSelectMember(r.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select deal member ${r.displayName || r.userEmail || r.id}`}
          />
        ),
      },
      {
        id: "user",
        header: "User",
        sortValue: (r) =>
          `${formatMemberUsername(r.userDisplayName)} ${String(r.userEmail ?? "")} ${String(r.displayName ?? "")}`.toLowerCase(),
        tdClassName: "um_td_user deal_inv_td_user_cell",
        cell: (r) => (
          <DealMemberUserCell row={r} isDraft={investorRowShowsDraftBadge(r)} />
        ),
      },
      {
        id: "role",
        header: "Deal role",
        sortValue: (r) =>
          String(investorRoleLabel(r.investorRole ?? "")).toLowerCase(),
        tdClassName: "deal_inv_td_role deal_inv_td_role_badge_cell",
        cell: (r) => <DealInvestorRoleCell row={r} />,
      },
      // {
      //   id: "class",
      //   align: "center",
      //   header: (
      //     <span className="deal_inv_th_investor_class_head">
      //       <span>Class</span>
      //       {investorClasses.length === 0 ? (
      //         <FormTooltip
      //           label="Please complete the Offering Details section to assign an investor class."
      //           content={
      //             <p className="deal_inv_class_tooltip_p">
      //               Please complete the Offering Details section to assign an
      //               investor class.
      //             </p>
      //           }
      //           placement="bottom"
      //           panelAlign="start"
      //           openOnHover={false}
      //           nativeButtonTrigger={false}
      //         />
      //       ) : null}
      //     </span>
      //   ),
      //   thClassName: "deals_th_align_center",
      //   sortValue: (r) => {
      //     const a = (r.investorClass ?? "").trim()
      //     if (a) return a.toLowerCase()
      //     return dealAllClassNamesLine.toLowerCase()
      //   },
      //   tdClassName:
      //     "deal_inv_td_investor_class deal_inv_td_investor_class_cell deal_inv_td_investor_class_center",
      //   cell: (r) => {
      //     const assignedRaw = (r.investorClass ?? "").trim()
      //     const dealLine = dealAllClassNamesLine.trim()
      //     const pillSource = assignedRaw || dealLine
      //     if (!pillSource.trim())
      //       return <span className="deal_inv_class_pill_muted">—</span>
      //     const titleForTooltip =
      //       assignedRaw && dealLine && assignedRaw !== dealLine
      //         ? `${assignedRaw} · Deal: ${dealLine}`
      //         : pillSource
      //     return (
      //       <InvestorClassPillsDisplay
      //         pillSource={pillSource}
      //         titleForTooltip={titleForTooltip}
      //       />
      //     )
      //   },
      // },
      {
        id: "commitment",
        align: "right",
        header: (
          <span className="deal_inv_th_investor_class_head deal_inv_th_commitment_head">
            <span>Commitment</span>
            <FormTooltip
              label="What this amount means"
              content={
                <p className="deal_inv_class_tooltip_p">
                  Total amount this member has committed on this deal: the
                  subscription commitment plus any additional contribution lines
                  from their investment record. Displayed in USD. If none is
                  recorded, this shows $0.
                </p>
              }
              placement="bottom"
              panelAlign="end"
              openOnHover
              nativeButtonTrigger={false}
            />
          </span>
        ),
        thClassName: "deals_th_align_right",
        sortValue: (r) =>
          parseMoneyDigits(displayInvestorCommittedAmount(r)),
        tdClassName:
          "deal_inv_td_ellipsis deal_inv_td_committed um_td_numeric",
        cell: (r) => <DealInvestorCommittedAmountCell row={r} />,
      },
      {
        id: "added_investors_commitment",
        align: "right",
        header: (
          <span className="deal_inv_th_investor_class_head deal_inv_th_commitment_head">
            <span>Investors added</span>
            <FormTooltip
              label="Commitment from investors they added"
              content={
                <p className="deal_inv_class_tooltip_p">
                  Total subscription commitment (plus additional contribution lines)
                  recorded on this deal for other investors this Lead Sponsor, Admin
                  sponsor, or Co-sponsor added. Their own commitment is not included.
                  Shown in USD.
                </p>
              }
              placement="bottom"
              panelAlign="end"
              openOnHover
              nativeButtonTrigger={false}
            />
          </span>
        ),
        thClassName: "deals_th_align_right",
        sortValue: (r) =>
          parseMoneyDigits(displayAddedInvestorsCommittedAmount(r)),
        tdClassName:
          "deal_inv_td_ellipsis deal_inv_td_committed um_td_numeric",
        cell: (r) => {
          if (r.id === ADD_MEMBER_DRAFT_ROW_ID) return "—"
          const text = displayAddedInvestorsCommittedAmount(r)
          const display = String(text ?? "").trim()
          if (!display || display === "—") return "—"
          return (
            <span className="deal_inv_ellipsis_text deal_inv_ellipsis_text_end">
              <TableCompactAmountCell amount={display} />
            </span>
          )
        },
      },
      {
        id: "status",
        header: "Status",
        sortValue: (r) =>
          dealInvestorStatusDisplayLabel(r).toLowerCase(),
        tdClassName: "deal_inv_td_ellipsis",
        cell: (r) => dealInvestorStatusDisplayLabel(r),
      },
      {
        id: "added_by",
        header: "Added by",
        sortValue: (r) =>
          String(r.addedByDisplayName ?? "").toLowerCase(),
        tdClassName: "deal_inv_td_ellipsis",
        cell: (r) => {
          if (r.id === ADD_MEMBER_DRAFT_ROW_ID) return "—"
          const s = String(r.addedByDisplayName ?? "").trim()
          return s && s !== "—" ? s : "—"
        },
      },
      {
        id: "mailStatus",
        header: "Email status",
        sortValue: (r) =>
          r.id === ADD_MEMBER_DRAFT_ROW_ID
            ? -1
            : r.invitationMailSent === true
              ? 1
              : 0,
        tdClassName: "deal_inv_td_mail_status",
        cell: (r) => <InviteMailStatusBadge row={r} />,
      },
      {
        id: "actions",
        header: "Actions",
        align: "center",
        thClassName: "um_th_actions",
        tdClassName: "um_td_actions deal_inv_td_actions",
        cell: (r) => (
          <div className="deal_members_actions_cell">
            <DealMemberRowActions
              row={r}
              draftRow={r.id === ADD_MEMBER_DRAFT_ROW_ID}
              invitationMailSent={r.invitationMailSent === true}
              offeringLinkAvailable={offeringLinkAvailable}
              offeringLinkBlockedBecauseDraft={offeringLinkBlockedBecauseDraft}
              onView={handleViewMember}
              onEdit={onEditMember}
              onCopyLink={onCopyMemberOfferingLink}
              onSendInvite={onSendMemberInvitationMail}
              onDelete={onDeleteMember}
            />
          </div>
        ),
      },
    ]
  }, [
    allFilteredMembersSelected,
    toggleSelectAllFilteredMembers,
    filteredRows.length,
    selectedMemberIds,
    toggleSelectMember,
    onEditMember,
    offeringLinkAvailable,
    onCopyMemberOfferingLink,
    onSendMemberInvitationMail,
    onDeleteMember,
    handleViewMember,
  ])

  function handleExportDealMembers(selected: DealInvestorRow[]) {
    const csv = buildDealMembersTableExportCsv(selected)
    const filename = buildTableExportFilename({
      dealName,
      tableSlug: "deal-member",
    })
    downloadDealExportCsv(csv, filename)
    void notifyDealMembersExportAudit(dealId, {
      rowCount: selected.length,
      exportedLines: exportAuditLinesForDealInvestorRows(selected),
    })
    toast.success("Deal members exported", `Saved as ${filename}`)
  }

  const handleSendMailToSelectedMembers = useCallback(async () => {
    const emails = [
      ...new Set(
        selectedMemberRows
          .map((r) => String(r.userEmail ?? "").trim())
          .filter((e) => e.includes("@")),
      ),
    ]
    if (emails.length === 0) {
      toast.error("No email recipients", "Selected deal members have no valid email.")
      return
    }
    const template = emailTemplates.find((t) => t.id === selectedTemplateId)
    if (!template) {
      toast.error("Template required", "Choose an email template first.")
      return
    }
    const result = await openSendMailDraft({
      to: emails,
      ccRaw: sendMailCc,
      templateSubject: template.subject,
      templateBodyHtml: template.body,
      senderEmail,
    })
    if (!result.ok) {
      toast.error("Could not send email", result.message)
      return
    }
    toast.success("Email sent", "Message was sent from server.")
    closeSendMailModal()
  }, [
    emailTemplates,
    selectedMemberRows,
    selectedTemplateId,
    sendMailCc,
    senderEmail,
    closeSendMailModal,
  ])

  return (
    <div className="deal_members_tab">
      <ExportDealInvestorRowsModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        title="Export deal members"
        hint="Search and select members, then export to Excel (CSV format)."
        searchPlaceholder="Search deal members…"
        searchAriaLabel="Search deal members in export list"
        listAriaLabel="Deal members to export"
        rows={exportModalRows}
        onExportExcel={handleExportDealMembers}
      />
      {sendMailModalOpen ? (
        <div className="um_modal_overlay contacts_suspend_overlay" role="presentation">
          <div
            className="um_modal contacts_suspend_modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="deal-members-send-mail-title"
          >
            <div className="um_modal_head">
              <h3
                id="deal-members-send-mail-title"
                className="um_modal_title um_title_with_icon"
              >
                <Mail
                  className="um_title_icon contacts_suspend_title_icon contacts_suspend_title_icon_info"
                  size={22}
                  strokeWidth={2}
                  aria-hidden
                />
                <span>Send email</span>
              </h3>
              <button
                type="button"
                className="um_modal_close"
                aria-label="Close"
                onClick={closeSendMailModal}
              >
                <X size={20} strokeWidth={2} aria-hidden />
              </button>
            </div>
            <p className="contacts_suspend_modal_desc contacts_suspend_modal_desc_info">
              <Info
                className="contacts_suspend_modal_desc_icon"
                size={18}
                strokeWidth={2}
                aria-hidden
              />
              <span>
                Sending to {selectedMemberRows.length} selected member
                {selectedMemberRows.length === 1 ? "" : "s"}.
              </span>
            </p>
            {/* <div className="um_field contacts_suspend_reason_field">
              <label
                className="um_field_label_row"
                htmlFor="deal-members-send-mail-from"
              >
                <span>From</span>
              </label>
              <input
                id="deal-members-send-mail-from"
                type="text"
                className="um_input"
                value={senderEmail || "Current user"}
                readOnly
              />
            </div> */}
            <div className="um_field contacts_suspend_reason_field">
              <label
                className="um_field_label_row"
                htmlFor="deal-members-send-mail-cc"
              >
                <span>CC</span>
              </label>
              <input
                id="deal-members-send-mail-cc"
                type="text"
                className="um_input"
                placeholder="email1@domain.com, email2@domain.com"
                value={sendMailCc}
                onChange={(e) => setSendMailCc(e.target.value)}
              />
            </div>
            <div className="um_field contacts_suspend_reason_field">
              <div className="contacts_send_mail_template_head">
                <label
                  className="um_field_label_row"
                  htmlFor="deal-members-send-mail-template"
                >
                  <span>Email template</span>
                </label>
              </div>
              <div className="contacts_send_mail_template_select_row">
                <select
                  id="deal-members-send-mail-template"
                  className="um_field_select contacts_send_mail_template_select"
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                >
                  {emailTemplates.length === 0 ? (
                    <option value="">No active templates</option>
                  ) : null}
                  {emailTemplates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
                {selectedTemplate ? (
                  <>
                    <button
                      type="button"
                      className="contacts_send_mail_template_edit_btn"
                      aria-label="View"
                      title="View"
                      onClick={() => openSendMailEmailPreview("view")}
                    >
                      <Eye size={16} strokeWidth={2} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="contacts_send_mail_template_edit_btn"
                      aria-label="Edit"
                      title="Edit"
                      onClick={() => openSendMailEmailPreview("edit")}
                    >
                      <Pencil size={16} strokeWidth={2} aria-hidden />
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="contacts_send_mail_template_edit_btn"
                  aria-label="New template"
                  title="New template"
                  onClick={goNewTemplateFromSendMail}
                >
                  <Plus size={16} strokeWidth={2} aria-hidden />
                </button>
              </div>
              {emailTemplates.length === 0 ? (
                <p className="um_hint" role="status">
                  Create an email template first in Email Templates.
                </p>
              ) : null}
            </div>
            <div className="um_modal_actions contacts_suspend_modal_actions">
              <button
                type="button"
                className="um_btn_secondary"
                onClick={closeSendMailModal}
              >
                <X size={16} strokeWidth={2} aria-hidden />
                Close
              </button>
              <button
                type="button"
                className="um_btn_primary"
                disabled={!selectedTemplateId || selectedMemberRows.length === 0}
                onClick={handleSendMailToSelectedMembers}
              >
                <Send size={16} strokeWidth={2} aria-hidden />
                Send
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <SendMailEmailPreviewModal
        preview={sendMailEmailPreview}
        onClose={() => setSendMailEmailPreview(null)}
        onSaved={handleSendMailPreviewSaved}
      />

      <div
        className={`um_panel um_members_tab_panel deal_inv_table_panel${
          loading ? " deal_members_table_panel_loading" : ""
        }`}
        aria-busy={loading}
      >
        {loading ? (
          <div
            className="deal_members_page_loading"
            role="status"
            aria-live="polite"
            aria-label="Loading deal members"
          >
            <div className="data_table_loader_spinner" aria-hidden />
            <span className="deal_members_page_loading_text">
              Loading deal members…
            </span>
          </div>
        ) : (
          <>
            <div className="um_toolbar deal_inv_table_um_toolbar um_toolbar_export_then_search deal_members_table_toolbar">
              <div className="um_toolbar_actions deal_inv_table_toolbar_actions deal_members_toolbar_actions_leading">
                <button
                  type="button"
                  className="um_btn_toolbar"
                  onClick={openSendMailModal}
                  disabled={selectedMemberRows.length === 0}
                >
                  <Send size={18} strokeWidth={2} aria-hidden />
                  Send email
                </button>
                <button
                  type="button"
                  className="um_toolbar_export_btn"
                  onClick={() => setExportModalOpen(true)}
                >
                  <Download size={18} strokeWidth={2} aria-hidden />
                  <span>Export All</span>
                </button>
              </div>
              <div className="um_toolbar_actions deal_inv_table_toolbar_actions deal_members_toolbar_actions_trailing">
                <div className="um_search_wrap">
                  <Search className="um_search_icon" size={18} aria-hidden />
                  <input
                    type="search"
                    className="um_search_input"
                    placeholder="Search deal members…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search deal members"
                  />
                </div>
                <button
                  type="button"
                  className="um_btn_primary deal_members_add_member_btn"
                  onClick={onAddMember}
                >
                  <Plus size={18} strokeWidth={2} aria-hidden />
                  Add Member
                </button>
              </div>
            </div>

            <DataTable<DealInvestorRow>
              visualVariant="members"
              membersTableClassName="um_table_members deal_inv_table"
              stickyColumnCount={2}
              forceHorizontalScroll
              columns={columns}
              rows={filteredRows}
              getRowKey={(r, i) => r.id || `dm-${dealId}-${i}`}
              getRowClassName={(r) =>
                investorRowShowsDraftBadge(r) ? "deal_inv_row_draft" : undefined
              }
              onBodyRowClick={(r) => {
                if (r.id === ADD_MEMBER_DRAFT_ROW_ID) {
                  onEditMember(r)
                  return
                }
                onViewMember(r)
              }}
              emptyLabel="No deal members yet. Add a member or record an investment on the Investors tab."
              pagination={{
                page,
                pageSize,
                totalItems: filteredRows.length,
                onPageChange: setPage,
                onPageSizeChange: (n) => {
                  setPageSize(n)
                  setPage(1)
                },
                ariaLabel: "Deal members pagination",
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
