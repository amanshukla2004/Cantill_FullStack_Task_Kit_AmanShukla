# Engineering Approach & AI Usage Disclosure (`APPROACH.md`)

As required by Section 7 of the task brief, this document discloses all AI tools used during development and inside the application, along with the core architectural decisions.

---

## 1. AI Tools Used

### A. Inside the Application (Runtime — Hybrid AI + Deterministic Architecture)
- **Provider & Model**: **Groq API** via the official **`groq-sdk`** Node.js client (`openai/gpt-oss-120b`, configurable via `GROQ_MODEL`, `temperature: 0`, `response_format: { type: "json_object" }`).
- **No LangChain / No Vector DB / No RAG**: Deliberately omitted heavy orchestration frameworks and embeddings. With 73 items, 48 suppliers, and 12 contracts, vector search introduces part-number confusion (e.g. `6205-2RS` vs `6308-ZZ`), whereas a direct ~90-line `GroqClient` wrapper with strict **Zod** schema validation and 1 automatic self-repair retry is transparent, fast, and easy to maintain.
- **Exactly Where Groq AI Is Used**:
  1. **Conversational Chat Intake (`src/server/services/chat-agent.ts`)**: Extracts structured procurement slots (`item_query`, `quantity`, `plant`, relative `need_by_date` like *"next Friday"*, `urgency`, `estimated_unit_price`) from natural language. **Anti-hallucination guardrail**: the LLM is never allowed to invent `ITM-XXXX` catalog codes—item matching and ambiguity detection always execute deterministically against SQLite (`item-resolver.ts`).
  2. **Policy-as-Data Amendment Compiler (`src/server/services/policy-agent.ts`)**: Reads uploaded amendment documents (`.pdf`, `.txt`, `.md`) or natural-language chat directives alongside the current active Policy JSON, compiles the updated declarative Policy AST rules (`PolicyAmendmentDraftSchema`), and generates a plain-language diff paired with an exact deterministic structural diff for buyer review and approval.
  3. **Contract PDF Fallback (`src/server/services/pdf-extractor.ts`)**: Standard Corvo signed contract PDFs (`RC-2026-031.pdf`, `RC-2026-033.pdf`) are extracted deterministically via `unpdf`; Groq is invoked only as a fallback if a future uploaded PDF uses an unfamiliar layout.
- **Offline / No-Key Resilience**: If `GROQ_API_KEY` is unset or rate-limited, both Chat Intake and Policy Amendments degrade gracefully to deterministic regex parsers + the inline Policy Rule Editor so the application never fails.

### B. Where AI Is Strictly NOT Used (100% Deterministic Core)
- **Decision Engine (`src/engine/`)**: Item matching, anomaly & near-duplicate guarding, anti-splitting clubbing, exact-decimal contract ceiling depletion, Clause 3.1 valuation, declarative AST waterfall evaluation, 5-factor Preferred Supplier ranking, Clause 6.4 category top-up, and 24-hour PO consolidation are **100% deterministic TypeScript** with zero LLM calls.

### C. Development Assistance
- Used an AI coding assistant (Google Antigravity) for architecture review, scaffolding, TypeScript/React implementation, and generating automated regression tests across all 14 worked examples, 3 PSL rankings, 39 free-text descriptions, and simulated policy amendments. Every module was reviewed, verified against raw CSV/PDF kit data, and validated via the automated test suite.

---

## 2. Key Architectural Choices

1. **Strict Separation of Concerns**:
   - `src/engine/` — Pure, framework-free deterministic procurement engine (zero HTTP or SQLite coupling).
   - `src/server/` — Express REST API, SQLite persistence (`node:sqlite` WAL mode), PDF/CSV services, and Groq AI adapters.
   - `client/` — Standalone React 19 + TypeScript SPA bundled into `dist/public/` and served on a single port in production.
2. **Policy as Declarative AST Data**:
   - Rules are stored in SQLite (`policies` + `policy_rules`) as strict Zod-validated recursive AST conditions (`all`, `any`, `not`, `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`) over `item_type`, `category`, `plant`, `group_value_inr`, `urgency`, `contract_available`, `has_active_365d_history`, `is_new_item`, and `total_quantity`.
   - Batch processing resolves the active policy **per requirement date** (`effective_date <= reqDate`), enabling mid-batch effective dates and arbitrary new plant/category rules with zero code changes.
3. **Zero Native Binary Friction**:
   - Uses Node 24's built-in `node:sqlite` (`DatabaseSync`), built-in `node:test`, `tsc`, and pure-JS Webpack 5, ensuring effortless cross-platform builds across Windows (even under strict Application Control policies), Linux Docker containers, and free cloud PaaS tiers.
