import {
  Contract,
  ContractLine,
  DecisionOutput,
  EvaluatedRequirement,
  Item,
  POHistoryEntry,
  PRLine,
  Plant,
  Policy,
  Supplier
} from './types.js';
import { extractDateOnly } from './date-utils.js';
import { filterAnomaliesAndResolveItems } from './anomaly-guard.js';
import { clubPRLines } from './clubbing-engine.js';
import { valueRequirement } from './contract-ceiling.js';
import { evaluateWaterfall, formatPolicyVersion, resolvePolicyForDate } from './waterfall-evaluator.js';
import { ConsolidatedPOGroup, consolidatePurchaseOrders } from './po-consolidator.js';

export interface PipelineInput {
  prLines: PRLine[];
  plants: Map<string, Plant>;
  items: Map<string, Item>;
  suppliers: Map<string, Supplier>;
  contracts: Contract[];
  contractLines: ContractLine[];
  poHistory: POHistoryEntry[];
  policies: Policy[];
}

export interface PipelineRunResult {
  decisions: DecisionOutput[];
  evaluatedRequirements: Array<EvaluatedRequirement & { po_id: string }>;
  anomalyOutputs: DecisionOutput[];
  poGroups: ConsolidatedPOGroup[];
  finalContracts: Contract[];
}

export function runProcurementPipeline(input: PipelineInput): PipelineRunResult {
  const {
    prLines,
    plants,
    items,
    suppliers,
    contracts,
    contractLines,
    poHistory,
    policies
  } = input;

  // Resolve macro clubbing/consolidation policy as of the batch's latest PR date
  // so future-dated policy versions never prematurely alter earlier batches
  const batchDates = prLines
    .map((l) => extractDateOnly(l.created_at))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const maxBatchDate =
    batchDates[batchDates.length - 1] || new Date().toISOString().slice(0, 10);
  const primaryPolicy = resolvePolicyForDate(policies, maxBatchDate);

  // Step 1: Anomaly validation, duplicate guard & deterministic item resolution (per-line policy version)
  const { validLines, anomalyOutputs } = filterAnomaliesAndResolveItems(
    prLines,
    plants,
    items,
    (dateStr) => formatPolicyVersion(resolvePolicyForDate(policies, dateStr).version)
  );

  // Step 2: Anti-splitting clubbing (Clause 2) with per-line effective-date window resolution
  const requirements = clubPRLines(
    validLines,
    primaryPolicy.clubbing_creation_window_days,
    primaryPolicy.clubbing_need_by_window_days,
    (dateStr) => {
      const p = resolvePolicyForDate(policies, dateStr);
      return {
        creationWindowDays: p.clubbing_creation_window_days,
        needByWindowDays: p.clubbing_need_by_window_days
      };
    }
  );

  // Step 3: Deep-clone contracts starting cleanly from baseline initial_consumed_value (idempotent Run 1 -> Run 2)
  const runningContracts: Contract[] = contracts.map((c) => ({
    ...c,
    current_consumed_value: c.initial_consumed_value
  }));

  const evaluatedReqs: EvaluatedRequirement[] = [];

  for (const req of requirements) {
    const reqDate = extractDateOnly(req.first_created_at);
    const reqPolicy = resolvePolicyForDate(policies, reqDate);

    // Clause 1.2: Novel uncataloged items
    if (req.resolved_item_code === 'NEW') {
      const unitEst = req.lines[0].estimated_unit_price ?? 0;
      const groupVal = Math.round(req.total_quantity * unitEst);
      const verLabel = formatPolicyVersion(reqPolicy.version);
      evaluatedReqs.push({
        requirement: req,
        policy_version: verLabel,
        clause_applied: '1.2',
        supplier_strategy: 'NONE',
        decision: 'SOURCING_REQUEST',
        route: 'NEW_ITEM_SOURCING',
        supplier_id: '',
        unit_price: '',
        group_value_inr: groupVal,
        suggested_supplier_ids: '',
        reference_doc: 'Requester Estimate',
        reason: `Policy ${verLabel} Clause 1.2 (New Item): Uncataloged item '${req.lines[0].description}'; valued at requester estimate ₹${unitEst.toFixed(2)}, never clubbed, no supplier suggestions`
      });
      continue;
    }

    const item = items.get(req.resolved_item_code)!;

    // Clauses 3 & 4: Valuation & dynamic contract ceiling qualification
    const valuation = valueRequirement(
      req,
      runningContracts,
      contractLines,
      poHistory,
      item,
      suppliers,
      reqPolicy.active_history_lookback_days
    );

    // Section 5: Declarative AST waterfall evaluation
    const decisionResult = evaluateWaterfall(
      req,
      item,
      valuation,
      reqPolicy,
      suppliers,
      poHistory,
      runningContracts,
      contractLines
    );

    // Consume contract ceiling whenever a CONTRACT_HOLDER rule actually awards the contract
    if (decisionResult.supplier_strategy === 'CONTRACT_HOLDER' && valuation.contract_used) {
      valuation.contract_used.current_consumed_value = Number(
        (valuation.contract_used.current_consumed_value + valuation.exact_value_inr).toFixed(2)
      );
    }

    evaluatedReqs.push(decisionResult);
  }

  // Step 4: PO Consolidation (Section 7) with per-requirement effective-date window resolution
  const { reqToPoId, poGroups } = consolidatePurchaseOrders(
    evaluatedReqs,
    primaryPolicy.po_consolidation_window_hours,
    (reqDate) => resolvePolicyForDate(policies, reqDate).po_consolidation_window_hours
  );

  const evaluatedWithPO = evaluatedReqs.map((e) => ({
    ...e,
    po_id: reqToPoId.get(e.requirement.group_id) || ''
  }));

  // Step 5: Expand to one DecisionOutput row per input PR line
  const validOutputs: DecisionOutput[] = [];
  for (const evalItem of evaluatedWithPO) {
    const req = evalItem.requirement;
    for (const line of req.lines) {
      validOutputs.push({
        pr_no: line.pr_no,
        pr_line: line.pr_line,
        resolved_item_code: req.resolved_item_code,
        group_id: req.group_id,
        po_id: evalItem.po_id,
        decision: evalItem.decision,
        route: evalItem.route,
        supplier_id: evalItem.supplier_id,
        unit_price: evalItem.unit_price,
        group_value_inr: evalItem.group_value_inr,
        suggested_supplier_ids: evalItem.suggested_supplier_ids,
        policy_version: evalItem.policy_version,
        reason: evalItem.reason
      });
    }
  }

  const decisions = [...validOutputs, ...anomalyOutputs].sort((a, b) => {
    const prCmp = a.pr_no.localeCompare(b.pr_no);
    if (prCmp !== 0) return prCmp;
    return a.pr_line - b.pr_line;
  });

  return {
    decisions,
    evaluatedRequirements: evaluatedWithPO,
    anomalyOutputs,
    poGroups,
    finalContracts: runningContracts
  };
}
