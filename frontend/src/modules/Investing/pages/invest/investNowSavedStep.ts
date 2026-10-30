import type { MyLpDealInvestNowCommitmentPayload } from "@/modules/Syndication/Deals/api/lpInvestNowCommitmentApi"
import type { InvestorQuestionnaireConfig } from "@/modules/Syndication/Deals/tabs/esign_templates/investorQuestionnaire.types"
import { buildInvestNowFlowSteps, type InvestNowFlowStep } from "./investNowFlowSteps"
import type { VisibleQuestionnaireSection } from "./investNowEsignContext"
import { validateInvestNowQuestionnaireSection } from "./investNowQuestionnaireValidation"

function hasW9NameAddress(
  w9: MyLpDealInvestNowCommitmentPayload["w9Form"],
): boolean {
  if (!w9) return false
  const name = String(w9.name ?? "").trim()
  const line = String(w9.address_line ?? w9.addressLine ?? "").trim()
  const street = String(w9.street1 ?? "").trim()
  const city = String(w9.city ?? "").trim()
  const state = String(w9.state ?? "").trim()
  const zip = String(w9.zip ?? "").trim()
  return Boolean(name && (line || (street && city && state && zip)))
}

function stepIndex(
  flowSteps: InvestNowFlowStep[],
  kind: InvestNowFlowStep["kind"],
  sectionId?: string,
): number {
  const idx = flowSteps.findIndex((step) => {
    if (step.kind !== kind) return false
    if (kind === "questionnaire" && step.kind === "questionnaire") {
      return step.sectionId === sectionId
    }
    return true
  })
  return idx >= 0 ? idx : 0
}

function resumedQuestionnaireAnswers(
  saved: MyLpDealInvestNowCommitmentPayload,
): Record<string, string> {
  const current = saved.questionnaireAnswers ?? {}
  if (Object.values(current).some((value) => String(value ?? "").trim())) {
    return current
  }
  return saved.priorQuestionnaireAnswers ?? {}
}

function questionnaireSectionIsIncomplete(params: {
  sectionId: string
  answers: Record<string, string>
  questionnaireConfig: InvestorQuestionnaireConfig | null
}): boolean {
  if (params.questionnaireConfig) {
    return (
      validateInvestNowQuestionnaireSection({
        config: params.questionnaireConfig,
        sectionId: params.sectionId,
        answers: params.answers,
      }) != null
    )
  }
  return !Object.entries(params.answers).some(([id, value]) => {
    if (!String(value ?? "").trim()) return false
    return id === params.sectionId || id.startsWith(`${params.sectionId}.`)
  })
}

/**
 * First incomplete wizard step from server-saved progress.
 * Resume investing opens here so a finished Investor, Investment, questionnaire,
 * or W-9 step is not shown again.
 */
export function investNowStepIndexFromSavedProgress(params: {
  saved: MyLpDealInvestNowCommitmentPayload
  showQuestionnaire: boolean
  visibleSections: VisibleQuestionnaireSection[]
  questionnaireConfig: InvestorQuestionnaireConfig | null
  esignWasSent?: boolean
}): number {
  const flowSteps = buildInvestNowFlowSteps({
    showQuestionnaire: params.showQuestionnaire,
    visibleSections: params.visibleSections,
  })
  if (flowSteps.length === 0) return 0

  if (params.esignWasSent) {
    return stepIndex(flowSteps, "esignatures")
  }

  const profileSelected = Boolean(
    params.saved.userInvestorProfileId?.trim() || params.saved.profileId?.trim(),
  )
  const classSelected = Boolean(params.saved.investorClass?.trim())
  if (!profileSelected || !classSelected) return 0

  const amount = Number(
    String(params.saved.committedAmount ?? "").replace(/[$,\s]/g, ""),
  )
  const hasAmount = Number.isFinite(amount) && amount > 0
  const hasFunding = Boolean(params.saved.fundingMethod?.trim())
  if (!hasAmount || !hasFunding) {
    return stepIndex(flowSteps, "investment")
  }

  // W-9 is after every questionnaire section. A saved W-9 means those
  // sections were already completed, so Resume opens Sign.
  if (hasW9NameAddress(params.saved.w9Form)) {
    return stepIndex(flowSteps, "esignatures")
  }

  if (params.showQuestionnaire) {
    const answers = resumedQuestionnaireAnswers(params.saved)
    for (const section of params.visibleSections) {
      if (
        questionnaireSectionIsIncomplete({
          sectionId: section.id,
          answers,
          questionnaireConfig: params.questionnaireConfig,
        })
      ) {
        return stepIndex(flowSteps, "questionnaire", section.id)
      }
    }
  }

  return stepIndex(flowSteps, "w9")
}
