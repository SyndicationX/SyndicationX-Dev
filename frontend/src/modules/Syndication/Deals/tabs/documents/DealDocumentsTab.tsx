import type { DealDetailApi } from "../../api/dealsApi"
import { DocumentsSection } from "./DocumentsSection"
import "../../deal-offering-details.css"
import "./deal-docs-section-modal.css"
import "../deal_members/add-investment/add_deal_modal.css"

type DealDocumentsTabProps = {
  dealId: string
  dealName?: string | null
  offeringInvestorPreviewJson?: string | null
  investorsListRefreshKey?: number
  onOfferingPreviewSynced?: (deal: DealDetailApi) => void
}

export function DealDocumentsTab({
  dealId,
  dealName,
  offeringInvestorPreviewJson,
  investorsListRefreshKey = 0,
  onOfferingPreviewSynced,
}: DealDocumentsTabProps) {
  return (
    <div className="deal_documents_tab_root deal_offering_root">
      <DocumentsSection
        key={dealId}
        dealId={dealId}
        dealName={dealName}
        offeringInvestorPreviewJson={offeringInvestorPreviewJson}
        investorsListRefreshKey={investorsListRefreshKey}
        onOfferingPreviewSynced={onOfferingPreviewSynced}
      />
    </div>
  )
}
