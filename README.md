<div align="center">

<img src="docs/logo.png" alt="DataDock" width="120" />

# DataDock

### The database client that finally organizes itself the way *you* think.

**Projects → Environments → Connections.** One clean desktop app for PostgreSQL, MySQL, SQLite, SQL Server, MongoDB and InfluxDB — with browsing, editing, structure changes, import/export, SSH tunneling, ER diagrams and a command palette built in.

<br/>

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-1fb6a6?style=flat-square)
![Built with Electron](https://img.shields.io/badge/Electron-Vue%203%20%2B%20TypeScript-5b8def?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-3fcf8e?style=flat-square)
![Price](https://img.shields.io/badge/price-free-e0a14a?style=flat-square)

<sub>A free product by <a href="https://devium.be/"><b>Devium</b></a> — made with care, given away for nothing.</sub>

</div>

<br/>

<p align="center">
  <img src="docs/screenshots/01-connections.png" alt="DataDock — projects, environments and connections" width="860" />
</p>

---

## Why DataDock?

Most database clients dump every connection into one flat, unsearchable list. If you juggle a handful of projects — each with **local**, **staging** and **production** databases — that list becomes a guessing game.

DataDock fixes the part that actually slows you down: **organization.**

```
📁 Acme Shop
 ├─ 🗂  Local
 │   └─ ● Sample Shop        (SQLite)
 ├─ 🗂  Staging
 │   └─ ● shop-staging       (PostgreSQL)
 └─ 🗂  Production
     ├─ ● shop-primary       (PostgreSQL over SSH)
     └─ ● metrics            (InfluxDB)
```

Click your way down — **project → environment → connection** — and you're in. No more `prod_db_2_FINAL_v3` in a sea of saved connections.

---

## ✨ Features

Everything here ships **today**. Scan the table for the lay of the land, then expand the section below for the full detail.

| | Area | What you get |
|:--:|---|---|
| 🗄️ | **Organized connections** | Projects → environment folders → connections — color-coded, encrypted at rest, shareable, with a read-only safe mode |
| 🔌 | **Six engines** | PostgreSQL · MySQL / MariaDB · SQLite · SQL Server · MongoDB · InfluxDB |
| 🔐 | **SSH tunneling** | Reach databases behind a bastion via private key, password or agent |
| 📊 | **Spreadsheet-style editing** | Paginate, sort, filter, inline- and bulk-edit — every change committed in a transaction |
| 🔗 | **Visual exploration** | Click-through foreign keys, a record Explorer, an interactive ER diagram and a dependency map |
| 🧱 | **Structure editor** | Create / drop tables and edit columns, types, foreign keys & indexes — no hand-written DDL |
| ⌨️ | **Query, your way** | Multi-tab editor, schema-aware autocomplete, history, snippets, variables, formatter & EXPLAIN |
| ✨ | **Built-in AI** | NL → SQL, explain, fix-with-AI and chat-with-your-data — Claude, Gemini, Mistral, Grok or Ollama |
| 📈 | **Performance & insights** | Slow-query dashboard, index hints, pool diagnostics, table sizes & column search |
| 📦 | **Import & export** | CSV · Excel · JSON · SQL · zipped whole-DB dumps · result → new table |
| 🛠️ | **Server tools** | Databases, users & roles and a process list (with kill) |
| 🎨 | **Comfortable to live in** | Dark / light themes, a ⌘K command palette and collapsible panels |

<details>
<summary><b>📖 Expand for the full feature tour</b></summary>
<br>

#### 🗄️ Organized connections
- **Projects → Environment folders → Connections** — a real hierarchy, not a flat list.
- Color-coded connections with live status dots (connecting / connected / error).
- **Duplicate a connection** in one click — useful for cloning a staging config to try against prod.
- Credentials **encrypted at rest** with the OS keychain (Electron `safeStorage`) — never stored in plain text.
- **Read-only "safe mode"** per connection — guard production by blocking edits, inserts/deletes, DDL, imports and mutating SQL, with a clear 🔒 badge.
- **Share connections** — export your project/environment/connection tree to JSON (secrets stripped) and import it on another machine.

#### 🔌 Multi-engine
- **PostgreSQL · MySQL / MariaDB · SQLite · Microsoft SQL Server · MongoDB · InfluxDB** — all from one app.
- **MongoDB** — browse collections like tables, run shell-style queries (`db.users.find({ active: true }).sort({ name: 1 }).limit(50)`, `.aggregate([…])`, `.countDocuments(…)`), edit documents inline, and get collection/field autocomplete. Documents are flattened to columns with nested values shown as JSON.

#### 🔐 SSH tunneling
- Reach databases that only live behind a bastion: **connect via SSH (private key, password, or agent), then to the DB** — exactly how you'd hit a prod/staging box.

#### 📊 Browse & edit data like a spreadsheet
- Fast result grid with **pagination, sorting and column filters**.
- **Double-click any cell to edit**, or pop open the **row detail panel** on the side.
- Stack up changes across many rows and **commit them all at once with ⌘S** — every batch runs in a transaction.
- **Bulk edit** — tick rows with the checkbox column (or select-all), then set a column to one value (or NULL) across the whole selection in a single staged, undoable change.
- **Generate SQL from a selection** — turn the ticked rows into `INSERT` or `UPDATE` statements (PK-keyed) dropped straight into a new query tab.

#### 🧱 Visual structure editor
- **Create new tables** (define columns inline) and **drop tables** — multi-select in the list, with *Ignore foreign-key checks* and *Cascade* options.
- Add / rename / drop **columns**, change types and nullability, manage **foreign keys** and **indexes** — no hand-written DDL.

#### 🔗 ER Diagram & schema visualization
- Open the **ER Diagram tab** from the menu (or `⌘K` → *ER Diagram*) to get an interactive visual map of every table, column, primary key and foreign-key relationship in your schema.
- **Dependency explorer** — right-click any table → *Dependencies…* to see exactly what it **references** and what **references it** (the foreign keys that block a drop), and click through to any related table.
- **Hierarchical layout** — parent tables (referenced by FK) appear above their dependent children, organized into clean labelled rows. **Re-layout** button resets everything back to the hierarchy at any time.
- **Drag** any table card to rearrange freely after the initial layout.
- **⊞ Fit** scales and scrolls the view so the whole diagram is visible at once.
- **Zoom in / out** with `⌘ +` / `⌘ −`, `⌘`-scroll the mouse wheel, trackpad pinch, or the toolbar `−` / `＋` buttons. Range: 15 % – 300 %. The zoom percentage is always shown and clicking it resets to 100 %.
- PK and FK column badges; smooth Bézier edges connect related tables with smart top/bottom routing for vertically stacked cards.

#### ⚙️ Settings (⌘,)
- **AI Providers** — add keys for Anthropic, Google, Mistral or xAI (Grok), or point at a local **Ollama** server (no key needed); pick the active provider and model, and **Test** the connection.
- **Appearance** — interface scale (zoom), light/dark theme, comfortable/compact row density, and the default page size.
- **About** — a little love from [Devium](https://devium.be/): built with a smile for everybody. 🙂

#### 🎨 Comfortable to live in
- **Dark and light themes**, remembered between sessions.
- Collapsible sidebar and table list to maximize screen for data.
- **Command palette (⌘K)** — fuzzy-search connections, tables and actions from anywhere in the app. Jump to any table, open a query tab, switch themes, open the ER diagram — all without touching the mouse. Navigate with ↑↓, confirm with ↵, dismiss with Esc.

#### 🧰 Query, your way
- Multi-**tab** workspace — open a tab per table, plus scratch SQL/Flux tabs.
- Real SQL editor (CodeMirror) with syntax highlighting and **⌘↵ to run**.
- **Schema-aware autocomplete** — table and column names from the connected database, right as you type.
- **Undo / redo** of pending row edits (⌘Z / ⌘⇧Z) and **query history** to re-run past statements.
- **Saved queries / snippets** — star a query to keep it in a reusable library.
- **AI SQL assistant (✨)** — describe what you want in plain English and get a ready-to-run query for your dialect (schema-aware), **explain** an existing query in plain English, or **fix it with AI** when it errors.
- **Chat with your data (✨ Chat)** — ask questions in plain English; the assistant runs **read-only** queries against the live database and answers from the real results, showing exactly which queries it ran. Available per connection (`⌘⇧A` or ⌘K → *Chat with Data*).
- **Bring your own AI** — choose between **Anthropic (Claude), Google (Gemini), Mistral, xAI (Grok)** or a local **Ollama** server, each with your own model. Keys are encrypted with your OS keychain and never leave the main process.
- **Visual EXPLAIN (◧)** — turn a query plan into an interactive, collapsible tree with estimated row counts and cost per node (PostgreSQL & SQLite).

#### 📦 Import & export
- Export a result, a table, or a **whole database** to **CSV, Excel, JSON, SQL or zipped SQL**.
- **Result → new table (⤒)** — persist any query or table result as a brand-new table in one click; column types are inferred from the data and names sanitized to safe identifiers.
- Full-database dumps let you choose **per table**: structure, data, both, or skip.
- Import **`.sql` scripts** and **CSV → table**.

#### 🔍 Visual data explorer
- **Click-through foreign keys** — FK cells in the grid render as links; click the `→` to jump straight to the related row (filtered), then keep chaining through relationships.
- **Record Explorer** — right-click any row → *Explore record* for a focused, one-record-at-a-time view that walks both directions (parent records and "referenced by" children) with a **breadcrumb trail**.

#### 📈 Performance dashboard
- Open **Database → Performance** (`⌘⇧P`) for a themed dashboard built from your query history: **query-volume chart**, **slow-query monitor** (grouped by query shape, with a configurable threshold), **heuristic index recommendations**, **connection-pool diagnostics** and a **storage-by-table** breakdown.

#### 🛠️ Server tools
- Built-in **Databases** (create/drop), **Users & Roles**, and **Process List** (with kill).
- **Table sizes** (`⌘K` → *Table Sizes*) — row counts and on-disk size per table, largest-first with inline size bars; click any table to open it.

</details>

---

## 📸 Screenshots

| | |
|---|---|
| **Connections** — projects, environments & connections | **Data grid** — pagination, filters & inline editing |
| ![Connections](docs/screenshots/01-connections.png) | ![Data](docs/screenshots/02-data.png) |
| **Structure editor** — columns & foreign keys | **SQL editor** — multi-tab, highlighted, ⌘↵ to run |
| ![Structure](docs/screenshots/03-structure.png) | ![Query](docs/screenshots/04-query.png) |
| **Export** — whole DB, per-table structure/data | **SSH tunnel** — key / password / agent auth |
| ![Export](docs/screenshots/05-export.png) | ![SSH](docs/screenshots/06-ssh.png) |
| **Autocomplete** — schema-aware table & column names | **ER Diagram** — interactive schema map with zoom |
| ![Autocomplete](docs/screenshots/07-autocomplete.png) | |

---

## 🚀 Getting started

> Requires **Node.js 20+**.

```bash
# 1. Install dependencies
npm install

# 2. Run in development (hot reload)
npm run dev

# 3. Build the production bundle
npm run build
```

> **macOS note:** SQLite uses a native module (`better-sqlite3`) compiled for Electron. If you hit a build error about missing C++ headers, reinstall the Command Line Tools: `xcode-select --install`.

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open command palette |
| `⌘,` / `Ctrl+,` | Open settings |
| `⌘⇧A` / `Ctrl+⇧A` | Chat with your data |
| `⌘T` / `Ctrl+T` | New query tab |
| `⌘↵` / `Ctrl+↵` | Run query |
| `⌘S` / `Ctrl+S` | Commit pending row edits |
| `⌘B` / `Ctrl+B` | Toggle sidebar |
| `⌘W` / `Ctrl+W` | Close tab |
| `⌘Z` / `Ctrl+Z` | Undo pending row edit |
| `⌘⇧Z` / `Ctrl+⇧Z` | Redo pending row edit |
| `⌘+` / `⌘−` *(ER Diagram)* | Zoom in / out |
| `⌘0` *(ER Diagram)* | Reset zoom to 100 % |
| `⌘`+scroll *(ER Diagram)* | Zoom around cursor |

---

## 🧩 Tech stack

**Electron** · **Vue 3** · **TypeScript** · **Pinia** · **CodeMirror 6** · **electron-vite**  
Drivers: `pg`, `mysql2`, `better-sqlite3`, `mssql`, `mongodb`, `@influxdata/influxdb-client` · Tunneling: `ssh2`  
AI: `@anthropic-ai/sdk` + `openai` (OpenAI-compatible endpoints for Gemini, Mistral, Grok & Ollama)

---

## 🗺️ Roadmap

### ✅ Shipped

| Area | Highlights |
|---|---|
| 🗄️ **Connections** | Projects → environments hierarchy · duplicate · read-only safe mode · production banners · export / import (secrets stripped) |
| 📊 **Data editing** | Spreadsheet grid (paginate · sort · filter) · inline + row-detail editing · transactional commit · bulk edit · duplicate row · generate INSERT/UPDATE · undo / redo |
| 🔗 **Explore** | Click-through FK navigation · record Explorer · ER diagram (drag · zoom · fit · export SVG/PNG) · dependency explorer · universal search (find any value across every table) |
| 🧱 **Schema** | Create / drop tables · column · type · nullable · FK & index editing · schema diff · data diff · data generator · migration-script generator (diff → `ALTER`) |
| ⌨️ **Query** | Multi-tab SQL/Flux editor · schema-aware autocomplete · query variables · history · saved snippets · formatter · EXPLAIN + Visual EXPLAIN · transaction mode |
| ✨ **AI** | Multi-provider (Claude · Gemini · Mistral · Grok · Ollama) · NL→SQL · explain · fix-with-AI · chat-with-your-data dock |
| 📈 **Insights** | Performance dashboard (slow queries · index hints · index-health scan · pool stats · storage growth over time) · table-size analyzer · column-usage search |
| 📄 **Docs** | One-click Markdown documentation generator — every table, column, key & index (Database → Documentation, `⌘⇧D`) |
| 📦 **Import / export** | CSV · Excel · JSON · SQL · whole-DB dump (per-table) · streaming exports · result → new table · import SQL / CSV |
| 🔐 **Platform** | SSH tunneling · OS-keychain secrets · dark / light themes · command palette · packaged installers (dmg · exe · AppImage) |

### 🚧 On the roadmap

| Area | Planned |
|---|---|
| 🎯 **Next up** | Database snapshots — save a restore point before risky changes |
| 🛡️ **Production safety** | Dangerous-query confirmation flow · temporary write-unlock ("unlock for 15 min") · SQL linting before run |
| ⌨️ **Querying** | Query bookmarks per connection · snippet autocomplete · multiple result tabs per run · execution-time history |
| 📈 **Performance** | Query-plan regression alerts |
| 👥 **Team** | Shared query library · connection bundles · per-table comments / notes · workspace sync · connection templates |
| 🧪 **Developer / AI** | AI schema docs · AI test-data generation · streaming chat responses |
| 🪄 **Wow** | Time-travel row history · clone prod schema → local SQLite |
| 🗃️ **Data management** | Soft-delete recovery viewer |

### 🗄️ Database engines

Already covers **≈80–90%** of typical use; more on the way.

| Engine | Status |
|---|:--:|
| PostgreSQL · MySQL / MariaDB · SQLite · SQL Server · MongoDB · InfluxDB | ✅ Supported |
| **Redis** — keys, JSON, queues, cache inspection | ⏳ Planned |
| **Oracle Database** — enterprise reach | ⏳ Planned |
| **CockroachDB · TimescaleDB** — ride on PostgreSQL support | ⏳ Planned |
| Snowflake · ClickHouse · BigQuery · Redshift · DuckDB | 💡 Exploring |

---

## 📄 License

**MIT** — free to use, fork and adapt. The only condition is that the copyright
notice crediting **Devium** stays in copies and derivative works, so we get
credit wherever DataDock is used. See [`LICENSE`](LICENSE).

---

<div align="center">

<br/>

<a href="https://devium.be/">
  <img src="docs/devium-logo.png" alt="Devium" height="56" />
</a>

### Made by **[Devium](https://devium.be/)**

DataDock is built by **Devium** and offered **completely free of charge**.  
We build software we'd want to use — and share it.

[**devium.be**](https://devium.be/)

</div>
