import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  useCallback,
  useLayoutEffect,
  useState,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"

interface FloatingTableHScrollProps {
  scrollerRef: RefObject<HTMLElement | null>
  /** Re-measure when table contents change (row count, page, columns). */
  syncKey?: string
  active?: boolean
  ariaLabel?: string
}

interface StickyBarMetrics {
  left: number
  top: number
  width: number
}

const BAR_HEIGHT_PX = 40

function scrollPortRect(scroller: HTMLElement): DOMRect {
  const port = scroller.closest(".app_main_content")
  if (port instanceof HTMLElement) return port.getBoundingClientRect()
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

export function FloatingTableHScroll({
  scrollerRef,
  syncKey = "",
  active = true,
  ariaLabel = "Columns",
}: FloatingTableHScrollProps) {
  const [sticky, setSticky] = useState<StickyBarMetrics | null>(null)
  const [overflowX, setOverflowX] = useState(false)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const syncArrowState = useCallback((scroller: HTMLElement) => {
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
    const hasOverflow = max > 2
    setOverflowX(hasOverflow)
    setCanScrollLeft(hasOverflow && scroller.scrollLeft > 2)
    setCanScrollRight(hasOverflow && scroller.scrollLeft < max - 2)
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return

    function hideSticky() {
      setSticky((prev) => (prev == null ? prev : null))
    }

    function updateSticky() {
      const node = scrollerRef.current
      if (!node) return
      if (!active) {
        setOverflowX(false)
        setCanScrollLeft(false)
        setCanScrollRight(false)
        hideSticky()
        return
      }
      syncArrowState(node)
      const hasOverflowX = node.scrollWidth - node.clientWidth > 2
      const rect = node.getBoundingClientRect()
      const port = scrollPortRect(node)
      const visible =
        rect.bottom > port.top + 8 && rect.top < port.bottom - 8
      if (!hasOverflowX || !visible) {
        hideSticky()
        return
      }
      const left = Math.max(rect.left, port.left)
      const width = Math.min(rect.right, port.right) - left
      if (width < 96) {
        hideSticky()
        return
      }
      const tableBottomInView = rect.bottom <= port.bottom + 1
      const fitsBelowTable =
        tableBottomInView && rect.bottom + BAR_HEIGHT_PX <= port.bottom + 1
      const top = fitsBelowTable
        ? rect.bottom
        : Math.min(rect.bottom, port.bottom) - BAR_HEIGHT_PX
      const next: StickyBarMetrics = {
        left,
        top,
        width,
      }
      setSticky((prev) => {
        if (
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width
        )
          return prev
        return next
      })
    }

    function onScrollerScroll() {
      const node = scrollerRef.current
      if (!node) return
      syncArrowState(node)
    }

    updateSticky()
    const port = scroller.closest(".app_main_content")
    port?.addEventListener("scroll", updateSticky, { passive: true })
    window.addEventListener("resize", updateSticky)
    scroller.addEventListener("scroll", onScrollerScroll, { passive: true })
    const resizeObserver = new ResizeObserver(updateSticky)
    resizeObserver.observe(scroller)
    if (scroller.firstElementChild)
      resizeObserver.observe(scroller.firstElementChild)

    return () => {
      port?.removeEventListener("scroll", updateSticky)
      window.removeEventListener("resize", updateSticky)
      scroller.removeEventListener("scroll", onScrollerScroll)
      resizeObserver.disconnect()
    }
  }, [active, scrollerRef, syncArrowState, syncKey])

  function scrollByDir(dir: -1 | 1) {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.scrollBy({
      left: dir * Math.max(240, scroller.clientWidth * 0.7),
      behavior: "smooth",
    })
  }

  return (
    <>
      {overflowX ? (
        <div className="data_table_hscroll_spacer" aria-hidden />
      ) : null}
      {sticky && typeof document !== "undefined"
        ? createPortal(
            <div
              className="data_table_hscroll_sticky"
              style={{
                left: sticky.left,
                top: sticky.top,
                width: sticky.width,
              }}
              role="group"
              aria-label={ariaLabel}
            >
              <button
                type="button"
                className="data_table_hscroll_btn"
                aria-label="Scroll left"
                disabled={!canScrollLeft}
                onClick={() => scrollByDir(-1)}
              >
                <ChevronLeft size={22} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className="data_table_hscroll_btn"
                aria-label="Scroll right"
                disabled={!canScrollRight}
                onClick={() => scrollByDir(1)}
              >
                <ChevronRight size={22} strokeWidth={2} aria-hidden />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
