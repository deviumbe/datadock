<div align="center">

<img src="docs/logo.png" alt="DataDock" width="120" />

# DataDock

### The database client that finally organizes itself the way *you* think.

**Projects → Environments → Connections.** One clean desktop app for PostgreSQL, MySQL, SQLite, SQL Server and InfluxDB — with browsing, editing, structure changes, import/export and SSH tunneling built in.

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
- Color-coded connections with live status dots.
- Credentials **encrypted at rest** with the OS keychain (Electron `safeStorage`) — never stored in plain text.

#### 🔌 Multi-engine
- **PostgreSQL · MySQL / MariaDB · SQLite · Microsoft SQL Server · InfluxDB** — all from one app.

#### 🔐 SSH tunneling
- Reach databases that only live behind a bastion: **connect via SSH (private key, password, or agent), then to the DB** — exactly how you'd hit a prod/staging box.

#### 📊 Browse & edit data like a spreadsheet
- Fast, virtualized result grid with **pagination, sorting and column filters**.
- **Double-click any cell to edit**, or pop open the **row detail panel** on the side.
- Stack up changes across many rows and **commit them all at once with ⌘S** — every batch runs in a transaction.

#### 🧱 Visual structure editor
- Add / rename / drop **columns**, change types and nullability, manage **foreign keys** — no hand-written DDL.

#### 🧰 Query, your way
- Multi-**tab** workspace — open a tab per table, plus scratch SQL/Flux tabs.
- Real SQL editor (CodeMirror) with syntax highlighting and **⌘↵ to run**.
- **Schema-aware autocomplete** — table and column names from the connected database, right as you type.
- **Undo / redo** of pending row edits (⌘Z / ⌘⇧Z) and **query history** to re-run past statements.

#### 📦 Import & export
- Export a result, a table, or a **whole database** to **CSV, Excel, JSON, SQL or zipped SQL**.
- Full-database dumps let you choose **per table**: structure, data, both, or skip.
- Import **`.sql` scripts** and **CSV → table**.

#### 🛠️ Server tools
- Built-in **Databases** (create/drop), **Users & Roles**, and **Process List** (with kill) — right from the Database menu.

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
| **Autocomplete** — schema-aware table & column names | |
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

> **macOS note:** SQLite uses a native module (`better-sqlite3`) that's compiled for Electron on install. If you hit a build error about missing C++ headers, reinstall the Command Line Tools (`xcode-select --install`).

---

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` / `Ctrl+T` | New query tab |
| `⌘↵` / `Ctrl+↵` | Run query |
| `⌘S` / `Ctrl+S` | Commit pending row edits |
| `⌘B` / `Ctrl+B` | Toggle sidebar |
| `⌘W` / `Ctrl+W` | Close tab |

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

**Planned**

- [ ] Saved queries / snippets library
- [ ] ER diagram & schema visualization
- [ ] Read-only "safe mode" to guard production connections
- [ ] Find & replace within result grids
- [ ] Result charts (quick visualizations from a query)
- [ ] Export/import of connection definitions (shareable, secrets stripped)
- [ ] Light theme

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
