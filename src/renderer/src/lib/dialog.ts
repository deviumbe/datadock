import { onBeforeUnmount, onMounted, type Ref } from 'vue'

interface DialogEntry {
  el: () => HTMLElement | null
  onEscape: () => void
  returnFocus: HTMLElement | null
}

const stack: DialogEntry[] = []

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]'

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]')
  )
}

// One listener for the whole stack: with a listener per dialog, the topmost one
// unmounts between listeners and the same Escape then closes the next one too.
function onKeydown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1]
  const root = top?.el()
  if (!top || !root) return
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return
    e.preventDefault()
    top.onEscape()
  } else if (e.key === 'Tab') {
    const items = focusables(root)
    if (!items.length) {
      e.preventDefault()
      root.focus()
      return
    }
    const at = document.activeElement
    const first = items[0]
    const last = items[items.length - 1]
    const outside = !root.contains(at)
    if (e.shiftKey ? at === first || at === root || outside : at === last || outside) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    }
  }
}

/** Focus containment, focus return and Escape for anything that overlays the app. */
export function useDialog(
  el: Ref<HTMLElement | null | undefined>,
  opts: { onEscape: () => void; initial?: string[] }
): void {
  const entry: DialogEntry = {
    el: () => el.value ?? null,
    onEscape: opts.onEscape,
    returnFocus: null
  }

  onMounted(() => {
    const root = el.value
    const at = document.activeElement as HTMLElement | null
    entry.returnFocus = at && !root?.contains(at) && at !== document.body ? at : lastFocused
    if (!stack.length) window.addEventListener('keydown', onKeydown)
    stack.push(entry)
    if (!root || root.contains(at)) return
    for (const selector of ['[data-autofocus]', '[autofocus]', ...(opts.initial ?? [])]) {
      const scope = root.querySelector<HTMLElement>(selector)
      if (!scope) continue
      const target = scope.matches(FOCUSABLE) && scope.tabIndex >= 0 ? scope : focusables(scope)[0]
      if (target) {
        target.focus()
        return
      }
    }
    ;(focusables(root)[0] ?? root).focus()
  })

  onBeforeUnmount(() => {
    const i = stack.indexOf(entry)
    if (i !== -1) stack.splice(i, 1)
    if (!stack.length) window.removeEventListener('keydown', onKeydown)
    const at = document.activeElement
    const owned = !at || at === document.body || !!el.value?.contains(at)
    if (owned && entry.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true })
  })
}

export function dialogOpen(): boolean {
  return stack.length > 0
}

// A dialog whose content focuses itself on mount has already moved focus by the
// time useDialog runs, so remember where focus was outside any dialog.
let lastFocused: HTMLElement | null = null
document.addEventListener('focusin', (e) => {
  const el = e.target as HTMLElement
  if (!el.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) lastFocused = el
})
