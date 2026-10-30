import { useEffect } from "react"

const MODAL_SELECTOR = '[aria-modal="true"]'

function modalIsOpen(): boolean {
  return document.querySelector(MODAL_SELECTOR) != null
}

function mainScroller(): HTMLElement | null {
  const node = document.querySelector(".app_main_content")
  return node instanceof HTMLElement ? node : null
}

/**
 * Dialogs rendered inside the page were scrolling the window and the main
 * pane, which left a white band above the app in Chrome and Edge.
 * While a modal is open, put the document and the main pane back where they
 * were. Scrolling inside the dialog itself is left alone.
 */
export function useAppModalScrollLock(): void {
  useEffect(() => {
    window.scrollTo(0, 0)
    let winX = 0
    let winY = 0
    let mainTop = mainScroller()?.scrollTop ?? 0

    const remember = () => {
      winX = window.scrollX
      winY = window.scrollY
      mainTop = mainScroller()?.scrollTop ?? 0
    }

    const restore = () => {
      if (window.scrollX !== winX || window.scrollY !== winY) {
        window.scrollTo(winX, winY)
      }
      const scroller = mainScroller()
      if (scroller && scroller.scrollTop !== mainTop) {
        const previous = scroller.style.scrollBehavior
        scroller.style.scrollBehavior = "auto"
        scroller.scrollTop = mainTop
        scroller.style.scrollBehavior = previous
      }
    }

    const onScroll = (event: Event) => {
      const target = event.target
      const open = modalIsOpen()
      if (
        target === document ||
        target === document.documentElement ||
        target === document.body
      ) {
        if (open) restore()
        else remember()
        return
      }
      if (
        target instanceof HTMLElement &&
        target.classList.contains("app_main_content")
      ) {
        if (open) restore()
        else mainTop = target.scrollTop
      }
    }

    let locking = false
    const sync = () => {
      const open = modalIsOpen()
      document.documentElement.classList.toggle("app_modal_open", open)
      if (open && !locking) {
        locking = true
        restore()
        requestAnimationFrame(restore)
        window.setTimeout(restore, 0)
        window.setTimeout(restore, 50)
        window.setTimeout(restore, 150)
      } else if (!open && locking) {
        locking = false
        remember()
      }
    }

    remember()
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "class", "hidden", "open"],
    })
    window.addEventListener("scroll", onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener("scroll", onScroll, true)
      document.documentElement.classList.remove("app_modal_open")
    }
  }, [])
}
