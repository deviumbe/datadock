// Captures DataDock documentation screenshots by driving the built app with
// Playwright's Electron support. Uses an isolated --user-data-dir seeded with a
// dummy e-commerce workspace, so the user's real config and any running
// instance are never touched.
//
// Run:  node scripts/capture-docs.mjs
// Out:  ../Datadock-web/assets/docs/*.png

import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

const APP_DIR = resolve(process.cwd())
const SAMPLE_DB = join(APP_DIR, 'docs', 'ecommerce_enterprise.db')
const ELECTRON_BIN = join(APP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const OUT_DIR = resolve(APP_DIR, '..', 'Datadock-web', 'assets', 'docs')

mkdirSync(OUT_DIR, { recursive: true })

// ---- isolated, seeded user-data dir ----------------------------------------
const userData = mkdtempSync(join(tmpdir(), 'datadock-docs-'))

const mainConnId = randomUUID()
const conn = (name, driver, color, extra = {}) => ({
  id: randomUUID(), name, driver, color,
  host: 'localhost', port: 5432, database: '', user: '', ssl: false,
  readOnly: false, sshEnabled: false, sshPort: 22, sshAuthMethod: 'key',
  production: false, ...extra
})

// The pretty dummy tree from the original screenshots. Only "ecommerce" is a
// real, reachable SQLite db; the rest are decorative for the connection tree.
const workspace = {
  projects: [
    {
      id: randomUUID(), name: 'E-Commerce Platform',
      environments: [
        { id: randomUUID(), name: 'Production', connections: [
          { ...conn('ecommerce', 'sqlite', '#2dd4bf', { filePath: SAMPLE_DB }), id: mainConnId },
          conn('analytics-replica', 'postgres', '#5b8def', { host: 'replica.internal', database: 'analytics', user: 'reader' })
        ]},
        { id: randomUUID(), name: 'Staging', connections: [
          conn('staging-orders', 'mssql', '#e0a14a', { host: 'staging.internal', database: 'orders', port: 1433 })
        ]}
      ]
    },
    {
      id: randomUUID(), name: 'Internal Tools',
      environments: [
        { id: randomUUID(), name: 'Local', connections: [
          conn('cache', 'redis', '#d97777', { host: 'localhost', port: 6379 }),
          conn('metrics', 'influxdb', '#b07fd6', { url: 'http://localhost:8086', org: 'acme', bucket: 'metrics' })
        ]}
      ]
    }
  ]
}

writeFileSync(join(userData, 'datadock.json'), JSON.stringify(workspace, null, 2))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({
  ai: { activeProvider: 'ollama', providers: { ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' } } },
  appearance: { fontScale: 1, density: 'comfortable', pageSize: 200, theme: 'dark' },
  mcp: { enabled: false, port: 4319, token: 'x', allowWrites: false }
}, null, 2))

// ---- helpers ----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let app, page
const log = (...a) => console.log('  ', ...a)

async function menu(action) {
  await app.evaluate(({ BrowserWindow }, act) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.webContents.send('menu:action', act)
  }, action)
}

async function shot(name) {
  await page.screenshot({ path: join(OUT_DIR, name) })
  log('captured', name)
}

async function tryStep(name, fn) {
  try { await fn(); } catch (e) { log('SKIP', name, '-', e.message.split('\n')[0]) }
}

// Close any open modal/overlay by clicking its button, falling back to Escape.
async function closeOverlay() {
  for (const label of ['Done', 'Cancel', 'Close']) {
    const b = page.getByRole('button', { name: label, exact: true }).first()
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await sleep(400); return }
  }
  await page.keyboard.press('Escape'); await sleep(400)
}

// ---- run --------------------------------------------------------------------
const main = async () => {
  app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: ['.', `--user-data-dir=${userData}`, '--lang=en-US'],
    cwd: APP_DIR
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1440, height: 900 })
  await sleep(1500)

  // 1) Connections tree (nothing open yet)
  await tryStep('connections', async () => { await shot('connections.png') })

  // Connect to the real sqlite db + open the orders table
  await tryStep('connect', async () => {
    await page.getByText('ecommerce', { exact: true }).first().click()
    await sleep(1800)
    await page.getByText('orders', { exact: true }).first().click()
    await sleep(1500)
  })

  await tryStep('data', async () => { await shot('data.png') })

  // 2) Structure tab
  await tryStep('structure', async () => {
    await page.getByText('Structure', { exact: true }).first().click()
    await sleep(800)
    await shot('structure.png')
    await page.getByText('Data', { exact: true }).first().click()
    await sleep(500)
  })

  // 3) ER diagram
  await tryStep('diagram', async () => { await menu('diagram'); await sleep(2500); await shot('er-diagram.png') })

  // 4) SQL query editor — schema-correct query that returns rows
  await tryStep('query', async () => {
    await menu('newQuery'); await sleep(1200)
    const ed = page.locator('.cm-content, textarea').first()
    await ed.click()
    const sql = "SELECT c.first_name || ' ' || c.last_name AS customer,\n       COUNT(o.id) AS orders,\n       SUM(o.total_amount) AS spend\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.id\nORDER BY spend DESC\nLIMIT 10;"
    await page.keyboard.type(sql)
    await sleep(500)
    // run a few times so Performance shows healthy, error-free history
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Meta+Enter'); await sleep(900) }
    await shot('query.png')
  })

  // 5) Built-in AI chat panel (UI; provider offline so no live answer)
  await tryStep('chat', async () => {
    await menu('chat'); await sleep(1500)
    const inp = page.getByPlaceholder(/ask/i).first()
    await inp.click({ timeout: 3000 }).catch(() => {})
    await inp.type('What was my biggest sale this year?').catch(() => {})
    await sleep(500)
    await shot('ai-chat.png')
  })

  // 6) Performance & insights (after successful queries)
  await tryStep('performance', async () => { await menu('performance'); await sleep(2000); await shot('performance.png') })

  // ---- overlays: open, capture, close cleanly before the next ----
  // 7) Table sizes modal
  await tryStep('tableSizes', async () => { await menu('tableSizes'); await sleep(1500); await shot('table-sizes.png'); await closeOverlay() })

  // 8) Column search modal
  await tryStep('columnSearch', async () => { await menu('columnSearch'); await sleep(1000); await page.keyboard.type('email'); await sleep(900); await shot('column-search.png'); await closeOverlay() })

  // 9) Export modal (incl. data masking options)
  await tryStep('export', async () => {
    await page.getByText('orders', { exact: true }).first().click(); await sleep(900)
    await page.getByText('Export', { exact: true }).first().click(); await sleep(1300)
    await shot('export.png'); await closeOverlay()
  })

  // 10) Settings (AI providers)
  await tryStep('settings', async () => { await menu('openSettings'); await sleep(1300); await shot('settings.png'); await closeOverlay() })

  // 11) Command palette (opened over the data view, all overlays closed)
  await tryStep('palette', async () => { await page.keyboard.press('Meta+k'); await sleep(900); await page.keyboard.type('diag'); await sleep(600); await shot('command-palette.png'); await page.keyboard.press('Escape') })

  await app.close()
  rmSync(userData, { recursive: true, force: true })
  console.log('\nDone. Screenshots in', OUT_DIR)
}

main().catch(async (e) => {
  console.error('FATAL', e)
  try { await app?.close() } catch {}
  try { rmSync(userData, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
