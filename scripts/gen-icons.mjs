// Generates src/renderer/src/lib/icons/*.ts from the icon packages in
// node_modules. Each DataDock icon name is mapped to one glyph per set; the
// script inlines the SVG inner markup so the renderer bundle never has to ship
// (or lazily fetch) thousands of unused SVG files.
//
//   node scripts/gen-icons.mjs
//
// Add a new icon by giving it a name in every set below, then re-run. A new set
// also needs an entry in src/renderer/src/lib/iconSets.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nm = resolve(root, 'node_modules')

// name → [lucide, tabler, phosphor, heroicons, material]
const MAP = {
  menu: ['menu', 'menu-2', 'list', 'bars-3', 'menu'],
  search: ['search', 'search', 'magnifying-glass', 'magnifying-glass', 'search'],
  sun: ['sun', 'sun', 'sun', 'sun', 'light_mode'],
  moon: ['moon', 'moon', 'moon', 'moon', 'dark_mode'],
  command: ['command', 'command', 'command', 'command-line', 'keyboard_command_key'],
  sparkles: ['sparkles', 'sparkles', 'sparkle', 'sparkles', 'wand_stars'],
  chart: ['chart-column', 'chart-bar', 'chart-bar', 'chart-bar', 'bar_chart'],
  plus: ['plus', 'plus', 'plus', 'plus', 'add'],
  power: ['power', 'power', 'power', 'power', 'power_settings_new'],
  lock: ['lock', 'lock', 'lock', 'lock-closed', 'lock'],
  unlock: ['lock-open', 'lock-open', 'lock-open', 'lock-open', 'lock_open'],
  play: ['play', 'player-play', 'play', 'play', 'play_arrow'],
  stop: ['square', 'player-stop', 'stop', 'stop', 'stop'],
  pause: ['pause', 'player-pause', 'pause', 'pause', 'pause'],
  refresh: ['refresh-cw', 'refresh', 'arrows-clockwise', 'arrow-path', 'refresh'],
  chevronLeft: ['chevron-left', 'chevron-left', 'caret-left', 'chevron-left', 'chevron_left'],
  chevronRight: ['chevron-right', 'chevron-right', 'caret-right', 'chevron-right', 'chevron_right'],
  chevronDown: ['chevron-down', 'chevron-down', 'caret-down', 'chevron-down', 'keyboard_arrow_down'],
  chevronUp: ['chevron-up', 'chevron-up', 'caret-up', 'chevron-up', 'keyboard_arrow_up'],
  pencil: ['pencil', 'pencil', 'pencil-simple', 'pencil', 'edit'],
  trash: ['trash-2', 'trash', 'trash', 'trash', 'delete'],
  star: ['star', 'star', 'star', 'star', 'star'],
  download: ['download', 'download', 'download-simple', 'arrow-down-tray', 'download'],
  upload: ['upload', 'upload', 'upload-simple', 'arrow-up-tray', 'upload'],
  tableExport: ['file-output', 'table-export', 'export', 'arrow-up-on-square', 'file_export'],
  filter: ['funnel', 'filter', 'funnel', 'funnel', 'filter_alt'],
  x: ['x', 'x', 'x', 'x-mark', 'close'],
  table: ['table', 'table', 'table', 'table-cells', 'table'],
  view: ['eye', 'eye', 'eye', 'eye', 'visibility'],
  database: ['database', 'database', 'database', 'circle-stack', 'database'],
  server: ['server', 'server', 'hard-drives', 'server-stack', 'dns'],
  code: ['code', 'code', 'code', 'code-bracket', 'code'],
  format: ['align-left', 'align-left', 'text-align-left', 'bars-3-bottom-left', 'format_align_left'],
  check: ['check', 'check', 'check', 'check', 'check'],
  swap: ['arrow-left-right', 'arrows-exchange', 'arrows-left-right', 'arrows-right-left', 'swap_horiz'],
  explain: ['chart-pie', 'chart-pie', 'chart-pie-slice', 'chart-pie', 'pie_chart'],
  plan: ['list-tree', 'list-tree', 'tree-view', 'queue-list', 'account_tree'],
  target: ['target', 'target', 'target', 'viewfinder-circle', 'target'],
  external: ['external-link', 'external-link', 'arrow-square-out', 'arrow-top-right-on-square', 'open_in_new'],
  clock: ['clock', 'clock', 'clock', 'clock', 'schedule'],
  info: ['info', 'info-circle', 'info', 'information-circle', 'info'],
  warn: ['triangle-alert', 'alert-triangle', 'warning', 'exclamation-triangle', 'warning'],
  diagram: ['workflow', 'hierarchy-2', 'tree-structure', 'rectangle-group', 'schema'],
  bolt: ['zap', 'bolt', 'lightning', 'bolt', 'bolt'],
  note: ['file-text', 'file-text', 'note', 'document-text', 'description'],
  bookmark: ['bookmark', 'bookmark', 'bookmark-simple', 'bookmark', 'bookmark'],
  copy: ['copy', 'copy', 'copy', 'document-duplicate', 'content_copy'],
  folder: ['folder', 'folder', 'folder', 'folder', 'folder'],
  user: ['user', 'user', 'user', 'user', 'person'],
  building: ['building-2', 'building', 'buildings', 'building-office-2', 'apartment'],
  sliders: ['sliders-horizontal', 'adjustments-horizontal', 'sliders-horizontal', 'adjustments-horizontal', 'tune'],
  palette: ['palette', 'palette', 'palette', 'swatch', 'palette'],
  type: ['type', 'typography', 'text-aa', 'language', 'text_fields'],
  shapes: ['shapes', 'shape', 'shapes', 'square-3-stack-3d', 'interests'],
  more: ['ellipsis', 'dots', 'dots-three', 'ellipsis-horizontal', 'more_horiz'],
  minus: ['minus', 'minus', 'minus', 'minus', 'remove'],
  arrowRight: ['arrow-right', 'arrow-right', 'arrow-right', 'arrow-right', 'arrow_forward'],
  arrowLeft: ['arrow-left', 'arrow-left', 'arrow-left', 'arrow-left', 'arrow_back'],
  fit: ['maximize', 'maximize', 'corners-out', 'arrows-pointing-out', 'fit_screen'],
  key: ['key-round', 'key', 'key', 'key', 'key'],
  ban: ['ban', 'ban', 'prohibit', 'no-symbol', 'block'],
  settings: ['settings', 'settings', 'gear', 'cog-6-tooth', 'settings'],
  money: ['banknote', 'cash', 'money', 'banknotes', 'payments'],
  trendUp: ['trending-up', 'trending-up', 'trend-up', 'arrow-trending-up', 'trending_up'],
  trendDown: ['trending-down', 'trending-down', 'trend-down', 'arrow-trending-down', 'trending_down'],
  cart: ['shopping-cart', 'shopping-cart', 'shopping-cart', 'shopping-cart', 'shopping_cart'],
  users: ['users', 'users', 'users', 'users', 'group'],
  package: ['package', 'package', 'package', 'cube', 'package_2'],
  flame: ['flame', 'flame', 'fire', 'fire', 'local_fire_department'],
  globe: ['globe', 'world', 'globe', 'globe-alt', 'public']
}

const SETS = [
  {
    id: 'lucide',
    label: 'Lucide',
    col: 0,
    fill: false,
    strokeWidths: { light: 1.5, regular: 2, bold: 2.5 },
    variants: { regular: (n) => `lucide-static/icons/${n}.svg` }
  },
  {
    id: 'tabler',
    label: 'Tabler',
    col: 1,
    fill: false,
    strokeWidths: { light: 1.5, regular: 2, bold: 2.5 },
    variants: { regular: (n) => `@tabler/icons/icons/outline/${n}.svg` }
  },
  {
    id: 'phosphor',
    label: 'Phosphor',
    col: 2,
    fill: true,
    variants: {
      light: (n) => `@phosphor-icons/core/assets/light/${n}-light.svg`,
      regular: (n) => `@phosphor-icons/core/assets/regular/${n}.svg`,
      bold: (n) => `@phosphor-icons/core/assets/bold/${n}-bold.svg`
    }
  },
  {
    id: 'heroicons',
    label: 'Heroicons',
    col: 3,
    fill: false,
    strokeWidths: { light: 1.25, regular: 1.5, bold: 2 },
    variants: { regular: (n) => `heroicons/24/outline/${n}.svg` }
  },
  {
    id: 'material',
    label: 'Material',
    col: 4,
    fill: true,
    variants: { regular: (n) => `@material-symbols/svg-400/rounded/${n}.svg` }
  }
]

function inner(file) {
  const svg = readFileSync(resolve(nm, file), 'utf-8')
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 24 24'
  let body = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    // Tabler ships an invisible bounding rect first; drop it.
    .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim()
  return { viewBox, body }
}

const HEADER = '// Generated by scripts/gen-icons.mjs — do not edit by hand.'
const missing = []
const target = resolve(root, 'src/renderer/src/lib/icons')
mkdirSync(target, { recursive: true })

for (const set of SETS) {
  const out = [HEADER, "import type { IconVariants } from '../iconSets'", '', 'export default {']
  for (const [weight, pathFor] of Object.entries(set.variants)) {
    let viewBox = '0 0 24 24'
    const glyphs = []
    for (const [name, cols] of Object.entries(MAP)) {
      const file = pathFor(cols[set.col])
      try {
        const g = inner(file)
        viewBox = g.viewBox
        glyphs.push(`      ${name}: ${JSON.stringify(g.body)}`)
      } catch {
        missing.push(file)
      }
    }
    out.push(`  ${weight}: {`)
    out.push(`    viewBox: ${JSON.stringify(viewBox)},`)
    out.push('    glyphs: {')
    out.push(glyphs.join(',\n'))
    out.push('    }')
    out.push('  },')
  }
  out.push('} satisfies IconVariants', '')
  writeFileSync(resolve(target, `${set.id}.ts`), out.join('\n'), 'utf-8')
}

if (missing.length) {
  console.error('Missing icon files:\n  ' + missing.join('\n  '))
  process.exit(1)
}

console.log(`Wrote ${target} (${Object.keys(MAP).length} icons × ${SETS.length} sets)`)
