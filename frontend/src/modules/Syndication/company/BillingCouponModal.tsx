import { BadgePercent, CircleCheck, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { toast } from "../../../common/components/Toast"
import { previewBillingCoupon, type BillingCouponPreview } from "./companyBillingApi"
import "../Deals/components/deal-stage-change-modal.css"

function CouponDialogConfetti({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const host = canvas?.parentElement
    const ctx = canvas?.getContext("2d")
    if (!canvas || !host || !ctx) return
    const colors = ["#047857", "#16a34a", "#d4af37", "#155abf", "#0f172a"]
    const rect = host.getBoundingClientRect()
    const width = Math.max(1, Math.floor(rect.width))
    const height = Math.max(1, Math.floor(rect.height))
    canvas.width = width
    canvas.height = height
    const pieces = Array.from({ length: 36 }, () => ({
      x: width * 0.5 + (Math.random() - 0.5) * width * 0.2,
      y: height * 0.48,
      vx: (Math.random() - 0.5) * 5.5,
      vy: -4.5 - Math.random() * 3.5,
      w: 4 + Math.random() * 3,
      h: 6 + Math.random() * 3,
      color: colors[Math.floor(Math.random() * colors.length)] ?? "#047857",
      spin: Math.random() * 0.22,
      angle: Math.random() * Math.PI,
    }))
    let frame = 0
    let raf = 0
    const draw = () => {
      frame += 1
      ctx.clearRect(0, 0, width, height)
      for (const piece of pieces) {
        piece.vy += 0.16
        piece.x += piece.vx
        piece.y += piece.vy
        piece.angle += piece.spin
        ctx.save()
        ctx.translate(piece.x, piece.y)
        ctx.rotate(piece.angle)
        ctx.fillStyle = piece.color
        ctx.fillRect(-piece.w / 2, -piece.h / 2, piece.w, piece.h)
        ctx.restore()
      }
      if (frame < 80) raf = window.requestAnimationFrame(draw)
      else ctx.clearRect(0, 0, width, height)
    }
    raf = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(raf)
  }, [active])

  if (!active) return null
  return <canvas ref={canvasRef} className="cp_coupon_confetti" aria-hidden="true" />
}

export function BillingCouponModal({
  open,
  onClose,
  onApplied,
  dealId,
}: {
  open: boolean
  onClose: () => void
  onApplied: (coupon: BillingCouponPreview) => void
  dealId?: string
}) {
  const titleId = useId()
  const [code, setCode] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState<BillingCouponPreview | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    setCode("")
    setError("")
    setBusy(false)
    setConfirmed(null)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current()
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (!open) return null

  async function apply() {
    const next = code.trim()
    if (!next) {
      setError("Enter a coupon code.")
      return
    }
    setBusy(true)
    setError("")
    const result = await previewBillingCoupon(next, dealId)
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setConfirmed(result.coupon)
    onApplied(result.coupon)
    toast.success("Coupon applied", `${result.coupon.code} updated the plan prices.`)
  }

  return createPortal(
    <div
      className="deal_stage_modal_overlay portal_modal_z_boost"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className={`cp_coupon_stage${confirmed ? " cp_coupon_stage_confirmed" : ""}`}
      >
        <CouponDialogConfetti active={confirmed != null} />
        <div
          className="deal_stage_modal deal_stage_modal--saas_paywall cp_coupon_dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
        >
        <header className="deal_stage_modal_head">
          <div className="deal_stage_modal_icon_wrap" aria-hidden>
            <BadgePercent size={22} strokeWidth={2} />
          </div>
          <div className="deal_stage_modal_head_text">
            <p className="deal_stage_modal_eyebrow">Pricing</p>
            <h2 id={titleId} className="deal_stage_modal_title">
              {confirmed ? "Coupon applied" : "Have a coupon?"}
            </h2>
          </div>
          <button
            type="button"
            className="deal_stage_modal_close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} strokeWidth={2} aria-hidden />
          </button>
        </header>
        {confirmed ? (
          <div className="deal_stage_modal_body">
            <p className="deal_stage_modal_desc">
              <strong>{confirmed.code}</strong> is applied. The plan prices are updated.
            </p>
          </div>
        ) : (
          <form
            className="deal_stage_modal_body"
            onSubmit={(e) => {
              e.preventDefault()
              void apply()
            }}
          >
            <p className="deal_stage_modal_desc">
              Enter your code to update the plan prices.
            </p>
            <label className="cp_coupon_apply_field">
              Coupon code
              <input
                className="cp_coupons_input"
                value={code}
                autoFocus
                autoCapitalize="characters"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="LAUNCH20"
              />
            </label>
            {error ? (
              <p className="cp_coupon_apply_error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        )}
        <footer className="deal_stage_modal_actions">
          {confirmed ? (
            <button
              type="button"
              className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
              onClick={onClose}
            >
              <CircleCheck size={16} strokeWidth={2} aria-hidden />
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="deal_stage_modal_btn deal_stage_modal_btn--cancel"
                disabled={busy}
                onClick={onClose}
              >
                <X size={16} strokeWidth={2} aria-hidden />
                Cancel
              </button>
              <button
                type="button"
                className="deal_stage_modal_btn deal_stage_modal_btn--confirm"
                disabled={busy}
                onClick={() => void apply()}
              >
                <CircleCheck size={16} strokeWidth={2} aria-hidden />
                {busy ? "Checking…" : "Apply"}
              </button>
            </>
          )}
        </footer>
        </div>
      </div>
    </div>,
    document.body,
  )
}
