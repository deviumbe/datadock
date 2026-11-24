import { shallowReactive } from 'vue'
import lucide from './icons/lucide'

export type IconWeight = 'light' | 'regular' | 'bold'
export interface IconGlyphs {
  viewBox: string
  glyphs: Record<string, string>
}
export type IconVariants = Partial<Record<IconWeight, IconGlyphs>> & { regular: IconGlyphs }
export interface IconSetDef {
  label: string
  /** Filled glyphs take `fill: currentColor`; stroked ones take stroke + width. */
  fill: boolean
  strokeWidths?: Record<IconWeight, number>
  weights: boolean
  load: () => Promise<{ default: IconVariants }>
}

export const ICON_SETS: Record<string, IconSetDef> = {
  lucide: {
    label: 'Lucide',
    fill: false,
    strokeWidths: { light: 1.5, regular: 2, bold: 2.5 },
    weights: true,
    load: () => Promise.resolve({ default: lucide })
  },
  tabler: {
    label: 'Tabler',
    fill: false,
    strokeWidths: { light: 1.5, regular: 2, bold: 2.5 },
    weights: true,
    load: () => import('./icons/tabler')
  },
  phosphor: {
    label: 'Phosphor',
    fill: true,
    weights: true,
    load: () => import('./icons/phosphor')
  },
  heroicons: {
    label: 'Heroicons',
    fill: false,
    strokeWidths: { light: 1.25, regular: 1.5, bold: 2 },
    weights: true,
    load: () => import('./icons/heroicons')
  },
  material: {
    label: 'Material',
    fill: true,
    weights: false,
    load: () => import('./icons/material')
  }
}

export const DEFAULT_ICON_SET = 'lucide'
export const DEFAULT_ICONS: IconGlyphs = lucide.regular

const loaded = shallowReactive<Record<string, IconVariants>>({ [DEFAULT_ICON_SET]: lucide })
const loading: Record<string, Promise<void>> = {}

export function loadIconSet(id: string): Promise<void> {
  if (loaded[id] || !ICON_SETS[id]) return Promise.resolve()
  return (loading[id] ??= ICON_SETS[id].load().then((m) => void (loaded[id] = m.default)))
}

/** The set's glyphs, or undefined until they have loaded (loading starts here). */
export function iconVariants(id: string): IconVariants | undefined {
  if (!loaded[id]) void loadIconSet(id)
  return loaded[id]
}
