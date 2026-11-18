import {
  Contract,
  ContractLine,
  EvaluatedRequirement,
  Item,
  POHistoryEntry,
  Policy,
  Requirement,
  Supplier,
  ValuationResult
} from './types.js';
import { EvaluationContext, evaluateCondition } from './policy-ast.js';
import { extractDateOnly, subtractDays } from './date-utils.js';
import { getSourcingSuggestions, rankPreferredSuppliers } from './preferred-suppliers.js';

export function formatPolicyVersion(version: string): string {
  return `v${version.trim().replace(/^v/i, '')}`;
}

/**
 * Resolve the applicable approved policy version as of a requirement's creation date.
 * - Supports mid-batch effective dates cleanly (ACTIVE policy + earlier historical SUPERSEDED ancestors).
 * - Excludes rolled-back SUPERSEDED policies (any SUPERSEDED version created after or effective on/after the current ACTIVE policy).
 */
export function resolvePolicyForDate(policies: Policy[], reqDate: string): Policy {
  const activePolicy = policies
    .filter((p) => p.status === 'ACTIVE')
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || b.policy_id - a.policy_id)[0];

  const eligible: Policy[] = [];
  if (activePolicy) {
    eligible.push(activePolicy);
    for (const p of policies) {
      if (
        p.status === 'SUPERSEDED' &&
        p.policy_id < activePolicy.policy_id &&
        p.effective_date < activePolicy.effective_date
      ) {
        eligible.push(p);
      }
    }
  } else {
    eligible.push(...policies.filter((p) => p.status === 'SUPERSEDED'));
  }

  eligible.sort(
    (a, b) => b.effective_date.localeCompare(a.effective_date) || b.policy_id - a.policy_id
  );

  const matching = eligible.find((p) => p.effective_date <= reqDate);
  if (matching) return matching;

  return eligible[eligible.length - 1] || policies[0];
}

export function hasActiveSupplierHistory(
  itemCode: string,
  reqDate: string,
  lookbackDays: number,
  poHistory: POHistoryEntry[],
  supplierMaster: Map<string, Supplier>
): boolean {
  const cutoff = subtractDays(reqDate, lookbackDays);
  return poHistory.some((po) => {
    if (po.item_code !== itemCode) return false;
    if (po.po_date < cutoff || po.po_date > reqDate) return false;
    const supp = supplierMaster.get(po.supplier_id);
    return supp?.status === 'Active';
  });
}

export function evaluateWaterfall(
  req: Requirement,
  item: Item,
  valuation: ValuationResult,
  policy: Policy,
  supplierMaster: Map<string, Supplier>,
  poHistory: POHistoryEntry[],
  contracts: Contract[],
  contractLines: ContractLine[]
): EvaluatedRequirement {
  const reqDate = extractDateOnly(req.first_created_at);
  const hasActiveHistory = hasActiveSupplierHistory(
    item.item_code,
    reqDate,
    policy.active_history_lookback_days,
    poHistory,
    supplierMaster
  );

  const preferredList = rankPreferredSuppliers(
    item.item_code,
    reqDate,
    supplierMaster,
    poHistory,
    contracts,
    contractLines,
    {
      lookbackDays: policy.psl_lookback_days,
      recencyHighDays: policy.psl_recency_high_days,
      recencyMedDays: policy.psl_recency_med_days
    }
  );

  const ctx: EvaluationContext = {
    item_code: item.item_code,
    item_type: item.item_type,
    category: item.category,
    plant: req.plant,
    department: req.lines[0]?.department || '',
    uom: item.uom,
    // Evaluate thresholds against exact 2-decimal valuation to prevent rounding boundary flips
    group_value_inr: valuation.exact_value_inr,
    urgency: req.is_emergency ? 'Emergency' : 'Normal',
    contract_available: valuation.contract_used !== null,
    has_active_365d_history: hasActiveHistory && preferredList.length > 0,
    is_new_item: false,
    total_quantity: req.total_quantity
  };

  const orderedRules = [...policy.rules].sort(
    (a, b) => a.priority_order - b.priority_order
  );
  const verLabel = formatPolicyVersion(policy.version);

  for (const rule of orderedRules) {
    if (!evaluateCondition(rule.conditions, ctx)) continue;

    // 1. Contract PO Strategy
    if (rule.supplier_strategy === 'CONTRACT_HOLDER') {
      if (!valuation.contract_used) continue;
      const c = valuation.contract_used;
      return {
        requirement: req,
        policy_version: verLabel,
        clause_applied: rule.clause_number,
        supplier_strategy: rule.supplier_strategy,
        decision: rule.outcome,
        route: rule.route,
        supplier_id: c.supplier_id,
        unit_price: valuation.unit_price.toFixed(2),
        group_value_inr: valuation.group_value_inr,
        suggested_supplier_ids: '',
        reference_doc: c.contract_id,
        reason: `Policy ${verLabel} Clause ${rule.clause_number} (${rule.rule_name}): Active contract ${c.contract_id} with ${c.supplier_id} (${c.supplier_name}) at ₹${valuation.unit_price.toFixed(2)}; ${valuation.pricing_basis}`
      };
    }

    // 2. 1st Preferred Supplier Strategy (SPOT_PO / EMERGENCY_PO)
    // CRITICAL: group_value_inr uses Clause 3.1 valuation, while awarded PO unit_price uses 1st preferred supplier's Clause 6.3 reference price!
    if (rule.supplier_strategy === 'PREFERRED_RANK_1') {
      if (preferredList.length === 0) continue;
      const topSupplier = preferredList[0];
      return {
        requirement: req,
        policy_version: verLabel,
        clause_applied: rule.clause_number,
        supplier_strategy: rule.supplier_strategy,
        decision: rule.outcome,
        route: rule.route,
        supplier_id: topSupplier.supplier_id,
        unit_price: topSupplier.reference_price.toFixed(2),
        group_value_inr: valuation.group_value_inr,
        suggested_supplier_ids: '',
        reference_doc: topSupplier.reference_source,
        reason: `Policy ${verLabel} Clause ${rule.clause_number} (${rule.rule_name}): Awarded to 1st preferred supplier ${topSupplier.supplier_id} (${topSupplier.supplier_name}) at ref price ₹${topSupplier.reference_price.toFixed(2)} via ${topSupplier.reference_source}; valued via ${valuation.pricing_basis}`
      };
    }

    // 3. Sourcing Request Strategy (RFQ / RFP / CAPEX_SOURCING / Custom Sourcing Rule)
    const suggested =
      rule.supplier_strategy === 'SUGGEST_SUPPLIERS'
        ? getSourcingSuggestions(item, rule.supplier_suggestion_count, preferredList, supplierMaster)
        : [];

    return {
      requirement: req,
      policy_version: verLabel,
      clause_applied: rule.clause_number,
      supplier_strategy: rule.supplier_strategy,
      decision: rule.outcome,
      route: rule.route,
      supplier_id: '',
      unit_price: '',
      group_value_inr: valuation.group_value_inr,
      suggested_supplier_ids: suggested.join(';'),
      reference_doc: valuation.reference_doc,
      reason: `Policy ${verLabel} Clause ${rule.clause_number} (${rule.rule_name}): Valued at ₹${valuation.group_value_inr.toLocaleString('en-IN')} via ${valuation.pricing_basis}${rule.notes ? `; ${rule.notes}` : ''}`
    };
  }

  // Defensive fallback if an amended policy omitted a catch-all rule
  const fallbackSuggestions = getSourcingSuggestions(item, 3, preferredList, supplierMaster);
  return {
    requirement: req,
    policy_version: verLabel,
    clause_applied: 'FALLBACK',
    supplier_strategy: 'SUGGEST_SUPPLIERS',
    decision: 'SOURCING_REQUEST',
    route: 'RFQ',
    supplier_id: '',
    unit_price: '',
    group_value_inr: valuation.group_value_inr,
    suggested_supplier_ids: fallbackSuggestions.join(';'),
    reference_doc: valuation.reference_doc,
    reason: `Policy ${verLabel} default sourcing fallback: no rule matched; valued via ${valuation.pricing_basis}`
  };
}
