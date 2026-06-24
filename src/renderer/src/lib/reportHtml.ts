// Compose a self-contained HTML document for PDF/report export. Chart images are
// embedded as data-URLs by the caller, so the resulting HTML needs no network.

export interface CardSnapshot {
  title: string
  type: string
  icon?: string
  /** PNG data-URL for graphical charts. */
  image?: string | null
  /** Formatted value for KPI cards. */
  valueText?: string
  /** Raw rows for table widgets. */
  columns?: string[]
  rows?: unknown[][]
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cardHtml(c: CardSnapshot): string {
  let body: string
  if (c.type === 'kpi') {
    body = `<div class="kpi">${c.icon ? `<span class="kpi-ic">${esc(c.icon)}</span>` : ''}<div><div class="kpi-label">${esc(c.title)}</div><div class="kpi-val">${esc(c.valueText ?? '—')}</div></div></div>`
  } else if (c.type === 'table') {
    const head = (c.columns ?? []).map((h) => `<th>${esc(h)}</th>`).join('')
    const rows = (c.rows ?? [])
      .map((r) => `<tr>${(r as unknown[]).map((v) => `<td>${v === null ? 'NULL' : esc(v)}</td>`).join('')}</tr>`)
      .join('')
    body = `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
  } else if (c.image) {
    body = `<img class="chart-img" src="${c.image}" />`
  } else {
    body = `<div class="muted">No preview.</div>`
  }
  const title = c.type === 'kpi' ? '' : `<div class="card-title">${esc(c.title)}</div>`
  return `<div class="card">${title}${body}</div>`
}

export function buildReportHtml(title: string, cards: CardSnapshot[], subtitle?: string): string {
  const generated = new Date().toLocaleString()
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; color: #1c2230; margin: 0; padding: 24px; }
  .report-head { display:flex; align-items:baseline; justify-content:space-between; border-bottom:2px solid #e2e6ee; padding-bottom:10px; margin-bottom:18px; }
  .report-head h1 { font-size: 20px; margin: 0; }
  .report-head .meta { font-size: 11px; color: #8a93a6; }
  .sub { font-size: 12px; color: #5b647a; margin: -8px 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .card { border: 1px solid #e2e6ee; border-radius: 10px; padding: 14px; page-break-inside: avoid; background: #fff; }
  .card-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: #2b3346; }
  .chart-img { width: 100%; height: auto; display: block; }
  .kpi { display:flex; align-items:center; gap:14px; }
  .kpi-ic { font-size: 34px; }
  .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: #8a93a6; font-weight: 600; }
  .kpi-val { font-size: 34px; font-weight: 700; color: #1c2230; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
  .tbl th, .tbl td { border-bottom: 1px solid #eef1f6; text-align: left; padding: 4px 7px; }
  .tbl th { color: #5b647a; }
  .muted { color: #98a1b3; font-size: 12px; }
  </style></head><body>
  <div class="report-head"><h1>${esc(title)}</h1><span class="meta">Generated ${esc(generated)} · DataDock</span></div>
  ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
  <div class="grid">${cards.map(cardHtml).join('')}</div>
  </body></html>`
}
