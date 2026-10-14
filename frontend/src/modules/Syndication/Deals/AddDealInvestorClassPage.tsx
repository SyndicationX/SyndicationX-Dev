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
  AddInvestorClassPanel,
  DEAL_ADD_IC_PAGE_TITLE_ID,
  InvestorClassAllocationToolbarNotice,
  InvestorClassPipelineStepper,
  type InvestorClassPipelineStep,
} from "./tabs/offering_details/OfferingInformationSection"
import { computeInvestorClassAllocationTotals } from "./utils/investorClassAllocationTotals"
import type { DealInvestorClass } from "./types/deal-investor-class.types"
import "../usermanagement/user_management.css"
import "./deal-investor-class.css"
import "./deals-create.css"
import "./deals-list.css"

export function AddDealInvestorClassPage() {
  const { dealId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [rows, setRows] = useState<DealInvestorClass[]>([])
  const [loading, setLoading] = useState(true)
  const [pipelineStep, setPipelineStep] = useState<InvestorClassPipelineStep>(1)
  const [, setVisitedPipelineSteps] = useState<
    ReadonlySet<InvestorClassPipelineStep>
  >(() => new Set([1]))

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
    setAppDocumentTitle("Add Investor Class")
  }, [])

  useEffect(() => {
    setPipelineStep(1)
    setVisitedPipelineSteps(new Set([1]))
  }, [dealId])

  const allocationTotals = useMemo(
    () => computeInvestorClassAllocationTotals(rows),
    [rows],
  )

  if (!dealId) {
    return (
      <div className="deals_list_page deals_detail_page">
        <p className="deals_list_not_found">Missing deal.</p>
        <Link to="/deals" className="deals_list_inline_back">
          Back to deals
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
              <h1 id={DEAL_ADD_IC_PAGE_TITLE_ID} className="deals_list_title">
                Add Investor Class
              </h1>
            </div>
          </div>
          <InvestorClassPipelineStepper pipelineStep={pipelineStep} />
        </div>
      </header>

      {loading ? (
        <section className="deals_add_investor_class_loading_panel deals_page_loader_center_panel" role="status">
          <p className="deal_offering_muted">Loading investor classes…</p>
        </section>
      ) : allocationTotals.addDisabled ? (
        <section
          className="deals_add_investor_class_loading_panel deal_inv_class_add_blocked_panel"
          aria-labelledby={DEAL_ADD_IC_PAGE_TITLE_ID}
        >
          <InvestorClassAllocationToolbarNotice totals={allocationTotals} />
          <p className="deal_offering_muted deal_inv_class_add_blocked_hint">
            Edit an existing class on the deal to lower legal ownership or
            distribution share before adding another class.
          </p>
          <button type="button" className="um_btn_secondary" onClick={goBack}>
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            Back to classes
          </button>
        </section>
      ) : (
        <AddInvestorClassPanel
          asPage
          dealId={dealId}
          existingClasses={rows}
          onClose={goBack}
          onCreated={goBack}
          pipelineStep={pipelineStep}
          onPipelineStepChange={handlePipelineStepChange}
        />
      )}
    </div>
  )
}
