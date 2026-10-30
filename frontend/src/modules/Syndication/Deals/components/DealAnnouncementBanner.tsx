import { ChevronDown, Megaphone } from "lucide-react"
import { useId, useLayoutEffect, useRef, useState } from "react"
import "./deal-announcement-banner.css"

export type DealAnnouncementBannerProps = {
  title?: string | null
  message?: string | null
  /** Extra class on the root (e.g. page layout hooks). */
  className?: string
  /** Tighter spacing when embedded in offering preview columns. */
  variant?: "page" | "preview"
}

/** Published deal announcement shown at the top of deal detail / offering preview. */
export function DealAnnouncementBanner({
  title,
  message,
  className = "",
  variant = "page",
}: DealAnnouncementBannerProps) {
  const trimmedTitle = title?.trim() ?? ""
  const trimmedMessage = message?.trim() ?? ""
  const name = trimmedTitle || trimmedMessage
  const detail =
    trimmedTitle && trimmedMessage && trimmedMessage !== trimmedTitle
      ? trimmedMessage
      : ""
  const bodyId = useId()
  const nameRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [nameOverflows, setNameOverflows] = useState(false)

  useLayoutEffect(() => {
    setExpanded(false)
  }, [name, detail])

  useLayoutEffect(() => {
    const el = nameRef.current
    if (!el || expanded) return

    const measure = () => {
      setNameOverflows(el.scrollWidth > el.clientWidth + 1)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, name])

  if (!name) return null

  const canToggle = Boolean(detail) || nameOverflows
  const isPage = variant !== "preview"

  const rootClass = [
    "deal_announcement_banner",
    isPage
      ? "deal_announcement_banner--page"
      : "deal_announcement_banner--preview",
    expanded ? "is-expanded" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={rootClass} role="region" aria-label="Deal announcement">
      <div className="deal_announcement_banner_icon_wrap" aria-hidden>
        <Megaphone size={15} strokeWidth={2} />
      </div>
      <div className="deal_announcement_banner_content">
        <p className="deal_announcement_banner_kicker">Announcement</p>
        <p ref={nameRef} className="deal_announcement_banner_title">
          {name}
        </p>
        {detail ? (
          <div className="deal_announcement_banner_body" id={bodyId} hidden={!expanded}>
            <p className="deal_announcement_banner_message">{detail}</p>
          </div>
        ) : null}
        {canToggle ? (
          <button
            type="button"
            className="deal_announcement_banner_toggle"
            aria-expanded={expanded}
            aria-controls={detail ? bodyId : undefined}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Show less" : "See complete announcement"}
            <ChevronDown size={14} strokeWidth={2.25} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  )
}
