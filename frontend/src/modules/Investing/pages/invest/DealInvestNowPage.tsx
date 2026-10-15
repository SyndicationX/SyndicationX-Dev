import { ArrowLeft, ChevronRight, CircleCheck, Loader2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { getSessionUserEmail } from "@/common/auth/sessionUserEmail"
import { FormHeadingWithInfo } from "@/common/components/form-heading/FormHeadingWithInfo"
import { toast } from "@/common/components/Toast"
import { focusFirstFormErrorAfterUpdate, scrollMultiStepFormToTopAfterUpdate } from "@/common/utils/scrollToFirstFormError"
import { setAppDocumentTitle } from "@/common/utils/appDocumentTitle"
import { usePortalMode } from "@/modules/Investing/context/PortalModeContext"
import type { SavedAddress } from "@/modules/Investing/pages/profiles/address.types"
import {
  fetchMyProfileBook,
  normalizeInvestorProfileListRow,
} from "@/modules/Investing/pages/profiles/investingProfileBookApi"
import type { InvestorProfileListRow } from "@/modules/Investing/pages/profiles/investor-profiles.types"
import { isInvestorProfileListRowIncomplete } from "@/modules/Investing/pages/profiles/addProfileDraftListRow"
import { upsertRuntimeInvestmentRow } from "@/modules/Investing/pages/investments/investmentsRuntimeStore"
import {
  fetchInvestmentSignStatus,
  type InvestmentSignStatusPayload,
} from "@/modules/Investing/api/investmentSignatureApi"
// Investor contributions: workflow — Stripe Checkout disabled for now
// import { startInvestorInvestmentCheckout } from "@/modules/Investing/api/stripeInvestorPaymentsApi"
import {
  fetchMyLpDealInvestNowCommitment,
  patchMyLpDealInvestNowCommitment,
  postMyLpDealInvestNowCommitmentComplete,
  postMyLpDealInvestNowEsignSend,
} from "@/modules/Syndication/Deals/api/lpInvestNowCommitmentApi"
import type { DealEsignTemplateFileRecord } from "@/modules/Syndication/Deals/api/dealsApi"
import {
  fetchDealById,
  fetchDealEsignTemplates,
  fetchDealInvestorClasses,
  fetchDealInvestorQuestionnaire,
  fetchDealInvestors,
  fetchDealMembers,
  fetchDealMyEsignDocuments,
  fetchReferringSponsorDisplayName,
  isDealEsignTemplateReady,
} from "@/modules/Syndication/Deals/api/dealsApi"
import { esignCategoryLabel } from "@/modules/Syndication/Deals/utils/esignTemplateCategories"
import { esignTemplateDisplayName } from "@/modules/Syndication/Deals/utils/esignTemplateDisplay"
import type { InvestorQuestionnaireConfig } from "@/modules/Syndication/Deals/tabs/esign_templates/investorQuestionnaire.types"
import { investorProfileLabel } from "@/modules/Syndication/Deals/constants/investor-profile"
import {
  EMPTY_INVESTORS_PAYLOAD,
  minimumInvestmentDisplayForClass,
  previewMinimumInvestmentDisplay,
} from "@/modules/Syndication/Deals/dealOfferingPreviewShared"
import {
  emptyDealMembersPayload,
  type DealInvestorRow,
} from "@/modules/Syndication/Deals/types/deal-investors.types"
import type { DealInvestorClass } from "@/modules/Syndication/Deals/types/deal-investor-class.types"
import { investorOnboardingSelectableClasses } from "@/modules/Syndication/Deals/utils/investorClassOverviewFields"
import { canInvestorCommitInvestOrOnboard } from "@/modules/Syndication/Deals/constants/deal-lifecycle"
import { dealWorkspacePath } from "@/modules/Syndication/Deals/utils/dealWorkspacePath"
import { dealInvestNowPath } from "@/modules/Syndication/Deals/utils/dealInvestNowPath"
import { DealSaasPaywallModal } from "@/modules/Syndication/Deals/components/DealSaasPaywallModal"
import {
  isDealSaasPaymentRequiredError,
  type DealSaasPaywallDeal,
} from "@/modules/Syndication/Deals/utils/dealSaasAccess"
import { lpProfileUseKey } from "@/modules/Syndication/Deals/utils/lpInvestNowProfileBlocking"
import { parseMoneyDigits } from "@/modules/Syndication/Deals/utils/offeringMoneyFormat"
import { parseInvestNowDocSignedCalendarDate } from "@/modules/Syndication/Deals/utils/prefillLpInvestNowFields"
import { recordRecentlyViewedDeal } from "@/modules/Investing/pages/dashboard/recentlyViewedDeals"
import { readInvestNowLocationState } from "./investNowLocationState"
import { investNowStepIndexFromSavedProgress } from "./investNowSavedStep"
import { investNowStepIndexForPhaseId } from "./investNowFlowSteps"
import {
  findInvestorRowForInvestNowScope,
} from "./investNowDraftUtils"
import {
  investorEsignIsFullyCompletedForRow,
  investorEsignWasSent,
} from "@/modules/Syndication/Deals/utils/investorEsignStatus"
import {
  bookProfileTypeDisplayLabel,
  commitmentProfileIdFromBookProfile,
  investNowDefaultInvestorClassId,
  resolveDealInvestorClassId,
  pickInvestNowSponsorDisplayName,
} from "@/modules/Syndication/Deals/utils/resolveInvestNowDealContext"
import { readOfferingPreviewSponsorAttributionForDeal, writeOfferingPreviewSponsorAttribution } from "@/modules/Syndication/Deals/utils/offeringPreviewSponsorRef"
import {
  buildInvestNowQuestionnairePrefill,
  buildQuestionnaireAddressPrefillFromW9,
  mergeInvestNowQuestionnaireAnswers,
} from "./investNowQuestionnairePrefill"
import {
  validateInvestNowQuestionnaireAnswers,
  validateInvestNowQuestionnaireSection,
} from "./investNowQuestionnaireValidation"
import type { InvestNowQuestionnaireAnswers } from "./investNowQuestionnaireValidation"
import {
  buildInvestNowFlowSteps,
  investNowActiveStepperPhaseId,
  investNowFlowStepSubtitle,
} from "./investNowFlowSteps"
import { investNowProfileDropdownOption } from "./investNowProfileDropdownOption"
import { InvestNowFlowStepper } from "./InvestNowFlowStepper"
import { InvestNowQuestionnaireSectionStep } from "./InvestNowQuestionnaireSectionStep"
import { InvestNowW9Step } from "./InvestNowW9Step"
import {
  InvestNowEsignaturesStep,
  mapMyEsignDocumentsToInvestNowRows,
  type InvestNowEsignDocRow,
} from "./InvestNowEsignaturesStep"
import {
  buildInvestNowW9Prefill,
  investNowW9FormApiPayload,
  mergeInvestNowW9Values,
  savedW9NameIsInvestorProfileDefault,
  ssnFromAnyInvestorProfile,
  syndicationAccountW9Name,
} from "./investNowW9FormUtils"
import {
  type InvestNowFieldErrors,
  INVEST_NOW_FIELD,
  hasInvestNowFieldErrors,
  investNowFieldErrorKeys,
  investNowFieldPreferSelector,
  investNowBelowMinimumAmountNotice,
  validateInvestNowInvestorFields,
  validateInvestNowInvestmentFields,
  validateInvestNowW9Fields,
} from "./investNowFieldValidation"
import { EMPTY_INVEST_NOW_W9 } from "./investNowW9.types"
import { InvestNowInvestmentStep } from "./InvestNowInvestmentStep"
import { InvestNowInvestorStep } from "./InvestNowInvestorStep"
import {
  esignCategoryIdFromCommitmentProfile,
  esignTemplateForCategory,
  filterMyEsignDocumentsForCategory,
  investNowCommitmentRowIdForScope,
  investNowWorkflowLabelForProfileDocs,
  questionnaireIncludedInInvestNowFlow,
  visibleQuestionnaireSectionsForProfile,
} from "./investNowEsignContext"
import "@/modules/Syndication/Deals/deals-list.css"
import "@/modules/Syndication/Deals/deals-create.css"
import "./invest-now-flow.css"


function formatDealCloseDateForInvestments(raw: string | undefined): string {
  const t = String(raw ?? "").trim()
  if (!t) return "—"
  const d = new Date(t)
  if (!Number.isFinite(d.getTime())) return t
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function esignFailureAllowsSoftCommitment(
  message: string | null | undefined,
): boolean {
  const normalized = String(message ?? "").trim().toLowerCase()
  return (
    normalized.includes("esign service is temporarily unavailable") ||
    normalized.includes("ensure signflow is running")
  )
}

export function DealInvestNowPage() {
  const { dealId: dealIdParam = "" } = useParams<{ dealId: string }>()
  const dealId = decodeURIComponent(dealIdParam.trim())
  const navigate = useNavigate()
  const location = useLocation()
  const { switchToInvesting } = usePortalMode()
  const investNowNav = readInvestNowLocationState(location.state)
  const storedSponsorAttribution =
    readOfferingPreviewSponsorAttributionForDeal(dealId)
  const referringSponsorRef =
    investNowNav.referringSponsorRef ?? storedSponsorAttribution?.sponsorRef
  const referringSponsorDisplayName =
    investNowNav.referringSponsorDisplayName ??
    storedSponsorAttribution?.sponsorDisplayName
  const entryMode = investNowNav.mode ?? "fresh"
  const addNewCommitment = investNowNav.addCommitment === true
  const resumeScope = useMemo(
    () => ({
      investmentId: investNowNav.investmentId,
      userInvestorProfileId: investNowNav.userInvestorProfileId,
      profileId: investNowNav.profileId,
    }),
    [
      investNowNav.investmentId,
      investNowNav.userInvestorProfileId,
      investNowNav.profileId,
    ],
  )

  const [saasPaywallDeal, setSaasPaywallDeal] =
    useState<DealSaasPaywallDeal | null>(null)
  const [loading, setLoading] = useState(true)
  const [resumeLoading, setResumeLoading] = useState(entryMode === "resume")
  const [resumeLoadError, setResumeLoadError] = useState("")
  const sessionDraftRef = useRef(entryMode === "resume")
  const resumeSavedRef = useRef<
    import("@/modules/Syndication/Deals/api/lpInvestNowCommitmentApi").MyLpDealInvestNowCommitmentPayload | null
  >(null)
  const resumeStepAppliedRef = useRef(false)
  const [dealInvestors, setDealInvestors] = useState<DealInvestorRow[]>([])
  const [submitting, setSubmitting] = useState(false)
  const pendingAutoFinishRef = useRef(false)
  const finishStartedRef = useRef(false)
  const investNowFormRef = useRef<HTMLFormElement>(null)
  const stepScrollBootRef = useRef(true)
  const [stepIndex, setStepIndex] = useState(0)
  const [error, setError] = useState("")
  const [fieldErrors, setFieldErrors] = useState<InvestNowFieldErrors>({})

  const [dealName, setDealName] = useState("")
  const [closeDate, setCloseDate] = useState<string | null>(null)
  const [offeringSize, setOfferingSize] = useState("")
  const [selectedInvestorClassId, setSelectedInvestorClassId] = useState("")
  const [sponsorLabel, setSponsorLabel] = useState("—")

  const [bookProfileRows, setBookProfileRows] = useState<InvestorProfileListRow[]>(
    [],
  )
  const [bookAddresses, setBookAddresses] = useState<SavedAddress[]>([])
  const [bookLoading, setBookLoading] = useState(true)
  const [blockedProfileKeys, setBlockedProfileKeys] = useState<Set<string>>(
    () => new Set(),
  )

  const [savedUserProfileId, setSavedUserProfileId] = useState("")
  const [profileId, setProfileId] = useState("")
  const [investorClasses, setInvestorClasses] = useState<DealInvestorClass[]>(
    [],
  )
  const [amount, setAmount] = useState("")
  const [fundingMethod, setFundingMethod] = useState("")
  const [questionnaireAnswers, setQuestionnaireAnswers] =
    useState<InvestNowQuestionnaireAnswers>({})
  const [w9Values, setW9Values] = useState(EMPTY_INVEST_NOW_W9)
  const [esignFilesByCategory, setEsignFilesByCategory] = useState<
    Record<string, DealEsignTemplateFileRecord[]>
  >({})
  const [questionnaireConfig, setQuestionnaireConfig] =
    useState<InvestorQuestionnaireConfig | null>(null)
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [esignLoading, setEsignLoading] = useState(false)
  const [esignSendError, setEsignSendError] = useState<string | null>(null)
  const [esignSendOk, setEsignSendOk] = useState(false)
  const [esignDocuments, setEsignDocuments] = useState<InvestNowEsignDocRow[]>([])
  const [esignPending, setEsignPending] = useState(false)
  const [esignCompleted, setEsignCompleted] = useState(false)
  const [esignWorkflowLabel, setEsignWorkflowLabel] = useState<string | null>(
    null,
  )
  const [esignSignatureRequestId, setEsignSignatureRequestId] = useState<
    string | null
  >(null)
  const [sequentialSignTurnOpen, setSequentialSignTurnOpen] = useState(true)
  const [awaitingSequentialSignTurn, setAwaitingSequentialSignTurn] =
    useState(false)
  const [investNowInvestmentId, setInvestNowInvestmentId] = useState<
    string | null
  >(null)
  const investNowInvestmentIdRef = useRef<string | null>(null)
  const duplicateProfileOverrideKeyRef = useRef("")
  const duplicateProfileConfirmResolveRef = useRef<
    ((confirmed: boolean) => void) | null
  >(null)
  const [duplicateProfileConfirmMessage, setDuplicateProfileConfirmMessage] =
    useState("")
  const [draftSavedModalOpen, setDraftSavedModalOpen] = useState(false)
  const esignSendInFlightRef = useRef(false)
  const [webhookSignStatus, setWebhookSignStatus] =
    useState<InvestmentSignStatusPayload | null>(null)
  const [signStatusLoading, setSignStatusLoading] = useState(false)
  const [status, setStatus] = useState("")
  const [docSignedDate, setDocSignedDate] = useState("")

  const selectableInvestorClasses = useMemo(
    () => investorOnboardingSelectableClasses(investorClasses),
    [investorClasses],
  )

  const minimumInvestmentHint = useMemo(() => {
    const cls = selectableInvestorClasses.find(
      (c) => c.id === selectedInvestorClassId,
    )
    const display = minimumInvestmentDisplayForClass(cls)
    if (!display || display === "—") return ""
    return `Minimum is ${display}`
  }, [selectableInvestorClasses, selectedInvestorClassId])

  const investmentClassOptions = useMemo(
    () =>
      selectableInvestorClasses.map((c) => ({
        value: c.id,
        label: c.name.trim() || "Unnamed class",
      })),
    [selectableInvestorClasses],
  )

  /** GP classes are not selectable during investor onboarding. */
  useEffect(() => {
    if (!selectedInvestorClassId.trim()) return
    if (
      selectableInvestorClasses.some(
        (c) => c.id === selectedInvestorClassId.trim(),
      )
    ) {
      return
    }
    setSelectedInvestorClassId(investNowDefaultInvestorClassId(investorClasses))
  }, [selectableInvestorClasses, selectedInvestorClassId, investorClasses])

  const esignCategoryId = useMemo(
    () => esignCategoryIdFromCommitmentProfile(profileId),
    [profileId],
  )

  const esignTemplate = useMemo(
    () => esignTemplateForCategory(esignFilesByCategory, esignCategoryId, profileId),
    [esignFilesByCategory, esignCategoryId, profileId],
  )

  const visibleQuestionnaireSections = useMemo(
    () =>
      visibleQuestionnaireSectionsForProfile(
        questionnaireConfig,
        esignCategoryId,
      ),
    [questionnaireConfig, esignCategoryId],
  )

  const questionnaireInFlow = useMemo(
    () =>
      questionnaireIncludedInInvestNowFlow({
        template: esignTemplate,
        config: questionnaireConfig,
        esignCategoryId,
      }),
    [esignTemplate, questionnaireConfig, esignCategoryId],
  )

  const flowSteps = useMemo(
    () =>
      buildInvestNowFlowSteps({
        showQuestionnaire: questionnaireInFlow,
        visibleSections: visibleQuestionnaireSections,
      }),
    [questionnaireInFlow, visibleQuestionnaireSections],
  )

  const currentStep = flowSteps[stepIndex] ?? flowSteps[0]

  const firstQuestionnaireStepIndex = useMemo(
    () => flowSteps.findIndex((s) => s.kind === "questionnaire"),
    [flowSteps],
  )

  const w9StepIndex = useMemo(
    () => flowSteps.findIndex((s) => s.kind === "w9"),
    [flowSteps],
  )

  const esignStepIndex = useMemo(
    () => flowSteps.findIndex((s) => s.kind === "esignatures"),
    [flowSteps],
  )

  useEffect(() => {
    if (entryMode !== "resume" || resumeStepAppliedRef.current) return
    if (resumeLoading || resumeLoadError || !resumeSavedRef.current) return
    if (questionnaireInFlow && documentsLoading) return
    const saved = resumeSavedRef.current
    const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
    const draftRow = em
      ? findInvestorRowForInvestNowScope(dealInvestors, {
          email: em,
          investmentId: saved.investmentId,
          userInvestorProfileId: saved.userInvestorProfileId,
          profileId: saved.profileId,
        })
      : undefined
    const idx = investNowNav.phaseId
      ? investNowStepIndexForPhaseId(investNowNav.phaseId, flowSteps)
      : investNowStepIndexFromSavedProgress({
          saved,
          showQuestionnaire: questionnaireInFlow,
          visibleSections: visibleQuestionnaireSections,
          questionnaireConfig,
          esignWasSent: draftRow ? investorEsignWasSent(draftRow) : false,
        })
    setStepIndex(idx)
    resumeStepAppliedRef.current = true
  }, [
    entryMode,
    resumeLoading,
    resumeLoadError,
    questionnaireInFlow,
    documentsLoading,
    visibleQuestionnaireSections,
    questionnaireConfig,
    dealInvestors,
    flowSteps,
    investNowNav.phaseId,
  ])

  useEffect(() => {
    setStepIndex((index) => Math.min(index, Math.max(0, flowSteps.length - 1)))
  }, [flowSteps.length])

  useEffect(() => {
    if (stepScrollBootRef.current) {
      stepScrollBootRef.current = false
      return
    }
    scrollMultiStepFormToTopAfterUpdate({ container: investNowFormRef.current })
  }, [stepIndex])

  const minimumInvestmentAmount = useMemo(() => {
    const cls = selectableInvestorClasses.find(
      (c) => c.id === selectedInvestorClassId,
    )
    const display = cls
      ? minimumInvestmentDisplayForClass(cls)
      : previewMinimumInvestmentDisplay(selectableInvestorClasses)
    if (!display || display === "—") return null
    const n = parseMoneyDigits(display)
    return Number.isFinite(n) && n > 0 ? n : null
  }, [selectableInvestorClasses, selectedInvestorClassId])

  const belowMinimumAmountNotice = useMemo(
    () =>
      investNowBelowMinimumAmountNotice({
        amount,
        minimumInvestmentAmount,
      }),
    [amount, minimumInvestmentAmount],
  )

  const backTo = useMemo(() => {
    if (investNowNav.returnTo) return investNowNav.returnTo
    return dealId ? dealWorkspacePath(dealId) : "/investing/investments"
  }, [dealId, investNowNav.returnTo])

  const exitInvestNowFlow = useCallback(
    (options?: { replace?: boolean }) => {
      const id = dealId?.trim()
      if (id) recordRecentlyViewedDeal(id)
      navigate(backTo, options?.replace ? { replace: true } : undefined)
    },
    [backTo, dealId, navigate],
  )

  const goToPendingInvestments = useCallback(() => {
    const id = dealId?.trim()
    if (id) recordRecentlyViewedDeal(id)
    switchToInvesting()
    navigate("/investing/investments?tab=pending", { replace: true })
  }, [dealId, navigate, switchToInvesting])

  useEffect(() => {
    switchToInvesting()
  }, [switchToInvesting])

  useEffect(() => {
    if (!dealId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setSaasPaywallDeal(null)
    const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
    void (async () => {
      try {
        const [deal, classes, inv, members, book] = await Promise.all([
          fetchDealById(dealId),
          fetchDealInvestorClasses(dealId).catch(() => []),
          fetchDealInvestors(dealId, { lpInvestorsOnly: true }).catch(
            () => EMPTY_INVESTORS_PAYLOAD,
          ),
          fetchDealMembers(dealId, {
            referringSponsorRef: referringSponsorRef ?? undefined,
          }).catch(() => emptyDealMembersPayload()),
          fetchMyProfileBook().catch(() => ({
            profiles: [] as InvestorProfileListRow[],
            beneficiaries: [],
            addresses: [] as SavedAddress[],
          })),
        ])
        if (cancelled) return

        if (
          !canInvestorCommitInvestOrOnboard({
            dealStage: deal.dealStage,
            offeringStatus: deal.offeringStatus,
          })
        ) {
          toast.error(
            "This offering is not open for investment yet.",
            "You can preview the deal until its status allows commitments or investing.",
          )
          exitInvestNowFlow({ replace: true })
          return
        }

        const name =
          deal.dealName?.trim() || deal.propertyName?.trim() || "Deal"
        setDealName(name)
        setCloseDate(deal.closeDate)
        setOfferingSize(deal.offeringSize?.trim() ?? "")
        setAppDocumentTitle(`Invest — ${name}`)

        const rows = (book.profiles ?? []).map((p) =>
          normalizeInvestorProfileListRow(p),
        )
        setBookProfileRows(rows)
        setBookAddresses((book.addresses ?? []) as SavedAddress[])

        setDealInvestors(inv.investors)
        setBlockedProfileKeys(new Set())
        setInvestorClasses(classes)
        let resolvedReferringSponsorName =
          members.referringSponsorDisplayName ?? referringSponsorDisplayName
        if (referringSponsorRef?.trim() && !resolvedReferringSponsorName?.trim()) {
          resolvedReferringSponsorName =
            (await fetchReferringSponsorDisplayName(
              dealId,
              referringSponsorRef.trim(),
            )) ?? undefined
        }
        const selfInvestor = inv.investors.find(
          (r) => String(r.userEmail ?? "").trim().toLowerCase() === em,
        )
        setSponsorLabel(
          pickInvestNowSponsorDisplayName(members, {
            referringSponsorDisplayName: resolvedReferringSponsorName,
            investorAddedByDisplayName: selfInvestor?.addedByDisplayName,
            investorAddedByCompanyName: selfInvestor?.addedByCompanyName,
          }),
        )
        if (referringSponsorRef?.trim() && resolvedReferringSponsorName?.trim()) {
          writeOfferingPreviewSponsorAttribution({
            dealId,
            sponsorRef: referringSponsorRef.trim(),
            sponsorDisplayName: resolvedReferringSponsorName.trim(),
          })
        }

        const viewerClass = inv.investors.find(
          (r) => String(r.userEmail ?? "").trim().toLowerCase() === em,
        )?.investorClass
        setSelectedInvestorClassId(
          investNowDefaultInvestorClassId(classes, {
            viewerInvestorClass: viewerClass,
          }),
        )
      } catch (err) {
        if (!cancelled) {
          if (isDealSaasPaymentRequiredError(err)) {
            setSaasPaywallDeal({
              ...err.payload,
              id: err.payload.id || dealId,
            })
          } else {
            exitInvestNowFlow({ replace: true })
          }
        }
      } finally {
        if (!cancelled) {
          setBookLoading(false)
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dealId, navigate, backTo, entryMode, resumeScope, referringSponsorDisplayName, referringSponsorRef])

  useEffect(() => {
    if (entryMode !== "resume" || !dealId || loading) return
    let cancelled = false
    setResumeLoading(true)
    setResumeLoadError("")
    void (async () => {
      const res = await fetchMyLpDealInvestNowCommitment(dealId, resumeScope)
      if (cancelled) return
      if (!res.ok) {
        if (res.notFound) {
          setResumeLoading(false)
          return
        }
        setResumeLoadError(res.message)
        setResumeLoading(false)
        return
      }
      const saved = res.payload
      if (saved.userInvestorProfileId) {
        const resumeProfileId = saved.userInvestorProfileId.trim()
        const resumeProfile = bookProfileRows.find((p) => p.id === resumeProfileId)
        if (resumeProfile && !isInvestorProfileListRowIncomplete(resumeProfile)) {
          setSavedUserProfileId(resumeProfileId)
        }
      }
      const resumeBookProfile = saved.userInvestorProfileId
        ? bookProfileRows.find((p) => p.id === saved.userInvestorProfileId.trim())
        : undefined
      const resumeCommitmentProfileId = resumeBookProfile
        ? commitmentProfileIdFromBookProfile(resumeBookProfile)
        : ""
      if (resumeCommitmentProfileId) setProfileId(resumeCommitmentProfileId)
      else if (saved.profileId) setProfileId(saved.profileId)
      if (saved.investmentId) {
        investNowInvestmentIdRef.current = saved.investmentId
        setInvestNowInvestmentId(saved.investmentId)
      }
      const amt = parseMoneyDigits(saved.committedAmount)
      if (Number.isFinite(amt) && amt > 0) setAmount(String(amt))
      if (saved.fundingMethod?.trim()) setFundingMethod(saved.fundingMethod.trim())
      if (saved.investorClass?.trim()) {
        setSelectedInvestorClassId((prev) =>
          resolveDealInvestorClassId(
            selectableInvestorClasses,
            saved.investorClass,
          ) || prev,
        )
      }
      if (saved.status?.trim()) setStatus(saved.status.trim())
      setDocSignedDate(parseInvestNowDocSignedCalendarDate(saved.docSignedDate))
      if (Object.keys(saved.questionnaireAnswers).length > 0) {
        setQuestionnaireAnswers(saved.questionnaireAnswers)
      }
      const profileIdForPrefill = saved.userInvestorProfileId?.trim() ?? ""
      const savedW9Name = String(saved.w9Form?.name ?? "").trim()
      const resumeProfileRow = profileIdForPrefill
        ? bookProfileRows.find((p) => p.id === profileIdForPrefill)
        : undefined
      const accountW9Name = syndicationAccountW9Name()
      const replaceSavedProfileName = savedW9NameIsInvestorProfileDefault(
        savedW9Name,
        resumeProfileRow,
        accountW9Name,
      )
      if (savedW9Name && profileIdForPrefill && !replaceSavedProfileName) {
        w9NameSourceRef.current = {
          profileId: profileIdForPrefill,
          appliedName: savedW9Name,
        }
        w9NameLockRef.current = true
      } else if (replaceSavedProfileName && profileIdForPrefill) {
        w9NameSourceRef.current = {
          profileId: profileIdForPrefill,
          appliedName: accountW9Name,
        }
        w9NameLockRef.current = false
      }
      setW9Values((prev) => {
        let next = prev
        if (saved.w9Form) {
          next = mergeInvestNowW9Values(next, {
            ...EMPTY_INVEST_NOW_W9,
            name: replaceSavedProfileName ? "" : savedW9Name,
            addressLine: String(
              saved.w9Form?.address_line ?? saved.w9Form?.addressLine ?? "",
            ).trim(),
            street1: String(saved.w9Form?.street1 ?? "").trim(),
            street2: String(saved.w9Form?.street2 ?? "").trim(),
            city: String(saved.w9Form?.city ?? "").trim(),
            state: String(saved.w9Form?.state ?? "").trim(),
            zip: String(saved.w9Form?.zip ?? "").trim(),
            ssn: "",
          })
        }
        if (profileIdForPrefill) {
          next = mergeInvestNowW9Values(
            next,
            buildInvestNowW9Prefill({
              profiles: bookProfileRows,
              addresses: bookAddresses,
              savedUserProfileId: profileIdForPrefill,
              questionnaireAnswers: saved.questionnaireAnswers,
            }),
          )
        }
        return next
      })
      sessionDraftRef.current = true
      resumeSavedRef.current = saved
      setResumeLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [entryMode, dealId, loading, resumeScope, bookProfileRows, bookAddresses, investorClasses, selectableInvestorClasses])

  const w9NameSourceRef = useRef({ profileId: "", appliedName: "" })
  const w9NameLockRef = useRef(false)
  const w9NameUserEditedRef = useRef(false)
  const profileScopeRef = useRef({ savedUserProfileId: "", profileId: "" })
  const freshProfilePreselectRef = useRef(false)

  useEffect(() => {
    if (entryMode !== "fresh" || freshProfilePreselectRef.current || bookLoading) {
      return
    }
    const selectedId = investNowNav.userInvestorProfileId?.trim() ?? ""
    if (!selectedId) return
    const profile = bookProfileRows.find((p) => p.id === selectedId)
    if (!profile || isInvestorProfileListRowIncomplete(profile)) return
    freshProfilePreselectRef.current = true
    setSavedUserProfileId(selectedId)
    const derived = commitmentProfileIdFromBookProfile(profile)
    if (derived) setProfileId(derived)
    else if (investNowNav.profileId?.trim()) setProfileId(investNowNav.profileId.trim())
  }, [
    bookLoading,
    bookProfileRows,
    entryMode,
    investNowNav.profileId,
    investNowNav.userInvestorProfileId,
  ])

  useEffect(() => {
    if (!savedUserProfileId.trim()) return
    const profile = bookProfileRows.find((p) => p.id === savedUserProfileId)
    if (!profile) return
    const next = commitmentProfileIdFromBookProfile(profile)
    if (next) setProfileId((prev) => (prev === next ? prev : next))
  }, [bookProfileRows, savedUserProfileId])

  /** Fresh Invest now: each profile selection starts with an empty amount. */
  useEffect(() => {
    if (entryMode === "resume" || sessionDraftRef.current) return
    setAmount("")
    setFundingMethod("")
  }, [savedUserProfileId, entryMode])

  /** Prefill SSN from the user's earliest saved profile; never overwrite session entries. */
  useEffect(() => {
    const knownSsn = ssnFromAnyInvestorProfile(bookProfileRows)
    if (!knownSsn) return

    setW9Values((prev) => {
      if (prev.ssn.trim()) return prev
      return prev.ssn === knownSsn ? prev : { ...prev, ssn: knownSsn }
    })
    setQuestionnaireAnswers((prev) => {
      const current = String(prev.social_security_number ?? "").trim()
      if (current) return prev
      return current === knownSsn
        ? prev
        : { ...prev, social_security_number: knownSsn }
    })
  }, [savedUserProfileId, bookProfileRows])

  const investNowEsignScope = useMemo(
    () => ({
      userInvestorProfileId: savedUserProfileId.trim() || undefined,
      investmentId: investNowInvestmentId?.trim() || undefined,
      profileId: profileId.trim() || undefined,
    }),
    [savedUserProfileId, investNowInvestmentId, profileId],
  )

  /** Type comes from the profile the investor picked, not the Add Investors selection. */
  const selectedCommitmentProfileId = useMemo(() => {
    const selectedId = savedUserProfileId.trim()
    if (selectedId) {
      const profile = bookProfileRows.find((p) => p.id === selectedId)
      const derived = profile
        ? commitmentProfileIdFromBookProfile(profile)
        : ""
      if (derived) return derived
    }
    return profileId.trim()
  }, [bookProfileRows, profileId, savedUserProfileId])

  const selectedProfileUseKey = useMemo(
    () => lpProfileUseKey(selectedCommitmentProfileId, savedUserProfileId),
    [selectedCommitmentProfileId, savedUserProfileId],
  )

  const selectedProfileAlreadyUsed = useMemo(() => {
    const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
    const key = selectedProfileUseKey.trim()
    if (!em || !key || !selectedCommitmentProfileId || !savedUserProfileId.trim()) {
      return false
    }
    const currentInvestmentId = investNowInvestmentId?.trim().toLowerCase() ?? ""
    return dealInvestors.some((row) => {
      if (String(row.userEmail ?? "").trim().toLowerCase() !== em) return false
      // Roster rows mean the person is on the deal; only investment rows mean
      // this saved profile was already used for an investment on this deal.
      if (row.investorKind && row.investorKind !== "investment") return false
      if (
        currentInvestmentId &&
        String(row.id ?? "").trim().toLowerCase() === currentInvestmentId
      ) {
        return false
      }
      return lpProfileUseKey(
        String(row.profileId ?? ""),
        row.userInvestorProfileId,
      ) === key
    })
  }, [
    dealInvestors,
    investNowInvestmentId,
    selectedCommitmentProfileId,
    savedUserProfileId,
    selectedProfileUseKey,
  ])

  const selectedProfileExistingInvestmentId = useMemo(() => {
    const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
    const key = selectedProfileUseKey.trim()
    if (!em || !key || !selectedCommitmentProfileId || !savedUserProfileId.trim()) {
      return ""
    }
    const row = dealInvestors.find((investor) => {
      if (String(investor.userEmail ?? "").trim().toLowerCase() !== em) return false
      if (investor.investorKind && investor.investorKind !== "investment") return false
      if (investorEsignIsFullyCompletedForRow(investor)) return false
      return lpProfileUseKey(
        String(investor.profileId ?? ""),
        investor.userInvestorProfileId,
      ) === key
    })
    return String(row?.id ?? "").trim()
  }, [dealInvestors, selectedCommitmentProfileId, savedUserProfileId, selectedProfileUseKey])

  useEffect(() => {
    const nextSaved = savedUserProfileId.trim()
    const nextProfile = profileId.trim()
    const prev = profileScopeRef.current
    const scopeChanged =
      (prev.savedUserProfileId !== nextSaved || prev.profileId !== nextProfile) &&
      (prev.savedUserProfileId !== "" || prev.profileId !== "")
    profileScopeRef.current = {
      savedUserProfileId: nextSaved,
      profileId: nextProfile,
    }
    if (!scopeChanged) return

    setEsignDocuments([])
    setEsignCompleted(false)
    setEsignPending(false)
    setEsignSignatureRequestId(null)
    setEsignSendOk(false)
    setEsignSendError(null)
    setInvestNowInvestmentId(null)
    investNowInvestmentIdRef.current = null
    setWebhookSignStatus(null)
  }, [savedUserProfileId, profileId])

  useEffect(() => {
    if (questionnaireInFlow) return
    setQuestionnaireAnswers((prev) =>
      Object.keys(prev).length === 0 ? prev : {},
    )
  }, [questionnaireInFlow])

  useEffect(() => {
    if (sessionDraftRef.current) return
    if (!questionnaireInFlow || !savedUserProfileId.trim()) return
    const prefill = buildInvestNowQuestionnairePrefill({
      profiles: bookProfileRows,
      addresses: bookAddresses,
      savedUserProfileId,
      config: questionnaireConfig,
    })
    setQuestionnaireAnswers((prev) =>
      mergeInvestNowQuestionnaireAnswers(prev, prefill),
    )
  }, [
    questionnaireInFlow,
    savedUserProfileId,
    bookProfileRows,
    bookAddresses,
    questionnaireConfig,
  ])

  useEffect(() => {
    if (!dealId || !profileId.trim()) return
    let cancelled = false
    setDocumentsLoading(true)
    void (async () => {
      const [esignRes, questionnaireRes] = await Promise.all([
        fetchDealEsignTemplates(dealId),
        fetchDealInvestorQuestionnaire(dealId),
      ])
      if (cancelled) return
      if (esignRes.ok) setEsignFilesByCategory(esignRes.filesByCategory)
      if (questionnaireRes.ok) setQuestionnaireConfig(questionnaireRes.config)
      setDocumentsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [dealId, profileId])

  useEffect(() => {
    if (!savedUserProfileId.trim()) return
    const prefill = buildInvestNowW9Prefill({
      profiles: bookProfileRows,
      addresses: bookAddresses,
      savedUserProfileId,
      questionnaireAnswers,
    })
    const profileChanged =
      w9NameSourceRef.current.profileId !== savedUserProfileId
    if (profileChanged && !w9NameUserEditedRef.current) {
      w9NameLockRef.current = false
    }
    setW9Values((prev) => {
      const merged = mergeInvestNowW9Values(prev, prefill)
      if (w9NameUserEditedRef.current) return merged
      const nextName = prefill.name.trim()
      const currentName = prev.name.trim()
      const autoFilled =
        !currentName || currentName === w9NameSourceRef.current.appliedName
      const mayApplyName =
        Boolean(nextName) &&
        !w9NameLockRef.current &&
        (profileChanged || autoFilled) &&
        currentName !== nextName
      if (!mayApplyName) {
        if (profileChanged) {
          w9NameSourceRef.current = {
            profileId: savedUserProfileId,
            appliedName: currentName || nextName,
          }
        }
        return merged
      }
      w9NameSourceRef.current = {
        profileId: savedUserProfileId,
        appliedName: nextName,
      }
      return { ...merged, name: nextName }
    })
  }, [
    savedUserProfileId,
    bookProfileRows,
    bookAddresses,
    questionnaireAnswers,
  ])

  useEffect(() => {
    if (!savedUserProfileId.trim()) return
    const addressPrefill = buildQuestionnaireAddressPrefillFromW9(w9Values)
    if (Object.keys(addressPrefill).length === 0) return
    setQuestionnaireAnswers((prev) =>
      mergeInvestNowQuestionnaireAnswers(prev, addressPrefill),
    )
  }, [savedUserProfileId, w9Values])

  useEffect(() => {
    if (stepIndex !== w9StepIndex || w9StepIndex < 0 || !savedUserProfileId.trim()) {
      return
    }
    const prefill = buildInvestNowW9Prefill({
      profiles: bookProfileRows,
      addresses: bookAddresses,
      savedUserProfileId,
      questionnaireAnswers,
    })
    setW9Values((prev) => mergeInvestNowW9Values(prev, prefill))
  }, [
    stepIndex,
    w9StepIndex,
    savedUserProfileId,
    bookProfileRows,
    bookAddresses,
    questionnaireAnswers,
  ])

  const profileDropdownOptions = useMemo(() => {
    const active = bookProfileRows.filter(
      (p) => p.profileName?.trim() && !isInvestorProfileListRowIncomplete(p),
    )
    return active.map((p) => {
      const pid = commitmentProfileIdFromBookProfile(p)
      const key = lpProfileUseKey(pid, p.id)
      return investNowProfileDropdownOption(
        {
          id: p.id,
          profileName: p.profileName,
          profileType: bookProfileTypeDisplayLabel(p),
        },
        !pid || blockedProfileKeys.has(key),
      )
    })
  }, [bookProfileRows, blockedProfileKeys])

  useEffect(() => {
    const selected = savedUserProfileId.trim()
    if (!selected) return
    const row = bookProfileRows.find((p) => p.id === selected)
    if (row && isInvestorProfileListRowIncomplete(row)) {
      setSavedUserProfileId("")
    }
  }, [bookProfileRows, savedUserProfileId])

  const clearInvestNowFieldErrors = useCallback((...keys: string[]) => {
    if (keys.length === 0) {
      setFieldErrors({})
      return
    }
    setFieldErrors((prev) => {
      const next = { ...prev }
      for (const key of keys) delete next[key]
      return next
    })
  }, [])

  const resolveDuplicateProfileConfirmation = useCallback((confirmed: boolean) => {
    const resolve = duplicateProfileConfirmResolveRef.current
    duplicateProfileConfirmResolveRef.current = null
    setDuplicateProfileConfirmMessage("")
    if (resolve) resolve(confirmed)
  }, [])

  const requestDuplicateProfileConfirmation = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      duplicateProfileConfirmResolveRef.current = resolve
      setDuplicateProfileConfirmMessage(message)
    })
  }, [])

  const reportInvestNowFieldValidation = useCallback(
    (errors: InvestNowFieldErrors, opts?: { stepError?: string | null }) => {
      setFieldErrors(errors)
      setError(opts?.stepError?.trim() ?? "")
      const firstKey = investNowFieldErrorKeys(errors)[0]
      focusFirstFormErrorAfterUpdate({
        container: investNowFormRef.current,
        preferSelector: firstKey
          ? investNowFieldPreferSelector(firstKey)
          : undefined,
      })
    },
    [],
  )

  const trackInvestmentRowAfterSave = useCallback(
    (
      investors: { investors: DealInvestorRow[] },
      savedInvestmentId?: string | null,
    ) => {
      const explicit = savedInvestmentId?.trim()
      if (explicit) {
        investNowInvestmentIdRef.current = explicit
        setInvestNowInvestmentId(explicit)
      } else {
        const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
        const rowId = investNowCommitmentRowIdForScope(investors.investors, {
          email: em,
          profileId: selectedCommitmentProfileId,
          userInvestorProfileId: savedUserProfileId.trim(),
        })
        if (rowId) {
          investNowInvestmentIdRef.current = rowId
          setInvestNowInvestmentId(rowId)
        }
      }
      sessionDraftRef.current = true
    },
    [selectedCommitmentProfileId, savedUserProfileId],
  )

  const persistInvestNowProgress = useCallback(
    async (opts: {
      committedAmount?: string
      progressOnly?: boolean
      skipCommittedAmount?: boolean
      fundingMethod?: string
      status?: string
      questionnaireAnswers?: Record<string, string>
      w9Form?: Record<string, string>
      allowDuplicateProfile?: boolean
    }): Promise<string | null> => {
      const submitStatus =
        opts.status?.trim() || status.trim() || "Open to investment"
      setSubmitting(true)
      setError("")
      const res = await patchMyLpDealInvestNowCommitment(
        dealId,
        opts.committedAmount,
        {
          profileId: selectedCommitmentProfileId,
          status: submitStatus,
          docSignedDate: parseInvestNowDocSignedCalendarDate(docSignedDate),
          includeUserInvestorProfileInBody: true,
          userInvestorProfileId: savedUserProfileId.trim(),
          progressOnly: opts.progressOnly,
          skipCommittedAmount: opts.skipCommittedAmount,
          replaceCommittedAmount: true,
          investmentId:
            addNewCommitment && !investNowInvestmentIdRef.current?.trim()
              ? undefined
              : investNowInvestmentIdRef.current?.trim() || undefined,
          allowDuplicateProfile:
            opts.allowDuplicateProfile ||
            (addNewCommitment && !investNowInvestmentIdRef.current?.trim()),
          ...(opts.fundingMethod !== undefined
            ? { fundingMethod: opts.fundingMethod }
            : fundingMethod.trim()
              ? { fundingMethod: fundingMethod.trim() }
              : {}),
          ...(selectedInvestorClassId.trim()
            ? { investorClassId: selectedInvestorClassId.trim() }
            : {}),
          ...(opts.questionnaireAnswers &&
          Object.keys(opts.questionnaireAnswers).length > 0
            ? { questionnaireAnswers: opts.questionnaireAnswers }
            : questionnaireInFlow && Object.keys(questionnaireAnswers).length > 0
              ? { questionnaireAnswers }
              : {}),
          ...(opts.w9Form ? { w9Form: opts.w9Form } : {}),
          ...(referringSponsorRef ? { referringSponsorRef } : {}),
        },
      )
      setSubmitting(false)
      if (!res.ok) return res.message
      trackInvestmentRowAfterSave(res.investorsPayload, res.investmentId)
      return null
    },
    [
      status,
      docSignedDate,
      dealId,
      selectedCommitmentProfileId,
      savedUserProfileId,
      fundingMethod,
      questionnaireInFlow,
      questionnaireAnswers,
      selectedInvestorClassId,
      trackInvestmentRowAfterSave,
      referringSponsorRef,
      addNewCommitment,
    ],
  )

  const onContinueFromInvestor = useCallback(async () => {
    const { fieldErrors: nextFieldErrors, stepError } =
      validateInvestNowInvestorFields({
        bookLoading,
        savedUserProfileId,
        profileId: selectedCommitmentProfileId,
        bookProfileRows,
        blockedProfileKeys,
        selectedInvestorClassId,
        investorClasses,
        sponsorLabel,
      })
    if (stepError || hasInvestNowFieldErrors(nextFieldErrors)) {
      reportInvestNowFieldValidation(nextFieldErrors, { stepError })
      return
    }
    setError("")
    clearInvestNowFieldErrors()
    const selectedKey = selectedProfileUseKey.trim()
    const existingInvestmentId = selectedProfileExistingInvestmentId.trim()
    if (
      !addNewCommitment &&
      !investNowInvestmentIdRef.current?.trim() &&
      existingInvestmentId
    ) {
      investNowInvestmentIdRef.current = existingInvestmentId
      setInvestNowInvestmentId(existingInvestmentId)
    }
    let allowDuplicateProfile =
      addNewCommitment ||
      (Boolean(selectedKey) &&
        duplicateProfileOverrideKeyRef.current === selectedKey)
    if (
      !addNewCommitment &&
      !investNowInvestmentIdRef.current?.trim() &&
      selectedProfileAlreadyUsed &&
      !allowDuplicateProfile
    ) {
      const confirmed = await requestDuplicateProfileConfirmation(
        "You have already used this investor profile for this deal. Continuing will create another investment with the same profile.",
      )
      if (!confirmed) return
      duplicateProfileOverrideKeyRef.current = selectedKey
      allowDuplicateProfile = true
    }
    const saveErr = await persistInvestNowProgress({
      progressOnly: true,
      skipCommittedAmount: true,
      allowDuplicateProfile,
    })
    if (saveErr) {
      setError(saveErr)
      return
    }
    setStepIndex(1)
  }, [
    bookLoading,
    savedUserProfileId,
    profileId,
    bookProfileRows,
    blockedProfileKeys,
    selectedInvestorClassId,
    investorClasses,
    sponsorLabel,
    reportInvestNowFieldValidation,
    clearInvestNowFieldErrors,
    persistInvestNowProgress,
    requestDuplicateProfileConfirmation,
    selectedProfileExistingInvestmentId,
    selectedProfileAlreadyUsed,
    selectedProfileUseKey,
    addNewCommitment,
  ])

  const validateAllQuestionnaireAndW9Fields = useCallback((): {
    stepError: string | null
    fieldErrors: InvestNowFieldErrors
  } => {
    if (documentsLoading) {
      return { stepError: "Loading documents…", fieldErrors: {} }
    }
    if (questionnaireInFlow) {
      const questionnaireErr = validateInvestNowQuestionnaireAnswers({
        config: questionnaireConfig,
        visibleSections: visibleQuestionnaireSections,
        answers: questionnaireAnswers,
      })
      if (questionnaireErr) {
        if (typeof questionnaireErr === "string") {
          return { stepError: questionnaireErr, fieldErrors: {} }
        }
        return {
          stepError: null,
          fieldErrors: {
            [questionnaireErr.questionId]: questionnaireErr.message,
          },
        }
      }
    }
    const w9FieldErrors = validateInvestNowW9Fields(w9Values)
    if (hasInvestNowFieldErrors(w9FieldErrors)) {
      return { stepError: null, fieldErrors: w9FieldErrors }
    }
    return { stepError: null, fieldErrors: {} }
  }, [
    documentsLoading,
    questionnaireInFlow,
    visibleQuestionnaireSections,
    questionnaireConfig,
    questionnaireAnswers,
    w9Values,
  ])

  const goToStepIndexForFieldValidation = useCallback(
    (errors: InvestNowFieldErrors) => {
      const firstKey = investNowFieldErrorKeys(errors)[0]
      if (!firstKey) return

      if (
        firstKey === INVEST_NOW_FIELD.amount ||
        firstKey === INVEST_NOW_FIELD.fundingMethod
      ) {
        setStepIndex(1)
        return
      }
      if (
        firstKey === INVEST_NOW_FIELD.profile ||
        firstKey === INVEST_NOW_FIELD.investmentClass ||
        firstKey === INVEST_NOW_FIELD.sponsor
      ) {
        setStepIndex(0)
        return
      }
      if (
        firstKey === INVEST_NOW_FIELD.w9Name ||
        firstKey === INVEST_NOW_FIELD.w9Address ||
        firstKey === INVEST_NOW_FIELD.w9Ssn
      ) {
        if (w9StepIndex >= 0) setStepIndex(w9StepIndex)
        return
      }
      if (questionnaireInFlow && firstQuestionnaireStepIndex >= 0) {
        for (const section of visibleQuestionnaireSections) {
          const sectionErr = validateInvestNowQuestionnaireSection({
            config: questionnaireConfig,
            sectionId: section.id,
            answers: questionnaireAnswers,
          })
          if (sectionErr) {
            const questionId =
              typeof sectionErr === "string" ? null : sectionErr.questionId
            if (questionId === firstKey || !questionId) {
              const idx = flowSteps.findIndex(
                (s) =>
                  s.kind === "questionnaire" && s.sectionId === section.id,
              )
              if (idx >= 0) setStepIndex(idx)
              return
            }
          }
        }
      }
      if (w9StepIndex >= 0) setStepIndex(w9StepIndex)
    },
    [
      questionnaireInFlow,
      firstQuestionnaireStepIndex,
      visibleQuestionnaireSections,
      questionnaireConfig,
      questionnaireAnswers,
      flowSteps,
      w9StepIndex,
    ],
  )

  const onContinueFromInvestment = useCallback(async () => {
    const nextFieldErrors = validateInvestNowInvestmentFields({
      amount,
      fundingMethod,
      investorClasses,
      selectedInvestorClassId,
      minimumInvestmentAmount,
    })
    if (hasInvestNowFieldErrors(nextFieldErrors)) {
      reportInvestNowFieldValidation(nextFieldErrors)
      return
    }
    setError("")
    clearInvestNowFieldErrors()
    const n = parseMoneyDigits(String(amount).trim())
    const saveErr = await persistInvestNowProgress({
      committedAmount: String(n),
      fundingMethod: fundingMethod.trim(),
    })
    if (saveErr) {
      setError(saveErr)
      return
    }
    setStepIndex((prev) => prev + 1)
  }, [
    amount,
    fundingMethod,
    investorClasses,
    minimumInvestmentAmount,
    reportInvestNowFieldValidation,
    clearInvestNowFieldErrors,
    persistInvestNowProgress,
  ])

  const investorDisplayName = useMemo(() => {
    const p = bookProfileRows.find((row) => row.id === savedUserProfileId)
    return p?.profileName?.trim() || ""
  }, [bookProfileRows, savedUserProfileId])

  const esignProfileLabel = useMemo(
    () => esignCategoryLabel(esignCategoryId),
    [esignCategoryId],
  )

  const refreshWebhookSignStatus = useCallback(
    async (investmentId: string, expectedSignatureRequestId?: string | null) => {
      const id = investmentId.trim()
      if (!id) return
      setSignStatusLoading(true)
      const res = await fetchInvestmentSignStatus(id)
      setSignStatusLoading(false)
      if (!res.ok) return
      setWebhookSignStatus(res.payload)
      const webhookSig = res.payload.signature_request_id?.trim() ?? ""
      const expected = expectedSignatureRequestId?.trim() ?? ""
      const sigMatches =
        !expected || !webhookSig || webhookSig === expected
      if (res.payload.status === "Completed" && sigMatches) {
        setEsignCompleted(true)
        setEsignPending(false)
      }
    },
    [],
  )


  const loadEsignStepData = useCallback(async (): Promise<boolean> => {
    if (!dealId.trim()) return false
    if (esignSendInFlightRef.current) return false
    const commitmentProfileId = profileId.trim()
    if (!commitmentProfileId) return false
    if (resumeLoading || bookLoading) return false
    esignSendInFlightRef.current = true
    setEsignLoading(true)
    setEsignSendError(null)
    setEsignSendOk(false)
    let trackedInvestmentId = investNowInvestmentIdRef.current?.trim() || null
    const w9Payload = investNowW9FormApiPayload(w9Values)
    try {
      if (!trackedInvestmentId && savedUserProfileId.trim()) {
        const n = parseMoneyDigits(String(amount).trim())
        if (Number.isFinite(n) && n > 0) {
          const saveErr = await persistInvestNowProgress({
            committedAmount: String(n),
            w9Form: w9Payload,
            ...(Object.keys(questionnaireAnswers).length > 0
              ? { questionnaireAnswers }
              : {}),
          })
          if (saveErr) {
            setEsignSendError(saveErr)
            setEsignSendOk(false)
            return false
          }
          trackedInvestmentId = investNowInvestmentIdRef.current?.trim() || null
        }
      }

      const sendRes = await postMyLpDealInvestNowEsignSend(dealId, {
        profileId: commitmentProfileId,
        memberDisplayName: investorDisplayName,
        userInvestorProfileId: savedUserProfileId.trim() || undefined,
        investmentId: trackedInvestmentId ?? undefined,
        ...(Object.keys(questionnaireAnswers).length > 0
          ? { questionnaireAnswers }
          : {}),
        w9Form: w9Payload,
      })
      if (!sendRes.ok) {
        setEsignSendError(sendRes.message)
        setEsignSendOk(false)
        return false
      }

      setEsignSendError(null)
      setEsignSendOk(true)
      const sentSigId = sendRes.signatureRequestId?.trim() || null
      setEsignSignatureRequestId(sentSigId)
      const invId = sendRes.investmentId?.trim() || null
      if (invId) {
        trackedInvestmentId = invId
        investNowInvestmentIdRef.current = invId
        setInvestNowInvestmentId(invId)
      }

      const scopeForFetch = {
        userInvestorProfileId: savedUserProfileId.trim() || undefined,
        investmentId: trackedInvestmentId ?? undefined,
        profileId: profileId.trim() || undefined,
      }
      const docs = await fetchDealMyEsignDocuments(dealId, scopeForFetch)
      setSequentialSignTurnOpen(docs.sequentialSignTurnOpen !== false)
      setAwaitingSequentialSignTurn(Boolean(docs.awaitingSequentialSignTurn))
      const signTurnOpen = docs.sequentialSignTurnOpen !== false
      const profileDocs = filterMyEsignDocumentsForCategory(
        docs.documents,
        esignCategoryIdFromCommitmentProfile(profileId.trim()),
      )
      const fallbackSigId = sendRes.signatureRequestId?.trim() || null
      const profileSignatureRequestId =
        fallbackSigId ||
        profileDocs
          .map((d) => d.signatureRequestId?.trim())
          .find(Boolean) ||
        null
      let mappedRows = mapMyEsignDocumentsToInvestNowRows(profileDocs).map((row) => {
        if (row.status !== "pending" || row.signatureRequestId?.trim()) {
          return row
        }
        if (!fallbackSigId) return row
        return { ...row, signatureRequestId: fallbackSigId }
      })
      if (
        mappedRows.length === 0 &&
        fallbackSigId &&
        !sendRes.alreadyCompleted
      ) {
        const names =
          sendRes.documentNames?.length > 0
            ? sendRes.documentNames
            : [
                (esignTemplate
                  ? esignTemplateDisplayName(esignTemplate)
                  : null) || "Subscription document",
              ]
        mappedRows = names.map((name, index) => ({
          id: `sent-${fallbackSigId}-${index}`,
          name,
          url: "",
          status: "pending" as const,
          canSign: signTurnOpen,
          signatureRequestId: signTurnOpen ? fallbackSigId : undefined,
        }))
      }
      setEsignDocuments(mappedRows)
      const profileCompleted =
        docs.esignCompleted ||
        (profileDocs.length > 0 && profileDocs.every((d) => d.status === "signed"))
      const profilePending =
        profileDocs.length > 0
          ? profileDocs.some((d) => d.status !== "signed")
          : Boolean(
              !sendRes.alreadyCompleted &&
                (sendRes.alreadySent || Boolean(profileSignatureRequestId)),
            )
      const completed =
        profileCompleted ||
        Boolean(
          sendRes.alreadyCompleted &&
            profileDocs.length > 0 &&
            profileDocs.every((d) => d.status === "signed"),
        )
      setEsignPending(profilePending)
      setEsignCompleted(completed)
      setEsignWorkflowLabel(investNowWorkflowLabelForProfileDocs(profileDocs))
      if (trackedInvestmentId) {
        await refreshWebhookSignStatus(
          trackedInvestmentId,
          profileSignatureRequestId,
        )
      }
      return completed
    } finally {
      esignSendInFlightRef.current = false
      setEsignLoading(false)
    }
  }, [
    dealId,
    profileId,
    savedUserProfileId,
    investNowEsignScope,
    investorDisplayName,
    questionnaireInFlow,
    questionnaireAnswers,
    w9Values,
    investNowInvestmentId,
    refreshWebhookSignStatus,
    resumeLoading,
    bookLoading,
    amount,
    persistInvestNowProgress,
  ])

  const loadEsignStepDataRef = useRef(loadEsignStepData)
  loadEsignStepDataRef.current = loadEsignStepData

  /** Load e-sign step data when entering the step — not on every callback identity change. */
  useEffect(() => {
    if (stepIndex !== esignStepIndex || esignStepIndex < 0 || !dealId) return
    if (resumeLoading || bookLoading) return
    if (!profileId.trim()) return
    void loadEsignStepDataRef.current()
  }, [
    stepIndex,
    esignStepIndex,
    dealId,
    profileId,
    savedUserProfileId,
    resumeLoading,
    bookLoading,
  ])

  useEffect(() => {
    const invId = investNowInvestmentId?.trim()
    if (
      stepIndex !== esignStepIndex ||
      esignStepIndex < 0 ||
      !invId ||
      esignCompleted
    ) {
      return
    }
    const timer = window.setInterval(() => {
      void refreshWebhookSignStatus(invId, esignSignatureRequestId)
    }, 8000)
    return () => window.clearInterval(timer)
  }, [
    stepIndex,
    esignStepIndex,
    investNowInvestmentId,
    esignSignatureRequestId,
    esignCompleted,
    refreshWebhookSignStatus,
  ])


  const validateEsignaturesStep = useCallback((): string | null => {
    if (esignLoading) return "Loading e-sign documents…"
    if (!esignTemplate) {
      return `No eSign document is configured for ${esignProfileLabel} on this deal. Your sponsor must add investor fields for this profile in the eSign template editor.`
    }
    if (!isDealEsignTemplateReady(esignTemplate) && !esignCompleted) {
      return "Your subscription document is not ready for signing yet"
    }
    if (!esignSendOk && !esignCompleted && !esignLoading) {
      return esignSendError ?? "Could not prepare eSign documents. Use Retry on this step."
    }
    if (esignSendError && !esignPending && !esignCompleted) {
      return esignSendError
    }
    const webhookSig = webhookSignStatus?.signature_request_id?.trim() ?? ""
    const activeSig = esignSignatureRequestId?.trim() ?? ""
    const webhookComplete =
      webhookSignStatus?.status === "Completed" &&
      (!activeSig || !webhookSig || webhookSig === activeSig)
    if (!esignCompleted && !webhookComplete) {
      return "Sign all required documents before finishing"
    }
    return null
  }, [
    esignLoading,
    esignTemplate,
    esignProfileLabel,
    esignSendOk,
    esignSendError,
    esignPending,
    esignCompleted,
    webhookSignStatus,
  ])

  const saveCommitment = useCallback(async (): Promise<string | null> => {
    const n = parseMoneyDigits(String(amount).trim())
    const err = await persistInvestNowProgress({
      committedAmount: String(n),
      w9Form: investNowW9FormApiPayload(w9Values),
      ...(Object.keys(questionnaireAnswers).length > 0
        ? { questionnaireAnswers }
        : {}),
    })
    if (err) return err
    return null
  }, [amount, w9Values, questionnaireAnswers, persistInvestNowProgress])

  const saveDraftForMissingEsign = useCallback(async (): Promise<string | null> => {
    const n = parseMoneyDigits(String(amount).trim())
    setSubmitting(true)
    const err = await persistInvestNowProgress({
      committedAmount: Number.isFinite(n) && n > 0 ? String(n) : undefined,
      skipCommittedAmount: !(Number.isFinite(n) && n > 0),
      progressOnly: !(Number.isFinite(n) && n > 0),
      status: "Soft committed",
      w9Form: investNowW9FormApiPayload(w9Values),
      ...(Object.keys(questionnaireAnswers).length > 0
        ? { questionnaireAnswers }
        : {}),
    })
    setSubmitting(false)
    if (err) return err

    upsertRuntimeInvestmentRow({
      dealId,
      investmentName: dealName,
      offeringName: dealName,
      investmentProfile: investorProfileLabel(profileId.trim()),
      commitmentProfileId: profileId.trim() || undefined,
      userInvestorProfileId: savedUserProfileId.trim() || undefined,
      investedAmount: Number.isFinite(n) && n > 0 ? n : 0,
      distributedAmount: 0,
      currentValuation: offeringSize || "—",
      dealCloseDate: formatDealCloseDateForInvestments(closeDate?.trim()),
      status: "Soft committed",
      actionRequired: "Resume investing",
      onboardingBucket: "pending",
      hasInvestNowDraft: true,
    })
    return null
  }, [
    amount,
    w9Values,
    questionnaireAnswers,
    persistInvestNowProgress,
    dealId,
    dealName,
    profileId,
    savedUserProfileId,
    offeringSize,
    closeDate,
  ])

  const onContinueFromCurrentStep = useCallback(async () => {
    const stepDef = flowSteps[stepIndex]
    if (!stepDef) return

    if (stepDef.kind === "investor") {
      await onContinueFromInvestor()
      return
    }

    if (stepDef.kind === "investment") {
      await onContinueFromInvestment()
      return
    }

    if (stepDef.kind === "questionnaire") {
      if (documentsLoading) {
        setFieldErrors({})
        setError("Loading questionnaire…")
        return
      }
      if (!questionnaireConfig) {
        setFieldErrors({})
        setError("Questionnaire is not loaded yet")
        return
      }
      const sectionResult = validateInvestNowQuestionnaireSection({
        config: questionnaireConfig,
        sectionId: stepDef.sectionId,
        answers: questionnaireAnswers,
      })
      if (sectionResult) {
        if (typeof sectionResult === "string") {
          reportInvestNowFieldValidation({}, { stepError: sectionResult })
        } else {
          reportInvestNowFieldValidation({
            [sectionResult.questionId]: sectionResult.message,
          })
        }
        return
      }
      const n = parseMoneyDigits(String(amount).trim())
      const saveErr = await persistInvestNowProgress({
        committedAmount: Number.isFinite(n) && n > 0 ? String(n) : undefined,
        skipCommittedAmount: !(Number.isFinite(n) && n > 0),
        progressOnly: !(Number.isFinite(n) && n > 0),
        questionnaireAnswers,
      })
      if (saveErr) {
        setError(saveErr)
        return
      }
      setError("")
      clearInvestNowFieldErrors()
      setStepIndex(stepIndex + 1)
      return
    }

    if (stepDef.kind === "w9") {
      const investorValidation = validateInvestNowInvestorFields({
        bookLoading,
        savedUserProfileId,
        profileId: selectedCommitmentProfileId,
        bookProfileRows,
        blockedProfileKeys,
        selectedInvestorClassId,
        investorClasses,
        sponsorLabel,
      })
      if (
        investorValidation.stepError ||
        hasInvestNowFieldErrors(investorValidation.fieldErrors)
      ) {
        setStepIndex(0)
        reportInvestNowFieldValidation(investorValidation.fieldErrors, {
          stepError: investorValidation.stepError,
        })
        return
      }
      const investmentFieldErrors = validateInvestNowInvestmentFields({
        amount,
        fundingMethod,
        investorClasses,
        selectedInvestorClassId,
        minimumInvestmentAmount,
      })
      if (hasInvestNowFieldErrors(investmentFieldErrors)) {
        setStepIndex(1)
        reportInvestNowFieldValidation(investmentFieldErrors)
        return
      }
      const documentsValidation = validateAllQuestionnaireAndW9Fields()
      if (
        documentsValidation.stepError ||
        hasInvestNowFieldErrors(documentsValidation.fieldErrors)
      ) {
        goToStepIndexForFieldValidation(documentsValidation.fieldErrors)
        window.setTimeout(() => {
          reportInvestNowFieldValidation(documentsValidation.fieldErrors, {
            stepError: documentsValidation.stepError,
          })
        }, 80)
        return
      }
      const commitErr = await saveCommitment()
      if (commitErr) {
        setError(commitErr)
        return
      }
      setError("")
      clearInvestNowFieldErrors()
      setStepIndex(stepIndex + 1)
      return
    }
  }, [
    flowSteps,
    stepIndex,
    onContinueFromInvestor,
    onContinueFromInvestment,
    persistInvestNowProgress,
    amount,
    documentsLoading,
    questionnaireConfig,
    questionnaireAnswers,
    bookLoading,
    savedUserProfileId,
    profileId,
    bookProfileRows,
    blockedProfileKeys,
    selectedInvestorClassId,
    investorClasses,
    sponsorLabel,
    fundingMethod,
    minimumInvestmentAmount,
    validateAllQuestionnaireAndW9Fields,
    goToStepIndexForFieldValidation,
    saveCommitment,
    reportInvestNowFieldValidation,
    clearInvestNowFieldErrors,
  ])

  const onFinish = useCallback(async () => {
    if (finishStartedRef.current) return
    // Finish runs only on the e-sign step — do not re-open step 1 (profile picker).
    const esignErr = validateEsignaturesStep()
    if (esignErr) {
      const esignSetupMissing =
        !esignTemplate || (!isDealEsignTemplateReady(esignTemplate) && !esignCompleted)
      const esignServiceUnavailable =
        esignFailureAllowsSoftCommitment(esignErr)
      if (esignSetupMissing || esignServiceUnavailable) {
        setError("")
        setFieldErrors({})
        setDraftSavedModalOpen(true)
        return
      }
      if (esignStepIndex >= 0) setStepIndex(esignStepIndex)
      setFieldErrors({})
      setError(esignErr)
      focusFirstFormErrorAfterUpdate({ container: investNowFormRef.current })
      return
    }
    finishStartedRef.current = true
    setSubmitting(true)
    try {
      const mail = await postMyLpDealInvestNowCommitmentComplete(dealId, {
        investmentId: investNowInvestmentIdRef.current?.trim() || undefined,
        referringSponsorRef: referringSponsorRef?.trim() || undefined,
      })
      if (!mail.ok) {
        console.warn("investment commitment email:", mail.message)
      }
    } catch (err) {
      console.warn("investment commitment email:", err)
    }
    const n = parseMoneyDigits(String(amount).trim())

    // Investor contributions: workflow — Stripe Checkout disabled for now
    // if (fundingMethod.trim() === "stripe_checkout") {
    //   const investmentId = investNowInvestmentIdRef.current?.trim() ?? ""
    //   if (!investmentId) {
    //     finishStartedRef.current = false
    //     setSubmitting(false)
    //     setError("Could not identify the saved investment for payment.")
    //     return
    //   }
    //   try {
    //     const checkout = await startInvestorInvestmentCheckout(
    //       dealId,
    //       investmentId,
    //     )
    //     window.location.assign(checkout.url)
    //     return
    //   } catch (err) {
    //     finishStartedRef.current = false
    //     setSubmitting(false)
    //     setError(
    //       err instanceof Error
    //         ? err.message
    //         : "Could not start Stripe Checkout.",
    //     )
    //     focusFirstFormErrorAfterUpdate({ container: investNowFormRef.current })
    //     return
    //   }
    // }

    const em = getSessionUserEmail()?.trim().toLowerCase() ?? ""
    let investedAmount = n
    try {
      const inv = await fetchDealInvestors(dealId, { lpInvestorsOnly: true })
      if (em && inv.investors?.length) {
        const mine = inv.investors.find(
          (r) => String(r.userEmail ?? "").trim().toLowerCase() === em,
        )
        if (mine) {
          const parsed = parseMoneyDigits(String(mine.committed ?? "").trim())
          if (Number.isFinite(parsed)) investedAmount = parsed
        }
      }
    } catch {
      /* keep local amount */
    }

    toast.success(
      "Investment complete",
      "Your commitment and signed documents were saved.",
    )

    upsertRuntimeInvestmentRow({
      dealId,
      investmentName: dealName,
      offeringName: dealName,
      investmentProfile: investorProfileLabel(profileId.trim()),
      investedAmount,
      distributedAmount: 0,
      currentValuation: offeringSize || "—",
      dealCloseDate: formatDealCloseDateForInvestments(closeDate?.trim()),
      status: "Active",
      actionRequired: "None",
    })

    switchToInvesting()
    navigate("/investing/investments", { replace: true })
  }, [
    validateEsignaturesStep,
    esignTemplate,
    esignCompleted,
    esignStepIndex,
    dealId,
    profileId,
    dealName,
    amount,
    fundingMethod,
    offeringSize,
    closeDate,
    navigate,
    referringSponsorRef,
    switchToInvesting,
  ])

  const onSaveSoftCommitment = useCallback(async () => {
    const draftErr = await saveDraftForMissingEsign()
    if (draftErr) {
      setDraftSavedModalOpen(false)
      setError(draftErr)
      focusFirstFormErrorAfterUpdate({ container: investNowFormRef.current })
      return
    }
    setError("")
    setFieldErrors({})
    setDraftSavedModalOpen(false)
    toast.success("Saved as soft commit", "Proceed to pending")
    goToPendingInvestments()
  }, [saveDraftForMissingEsign, goToPendingInvestments])

  const onEsignSignedComplete = useCallback(
    async (result: { esignCompleted: boolean }) => {
      if (!result.esignCompleted) return

      setEsignCompleted(true)
      setEsignPending(false)
      await loadEsignStepData()
      setEsignCompleted(true)
      setEsignPending(false)
      pendingAutoFinishRef.current = false
      void onFinish()
    },
    [loadEsignStepData, onFinish],
  )

  useEffect(() => {
    if (
      !pendingAutoFinishRef.current ||
      !esignCompleted ||
      stepIndex !== esignStepIndex ||
      esignStepIndex < 0 ||
      finishStartedRef.current
    ) {
      return
    }
    pendingAutoFinishRef.current = false
    void onFinish()
  }, [esignCompleted, stepIndex, esignStepIndex, onFinish])

  if (!dealId) {
    return (
      <div className="deals_list_page deals_detail_page invest_now_flow_page">
        <p className="deals_list_not_found">Missing deal.</p>
      </div>
    )
  }

  if (saasPaywallDeal) {
    return (
      <div className="deals_list_page deals_detail_page invest_now_flow_page">
        <p className="deals_list_not_found">
          {saasPaywallDeal.dealName.trim()
            ? `Contact your sponsor for access to “${saasPaywallDeal.dealName.trim()}”.`
            : "Contact your sponsor for access to this deal."}
        </p>
        <DealSaasPaywallModal
          deal={saasPaywallDeal}
          investorFacing
          onClose={() => exitInvestNowFlow({ replace: true })}
        />
      </div>
    )
  }

  if (resumeLoadError) {
    return (
      <div className="deals_list_page deals_detail_page invest_now_flow_page">
        <p className="deals_list_not_found" role="alert">
          {resumeLoadError}
        </p>
        <button
          type="button"
          className="um_btn_secondary"
          onClick={() => exitInvestNowFlow()}
        >
          <ArrowLeft size={16} strokeWidth={2} aria-hidden />
          Back
        </button>
      </div>
    )
  }

  if (loading || resumeLoading) {
    return (
      <div className="deals_list_page deals_detail_page deals_add_investor_class_page deals_add_deal_asset_page deals_create_flow invest_now_flow_page">
        <section
          className="deals_create_loading_panel"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <Loader2
            className="deals_create_loading_icon"
            size={28}
            strokeWidth={2}
            aria-hidden
          />
          <p className="deals_create_loading_text">Loading invest now…</p>
        </section>
      </div>
    )
  }

  const isFirstStep = stepIndex <= 0
  const isLastStep = stepIndex >= flowSteps.length - 1
  const continueDisabled =
    submitting ||
    resumeLoading ||
    (currentStep?.kind === "investor" && bookLoading) ||
    (currentStep?.kind === "questionnaire" &&
      (documentsLoading || !questionnaireConfig)) ||
    (currentStep?.kind === "w9" && documentsLoading)

  function renderCurrentStep() {
    if (!currentStep) return null

    if (currentStep.kind === "investor") {
      return (
        <InvestNowInvestorStep
          profileOptions={profileDropdownOptions}
          savedUserProfileId={savedUserProfileId}
          onSavedProfileChange={(id) => {
            setSavedUserProfileId(id)
            clearInvestNowFieldErrors(
              INVEST_NOW_FIELD.profile,
              INVEST_NOW_FIELD.investmentClass,
              INVEST_NOW_FIELD.sponsor,
            )
            if (error) setError("")
          }}
          fieldErrors={{
            profile: fieldErrors[INVEST_NOW_FIELD.profile],
            investmentClass: fieldErrors[INVEST_NOW_FIELD.investmentClass],
            sponsor: fieldErrors[INVEST_NOW_FIELD.sponsor],
          }}
          investmentClassOptions={investmentClassOptions}
          selectedInvestorClassId={selectedInvestorClassId}
          onInvestorClassChange={(id) => {
            setSelectedInvestorClassId(id)
            clearInvestNowFieldErrors(INVEST_NOW_FIELD.investmentClass)
            if (error) setError("")
          }}
          classesLoading={loading}
          sponsorLabel={sponsorLabel}
          loading={submitting}
          disabled={submitting}
          bookLoading={bookLoading}
          error={error}
          onAddProfile={() =>
            navigate("/investing/profiles/add", {
              state: {
                returnTo: dealId
                  ? dealInvestNowPath(dealId)
                  : "/investing/investments",
              },
            })
          }
        />
      )
    }

    if (currentStep.kind === "investment") {
      return (
        <InvestNowInvestmentStep
          amount={amount}
          fundingMethod={fundingMethod}
          minimumHint={minimumInvestmentHint}
          belowMinimumNotice={belowMinimumAmountNotice}
          onAmountChange={(v) => {
            setAmount(v)
            clearInvestNowFieldErrors(INVEST_NOW_FIELD.amount)
            if (error) setError("")
          }}
          onFundingMethodChange={(v) => {
            setFundingMethod(v)
            clearInvestNowFieldErrors(INVEST_NOW_FIELD.fundingMethod)
            if (error) setError("")
          }}
          disabled={submitting}
          error={error}
          fieldErrors={{
            amount: fieldErrors[INVEST_NOW_FIELD.amount],
            fundingMethod: fieldErrors[INVEST_NOW_FIELD.fundingMethod],
          }}
        />
      )
    }

    if (currentStep.kind === "questionnaire") {
      if (!questionnaireConfig) {
        return (
          <section
            className="deals_create_card invest_now_step_card"
            aria-busy="true"
          >
            <h2 className="deals_create_section_title deals_create_step_card_title">
              Questionnaire
            </h2>
            <p className="deals_create_loading_text" role="status">
              <Loader2
                className="deals_create_loading_icon"
                size={20}
                aria-hidden
              />
              Loading questionnaire…
            </p>
          </section>
        )
      }
      return (
        <InvestNowQuestionnaireSectionStep
          step={currentStep}
          config={questionnaireConfig}
          answers={questionnaireAnswers}
          showIntro={currentStep.sectionId === visibleQuestionnaireSections[0]?.id}
          disabled={submitting || documentsLoading}
          error={error}
          fieldErrors={fieldErrors}
          onAnswersChange={(answers) => {
            setQuestionnaireAnswers(answers)
            const changedIds = Object.keys(answers).filter(
              (id) => answers[id] !== questionnaireAnswers[id],
            )
            if (changedIds.length > 0) {
              clearInvestNowFieldErrors(...changedIds)
            }
            if (error) setError("")
          }}
        />
      )
    }

    if (currentStep.kind === "w9") {
      return (
        <InvestNowW9Step
          w9Values={w9Values}
          onW9Change={(v) => {
            if (v.name !== w9Values.name) {
              w9NameUserEditedRef.current = true
              w9NameLockRef.current = true
              w9NameSourceRef.current = {
                profileId: savedUserProfileId,
                appliedName: v.name,
              }
            }
            setW9Values(v)
            const clearedKeys: string[] = []
            if (v.name !== w9Values.name) clearedKeys.push(INVEST_NOW_FIELD.w9Name)
            if (
              v.addressLine !== w9Values.addressLine ||
              v.street1 !== w9Values.street1 ||
              v.street2 !== w9Values.street2 ||
              v.city !== w9Values.city ||
              v.state !== w9Values.state ||
              v.zip !== w9Values.zip
            ) {
              clearedKeys.push(INVEST_NOW_FIELD.w9Address)
            }
            if (v.ssn !== w9Values.ssn) clearedKeys.push(INVEST_NOW_FIELD.w9Ssn)
            if (clearedKeys.length > 0) clearInvestNowFieldErrors(...clearedKeys)
            if (error) setError("")
          }}
          disabled={submitting}
          error={error}
          fieldErrors={{
            "w9-name": fieldErrors[INVEST_NOW_FIELD.w9Name],
            "w9-address": fieldErrors[INVEST_NOW_FIELD.w9Address],
            "w9-ssn": fieldErrors[INVEST_NOW_FIELD.w9Ssn],
          }}
        />
      )
    }

    return (
      <InvestNowEsignaturesStep
        dealId={dealId}
        esignScope={investNowEsignScope}
        esignCategoryId={esignCategoryId}
        profileTemplate={esignTemplate}
        commitmentProfileId={profileId}
        questionnaireInFlow={questionnaireInFlow}
        investorDisplayName={investorDisplayName}
        sendError={esignSendError}
        esignSendOk={esignSendOk}
        esignLoading={esignLoading}
        esignDocuments={esignDocuments}
        esignPending={esignPending}
        esignCompleted={esignCompleted}
        sequentialSignTurnOpen={sequentialSignTurnOpen}
        awaitingSequentialSignTurn={awaitingSequentialSignTurn}
        esignWorkflowLabel={esignWorkflowLabel}
        webhookSignStatus={webhookSignStatus}
        signStatusLoading={signStatusLoading}
        fallbackSignatureRequestId={esignSignatureRequestId}
        onRefreshDocuments={() => void loadEsignStepData()}
        onSignedComplete={onEsignSignedComplete}
        disabled={submitting || esignLoading}
        error={error}
      />
    )
  }

  const stepSubtitle = currentStep
    ? investNowFlowStepSubtitle(currentStep)
    : ""
  const activeStepperPhaseId = investNowActiveStepperPhaseId(currentStep)
  const duplicateProfileConfirmation =
    duplicateProfileConfirmMessage && typeof document !== "undefined"
      ? createPortal(
          <div
            className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                resolveDuplicateProfileConfirmation(false)
              }
            }}
          >
            <div
              className="um_modal um_modal_view deals_add_inv_modal_panel add_contact_panel invest_now_duplicate_profile_modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="invest-now-duplicate-profile-title"
            >
              <div className="um_modal_head add_contact_modal_head">
                <h3
                  id="invest-now-duplicate-profile-title"
                  className="um_modal_title add_contact_modal_title"
                >
                  Profile already used
                </h3>
                <button
                  type="button"
                  className="um_modal_close"
                  onClick={() => resolveDuplicateProfileConfirmation(false)}
                  aria-label="Close"
                >
                  <X size={20} strokeWidth={2} aria-hidden />
                </button>
              </div>
              <div className="deals_add_inv_modal_scroll">
                <p className="deals_suspend_all_modal_message">
                  {duplicateProfileConfirmMessage}
                </p>
              </div>
              <div className="um_modal_actions add_contact_modal_actions">
                <div className="add_contact_modal_actions_trailing">
                  <button
                    type="button"
                    className="um_btn_secondary"
                    onClick={() => resolveDuplicateProfileConfirmation(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="um_btn_primary"
                    onClick={() => resolveDuplicateProfileConfirmation(true)}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null
  const draftSavedModal =
    draftSavedModalOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="um_modal_overlay deals_add_inv_modal_overlay portal_modal_z_boost"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDraftSavedModalOpen(false)
            }}
          >
            <div
              className="um_modal um_modal_view deals_add_inv_modal_panel add_contact_panel invest_now_duplicate_profile_modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="invest-now-draft-saved-title"
            >
              <div className="um_modal_head add_contact_modal_head">
                <h3
                  id="invest-now-draft-saved-title"
                  className="um_modal_title add_contact_modal_title"
                >
                  Soft commitment
                </h3>
                <button
                  type="button"
                  className="um_modal_close"
                  onClick={() => setDraftSavedModalOpen(false)}
                  aria-label="Close"
                >
                  <X size={20} strokeWidth={2} aria-hidden />
                </button>
              </div>
              <div className="deals_add_inv_modal_scroll">
                <p className="deals_suspend_all_modal_message">
                  {esignFailureAllowsSoftCommitment(esignSendError)
                    ? "The eSign service is temporarily unavailable. You can save a soft commitment now and complete signing when the service is available."
                    : "No documents are uploaded for this deal yet. You can contact your Sponsor & they will let you know when it is ready to complete the investment."}
                </p>
              </div>
              <div className="um_modal_actions add_contact_modal_actions">
                <div className="add_contact_modal_actions_trailing">
                  <button
                    type="button"
                    className="um_btn_primary"
                    disabled={submitting}
                    onClick={() => void onSaveSoftCommitment()}
                  >
                    {submitting ? (
                      <>
                        <Loader2
                          size={16}
                          strokeWidth={2}
                          className="deals_create_loading_icon"
                          aria-hidden
                        />
                        Saving…
                      </>
                    ) : (
                      "Save soft commitment"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
    <div className="deals_list_page deals_detail_page deals_add_investor_class_page deals_add_deal_asset_page deals_create_flow invest_now_flow_page">
      <header className="deals_list_head deals_add_investor_class_page_head deals_create_page_head">
        <div className="deals_add_deal_asset_head_main deals_create_head_main">
          <div className="deals_list_title_row deals_add_deal_asset_title_row">
            <button
              type="button"
              className="deals_list_back_circle"
              onClick={() => exitInvestNowFlow()}
              aria-label={
                backTo === "/investing/investments"
                  ? "Back to investments"
                  : "Back to deal"
              }
            >
              <ArrowLeft size={20} strokeWidth={2} aria-hidden />
            </button>
            <div className="deals_add_deal_asset_title_stack">
              <FormHeadingWithInfo
                as="h1"
                className="deals_list_title"
                title={`Invest now — ${dealName}`}
                info={stepSubtitle ? <p>{stepSubtitle}</p> : undefined}
              />
            </div>
          </div>
          <InvestNowFlowStepper
            activePhaseId={activeStepperPhaseId}
            includeQuestionnaire={questionnaireInFlow}
          />
        </div>
      </header>

      <section className="deals_create_deal_section" aria-label="Invest now form">
        <form
          ref={investNowFormRef}
          className="deals_add_deal_asset_form"
          onSubmit={(e) => e.preventDefault()}
          noValidate
        >
          <div className="deals_add_deal_asset_form_scroll">
            {renderCurrentStep()}
          </div>

          <div className="um_modal_actions add_contact_modal_actions deal_inv_ic_add_panel_actions deals_add_deal_asset_footer_actions">
            <button
              type="button"
              className="um_btn_secondary"
              disabled={submitting}
              onClick={() => exitInvestNowFlow()}
            >
              <X size={16} strokeWidth={2} aria-hidden />
              Close
            </button>
            <div className="add_contact_modal_actions_trailing">
              {!isFirstStep ? (
                <button
                  type="button"
                  className="um_btn_secondary"
                  disabled={submitting}
                  onClick={() => {
                    setError("")
                    clearInvestNowFieldErrors()
                    setStepIndex((index) => Math.max(0, index - 1))
                  }}
                >
                  <ArrowLeft size={16} strokeWidth={2} aria-hidden />
                  Back
                </button>
              ) : null}
              {!isLastStep ? (
                <button
                  type="button"
                  className="um_btn_primary"
                  disabled={continueDisabled}
                  onClick={() => {
                    if (
                      currentStep?.kind === "investor" ||
                      currentStep?.kind === "investment"
                    ) {
                      void onContinueFromCurrentStep()
                      return
                    }
                    void onContinueFromCurrentStep()
                  }}
                >
                  {submitting && currentStep?.kind === "w9" ? (
                    <>
                      <Loader2
                        size={16}
                        strokeWidth={2}
                        className="deals_create_loading_icon"
                        aria-hidden
                      />
                      Saving…
                    </>
                  ) : (
                    <>
                      Continue
                      <ChevronRight size={18} strokeWidth={2} aria-hidden />
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="um_btn_primary"
                  disabled={submitting || esignLoading}
                  onClick={() => void onFinish()}
                >
                  {submitting ? (
                    <>
                      <Loader2
                        size={16}
                        strokeWidth={2}
                        className="deals_create_loading_icon"
                        aria-hidden
                      />
                      Finishing…
                    </>
                  ) : (
                    <>
                      <CircleCheck size={16} strokeWidth={2} aria-hidden />
                      Finish
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </form>
      </section>
    </div>
    {duplicateProfileConfirmation}
    {draftSavedModal}
    </>
  )
}

export default DealInvestNowPage
