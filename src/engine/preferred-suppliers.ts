import {
  Contract,
  ContractLine,
  Item,
  POHistoryEntry,
  Supplier,
  SupplierRankScore
} from './types.js';
import { subtractDays } from './date-utils.js';

export interface PslOptions {
  lookbackDays?: number;
  recencyHighDays?: number;
  recencyMedDays?: number;
}

/**
 * Policy Section 6: Preferred Supplier List (PSL)
 * - Clause 6.1: Every Active supplier with >=1 PO for item in 548 days before asOfDate,
 *   OR a contract covering the item with start_date <= asOfDate (even if expired).
 * - Clause 6.2: 5-factor weighted composite score (0-100):
 *     0.25 * ContractHistory + 0.25 * OrderVolume(cap 5) + 0.20 * Recency + 0.15 * Quality + 0.15 * OnTime
 * - Clause 6.3: Reference price = supplier's most recent PO price in 548 days (tie-break po_number DESC);
 *   if none, rate in supplier's most recent contract covering the item.
 */
export function rankPreferredSuppliers(
  itemCode: string,
  asOfDate: string,
  supplierMaster: Map<string, Supplier>,
  poHistory: POHistoryEntry[],
  contracts: Contract[],
  contractLines: ContractLine[],
  options: PslOptions = {}
): SupplierRankScore[] {
  const lookbackDays = options.lookbackDays ?? 548;
  const recencyHighDays = options.recencyHighDays ?? 90;
  const recencyMedDays = options.recencyMedDays ?? 365;

  const cutoff548 = subtractDays(asOfDate, lookbackDays);
  const cutoff90 = subtractDays(asOfDate, recencyHighDays);
  const cutoff365 = subtractDays(asOfDate, recencyMedDays);

  const candidates: SupplierRankScore[] = [];

  for (const [suppId, supp] of supplierMaster.entries()) {
    if (supp.status !== 'Active') continue; // Clause 5.7 & 6.1: Active only

    const itemPOs = poHistory
      .filter(
        (po) =>
          po.supplier_id === suppId &&
          po.item_code === itemCode &&
          po.po_date >= cutoff548 &&
          po.po_date <= asOfDate
      )
      .sort((a, b) => b.po_date.localeCompare(a.po_date) || b.po_number.localeCompare(a.po_number));

    const itemContracts = contracts
      .filter(
        (c) =>
          c.supplier_id === suppId &&
          c.start_date <= asOfDate &&
          contractLines.some(
            (cl) => cl.contract_id === c.contract_id && cl.item_code === itemCode
          )
      )
      .sort(
        (a, b) =>
          b.start_date.localeCompare(a.start_date) || b.contract_id.localeCompare(a.contract_id)
      );

    const heldContract = itemContracts.length > 0;
    if (itemPOs.length === 0 && !heldContract) continue;

    // 5-Factor Normalized Scoring (0-100 each)
    const contractScore = heldContract ? 100 : 0;
    const volumeScore = Math.min(itemPOs.length / 5, 1.0) * 100;

    let recencyBracket = 0.0;
    if (itemPOs.length > 0) {
      const latestDate = itemPOs[0].po_date;
      if (latestDate >= cutoff90) recencyBracket = 1.0;
      else if (latestDate >= cutoff365) recencyBracket = 0.5;
      else recencyBracket = 0.0;
    }
    const recencyScore = recencyBracket * 100;
    const qualityScore = (supp.quality_rating / 5.0) * 100;
    const onTimeScore = supp.on_time_pct;

    const compositeScore = Number(
      (
        0.25 * contractScore +
        0.25 * volumeScore +
        0.2 * recencyScore +
        0.15 * qualityScore +
        0.15 * onTimeScore
      ).toFixed(4)
    );

    // Clause 6.3: Reference price
    let referencePrice = 0;
    let referenceSource = '';
    if (itemPOs.length > 0) {
      referencePrice = itemPOs[0].unit_price;
      referenceSource = `PO ${itemPOs[0].po_number} (${itemPOs[0].po_date})`;
    } else {
      const latestContract = itemContracts[0];
      const line = contractLines.find(
        (cl) => cl.contract_id === latestContract.contract_id && cl.item_code === itemCode
      )!;
      referencePrice = line.rate;
      referenceSource = `Contract ${latestContract.contract_id}`;
    }

    candidates.push({
      supplier_id: suppId,
      supplier_name: supp.name,
      rank: 0,
      composite_score: compositeScore,
      reference_price: referencePrice,
      reference_source: referenceSource,
      breakdown: {
        contract_score: Number((0.25 * contractScore).toFixed(2)),
        volume_score: Number((0.25 * volumeScore).toFixed(2)),
        recency_score: Number((0.2 * recencyScore).toFixed(2)),
        quality_score: Number((0.15 * qualityScore).toFixed(2)),
        on_time_score: Number((0.15 * onTimeScore).toFixed(2)),
        po_count_548d: itemPOs.length,
        recency_bracket: recencyBracket,
        held_contract: heldContract,
        quality_rating: supp.quality_rating,
        on_time_pct: supp.on_time_pct
      }
    });
  }

  candidates.sort(
    (a, b) => b.composite_score - a.composite_score || a.supplier_id.localeCompare(b.supplier_id)
  );

  return candidates.map((c, idx) => ({ ...c, rank: idx + 1 }));
}

/**
 * Policy Clause 6.4: Suggesting suppliers for sourcing.
 * 1. Take preferred list in order.
 * 2. If fewer than targetCount (3 for RFQ, 5 for RFP/Capex), top up with other Active suppliers
 *    listing item.category, ranked by equal-weighted 50/50 delivery & quality composite score.
 */
export function getSourcingSuggestions(
  item: Item,
  targetCount: number,
  preferredList: SupplierRankScore[],
  supplierMaster: Map<string, Supplier>
): string[] {
  if (targetCount <= 0) return [];
  const suggestions: string[] = [];

  for (const s of preferredList) {
    if (suggestions.length < targetCount) {
      suggestions.push(s.supplier_id);
    }
  }

  if (suggestions.length < targetCount) {
    const fallbackPool: Array<{ supplier_id: string; score: number }> = [];

    for (const [suppId, supp] of supplierMaster.entries()) {
      if (supp.status !== 'Active') continue; // Clause 5.7
      if (suggestions.includes(suppId)) continue;

      if (supp.categories.includes(item.category)) {
        const score = 0.5 * (supp.on_time_pct / 100) + 0.5 * (supp.quality_rating / 5.0);
        fallbackPool.push({ supplier_id: suppId, score });
      }
    }

    fallbackPool.sort(
      (a, b) => b.score - a.score || a.supplier_id.localeCompare(b.supplier_id)
    );

    for (const s of fallbackPool) {
      if (suggestions.length < targetCount) {
        suggestions.push(s.supplier_id);
      }
    }
  }

  return suggestions;
}
