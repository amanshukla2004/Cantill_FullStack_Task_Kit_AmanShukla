# Business Decisions, Edge Cases & Ranking Methodology (`DECISIONS.md`)

Corvo Engineering's Procurement Policy v5.0 deliberately leaves several operational edge cases, data anomalies, and mathematical weights unspecified. This document records every ambiguity identified in the data and policy, the decision implemented in the engine, and the business rationale behind it.

---

## 1. Data Anomalies & Policy Edge Cases

### 1.1 Zero or Non-Positive Quantity (`PR-26-00172/1`)
- **Observation**: `PR-26-00172/1` requests `0 NOS` of `ITM-1020` (Cutting wheel 14 inch).
- **Decision**: Output `decision = NOT_PROCESSED`, `route = NOT_PROCESSED`, `group_value_inr = 0`, excluded from clubbing and PO consolidation, with reason `"Zero or invalid quantity (0); line cannot be commercially fulfilled"`.
- **Rationale**: Zero-quantity lines cannot generate valid commercial POs or RFQs and would pollute ERP receiving/invoicing. Surfacing them as `NOT_PROCESSED` alerts the buyer to clarify the required quantity with the requester.

### 1.2 Invalid / Unrecognized Delivery Plant (`PR-26-00173/1`)
- **Observation**: `PR-26-00173/1` specifies delivery plant `PUN2`, whereas `master_data/plants.csv` defines only `PUN1` (Bhosari) and `CHK1` (Chakan).
- **Decision**: Output `decision = NOT_PROCESSED`, `route = NOT_PROCESSED`, `group_value_inr = 0`, reason citing invalid delivery plant `PUN2`.
- **Rationale**: Issuing a PO to a non-existent plant code causes GST billing, shipping address, and goods-receipt failures.

### 1.3 Near-Duplicate PR Submissions (`PR-26-00174/1` & `PR-26-00175/1`)
- **Observation**: At the end of `sample_pr_batch.csv` (immediately after the other intentional anomalies `170`–`173`), `S. Patil` raises `PR-26-00174/1` (`2026-11-02 08:10`) and `PR-26-00175/1` (`2026-11-02 08:14`) **4 minutes apart** for the exact same item (`ITM-1033`, Servo drive 2kW), same plant (`PUN1`), same quantity (`1 NOS`), and same need-by date (`2026-11-16`).
- **Decision**: Implemented a deterministic **15-minute Duplicate PR Guard**: when a later line matches an earlier valid line on `(requester, resolved_item_code, plant, quantity, need_by_date)` within 15 minutes (excluding `NEW` items), the earlier line proceeds normally and the later line (`PR-26-00175/1`) is flagged `decision = NOT_PROCESSED`, `route = NOT_PROCESSED` with a reason referencing `PR-26-00174/1`. Buyers can still **Override** it in the workspace with a written comment if two units were genuinely intended.
- **Rationale**: Blindly clubbing an accidental double-entry of a ₹68,500 CNC servo drive doubles spend unnecessarily. Flagging it while preserving buyer override provides safe procurement control.

### 1.4 Free-Text `"- urgent"` Suffix vs. Structured `urgency = Normal`
- **Observation**: Four lines (`PR-26-00018/1`, `PR-26-00023/1`, `PR-26-00139/1`, `PR-26-00167/2`) include `- urgent` inside the `description` text while their structured `urgency` field is explicitly `Normal`.
- **Decision**: Only the structured `urgency` column (`Emergency`) activates Rule 5.3 (`EMERGENCY_PO`). Operational suffixes (`- urgent`, `for maintenance`, `as per sample`, `(repeat)`) are stripped during item matching.
- **Rationale**: Rule 5.3 bypasses competitive RFQ up to ₹5,00,000; informal text appended to an item description should not bypass formal urgency governance.

### 1.5 Uncataloged / Novel Items (`PR-26-00170/1` & `PR-26-00171/1`)
- **Observation**: `"Drinking water purifier 50 LPH"` and `"Ultrasonic thickness gauge"` do not match any catalog item in `item_master.csv`.
- **Decision**: `resolved_item_code = NEW`, `decision = SOURCING_REQUEST`, `route = NEW_ITEM_SOURCING`, valued at `round(quantity * estimated_unit_price)`, never clubbed (Clause 1.2), and `suggested_supplier_ids = ""` (Clause 6.4). Verified against Worked Example 13.

### 1.6 Blocked / Inactive Suppliers Holding Rate Contracts (`RC-2026-005` / `S004`)
- **Observation**: `RC-2026-005` covers `ITM-1006` and `ITM-1007`, but supplier `S004` (Metalink Alloys) is `Blocked` in `supplier_master.csv`.
- **Decision**: Strictly ineligible under Clauses 4.1 and 5.7. Blocked or Inactive suppliers **never** receive a PO, **never** provide an applicable contract, and are **never** ranked or suggested for sourcing (enforced even on manual buyer overrides). Verified against Worked Example 10.

### 1.7 Contract Ceiling Exhaustion & No Partial Splits (`RC-2026-002` & `RC-2026-015`)
- **Observation**: When a requirement exceeds a contract's remaining headroom (e.g. Worked Example 3: `RC-2026-002` has ₹38,000 left vs. ₹2,20,256 requirement; Worked Example 4: `RC-2026-015` has ₹12,000 left vs. ₹29,734.50 requirement).
- **Decision**:
  - Never partially split a single requirement across a contract and sourcing.
  - Check applicable contracts in ascending rate order (Clause 4.3) using exact 2-decimal headroom arithmetic; pick the lowest-rate contract that fits the full requirement (`RC-2026-013` in Example 4).
  - If every applicable contract is out of ceiling, value at the lowest applicable contract rate (Clause 3.1a) and route via subsequent waterfall rules (`RFQ` in Example 3).

### 1.8 Signed PDF-Only Contracts & Chronological Start Dates (`RC-2026-031`, `RC-2026-033`)
- **Observation**: `RC-2026-031` (Pneumatic Point `S021`, valid from `2026-11-15`) and `RC-2026-033` (Infoline Systems `S035`, valid from `2026-11-20`) exist only in `contracts/pdf/`.
- **Decision**: Auto-extracted on database seed (and uploadable via the Contracts UI) with `initial_consumed_value = 0` (Clause 4.2). Strictly applied only to requirements whose `requirement_date` (`first_created_at`) falls on or after `start_date` and on or before `end_date`. Verified against Worked Example 2.

### 1.9 "Bought from an Active Supplier in the Last 365 Days" (Rules 5.3 & 5.4)
- **Observation**: Five catalog items (`ITM-1006`, `ITM-1025`, `ITM-1032`, `ITM-1055`, `ITM-1060`) have **zero POs** in `po_history.csv`, and several other items have historical POs from `Blocked`/`Inactive` vendors (`S004`, `S008`, `S011`, `S031`, `S034`).
- **Decision**: Rules 5.3 (`EMERGENCY_PO`) and 5.4 (`SPOT_PO`) require at least one historical PO within the lookback window (`365` days before requirement date) placed with a supplier whose **current status is `Active`**. Items failing this check (like `ITM-1006` in Worked Example 10) fall through to `RFQ` (Rule 5.5).

### 1.10 Clause 3.1(b) Market Valuation vs. Non-Active Supplier POs
- **Observation**: Five items (`ITM-1014`, `ITM-1017`, `ITM-1020`, `ITM-1049`, `ITM-1050`) have their single most recent PO placed with a vendor who is now `Blocked` (`S008`, `S011`) or `Inactive` (`S031`).
- **Decision**: Clause 3.1(b) (*"the price on the most recent PO for the item in the 365 days before the requirement date"*) is a market valuation benchmark and uses the most recent PO price regardless of current vendor status, whereas supplier eligibility (Rules 5.3, 5.4, 5.7, Section 6) strictly restricts to `Active` suppliers.

### 1.11 Requirement Valuation Price (Clause 3.1) vs. Awarded PO Unit Price (Clause 6.3)
- **Observation**: In Worked Example 6 (`ITM-1044` VCI bag, qty `7370`, `PUN1`), the requirement value is **₹1,56,170** (`7370 × ₹21.19` from the item's most recent PO `7300299` placed with `S028`), while the awarded `SPOT_PO` goes to 1st preferred supplier **`S027`** at `S027`'s reference price of **₹21.59** (`7300300`, shown rounded as ₹22 in the PDF).
- **Decision**: Strictly separate valuation (`group_value_inr`, rounded to nearest rupee per Clause 3.1) from the awarded PO `unit_price` (exact 2 decimals: contract rate for `CONTRACT_PO`, 1st preferred supplier's Clause 6.3 reference price for `SPOT_PO` and `EMERGENCY_PO`).

### 1.12 Identical-Date PO History Tie-Breaking (`ITM-1034`)
- **Observation**: `ITM-1034` has two POs on `2026-04-10`: `7300215` (₹40,929.88) and `7300220` (₹41,415.60).
- **Decision**: Break identical `po_date` ties by `po_number DESC` (`7300220 > 7300215`, the later ERP document). Produces exact valuation `50 × 41,415.60 = ₹20,70,780`, matching Worked Example 11.

### 1.13 Capex Requirement Valuation (Clause 3.1 before Rule 5.1)
- **Observation**: Worked Example 12 (`ITM-1071`, qty `4`) values at ₹60,36,704 (`4 × ₹15,09,176.02` from PO `7300466`) rather than standard price ₹58,00,000.
- **Decision**: Capex items still follow universal Clause 3.1 valuation (most recent PO price in 365 days before standard price), while Rule 5.1 guarantees they always route to `CAPEX_SOURCING` (never consuming a contract ceiling).

### 1.14 Depleted Category Sourcing Pools (`ITM-1034`)
- **Observation**: Worked Example 11 requires 5 RFP suppliers, but only 4 Active suppliers exist in `Electrical Spares` (`S017`–`S020`).
- **Decision**: Return all available eligible Active suppliers without error or fabrication (`S020;S017;S019;S018`).

### 1.15 24-Hour PO Consolidation Anchor Window (Clause 7.1 & 7.2)
- **Decision**: A consolidated PO's 24-hour eligibility window is anchored strictly to the `first_created_at` timestamp of the **first** requirement on that PO (preventing indefinite chaining). Requirements join the earliest qualifying open PO sharing `(supplier_id, plant, route)`. Verified against Worked Example 14.

### 1.16 Model-Number Conflict Pruning in Free-Text Item Matching
- **Decision**: Token normalization expands common industrial abbreviations (`brg` → `ball bearing` / context-aware `roller bearing`, `hyd` → `hydraulic`, `pneu` → `pneumatic`, `rod` → `electrode`, `24"` → `24 inch`), strips noise tags, and strictly prunes candidates whose numeric/model tokens conflict (`6308` never matches `6205`). Verified 39/39 across every free-text line in `sample_pr_batch.csv`.

### 1.17 Batch Reprocessing Idempotency (Run 1 → Run 2)
- **Decision**: Every `POST /api/process-batch` execution starts from a clean snapshot of baseline contract consumed values (`initial_consumed_value`), ensuring reprocessing the same batch after activating an amended policy never double-depletes contract ceilings.

---

## 2. Preferred Supplier Ranking Formula (Policy Section 6.2)

### Eligibility (Clause 6.1)
Active suppliers (`status = 'Active'`) with either (a) ≥ 1 PO for the item in the 548 days prior to `as_of_date`, OR (b) a rate contract covering the item with `start_date <= as_of_date` (even if expired).

### 5-Factor Normalized Composite Score (0–100 Scale)
$$\text{Score}(s) = 0.25\,S_C + 0.25\,S_V + 0.20\,S_R + 0.15\,S_Q + 0.15\,S_O$$

| Factor | Definition (0–100 Scale) | Weight | Rationale |
| :--- | :--- | :---: | :--- |
| **Contract History ($S_C$)** | `100` if supplier holds/held a contract for the item (`start_date <= as_of_date`), else `0` | **25%** | Pre-vetted commercial terms & audited compliance |
| **Order Volume ($S_V$)** | $\min(\text{PO\_count}_{548d} / 5,\ 1.0) \times 100$ | **25%** | Proven fulfillment experience with Corvo |
| **Recency ($S_R$)** | `100` (≤ 90d), `50` (≤ 365d), `0` (> 365d or no PO) | **20%** | Active supply readiness & current pricing |
| **Quality Rating ($S_Q$)** | $(\text{quality\_rating} / 5.0) \times 100$ | **15%** | Engineering quality & low rejection rates |
| **On-Time Delivery ($S_O$)** | $\text{on\_time\_pct}$ (0–100) | **15%** | Schedule reliability for plant operations |

Ties are broken deterministically by `supplier_id ASC`. Buyers see every factor's exact point contribution in both the Buyer Workspace and Preferred Suppliers views.

### Verification Against Official Worked Examples (as of `2026-11-01`)
- **`ITM-1048` (Nitrile coated gloves)**: `S029` (91.45) > `S030` (61.00); `S031` Inactive excluded. **Exact match.**
- **`ITM-1036` (Pneumatic cylinder 50x100)**: `S023` (52.80) > `S022` (42.05) > `S024` (30.65). **Exact match.**
- **`ITM-1016` (MIG wire ER70S-6 1.2mm)**: `S009` (66.25) > `S010` (38.70). **Exact match.**

---

## 3. Category Sourcing Top-Up Ranking (Policy Section 6.4)

When the preferred list has fewer suppliers than needed (`3` for RFQ, `5` for RFP/Capex), remaining Active suppliers in the item's category are ranked by an equal-weighted 50/50 delivery & quality composite:

$$\text{Score}_{\text{category}}(s) = 0.50 \left(\frac{\text{on\_time\_pct}}{100}\right) + 0.50 \left(\frac{\text{quality\_rating}}{5.0}\right)$$

Ties are broken by `supplier_id ASC`.

### Verification Against Official Worked Examples
- **Worked Example 10 (`ITM-1006`)**: `S003` (0.950) > `S002` (0.845) > `S005` (0.800) > `S001` (0.765) → **`S003;S002;S005`**.
- **Worked Example 11 (`ITM-1034`)**: `S020` (PSL) + `S017` (0.805) > `S019` (0.755) > `S018` (0.640) → **`S020;S017;S019;S018`**.
- **Worked Example 12 (`ITM-1071`)**: `S045` (PSL) + `S047` (0.810) > `S020` (0.790) > `S048` (0.790) > `S046` (0.775) → **`S045;S047;S020;S048;S046`**.
