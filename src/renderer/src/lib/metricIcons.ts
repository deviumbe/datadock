import { DEFAULT_ICONS } from './iconSets'

export const METRIC_ICONS = [
  'money',
  'trendUp',
  'trendDown',
  'cart',
  'users',
  'package',
  'star',
  'bolt',
  'flame',
  'check',
  'clock',
  'globe'
] as const

// Cards saved before metric icons came from the icon set (and some AI replies)
// store an emoji instead of an icon name.
const FROM_EMOJI: Record<string, string> = {
  '💰': 'money',
  '💵': 'money',
  '💶': 'money',
  '📈': 'trendUp',
  '📉': 'trendDown',
  '🛒': 'cart',
  '🛍': 'cart',
  '👥': 'users',
  '👤': 'user',
  '🧑': 'user',
  '📦': 'package',
  '⭐': 'star',
  '⚡': 'bolt',
  '🔥': 'flame',
  '✅': 'check',
  '⏱': 'clock',
  '⏰': 'clock',
  '🌍': 'globe',
  '🌎': 'globe',
  '🌐': 'globe',
  '📊': 'chart',
  '🧾': 'note',
  '🎯': 'target'
}

const GLYPHS = DEFAULT_ICONS.glyphs

/** The icon-set name for a stored metric icon, or undefined when it has none. */
export function metricIconName(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  const plain = stored.replace(/️/g, '')
  if (FROM_EMOJI[plain]) return FROM_EMOJI[plain]
  return plain in GLYPHS ? plain : undefined
}
