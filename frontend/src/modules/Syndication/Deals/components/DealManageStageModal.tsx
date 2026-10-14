import {
  Archive,
  Building2,
  FilePenLine,
  HandCoins,
  Loader2,
  Save,
  X,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import { RadioPillGroup } from "../../../../common/components/radio-pill-group/RadioPillGroup"
import { patchDealStage, type DealDetailApi } from "../api/dealsApi"
import type { DealStage } from "../constants/deal-lifecycle/deal-stage"
import {
  canonicalDealStageToFormValue,
  dealStagesAreDifferent,
  formDealStageToCanonical,
  getDealStageModalContent,
} from "../constants/deal-stage-modal-config"
import {
  DEAL_STAGE_CHOICES,
  type DealStageOption,
} from "../types/deals.types"
import "./deal-stage-change-modal.css"
import "./deal-manage-stage-modal.css"

const STAGE_ICONS: Record<DealStage, LucideIcon> = {
  draft: FilePenLine,
  capital_raising: HandCoins,
  asset_managing: Building2,
  liquidated: Archive,
}

const STAGE_PILL_OPTIONS = DEAL_STAGE_CHOICES.map((choice) => ({
  value: choice.value,
  label: choice.label,
}))

interface DealManageStageModalProps {
  open: boolean
  dealId: string
  dealName: string
  /** Stored stage on the deal (any alias) — seeds the picker. */
  currentStage: string
  onClose: () => void
  /** Stage saved: deal row from the API (also fired when SaaS payment held it in Draft). */
  onSaved: (deal: DealDetailApi, pendingDealStage: string | null) => void
}

/**
 * Stage-only editor for “Manage deal stage”: picks a lifecycle stage and PATCHes just
 * that field, so sponsors never pass through the full edit-deal wizard.
 */
export function DealManageStageModal({
  open,
  dealId,
  dealName,
  currentStage,
  onClose,
  onSaved,
}: DealManageStageModalProps) {
  const titleId = useId()
  const stageHeadingId = useId()
  const [selected, setSelected] = useState<DealStageOption | "">("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    const canon = formDealStageToCanonical(currentStage)
    setSelected(canon ? canonicalDealStageToFormValue(canon) : "")
    setError("")
  }, [open, currentStage])

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener("keydown", onKey)
    }
  }, [open, saving, onClose])

  if (!open) return null

  const targetCanon = formDealStageToCanonical(selected)
  const content = targetCanon ? getDealStageModalContent(targetCanon) : null
  const StageIcon = STAGE_ICONS[targetCanon ?? "draft"]
  const stageChanged = dealStagesAreDifferent(currentStage, selected)
  const currentCanon = formDealStageToCanonical(currentStage)
  const currentStageLabel = currentCanon
    ? getDealStageModalContent(currentCanon).stageLabel
    : ""

  async function handleSave() {
    if (!selected || !stageChanged || saving) return
    setSaving(true)
    setError("")
    const result = await patchDealStage(dealId, selected)
    setSaving(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onSaved(result.deal, result.pendingDealStage)
    onClose()
  }

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div
        className={`deal_stage_modal deal_stage_modal--${targetCanon ?? "draft"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap" aria-hidden>
            <StageIcon size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Manage deal stage</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              {dealName.trim() || "This deal"}
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            disabled={saving}
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <div className="deal_stage_modal_body deal_manage_stage_body">
          <div className="deal_manage_stage_field">
            <div className="deal_manage_stage_label_row">
              <p id={stageHeadingId} className="deal_manage_stage_label">
                Deal stage
              </p>
              {currentStageLabel ? (
                <span className="deal_manage_stage_current">
                  Current: {currentStageLabel}
                </span>
              ) : null}
            </div>
            <RadioPillGroup
              name="manageDealStage"
              className="deal_manage_stage_pills"
              value={selected}
              options={STAGE_PILL_OPTIONS}
              ariaLabelledBy={stageHeadingId}
              onChange={(value) => {
                setSelected(value)
                if (error) setError("")
              }}
            />
          </div>
          {content ? (
            <div className="deal_manage_stage_summary">
              <span className="deal_stage_modal_badge deal_manage_stage_summary_badge">
                {stageChanged
                  ? `Moving to ${content.stageLabel}`
                  : `Currently ${content.stageLabel}`}
              </span>
              <p className="deal_stage_modal_desc">{content.description}</p>
            </div>
          ) : null}
          {error ? (
            <p
              className="deal_saas_paywall_error deal_manage_stage_error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="deal_stage_modal_actions">
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--cancel"
            disabled={saving}
            onClick={onClose}
          >
            <X size={16} strokeWidth={2} aria-hidden />
            Close
          </button>
          <button
            type="button"
            className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
            disabled={saving || !stageChanged}
            title={stageChanged ? undefined : "Pick a different stage to save"}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <>
                <Loader2
                  size={16}
                  strokeWidth={2}
                  className="deals_create_btn_spin"
                  aria-hidden
                />
                Saving…
              </>
            ) : (
              <>
                <Save size={16} strokeWidth={2} aria-hidden />
                {content && stageChanged ? content.confirmText : "Save stage"}
              </>
            )}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
