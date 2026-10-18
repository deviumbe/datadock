// Theme engine: a preset (or the user's custom colours) is seven base colours;
// everything the stylesheet consumes (surfaces, borders, text tiers, accent
// states, syntax + chart palettes) is derived here and written as CSS custom
// properties on <html>. Presets may pin hand-tuned values for any derived token.
import type { IconWeight, ThemeColors, ThemeSettings } from '@shared/types'
import { ICON_SETS } from './iconSets'

export type Mode = 'dark' | 'light'

export interface ThemePreset {
  id: string
  label: string
  mode: Mode
  colors: ThemeColors
  overrides?: Record<string, string>
}

// ---- colour maths -----------------------------------------------------------

type Rgb = [number, number, number]

function parse(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [128, 128, 128]
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function toHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
/** Linear blend of `a` toward `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a)
  const y = parse(b)
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
export function alpha(hex: string, a: number): string {
  const [r, g, b] = parse(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
function luminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = parse(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
export function isValidHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v.trim())
}

// ---- presets ------------------------------------------------------------------

// The shipped Midnight/Snow values are pinned so the default look is unchanged
// by the derivation; the other presets rely on it fully.
export const PRESETS: ThemePreset[] = [
  {
    id: 'midnight',
    label: 'Midnight',
    mode: 'dark',
    colors: { bg: '#0c1322', surface: '#0e1626', text: '#dce2f8', accent: '#2dd4bf', danger: '#f87171', warn: '#f0b429', ok: '#4ade80' },
    overrides: {
      '--bg-sidebar': '#10182a',
      '--bg-elevated': '#1b2438',
      '--bg-input': '#131b2c',
      '--bg-hover': '#1a2336',
      '--bg-active': '#283149',
      '--border': '#1d2740',
      '--border-strong': '#2e3a55',
      '--text-dim': '#9aa6c4',
      '--text-faint': '#66728f',
      '--accent-hover': '#45e0cd',
      '--on-accent': '#00322c'
    }
  },
  {
    id: 'graphite',
    label: 'Graphite',
    mode: 'dark',
    colors: { bg: '#161719', surface: '#1c1d20', text: '#e8e9ec', accent: '#5b9cff', danger: '#f26d6d', warn: '#e9b949', ok: '#5ad08a' }
  },
  {
    id: 'nord',
    label: 'Nord',
    mode: 'dark',
    colors: { bg: '#2e3440', surface: '#333a48', text: '#eceff4', accent: '#88c0d0', danger: '#bf616a', warn: '#ebcb8b', ok: '#a3be8c' }
  },
  {
    id: 'dusk',
    label: 'Dusk',
    mode: 'dark',
    colors: { bg: '#232530', surface: '#282a36', text: '#f8f8f2', accent: '#bd93f9', danger: '#ff5555', warn: '#ffb86c', ok: '#50fa7b' }
  },
  {
    id: 'mocha',
    label: 'Mocha',
    mode: 'dark',
    colors: { bg: '#181825', surface: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa', danger: '#f38ba8', warn: '#f9e2af', ok: '#a6e3a1' }
  },
  {
    id: 'solarized-dark',
    label: 'Solarized',
    mode: 'dark',
    colors: { bg: '#002b36', surface: '#073642', text: '#eee8d5', accent: '#268bd2', danger: '#dc322f', warn: '#b58900', ok: '#859900' }
  },
  {
    id: 'ember',
    label: 'Ember',
    mode: 'dark',
    colors: { bg: '#1d1b1a', surface: '#242120', text: '#f2ebe3', accent: '#f97316', danger: '#ef5350', warn: '#fbbf24', ok: '#66bb6a' }
  },
  {
    id: 'snow',
    label: 'Snow',
    mode: 'light',
    colors: { bg: '#f5f7fb', surface: '#ffffff', text: '#16203a', accent: '#14b8a6', danger: '#e23b4e', warn: '#c2820f', ok: '#1f9d63' },
    overrides: {
      '--bg-sidebar': '#eef1f7',
      '--bg-elevated': '#f1f4f9',
      '--bg-hover': '#eaeef5',
      '--bg-active': '#dde4ef',
      '--border': '#e4e8f0',
      '--border-strong': '#cfd6e2',
      '--text-dim': '#5c6781',
      '--text-faint': '#8a94a8',
      '--accent-hover': '#0d9488',
      '--on-accent': '#ffffff'
    }
  },
  {
    id: 'paper',
    label: 'Paper',
    mode: 'light',
    colors: { bg: '#f4f1ea', surface: '#fffdf8', text: '#2a2520', accent: '#c2410c', danger: '#c62828', warn: '#a16207', ok: '#2e7d32' }
  },
  {
    id: 'slate',
    label: 'Slate',
    mode: 'light',
    colors: { bg: '#eef0f4', surface: '#ffffff', text: '#1f2937', accent: '#4f46e5', danger: '#dc2626', warn: '#b45309', ok: '#15803d' }
  },
  {
    id: 'latte',
    label: 'Latte',
    mode: 'light',
    colors: { bg: '#e6e9ef', surface: '#eff1f5', text: '#4c4f69', accent: '#1e66f5', danger: '#d20f39', warn: '#df8e1d', ok: '#40a02b' }
  },
  {
    id: 'solarized-light',
    label: 'Solarized',
    mode: 'light',
    colors: { bg: '#eee8d5', surface: '#fdf6e3', text: '#073642', accent: '#268bd2', danger: '#dc322f', warn: '#b58900', ok: '#859900' }
  }
]

export const CUSTOM_ID = 'custom'

export function presetsFor(mode: Mode): ThemePreset[] {
  return PRESETS.filter((p) => p.mode === mode)
}

export function findPreset(id: string, mode: Mode): ThemePreset {
  return PRESETS.find((p) => p.id === id && p.mode === mode) ?? presetsFor(mode)[0]
}

/** The colours + overrides in effect for the given settings and resolved mode. */
export function resolveTheme(s: ThemeSettings, mode: Mode): ThemePreset {
  const id = mode === 'dark' ? s.darkPreset : s.lightPreset
  const custom = mode === 'dark' ? s.customDark : s.customLight
  if (id === CUSTOM_ID && custom) {
    return { id: CUSTOM_ID, label: 'Custom', mode, colors: custom }
  }
  return findPreset(id, mode)
}

// ---- fonts ---------------------------------------------------------------------

export interface FontChoice {
  id: string
  label: string
  stack: string
}

const SYSTEM_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const SYSTEM_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

export const UI_FONTS: FontChoice[] = [
  { id: 'system', label: 'System', stack: SYSTEM_SANS },
  { id: 'inter', label: 'Inter', stack: `'Inter', ${SYSTEM_SANS}` },
  { id: 'geist', label: 'Geist', stack: `'Geist', ${SYSTEM_SANS}` },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: `'IBM Plex Sans', ${SYSTEM_SANS}` },
  { id: 'source-sans', label: 'Source Sans', stack: `'Source Sans 3', ${SYSTEM_SANS}` },
  { id: 'manrope', label: 'Manrope', stack: `'Manrope', ${SYSTEM_SANS}` },
  { id: 'dm-sans', label: 'DM Sans', stack: `'DM Sans', ${SYSTEM_SANS}` },
  { id: 'space-grotesk', label: 'Space Grotesk', stack: `'Space Grotesk', ${SYSTEM_SANS}` }
]

export const CODE_FONTS: FontChoice[] = [
  { id: 'system-mono', label: 'System mono', stack: SYSTEM_MONO },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: `'JetBrains Mono', ${SYSTEM_MONO}` },
  { id: 'geist-mono', label: 'Geist Mono', stack: `'Geist Mono', ${SYSTEM_MONO}` },
  { id: 'fira-code', label: 'Fira Code', stack: `'Fira Code', ${SYSTEM_MONO}` },
  { id: 'source-code-pro', label: 'Source Code Pro', stack: `'Source Code Pro', ${SYSTEM_MONO}` },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', stack: `'IBM Plex Mono', ${SYSTEM_MONO}` }
]

function fontStack(list: FontChoice[], id: string): string {
  return (list.find((f) => f.id === id) ?? list[1]).stack
}

// ---- icons ---------------------------------------------------------------------

export const ICON_SET_IDS = Object.keys(ICON_SETS)
export const ICON_WEIGHTS: { id: IconWeight; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'regular', label: 'Regular' },
  { id: 'bold', label: 'Bold' }
]
export function iconSetSupportsWeight(id: string): boolean {
  const def = ICON_SETS[id]
  return !!def && (!!def.strokeWidths || Object.keys(def.variants).length > 1)
}

// ---- derivation ------------------------------------------------------------------

const CHART_HUES = ['#5b8def', '#e0a14a', '#b07fd6', '#22d3ee', '#ec4899', '#a3e635', '#f59e0b']

export function deriveVars(theme: ThemePreset): Record<string, string> {
  const { bg, surface, text, accent, danger, warn, ok } = theme.colors
  const dark = theme.mode === 'dark'
  const white = '#ffffff'
  const black = '#000000'

  const v: Record<string, string> = {
    '--bg-app': bg,
    '--bg-panel': surface,
    '--bg-sidebar': dark ? mix(surface, text, 0.015) : mix(bg, text, 0.03),
    '--bg-input': dark ? mix(surface, text, 0.03) : surface,
    '--bg-hover': dark ? mix(surface, text, 0.06) : mix(bg, text, 0.05),
    '--bg-elevated': dark ? mix(surface, text, 0.07) : mix(bg, text, 0.02),
    '--bg-active': dark ? mix(surface, text, 0.13) : mix(bg, text, 0.11),

    '--border': dark ? mix(surface, text, 0.08) : mix(surface, text, 0.1),
    '--border-strong': dark ? mix(surface, text, 0.16) : mix(surface, text, 0.2),
    '--text': text,
    '--text-dim': mix(text, dark ? surface : bg, 0.3),
    '--text-faint': mix(text, dark ? surface : bg, 0.52),

    '--accent': accent,
    '--accent-hover': dark ? mix(accent, white, 0.12) : mix(accent, black, 0.12),
    '--accent-soft': alpha(accent, 0.13),
    '--accent-tint': alpha(accent, 0.06),
    '--accent-selection': alpha(accent, 0.2),
    '--accent-glow': alpha(accent, 0.25),
    '--accent-ring': alpha(accent, 0.5),
    '--on-accent': luminance(accent) > 0.4 ? mix(accent, black, 0.78) : white,

    '--danger': danger,
    '--warn': warn,
    '--ok': ok,

    '--shadow-modal': dark ? '0 24px 60px rgba(0, 0, 0, 0.55)' : '0 24px 60px rgba(15, 30, 60, 0.18)',
    '--shadow-pop': dark ? '0 10px 30px rgba(0, 0, 0, 0.45)' : '0 10px 30px rgba(15, 30, 60, 0.12)',
    '--shadow-card': dark
      ? '0 1px 2px rgba(0, 0, 0, 0.18), 0 10px 28px rgba(0, 0, 0, 0.2)'
      : '0 1px 2px rgba(15, 30, 60, 0.06), 0 8px 22px rgba(15, 30, 60, 0.08)',
    '--shadow-card-hover': dark
      ? '0 1px 2px rgba(0, 0, 0, 0.22), 0 14px 36px rgba(0, 0, 0, 0.28)'
      : '0 1px 2px rgba(15, 30, 60, 0.08), 0 12px 30px rgba(15, 30, 60, 0.12)',
    '--border-soft': alpha(text, dark ? 0.05 : 0.07),
    '--bg-zebra': alpha(text, 0.022),

    '--syn-keyword': dark ? mix(accent, white, 0.18) : mix(accent, black, 0.18),
    '--syn-string': dark ? mix(ok, text, 0.35) : mix(ok, black, 0.2),
    '--syn-number': dark ? warn : mix(warn, black, 0.15),
    '--syn-comment': mix(text, dark ? surface : bg, 0.52),
    '--syn-function': dark ? '#c8b4f6' : '#6d4fc2',
    '--syn-type': accent,
    '--syn-operator': mix(text, dark ? surface : bg, 0.3),

    '--chart-1': accent
  }
  CHART_HUES.forEach((h, i) => {
    v[`--chart-${i + 2}`] = dark ? h : mix(h, black, 0.1)
  })
  Object.assign(v, theme.overrides ?? {})
  return v
}

/** Every variable name deriveVars can emit, so a switch clears stale ones. */
const ALL_VARS = Object.keys(
  deriveVars({ id: '', label: '', mode: 'dark', colors: PRESETS[0].colors })
)

export interface AppliedTheme {
  mode: Mode
  preset: ThemePreset
  /** Window chrome colour for Electron's `setBackgroundColor`. */
  background: string
}

export function applyTheme(s: ThemeSettings, mode: Mode): AppliedTheme {
  const preset = resolveTheme(s, mode)
  const vars = deriveVars(preset)
  const root = document.documentElement
  for (const name of ALL_VARS) root.style.removeProperty(name)
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  root.style.setProperty('--font', fontStack(UI_FONTS, s.uiFont))
  root.style.setProperty('--font-display', fontStack(UI_FONTS, s.uiFont))
  root.style.setProperty('--mono', fontStack(CODE_FONTS, s.codeFont))
  root.style.colorScheme = mode
  root.setAttribute('data-theme', mode)
  root.setAttribute('data-sidebar', s.sidebarLayout)
  return { mode, preset, background: preset.colors.bg }
}
