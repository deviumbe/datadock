// App-wide tooltips. Any control with a `title` gets a fast, themed tooltip in
// place of the OS one; `data-tip` adds a second line saying what pressing it does.
// A trailing "(⌘K)" in the title is drawn as a key hint.

const TARGETS =
  'button[title], a[title], select[title], input[title], summary[title], [role="button"][title], [role="separator"][title], [data-tooltip]'
const SHOW_DELAY = 350
const HIDE_DELAY = 120
// Moving along a toolbar shows each next tooltip at once.
const WARM_WINDOW = 400
const GAP = 8

let tip: HTMLElement | null = null
let anchor: HTMLElement | null = null
let showTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
let lastHidden = 0

// While our tooltip owns the hover, the native title must be gone or the OS draws
// a second one. Anything that relied on it for its name keeps it via aria-label.
let suppressed: { el: HTMLElement; title: string; labelled: boolean } | null = null

function suppressNative(el: HTMLElement): void {
  const title = el.getAttribute('title')
  if (!title) return
  // innerText, not textContent: a label collapsed to icon-only names nothing.
  const labelled = !el.hasAttribute('aria-label') && !el.innerText.trim()
  if (labelled) el.setAttribute('aria-label', title)
  el.removeAttribute('title')
  suppressed = { el, title, labelled }
}
function restoreNative(): void {
  if (!suppressed) return
  const { el, title, labelled } = suppressed
  if (!el.hasAttribute('title')) el.setAttribute('title', title)
  if (labelled) el.removeAttribute('aria-label')
  suppressed = null
}

function textOf(el: HTMLElement): string {
  if (suppressed?.el === el) return el.getAttribute('title') ?? suppressed.title
  return el.getAttribute('title') ?? el.dataset.tooltip ?? ''
}

function element(): HTMLElement {
  if (tip) return tip
  tip = document.createElement('div')
  tip.className = 'dd-tip'
  tip.id = 'dd-tip'
  tip.setAttribute('role', 'tooltip')
  tip.addEventListener('pointerenter', () => clearTimeout(hideTimer))
  tip.addEventListener('pointerleave', scheduleHide)
  document.body.append(tip)
  return tip
}

function fill(el: HTMLElement, target: HTMLElement): void {
  const raw = textOf(target)
  const key = /\s*\(([⌘⇧⌥⌃↵⌫A-Z0-9+−,]{1,6})\)$/.exec(raw)
  const line = document.createElement('div')
  line.className = 'dd-tip-title'
  line.textContent = key ? raw.slice(0, key.index) : raw
  if (key) {
    const kbd = document.createElement('kbd')
    kbd.textContent = key[1]
    line.append(kbd)
  }
  el.replaceChildren(line)
  if (target.dataset.tip) {
    const detail = document.createElement('div')
    detail.className = 'dd-tip-detail'
    detail.textContent = target.dataset.tip
    el.append(detail)
  }
}

function place(el: HTMLElement, target: HTMLElement): void {
  const r = target.getBoundingClientRect()
  const { offsetWidth: w, offsetHeight: h } = el
  const below = r.bottom + GAP + h <= window.innerHeight
  const x = Math.max(GAP, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - GAP))
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(below ? r.bottom + GAP : r.top - GAP - h)}px`
}

function show(target: HTMLElement, fromPointer: boolean): void {
  if (!target.isConnected || !textOf(target)) return
  hide()
  anchor = target
  const el = element()
  fill(el, target)
  // Last in <body> so it stacks above any dialog opened since it was created.
  document.body.append(el)
  el.classList.add('on')
  place(el, target)
  if (fromPointer) suppressNative(target)
  target.setAttribute('aria-describedby', el.id)
}

function hide(): void {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  restoreNative()
  if (!anchor) return
  if (anchor.getAttribute('aria-describedby') === 'dd-tip') anchor.removeAttribute('aria-describedby')
  anchor = null
  tip?.classList.remove('on')
  lastHidden = performance.now()
}
function scheduleHide(): void {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  hideTimer = setTimeout(hide, HIDE_DELAY)
}

function request(target: HTMLElement, fromPointer: boolean): void {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  const warm = !!anchor || performance.now() - lastHidden < WARM_WINDOW
  showTimer = setTimeout(() => show(target, fromPointer), warm ? 0 : SHOW_DELAY)
}

function targetOf(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  if (suppressed && suppressed.el.contains(node)) return suppressed.el
  return node.closest<HTMLElement>(TARGETS)
}

export function installTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return
    const target = targetOf(e.target)
    if (target === anchor && anchor) {
      clearTimeout(hideTimer)
      return
    }
    if (target) request(target, true)
    else if (!tip?.contains(e.target as Node)) scheduleHide()
  })
  document.addEventListener('pointerleave', scheduleHide)
  document.addEventListener('focusin', (e) => {
    const target = targetOf(e.target)
    if (target && target === e.target && target.matches(':focus-visible')) request(target, false)
    else if (anchor && e.target !== anchor) hide()
  })
  document.addEventListener('focusout', scheduleHide)
  document.addEventListener('pointerdown', hide, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') hide()
    },
    true
  )
}
