import {
  Contract,
  ContractLine,
  Item,
  POHistoryEntry,
  Requirement,
  Supplier,
  ValuationResult
} from './types.js';
import { extractDateOnly, subtractDays } from './date-utils.js';

/**
 * Policy Clauses 3 & 4: Valuation & Dynamic Contract Ceiling Qualification.
 * - Uses exact 2-decimal precision for ceiling headroom checks.
 * - Clause 4.1: Active supplier + start_date <= reqDate <= end_date + covers item.
 * - Clause 4.2 & 4.3: Lowest rate among applicable contracts that still has enough ceiling.
 * - Clause 3.1a fallback: If all applicable contracts are out of ceiling, value at lowest applicable contract rate.
 * - Clause 3.1b: Most recent PO for the item in the 365 days before reqDate (tie-broken by po_number DESC).
 * - Clause 3.1c: Item master standard price.
 */
export function valueRequirement(
  req: Requirement,
  contracts: Contract[],
  contractLines: ContractLine[],
  poHistory: POHistoryEntry[],
  itemMaster: Item,
  supplierMaster: Map<string, Supplier>,
  historyLookbackDays = 365
): ValuationResult {
  const reqDate = extractDateOnly(req.first_created_at);

  // 1. Applicable contracts (Clause 4.1)
  const applicableEntries: Array<{ contract: Contract; rate: number }> = [];
  for (const contract of contracts) {
    const supp = supplierMaster.get(contract.supplier_id);
    if (!supp || supp.status !== 'Active') continue; // Clause 4.1 & 5.7
    if (reqDate < contract.start_date || reqDate > contract.end_date) continue;

    const line = contractLines.find(
      (cl) => cl.contract_id === contract.contract_id && cl.item_code === req.resolved_item_code
    );
    if (line) {
      applicableEntries.push({ contract, rate: line.rate });
    }
  }

  // Sort by rate ASC, tie-break contract_id ASC (Clause 4.3)
  applicableEntries.sort(
    (a, b) => a.rate - b.rate || a.contract.contract_id.localeCompare(b.contract.contract_id)
  );

  if (applicableEntries.length > 0) {
    for (const entry of applicableEntries) {
      const exactCost = Number((req.total_quantity * entry.rate).toFixed(2));
      const remainingRoom = Number(
        (entry.contract.value_cap - entry.contract.current_consumed_value).toFixed(2)
      );
      if (exactCost <= remainingRoom) {
        return {
          unit_price: entry.rate,
          exact_value_inr: exactCost,
          group_value_inr: Math.round(exactCost),
          contract_used: entry.contract,
          pricing_basis: `Contract ${entry.contract.contract_id} rate ₹${entry.rate.toFixed(2)} (Clause 3.1a)`,
          reference_doc: entry.contract.contract_id
        };
      }
    }

    // All applicable contracts out of ceiling -> value at lowest applicable rate (Clause 3.1a)
    const lowest = applicableEntries[0];
    const exactCost = Number((req.total_quantity * lowest.rate).toFixed(2));
    return {
      unit_price: lowest.rate,
      exact_value_inr: exactCost,
      group_value_inr: Math.round(exactCost),
      contract_used: null,
      pricing_basis: `Lowest applicable contract ${lowest.contract.contract_id} rate ₹${lowest.rate.toFixed(2)} (ceiling exhausted, Clause 3.1a)`,
      reference_doc: lowest.contract.contract_id
    };
  }

  // 2. Most recent PO in lookback days before requirement date (Clause 3.1b)
  const cutoffDate = subtractDays(reqDate, historyLookbackDays);
  const recentPOs = poHistory
    .filter(
      (po) =>
        po.item_code === req.resolved_item_code &&
        po.po_date >= cutoffDate &&
        po.po_date <= reqDate
    )
    .sort((a, b) => b.po_date.localeCompare(a.po_date) || b.po_number.localeCompare(a.po_number));

  if (recentPOs.length > 0) {
    const latest = recentPOs[0];
    const exactCost = Number((req.total_quantity * latest.unit_price).toFixed(2));
    return {
      unit_price: latest.unit_price,
      exact_value_inr: exactCost,
      group_value_inr: Math.round(exactCost),
      contract_used: null,
      pricing_basis: `Most recent PO ${latest.po_number} (${latest.po_date}) @ ₹${latest.unit_price.toFixed(2)} (Clause 3.1b)`,
      reference_doc: `PO ${latest.po_number}`
    };
  }

  // 3. Item master standard price (Clause 3.1c)
  const exactCost = Number((req.total_quantity * itemMaster.standard_price).toFixed(2));
  return {
    unit_price: itemMaster.standard_price,
    exact_value_inr: exactCost,
    group_value_inr: Math.round(exactCost),
    contract_used: null,
    pricing_basis: `Item master standard price ₹${itemMaster.standard_price.toFixed(2)} (Clause 3.1c)`,
    reference_doc: `Item Master (${itemMaster.item_code})`
  };
}
