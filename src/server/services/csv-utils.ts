import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { DecisionOutput, PRLine, Urgency } from '../../engine/types.js';

export function parsePrBatchCsv(csvContent: string): PRLine[] {
  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Record<string, string>[];

  return rows.map((r) => {
    const rawEst = r.estimated_unit_price?.trim();
    const estNum = rawEst !== undefined && rawEst !== '' ? Number(rawEst) : null;
    const rawUrgency = (r.urgency || 'Normal').trim();
    const urgency: Urgency =
      rawUrgency.toLowerCase() === 'emergency' ? 'Emergency' : 'Normal';

    return {
      pr_no: (r.pr_no || '').trim(),
      pr_line: Number(r.pr_line || 1),
      created_at: (r.created_at || '').trim(),
      requester: (r.requester || '').trim(),
      department: (r.department || '').trim(),
      plant: (r.plant || '').trim(),
      raw_item_code: r.item_code && r.item_code.trim() !== '' ? r.item_code.trim() : null,
      description: (r.description || '').trim(),
      quantity: Number(r.quantity),
      uom: (r.uom || '').trim(),
      estimated_unit_price: estNum !== null && Number.isFinite(estNum) ? estNum : null,
      need_by_date: (r.need_by_date || '').trim(),
      urgency
    };
  });
}

export function serializeDecisionsCsv(decisions: DecisionOutput[]): string {
  return stringify(decisions, {
    header: true,
    columns: [
      'pr_no',
      'pr_line',
      'resolved_item_code',
      'group_id',
      'po_id',
      'decision',
      'route',
      'supplier_id',
      'unit_price',
      'group_value_inr',
      'suggested_supplier_ids',
      'policy_version',
      'reason'
    ]
  });
}

export function serializePreferredSuppliersCsv(
  rows: Array<{
    item_code: string;
    rank: number;
    supplier_id: string;
    reference_price: string;
  }>
): string {
  return stringify(rows, {
    header: true,
    columns: ['item_code', 'rank', 'supplier_id', 'reference_price']
  });
}
