# Corvo Engineering — Policy-Driven PR-to-PO Web Application

A full-stack, policy-driven procurement automation web app built for **Corvo Engineering Pvt Ltd** (`PUN1` Bhosari & `CHK1` Chakan plants). Employees raise purchase requisitions via conversational chat (or batch CSV upload), Procurement updates policy rules without code changes, and a 100% deterministic engine routes requirements to consolidated Purchase Orders or Sourcing Requests.

- **Live Hosted App:** `<ADD_YOUR_RENDER_OR_RAILWAY_URL_HERE>`
- **Business Decisions & Ranking Proof:** [DECISIONS.md](./DECISIONS.md)
- **Architecture & AI Disclosure:** [APPROACH.md](./APPROACH.md)

---

## Architecture Overview

```
React 19 + TypeScript SPA (client/ -> dist/public/)
  ├── Chat Intake & Batch CSV Center
  ├── Buyer Workspace (Approve, Override + Audit Trail, PSL Breakdown)
  ├── Policy-as-Data Studio (Upload/Chat Amend, Plain-Language Diff, Rule Editor)
  ├── Rate Contracts Manager (Ceiling Bars, Signed PDF Extraction, Manual Add)
  └── Preferred Suppliers (Date-Selectable 5-Factor Rankings + Top-3 CSV Export)
            │
            ▼ HTTP / REST (Express)
Node.js 24 + TypeScript API (src/server/)
  ├── Direct Groq SDK Layer (groq-sdk + Zod + offline fallback — NO LangChain)
  ├── PDF Extractor (unpdf + Groq layout fallback) & CSV Pipeline
  └── Built-in SQLite (node:sqlite WAL mode, auto-seeded on startup)
            │
            ▼ Pure TypeScript Calls
Deterministic Decision Engine (src/engine/)
  └── Anomaly/Dup Guard -> Item Resolver -> Clubbing (14d/7d) -> Exact-Decimal
      Contract Ceiling & Valuation -> Effective-Date AST Waterfall -> 24h PO Consolidator
```

---

## Quick Start

### Option 1: One-Command Local Run with Docker (Recommended)
```bash
cp .env.example .env
# Optional: set GROQ_API_KEY in .env for live Groq AI chat & policy parsing
# (App also works cleanly in deterministic fallback mode without a key)
docker compose up --build
```
Open **http://localhost:3000**.

### Option 2: Local Node.js Run (Node 24+)
```bash
cp .env.example .env
npm install
npm --prefix client install
npm run build
npm start
```
Open **http://localhost:3000**.

For local frontend hot-reload during development (two terminals):
```bash
npm run dev          # Express API on :3000
npm run dev:client   # React dev server on :5173 (proxies /api -> :3000)
```

---

## Automated Verification Suite

Run all **50 automated tests** (covering Phase 0 seeding & PDF ingestion, all **14/14 Worked Examples** on the full 186-line `sample_pr_batch.csv`, all **3/3 Preferred Supplier rankings**, all **39/39 free-text descriptions** + **27/27 unseen adversarial & spaced-dimension/typo descriptions**, anomalies & duplicate guard, Buyer Workspace approvals/overrides/cross-batch PO isolation/Clause 5.7 enforcement, Chat Intake happy/vague/unknown/multi-turn edit/double-confirm/live clubbing flows, and end-to-end zero-code Policy amendments including rollback isolation, tightened plant/category limits, and per-date mid-batch clubbing & consolidation windows):

```bash
npm test
```

---

## REST API Reference

| Method & Endpoint | Description |
| :--- | :--- |
| `GET /api/health` | Health status, active policy version, Groq status, master counts |
| `POST /api/process-batch` | Process PR batch CSV (`multipart/form-data` field `file`, `text/csv`, or JSON) |
| `GET /api/export-decisions` | Export decisions CSV in exact Section 4 13-column format (`?batch_id=`) |
| `GET /api/preferred-suppliers` | Preferred supplier lists (`?as_of_date=YYYY-MM-DD&format=csv\|json`) |
| `POST /api/chat/message` | Multi-turn conversational PR slot-filling & deterministic item matching |
| `POST /api/chat/confirm-pr` | Confirm chat slots, create PR, evaluate active policy, add to Buyer Workspace |
| `GET /api/policies` | List all versioned policies (`ACTIVE`, `SUPERSEDED`, `DRAFT`) and AST rules |
| `POST /api/policy/amend` | Upload amendment doc (`file`) or chat `instruction` → draft AST + plain diff |
| `PUT /api/policy/:id` | Edit a `DRAFT` policy's rules, dates, or windows (Zod-validated) |
| `POST /api/policy/:id/activate` | Approve & activate a policy version with zero code changes |
| `GET /api/contracts` | List all rate contracts with ceiling utilization & validity status |
| `POST /api/contracts/upload-pdf` | Extract contract header & Schedule A lines from a signed PDF |
| `POST /api/contracts` | Save an extracted or manually entered rate contract |
| `GET /api/requirements` | Buyer Workspace queue with clubbed PR lines & 5-factor PSL breakdown |
| `POST /api/requirements/:id/approve` | Approve requirement → creates PO or RFQ/RFP + audit log |
| `POST /api/requirements/:id/override` | Override requirement (requires written comment; blocks non-Active vendors) |
| `GET /api/audit-logs` | Chronological audit trail (who, when, before/after details) |

---

## Environment Variables

See [.env.example](./.env.example):
- `PORT` (default `3000`)
- `DATABASE_PATH` (default `./storage/procurement.db`)
- `GROQ_API_KEY` (optional; enables live Groq AI for Chat Intake & Policy Amendments)
- `GROQ_MODEL` (default `openai/gpt-oss-120b`)
