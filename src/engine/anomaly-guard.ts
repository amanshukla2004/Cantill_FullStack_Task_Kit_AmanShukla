import { DecisionOutput, Item, PRLine, Plant } from './types.js';
import { minutesDiff, parseUtcTimestampMs } from './date-utils.js';
import { resolveItem } from './item-resolver.js';

export interface AnomalyCheckResult {
  validLines: PRLine[];
  anomalyOutputs: DecisionOutput[];
}

const DUPLICATE_WINDOW_MINUTES = 15;

export function filterAnomaliesAndResolveItems(
  prLines: PRLine[],
  plants: Map<string, Plant>,
  items: Map<string, Item>,
  defaultPolicyVersion: string
): AnomalyCheckResult {
  const validLines: PRLine[] = [];
  const anomalyOutputs: DecisionOutput[] = [];

  // Process in deterministic chronological order so duplicate checks always keep the earliest PR
  const ordered = [...prLines].sort((a, b) => {
    const tDiff = parseUtcTimestampMs(a.created_at) - parseUtcTimestampMs(b.created_at);
    if (tDiff !== 0) return tDiff;
    const prDiff = a.pr_no.localeCompare(b.pr_no);
    if (prDiff !== 0) return prDiff;
    return a.pr_line - b.pr_line;
  });

  for (const rawLine of ordered) {
    const line: PRLine = { ...rawLine };

    // Resolve item first so anomaly rows also carry accurate item code when possible
    const match = resolveItem(line.raw_item_code, line.description, items);
    line.resolved_item_code = match.resolved_item_code;
    line.is_new_item = match.is_new;
    line.match_confidence = match.match_confidence;
    line.had_text_urgent_tag = match.had_text_urgent_tag;

    // 1. Zero or negative quantity (DECISIONS.md 1.1)
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      anomalyOutputs.push({
        pr_no: line.pr_no,
        pr_line: line.pr_line,
        resolved_item_code: line.resolved_item_code,
        group_id: `ERR-${line.pr_no}-${line.pr_line}`,
        po_id: '',
        decision: 'NOT_PROCESSED',
        route: 'NOT_PROCESSED',
        supplier_id: '',
        unit_price: '',
        group_value_inr: 0,
        suggested_supplier_ids: '',
        policy_version: defaultPolicyVersion,
        reason: `Zero or invalid quantity (${line.quantity}); line cannot be commercially fulfilled (see DECISIONS.md 1.1)`
      });
      continue;
    }

    // 2. Unrecognized delivery plant (DECISIONS.md 1.2)
    if (!plants.has(line.plant)) {
      const validPlantList = Array.from(plants.keys()).join(', ');
      anomalyOutputs.push({
        pr_no: line.pr_no,
        pr_line: line.pr_line,
        resolved_item_code: line.resolved_item_code,
        group_id: `ERR-${line.pr_no}-${line.pr_line}`,
        po_id: '',
        decision: 'NOT_PROCESSED',
        route: 'NOT_PROCESSED',
        supplier_id: '',
        unit_price: '',
        group_value_inr: 0,
        suggested_supplier_ids: '',
        policy_version: defaultPolicyVersion,
        reason: `Invalid delivery plant '${line.plant}'; valid plants are ${validPlantList} (see DECISIONS.md 1.2)`
      });
      continue;
    }

    // 3. Near-duplicate PR guard (DECISIONS.md 1.13):
    // Same requester, resolved item, plant, quantity, and need_by_date raised within 15 minutes
    const dupOf = validLines.find(
      (prev) =>
        prev.requester.trim().toLowerCase() === line.requester.trim().toLowerCase() &&
        prev.resolved_item_code === line.resolved_item_code &&
        prev.resolved_item_code !== 'NEW' &&
        prev.plant === line.plant &&
        prev.quantity === line.quantity &&
        prev.need_by_date === line.need_by_date &&
        Math.abs(minutesDiff(prev.created_at, line.created_at)) <= DUPLICATE_WINDOW_MINUTES
    );

    if (dupOf) {
      const elapsed = Math.round(Math.abs(minutesDiff(dupOf.created_at, line.created_at)));
      anomalyOutputs.push({
        pr_no: line.pr_no,
        pr_line: line.pr_line,
        resolved_item_code: line.resolved_item_code,
        group_id: `DUP-${line.pr_no}-${line.pr_line}`,
        po_id: '',
        decision: 'NOT_PROCESSED',
        route: 'NOT_PROCESSED',
        supplier_id: '',
        unit_price: '',
        group_value_inr: 0,
        suggested_supplier_ids: '',
        policy_version: defaultPolicyVersion,
        reason: `Suspected duplicate of ${dupOf.pr_no}/${dupOf.pr_line} raised ${elapsed} min earlier by ${line.requester} for identical item, plant, quantity, and need-by date (see DECISIONS.md 1.13)`
      });
      continue;
    }

    validLines.push(line);
  }

  return { validLines, anomalyOutputs };
}
