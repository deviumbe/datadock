/**
 * App-wide horizontal-scroll rescue.
 *
 * High-resolution mice — notably the Logitech MX Master's thumb wheel on Windows —
 * emit horizontal scroll that Chromium barely applies (and often with a tiny
 * residual vertical delta). This installs one capture-agnostic wheel listener that,
 * on any *horizontal-dominant* wheel event, scrolls the nearest horizontally-
 * scrollable ancestor of the cursor itself, so every wide grid/table/panel in the
 * app scrolls sideways smoothly.
 *
 * - Vertical-dominant events are ignored → normal scrolling is untouched.
 * - Shift+wheel is mapped to horizontal (the usual convention), app-wide.
 * - `e.defaultPrevented` events are skipped → components with their own wheel
 *   handling (e.g. the ER diagram's ctrl-scroll zoom) keep working.
 */
export function installHorizontalWheel(): void {
  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (e.defaultPrevented) return
      const ax = Math.abs(e.deltaX)
      const ay = Math.abs(e.deltaY)
      // Horizontal-dominant wheel, or Shift+vertical wheel that the OS didn't
      // already convert to a horizontal delta.
      const shiftHoriz = e.shiftKey && ax === 0 && ay > 0
      if (ax <= ay && !shiftHoriz) return
      const raw = ax > ay ? e.deltaX : e.deltaY

      let el: Element | null = e.target instanceof Element ? e.target : null
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const ox = getComputedStyle(el).overflowX
          if (ox === 'auto' || ox === 'scroll') {
            let delta = raw
            if (e.deltaMode === 1) delta *= 16 // lines → px
            else if (e.deltaMode === 2) delta *= el.clientWidth // pages → px
            const max = el.scrollWidth - el.clientWidth
            const next = Math.max(0, Math.min(max, el.scrollLeft + delta))
            if (next !== el.scrollLeft) {
              el.scrollLeft = next
              e.preventDefault()
            }
            return
          }
        }
        el = el.parentElement
      }
    },
    { passive: false }
  )
}
