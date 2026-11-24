import type { Directive } from 'vue'

// Keyboard behaviour for rows that are too rich to be a plain <button> (they hold
// their own action buttons). `v-row` inside a `data-rows` container gives a single
// tab stop with arrow-key movement; `v-press` makes one element act as a button.

type RowEl = HTMLElement & { _rowCleanup?: () => void }

const pending = new Set<HTMLElement>()

function rowsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-row]')].filter(
    (r) => r.closest('[data-rows]') === container && r.getClientRects().length > 0
  )
}

function sync(container: HTMLElement, current?: HTMLElement): void {
  const rows = rowsOf(container)
  const active =
    current ??
    rows.find((r) => r === document.activeElement) ??
    rows.find((r) => r.tabIndex === 0) ??
    rows.find((r) => r.getAttribute('aria-selected') === 'true') ??
    rows[0]
  for (const row of container.querySelectorAll<HTMLElement>('[data-row]')) {
    if (row.closest('[data-rows]') !== container) continue
    const on = row === active
    row.tabIndex = on ? 0 : -1
    for (const b of row.querySelectorAll<HTMLElement>('[data-row-actions] button')) b.tabIndex = on ? 0 : -1
  }
}

function scheduleSync(container: HTMLElement | null): void {
  if (!container || pending.has(container)) return
  pending.add(container)
  queueMicrotask(() => {
    pending.delete(container)
    if (container.isConnected) sync(container)
  })
}

function level(row: HTMLElement): number {
  return Number(row.getAttribute('aria-level') ?? 1)
}

export function openContextMenuAt(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(24, r.width / 2),
      clientY: r.bottom
    })
  )
}

function onRowKeydown(e: KeyboardEvent): void {
  const row = e.currentTarget as HTMLElement
  if (e.target !== row) return
  const container = row.closest<HTMLElement>('[data-rows]')
  const horizontal = container?.dataset.rows === 'horizontal'
  const rows = container ? rowsOf(container) : [row]
  const at = rows.indexOf(row)
  const go = (i: number): void => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, i))]
    if (container) sync(container, next)
    next.focus()
  }
  const toggle = (): void => (row.querySelector<HTMLElement>('[data-toggle]') ?? row).click()
  const expanded = row.getAttribute('aria-expanded')

  switch (e.key) {
    case 'Enter':
    case ' ':
      row.dispatchEvent(
        new MouseEvent('click', { bubbles: true, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey })
      )
      break
    case 'ArrowDown':
    case 'ArrowUp':
      if (horizontal) return
      go(at + (e.key === 'ArrowDown' ? 1 : -1))
      break
    case 'ArrowRight':
      if (horizontal) go(at + 1)
      else if (expanded === 'false') toggle()
      else if (expanded === 'true') go(at + 1)
      else return
      break
    case 'ArrowLeft':
      if (horizontal) go(at - 1)
      else if (expanded === 'true') toggle()
      else {
        const parent = rows.slice(0, at).reverse().find((r) => level(r) < level(row))
        if (!parent) return
        go(rows.indexOf(parent))
      }
      break
    case 'Home':
      go(0)
      break
    case 'End':
      go(rows.length - 1)
      break
    case 'F10':
      if (!e.shiftKey) return
      openContextMenuAt(row)
      break
    default:
      return
  }
  e.preventDefault()
  e.stopPropagation()
}

export const vRow: Directive<RowEl> = {
  mounted(el) {
    el.dataset.row = ''
    el.tabIndex = -1
    const container = el.closest<HTMLElement>('[data-rows]')
    const onFocus = (): void => {
      if (container) sync(container, el)
    }
    el.addEventListener('keydown', onRowKeydown)
    el.addEventListener('focusin', onFocus)
    el._rowCleanup = () => {
      el.removeEventListener('keydown', onRowKeydown)
      el.removeEventListener('focusin', onFocus)
      scheduleSync(container)
    }
    scheduleSync(container)
  },
  updated(el) {
    // Runs for every row on each re-render, so only resync when the container has
    // lost its tab stop (filtered out or collapsed).
    const container = el.closest<HTMLElement>('[data-rows]')
    const stop = container?.querySelector<HTMLElement>('[data-row][tabindex="0"]')
    if (!stop || !stop.offsetParent) scheduleSync(container)
  },
  unmounted(el) {
    el._rowCleanup?.()
  }
}

function onPressKeydown(e: KeyboardEvent): void {
  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).click()
}

export const vPress: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, { value }) {
    el.addEventListener('keydown', onPressKeydown)
    applyPress(el, value)
  },
  updated(el, { value }) {
    applyPress(el, value)
  },
  unmounted(el) {
    el.removeEventListener('keydown', onPressKeydown)
  }
}

function applyPress(el: HTMLElement, value: boolean | undefined): void {
  if (value === false) {
    el.removeAttribute('tabindex')
    el.removeAttribute('role')
  } else {
    el.tabIndex = 0
    el.setAttribute('role', 'button')
  }
}
