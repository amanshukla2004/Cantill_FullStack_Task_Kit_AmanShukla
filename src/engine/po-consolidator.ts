import { EvaluatedRequirement } from './types.js';
import { extractDateOnly, hoursDiff, parseUtcTimestampMs } from './date-utils.js';

export interface ConsolidatedPOGroup {
  po_id: string;
  supplier_id: string;
  plant: string;
  route: string;
  first_req_created_at: string;
  requirement_group_ids: string[];
}

export type ConsolidationWindowResolver = (reqDate: string) => number;

/**
 * Policy Section 7: Placing purchase orders (consolidation).
 * - Only requirements ending in decision === 'PO' are consolidated.
 * - Evaluated in chronological order of requirement creation time (first_created_at ASC, group_id ASC).
 * - Joins earliest open PO with same supplier, plant, route where
 *   hoursDiff(po.first_req_created_at, req.first_created_at) <= consolidationWindowHours
 *   (resolved per requirement's effective policy date when mid-batch policies exist).
 * - Sourcing requests are never combined.
 */
export function consolidatePurchaseOrders(
  evaluated: EvaluatedRequirement[],
  consolidationWindowHours = 24,
  windowResolver?: ConsolidationWindowResolver
): {
  reqToPoId: Map<string, string>;
  poGroups: ConsolidatedPOGroup[];
} {
  const reqToPoId = new Map<string, string>();
  const poGroups: ConsolidatedPOGroup[] = [];

  const poCandidates = evaluated
    .filter((e) => e.decision === 'PO' && e.supplier_id)
    .sort((a, b) => {
      const tDiff =
        parseUtcTimestampMs(a.requirement.first_created_at) -
        parseUtcTimestampMs(b.requirement.first_created_at);
      if (tDiff !== 0) return tDiff;
      return a.requirement.group_id.localeCompare(b.requirement.group_id);
    });

  let poCounter = 1;

  for (const item of poCandidates) {
    const req = item.requirement;
    const reqWindowHours = windowResolver
      ? windowResolver(extractDateOnly(req.first_created_at))
      : consolidationWindowHours;
    let matchedPO: ConsolidatedPOGroup | null = null;

    for (const po of poGroups) {
      if (
        po.supplier_id === item.supplier_id &&
        po.plant === req.plant &&
        po.route === item.route
      ) {
        const diffHrs = hoursDiff(po.first_req_created_at, req.first_created_at);
        if (diffHrs >= 0 && diffHrs <= reqWindowHours) {
          matchedPO = po;
          break; // Clause 7.2: joins earliest qualifying open PO
        }
      }
    }

    if (matchedPO) {
      matchedPO.requirement_group_ids.push(req.group_id);
      reqToPoId.set(req.group_id, matchedPO.po_id);
    } else {
      const poId = `PO-${String(poCounter++).padStart(4, '0')}`;
      poGroups.push({
        po_id: poId,
        supplier_id: item.supplier_id,
        plant: req.plant,
        route: item.route,
        first_req_created_at: req.first_created_at,
        requirement_group_ids: [req.group_id]
      });
      reqToPoId.set(req.group_id, poId);
    }
  }

  return { reqToPoId, poGroups };
}
