import { ArrowLeft } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"
import {
  buildDealDetailReturnSearch,
  type DealDetailReturnState,
} from "./utils/offeringDetailsSectionNav"
import { setAppDocumentTitle } from "../../../common/utils/appDocumentTitle"
import { fetchDealInvestorClasses } from "./api/dealsApi"
import {
  DEAL_EDIT_IC_PAGE_TITLE_ID,
  EditInvestorClassPanel,
  INVESTOR_CLASS_PIPELINE_STEPS_ALL,
  InvestorClassPipelineStepper,
  type InvestorClassPipelineStep,
} from "./tabs/offering_details/OfferingInformationSection"
import type { DealInvestorClass } from "./types/deal-investor-class.types"
import "../usermanagement/user_management.css"
import "./deal-investor-class.css"
import "./deals-create.css"
import "./deals-list.css"

export function EditDealInvestorClassPage() {
  const { dealId, classId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [rows, setRows] = useState<DealInvestorClass[]>([])
  const [loading, setLoading] = useState(true)
  const [pipelineStep, setPipelineStep] = useState<InvestorClassPipelineStep>(1)
  const [, setVisitedPipelineSteps] =
    useState<ReadonlySet<InvestorClassPipelineStep>>(
      INVESTOR_CLASS_PIPELINE_STEPS_ALL,
    )

  const handlePipelineStepChange = useCallback((step: InvestorClassPipelineStep) => {
    setPipelineStep(step)
    setVisitedPipelineSteps((prev) => {
      if (prev.has(step)) return prev
      return new Set([...prev, step])
    })
  }, [])

  const dealDetailPath =
    dealId != null && dealId !== ""
      ? `/deals/${encodeURIComponent(dealId)}`
      : "/deals"

  const returnState = location.state as DealDetailReturnState | null

  const goBack = useCallback(() => {
    const qs = buildDealDetailReturnSearch({
      tab: returnState?.returnTab ?? "offering_details",
      offeringSection: returnState?.returnSection,
    })
    navigate(`${dealDetailPath}${qs}`)
  }, [dealDetailPath, navigate, returnState?.returnSection, returnState?.returnTab])

  const load = useCallback(async () => {
    if (!dealId) return
    setLoading(true)
    setRows([])
    try {
      const list = await fetchDealInvestorClasses(dealId)
      setRows(list)
    } finally {
      setLoading(false)
    }
  }, [dealId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setAppDocumentTitle("Edit Investor Class")
  }, [])

  useEffect(() => {
    setPipelineStep(1)
    setVisitedPipelineSteps(INVESTOR_CLASS_PIPELINE_STEPS_ALL)
  }, [dealId, classId])

  const editingRow = useMemo(() => {
    if (!classId || rows.length === 0) return null
    return rows.find((r) => r.id === classId) ?? null
  }, [classId, rows])

  const missingClass =
    !loading &&
    classId != null &&
    (rows.length === 0 || !rows.some((r) => r.id === classId))

  if (!dealId || !classId) {
    return (
      <div className="deals_list_page deals_detail_page">
        <p className="deals_list_not_found">Missing deal or class.</p>
        <Link to="/deals" className="deals_list_inline_back">
          Back to deals
        </Link>
      </div>
    )
  }

  if (missingClass) {
    return (
      <div className="deals_list_page deals_detail_page">
        <p className="deals_list_not_found">Investor class not found.</p>
        <Link
          to={`${dealDetailPath}${buildDealDetailReturnSearch({
            tab: returnState?.returnTab ?? "offering_details",
            offeringSection: returnState?.returnSection,
          })}`}
          className="deals_list_inline_back"
        >
          Back to deal
        </Link>
      </div>
    )
  }

  return (
    <div className="deals_list_page deals_detail_page deals_add_investor_class_page deals_add_deal_asset_page deals_investor_class_add_edit_page">
      <header className="deals_list_head deals_add_investor_class_page_head">
        <div className="deals_add_deal_asset_head_main">
          <div className="deals_list_title_row deals_add_deal_asset_title_row">
            <button
              type="button"
              className="deals_list_back_circle"
              onClick={goBack}
              aria-label="Back to deal"
            >
              <ArrowLeft size={20} strokeWidth={2} aria-hidden />
            </button>
            <div className="deals_add_deal_asset_title_stack">
              <h1 id={DEAL_EDIT_IC_PAGE_TITLE_ID} className="deals_list_title">
                Edit Investor Class
              </h1>
            </div>
          </div>
          <InvestorClassPipelineStepper pipelineStep={pipelineStep} />
        </div>
      </header>

      {loading || !editingRow ? (
        <section className="deals_add_investor_class_loading_panel deals_page_loader_center_panel" role="status">
          <p className="deal_offering_muted">Loading investor class…</p>
        </section>
      ) : (
        <EditInvestorClassPanel
          dealId={dealId}
          row={editingRow}
          existingClasses={rows}
          onClose={goBack}
          onSaved={() => void load()}
          pipelineStep={pipelineStep}
          onPipelineStepChange={handlePipelineStepChange}
        />
      )}
    </div>
  )
}
