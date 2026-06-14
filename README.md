<div align="center">

<img src="docs/logo.png" alt="DataDock" width="120" />

# DataDock

### The database client that finally organizes itself the way *you* think.

**Projects → Environments → Connections.** One clean desktop app for PostgreSQL, MySQL, SQLite, SQL Server and InfluxDB — with browsing, editing, structure changes, import/export, SSH tunneling, ER diagrams and a command palette built in.

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

#### 🗄️ Organized connections
- **Projects → Environment folders → Connections** — a real hierarchy, not a flat list.
- Color-coded connections with live status dots (connecting / connected / error).
- **Duplicate a connection** in one click — useful for cloning a staging config to try against prod.
- Credentials **encrypted at rest** with the OS keychain (Electron `safeStorage`) — never stored in plain text.
- **Read-only "safe mode"** per connection — guard production by blocking edits, inserts/deletes, DDL, imports and mutating SQL, with a clear 🔒 badge.
- **Share connections** — export your project/environment/connection tree to JSON (secrets stripped) and import it on another machine.

#### 🔌 Multi-engine
- **PostgreSQL · MySQL / MariaDB · SQLite · Microsoft SQL Server · InfluxDB** — all from one app.

#### 🔐 SSH tunneling
- Reach databases that only live behind a bastion: **connect via SSH (private key, password, or agent), then to the DB** — exactly how you'd hit a prod/staging box.

#### 📊 Browse & edit data like a spreadsheet
- Fast result grid with **pagination, sorting and column filters**.
- **Double-click any cell to edit**, or pop open the **row detail panel** on the side.
- Stack up changes across many rows and **commit them all at once with ⌘S** — every batch runs in a transaction.

#### 🧱 Visual structure editor
- **Create new tables** (define columns inline) and **drop tables** — multi-select in the list, with *Ignore foreign-key checks* and *Cascade* options.
- Add / rename / drop **columns**, change types and nullability, manage **foreign keys** and **indexes** — no hand-written DDL.

#### 🔗 ER Diagram & schema visualization
- Open the **ER Diagram tab** from the menu (or `⌘K` → *ER Diagram*) to get an interactive visual map of every table, column, primary key and foreign-key relationship in your schema.
- **Hierarchical layout** — parent tables (referenced by FK) appear above their dependent children, organized into clean labelled rows. **Re-layout** button resets everything back to the hierarchy at any time.
- **Drag** any table card to rearrange freely after the initial layout.
- **⊞ Fit** scales and scrolls the view so the whole diagram is visible at once.
- **Zoom in / out** with `⌘ +` / `⌘ −`, `⌘`-scroll the mouse wheel, trackpad pinch, or the toolbar `−` / `＋` buttons. Range: 15 % – 300 %. The zoom percentage is always shown and clicking it resets to 100 %.
- PK and FK column badges; smooth Bézier edges connect related tables with smart top/bottom routing for vertically stacked cards.

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

#### 📦 Import & export
- Export a result, a table, or a **whole database** to **CSV, Excel, JSON, SQL or zipped SQL**.
- Full-database dumps let you choose **per table**: structure, data, both, or skip.
- Import **`.sql` scripts** and **CSV → table**.

#### 🛠️ Server tools
- Built-in **Databases** (create/drop), **Users & Roles**, and **Process List** (with kill).

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
Drivers: `pg`, `mysql2`, `better-sqlite3`, `mssql`, `@influxdata/influxdb-client` · Tunneling: `ssh2`

---

## 🗺️ Roadmap

**Shipped**

- [x] Insert & delete rows (with transactional commit)
- [x] Undo / redo of draft edits (⌘Z / ⌘⇧Z)
- [x] Index management in the structure editor
- [x] Query history
- [x] Streaming exports for very large tables
- [x] Packaged installers (macOS `.dmg`, Windows `.exe`, Linux `AppImage`)
- [x] SQL autocomplete for table & column names
- [x] Saved queries / snippets library
- [x] Read-only "safe mode" to guard production connections
- [x] Light theme
- [x] Export/import of connection definitions (shareable, secrets stripped)
- [x] ER diagram & schema visualization (hierarchical layout, drag, zoom, fit-to-view)
- [x] Command palette (⌘K) — fuzzy search across connections, tables and actions
- [x] Duplicate a connection in one click
- [x] SQL formatter & beautifier (⌘⇧F)
- [x] Production connection banners (red header on production connections)
- [x] Dangerous-query guard (warns on `UPDATE`/`DELETE` without `WHERE`, `TRUNCATE`, `DROP`)
- [x] Query execution plans (`EXPLAIN` runner)
- [x] Schema diff viewer (compare two connections' structure)
- [x] Data diff viewer (compare table rows, matched by primary key)
- [x] Data generator (seed realistic fake data into tables)
- [x] Export ER diagram to SVG / PNG
- [x] Transaction mode (explicit Begin / Commit / Rollback)

### 🎯 Next up

The features that push DataDock past "another database client" into *organized, safe, fast* database work:

- [ ] **Visual EXPLAIN** — turn the plan into an interactive tree
- [ ] **AI SQL assistant** — natural language → SQL, explain & troubleshoot queries

### 🧭 Backlog

**Data management** — generate INSERT/UPDATE from selected rows · copy row as JSON / SQL / CSV · bulk edit selected rows · duplicate row · soft-delete recovery viewer

**Querying** — query bookmarks per connection · query variables (`{{userId}}`) · snippet autocomplete · multiple result tabs per execution · export result directly to a new table · execution-time history

**Production safety** — confirmation workflow for dangerous queries · temporary write-access unlock ("unlock for 15 min") · SQL linting before execution

**Schema tools** — migration script generator · visual index analyzer · dependency explorer ("what references this table?") · column-usage search across schema · database documentation generator

**Performance** — table size analyzer · largest-tables dashboard · slow-query monitor · index recommendations · connection-pool diagnostics · storage-growth tracking

**Team** — shared query library · shared connection bundles · comments/notes per table · workspace sync · connection templates

**Developer / AI** — generate schema docs with AI · explain query in plain English · generate test data with AI · SQL error troubleshooting assistant

**"Wow"** — database snapshots (save state before changes) · time-travel row history · visual data explorer (click through relationships) · universal smart search · one-click clone production schema to local SQLite

### 🗄️ More database engines

Today: **PostgreSQL · MySQL/MariaDB · SQLite · SQL Server · InfluxDB** (≈80–90% of typical use). Planned, in priority order:

- [ ] **MongoDB** — "SQL + NoSQL in one place"
- [ ] **Redis** — keys, JSON, queues, cache inspection
- [ ] **Oracle Database** — enterprise reach
- [ ] **CockroachDB / TimescaleDB** — largely ride on PostgreSQL support
- [ ] Analytics engines (Snowflake · ClickHouse · BigQuery · Redshift · DuckDB)

---

## 📄 License

MIT — free to use, fork and adapt.

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
